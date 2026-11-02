/**
 * 插件装载器（ADR-005 §4.4）。
 *
 * 职责：扫描 `<Data>/plugins` 下每个插件目录的 manifest.json → 校验必填字段 / `apiVersion` 兼容表 / 权限声明
 * → `require()` 隔离加载入口 → 登记到注册表。
 *
 * **失败绝不抛出给调用方**：任何一个插件的目录不可读、JSON 非法、缺字段、版本不匹配、
 * 入口 require 抛错、activate 抛错，都只落成一条带可读原因的 `PluginStatus`（D23）。
 */
import * as fs from 'fs'
import * as path from 'path'
import { PluginHost } from './host'
import { PluginRegistry, normalizeCapabilities, normalizePermissions, normalizeRuntime } from './registry'
import {
  PluginKind,
  PluginManifest,
  SUPPORTED_API_VERSIONS,
} from './types'

export interface PluginLoadRejection {
  id: string
  reason: string
  dir: string
}

export interface PluginLoadReport {
  /** 成功装载的插件 id */
  loaded: string[]
  /** 被拒绝的插件（含原因），宿主日志与验证脚本都用它 */
  rejected: PluginLoadRejection[]
}

const PLUGIN_KINDS: PluginKind[] = ['parser', 'embedding', 'llm', 'rerank', 'method', 'panel']

function isPluginKind(value: unknown): value is PluginKind {
  return typeof value === 'string' && (PLUGIN_KINDS as string[]).includes(value)
}

/** 扩展名归一：小写、去点、去空白 */
function normalizeExtension(value: unknown): string {
  return String(value ?? '').toLowerCase().trim().replace(/^\./, '')
}

/**
 * 把任意 JSON 收敛成 manifest 结构（缺字段填安全默认值）。
 * 真正的「缺什么字段」由 `validateManifest` 给出可读原因，这里只保证后续代码不因 undefined 崩。
 */
export function coerceManifest(raw: any, fallbackId: string): { manifest: PluginManifest; kind: PluginKind | 'unknown' } {
  const kindKnown = isPluginKind(raw?.kind)
  const id = typeof raw?.id === 'string' && raw.id.trim() ? raw.id.trim() : fallbackId
  return {
    kind: kindKnown ? raw.kind : 'unknown',
    manifest: {
      id,
      name: typeof raw?.name === 'string' && raw.name.trim() ? raw.name.trim() : id,
      version: typeof raw?.version === 'string' && raw.version.trim() ? raw.version.trim() : '未知',
      apiVersion: Number.isFinite(Number(raw?.apiVersion)) ? Number(raw.apiVersion) : 0,
      // kind 非法时给一个占位值：真实 kind 由 registry 的 override 记为 'unknown'，UI 显示「未知」
      kind: kindKnown ? raw.kind : 'parser',
      runtime: normalizeRuntime(raw?.runtime),
      builtin: false,
      permissions: normalizePermissions(raw?.permissions),
      capabilities: normalizeCapabilities(raw?.capabilities),
      entry: typeof raw?.entry === 'string' ? raw.entry : undefined,
      description: typeof raw?.description === 'string' ? raw.description : undefined,
    },
  }
}

/**
 * 校验 manifest，返回可读原因（null 表示通过）。
 *
 * 规则来源：D23（显式权限声明、默认不联网、下载白名单）、D25（apiVersion 兼容表）、
 * §4.2（必填字段）与 §4.3（解析器必须能读用户文件、必须声明扩展名）。
 */
export function validateManifest(raw: any, manifest: PluginManifest): string | null {
  const missing: string[] = []
  for (const field of ['id', 'name', 'version'] as const) {
    if (typeof raw?.[field] !== 'string' || !String(raw[field]).trim()) missing.push(field)
  }
  if (missing.length) return `manifest 缺少必填字段：${missing.join('、')}`
  if (!Number.isFinite(Number(raw?.apiVersion))) return 'manifest 缺少必填字段：apiVersion'
  if (!isPluginKind(raw?.kind)) {
    return `manifest 的 kind 不合法：${String(raw?.kind)}（可选 ${PLUGIN_KINDS.join(' / ')}）`
  }
  if (raw?.runtime !== 'inline' && raw?.runtime !== 'worker') {
    return `manifest 的 runtime 不合法：${String(raw?.runtime)}（可选 inline / worker）`
  }
  const apiVersion = Number(raw.apiVersion)
  if (!SUPPORTED_API_VERSIONS.includes(apiVersion)) {
    return `插件声明 apiVersion=${apiVersion}，当前宿主仅兼容 ${SUPPORTED_API_VERSIONS.join('、')}；不做尽力兼容，请升级宿主或改用兼容版本插件`
  }
  if (typeof raw?.entry !== 'string' || !raw.entry.trim()) return 'manifest 缺少必填字段：entry（本地插件入口文件，如 index.js）'
  if (raw?.builtin === true) return '本地插件不得声明 builtin=true（该字段由宿主保留给内建插件）'
  if (!raw?.permissions || typeof raw.permissions !== 'object') {
    return 'manifest 缺少 permissions 声明（未声明即拒绝：至少显式写出 fsRead 与 net）'
  }
  if (manifest.kind === 'parser' && manifest.permissions?.fsRead !== true) {
    return '解析器插件必须声明 permissions.fsRead=true（否则无法读取用户文件，拒绝加载）'
  }
  // 模型接入插件（ADR-006）的端点由用户配置、由宿主的出口守卫按端点校验，清单里写不出固定域名，
  // 因此不套用「modelDownload 白名单」这条（它针对的是模型文件下载地址）。
  const needsDownloadWhitelist = manifest.permissions?.net === true && manifest.kind !== 'llm'
  if (needsDownloadWhitelist && !(manifest.permissions.modelDownload || []).length) {
    return 'permissions.net=true 时必须声明 modelDownload 白名单（拒绝「允许任意联网」）'
  }
  if (manifest.kind === 'parser' && !(manifest.capabilities?.extensions || []).length) {
    return 'parser 类插件必须声明 capabilities.extensions（能处理的扩展名）'
  }
  if (manifest.kind === 'llm') {
    if (manifest.permissions?.net !== true) {
      return '模型接入插件必须声明 permissions.net=true（它要自己发起模型请求，未声明即视为隐瞒联网）'
    }
    if (!(manifest.capabilities?.providerTypes || []).length) {
      return '模型接入插件必须声明 capabilities.providerTypes（该插件覆盖的 provider 类型，如 byo-openai）'
    }
  }
  return null
}

export class PluginLoader {
  constructor(
    private registry: PluginRegistry,
    private opts: { dataDir: string; host: PluginHost }
  ) {}

  /** 本地插件目录：`<Data>/plugins` */
  pluginsDir(): string {
    return path.join(this.opts.dataDir, 'plugins')
  }

  private log(level: 'info' | 'warn' | 'error', message: string): void {
    const line = `[plugins] ${message}`
    if (level === 'error') console.error(line)
    else if (level === 'warn') console.warn(line)
    else console.log(line)
  }

  /** 扫描并装载；目录不存在视为「没有本地插件」，不是错误 */
  loadAll(): PluginLoadReport {
    const report: PluginLoadReport = { loaded: [], rejected: [] }
    const root = this.pluginsDir()
    if (!fs.existsSync(root)) return report

    let dirs: string[]
    try {
      dirs = fs.readdirSync(root, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => path.join(root, d.name))
    } catch (e: any) {
      report.rejected.push({ id: '<plugins 目录>', reason: `插件目录不可读：${e?.message || e}`, dir: root })
      this.log('warn', report.rejected[0].reason)
      return report
    }

    for (const dir of dirs) this.loadOne(dir, report)
    if (report.loaded.length || report.rejected.length) {
      this.log('info', `本地插件扫描完成：装载 ${report.loaded.length} 个，拒绝 ${report.rejected.length} 个`)
    }
    return report
  }

  /** 重新扫描：先清掉已登记的本地插件，再重扫（内建插件不受影响） */
  reload(): PluginLoadReport {
    this.registry.clearLocal()
    return this.loadAll()
  }

  private loadOne(dir: string, report: PluginLoadReport): void {
    const dirName = path.basename(dir)
    const manifestPath = path.join(dir, 'manifest.json')

    /** 统一的失败出口：登记一条可读原因的状态，并记入报告 */
    const reject = (manifest: PluginManifest, kind: PluginKind | 'unknown', reason: string): void => {
      this.registry.register({ manifest, kind, source: 'local', path: dir, loaded: false, error: reason })
      report.rejected.push({ id: manifest.id, reason, dir })
      this.log('warn', `插件加载失败 [${manifest.id}] @ ${dir}：${reason}`)
    }

    if (!fs.existsSync(manifestPath)) {
      const { manifest, kind } = coerceManifest({}, `local.${dirName}`)
      return reject(manifest, kind, '缺少 manifest.json（本地插件必须以 manifest.json 声明清单）')
    }

    let raw: any
    try {
      raw = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'))
    } catch (e: any) {
      const { manifest, kind } = coerceManifest({}, `local.${dirName}`)
      return reject(manifest, kind, `manifest.json 不是合法 JSON：${e?.message || e}`)
    }

    const { manifest, kind } = coerceManifest(raw, `local.${dirName}`)
    const reason = validateManifest(raw, manifest)
    if (reason) return reject(manifest, kind, reason)

    // 同一目录被重复扫描（重新初始化 / 重新扫描）视为「重新登记」；其它 id 冲突一律拒绝，
    // 避免本地插件顶掉内建插件或与另一个插件目录抢同一个 id。
    const existing = this.registry.describeRegistration(manifest.id)
    if (existing && !(existing.source === 'local' && existing.path === dir)) {
      return reject(manifest, kind, `插件 id 与已装载的插件冲突：${manifest.id}`)
    }

    const entryPath = path.resolve(dir, manifest.entry as string)
    if (!fs.existsSync(entryPath)) {
      return reject(manifest, kind, `入口文件不存在：${manifest.entry}`)
    }

    let mod: any
    try {
      // 本地插件只在此处执行（CommonJS）；宿主不向它暴露 fs/net，见 host.ts 与 D23
      mod = require(entryPath)
    } catch (e: any) {
      return reject(manifest, kind, `入口加载失败（require 抛错）：${e?.message || e}`)
    }

    const activate =
      typeof mod?.activate === 'function' ? mod.activate
        : typeof mod === 'function' ? mod
          : typeof mod?.default?.activate === 'function' ? mod.default.activate
            : null
    if (!activate) {
      return reject(manifest, kind, '入口未导出 activate(host)：本地插件需导出 activate(host) 并返回 { parser } 或 { embedding }')
    }

    let produced: any
    try {
      produced = activate.call(mod, this.opts.host.api)
    } catch (e: any) {
      return reject(manifest, kind, `activate(host) 抛错：${e?.message || e}`)
    }
    if (produced && typeof produced.then === 'function') {
      return reject(manifest, kind, 'activate(host) 返回了 Promise：本轮只支持同步激活（异步初始化请放进 parse / embed 内部）')
    }

    if (manifest.kind === 'parser') return this.registerParser(dir, manifest, produced, report, reject)
    if (manifest.kind === 'embedding') return this.registerEmbedding(dir, manifest, produced, report, reject)
    if (manifest.kind === 'llm') return this.registerLlmPlugin(dir, manifest, produced, report, reject)
    reject(manifest, kind, `kind=${manifest.kind} 的扩展点尚未实现（ADR-005 D22：首批交付解析器与嵌入模型，ADR-006 追加模型接入）`)
  }

  /**
   * 模型接入插件（ADR-006）。
   *
   * 只校验「能否把配置变成 provider」：`createProvider(config)` 必须同步返回实现，
   * 不在这里发起任何请求——登记成功不等于已接入模型，网关仍然只在用户配置了 provider 时才装载。
   */
  private registerLlmPlugin(
    dir: string,
    manifest: PluginManifest,
    produced: any,
    report: PluginLoadReport,
    reject: (manifest: PluginManifest, kind: PluginKind | 'unknown', reason: string) => void
  ): void {
    const plugin = produced?.llm
    if (!plugin || typeof plugin.createProvider !== 'function') {
      return reject(manifest, manifest.kind, 'activate(host) 未返回可用的 llm（需要 { llm: { kind, providerTypes, createProvider } }）')
    }
    const specs = Array.isArray(plugin.providerTypes) ? plugin.providerTypes : []
    const providerTypes = specs
      .filter((spec: any) => spec && typeof spec.kind === 'string' && spec.kind.trim())
      .map((spec: any) => ({
        kind: String(spec.kind).trim(),
        label: String(spec.label || spec.kind),
        requiresKey: spec.requiresKey !== false,
        available: spec.available !== false,
        defaultBaseUrl: String(spec.defaultBaseUrl || ''),
        note: String(spec.note || ''),
      }))
    if (!providerTypes.length) {
      return reject(manifest, manifest.kind, 'llm 未声明任何 providerTypes（需要 [{ kind, label, ... }]）')
    }
    const declared = (manifest.capabilities?.providerTypes || []).map(String)
    const undeclared = providerTypes.map((t: { kind: string }) => t.kind).filter((k: string) => !declared.includes(k))
    if (undeclared.length) {
      return reject(
        manifest,
        manifest.kind,
        `llm 运行时声明的 provider 类型未写进 manifest.capabilities.providerTypes：${undeclared.join('、')}（设置页据此在装载前展示可选项）`
      )
    }

    this.registry.registerLlm({
      manifest: { ...manifest, capabilities: { ...manifest.capabilities, providerTypes: declared } },
      llm: { kind: 'llm', providerTypes, createProvider: plugin.createProvider.bind(plugin) },
      source: 'local',
      path: dir,
      loaded: true,
      error: null,
    })
    report.loaded.push(manifest.id)
  }

  private registerParser(
    dir: string,
    manifest: PluginManifest,
    produced: any,
    report: PluginLoadReport,
    reject: (manifest: PluginManifest, kind: PluginKind | 'unknown', reason: string) => void
  ): void {
    const plugin = produced?.parser
    if (!plugin || typeof plugin.parse !== 'function') {
      return reject(manifest, manifest.kind, 'activate(host) 未返回可用的 parser（需要 { parser: { kind, extensions, parse } }）')
    }
    const declared = (manifest.capabilities?.extensions || []).map(normalizeExtension).filter(Boolean)
    const owned = (Array.isArray(plugin.extensions) ? plugin.extensions : []).map(normalizeExtension).filter(Boolean)
    const extensions = owned.length ? owned : declared
    if (!extensions.length) {
      return reject(manifest, manifest.kind, 'parser 未声明任何扩展名（capabilities.extensions 与 plugin.extensions 均为空）')
    }
    const fileTypes: Record<string, string> = { ...(manifest.capabilities?.fileTypes || {}) }
    for (const ext of extensions) if (!fileTypes[ext]) fileTypes[ext] = ext

    this.registry.register({
      manifest: { ...manifest, capabilities: { ...manifest.capabilities, extensions } },
      parser: { kind: 'parser', extensions, parse: plugin.parse.bind(plugin) },
      fileTypes,
      source: 'local',
      path: dir,
      loaded: true,
      error: null,
    })
    report.loaded.push(manifest.id)
  }

  private registerEmbedding(
    dir: string,
    manifest: PluginManifest,
    produced: any,
    report: PluginLoadReport,
    reject: (manifest: PluginManifest, kind: PluginKind | 'unknown', reason: string) => void
  ): void {
    const plugin = produced?.embedding
    if (!plugin || typeof plugin.embed !== 'function') {
      return reject(manifest, manifest.kind, 'activate(host) 未返回可用的 embedding（需要 { embedding: { kind, id, dimension, descriptor, embed } }）')
    }
    if (!plugin.descriptor || typeof plugin.descriptor.source !== 'string') {
      return reject(manifest, manifest.kind, 'embedding 必须声明 descriptor{quantized, source}（模型来源与是否量化）')
    }
    const id = String(plugin.id || manifest.capabilities?.modelId || manifest.id)
    if (id !== manifest.id) {
      return reject(manifest, manifest.kind, `embedding 的 id（${id}）必须与 manifest.id（${manifest.id}）一致：宿主用该值写 vectors.model 并拒绝跨模型混算`)
    }
    this.registry.register({
      manifest: {
        ...manifest,
        capabilities: {
          ...manifest.capabilities,
          modelId: id,
          dimension: Number(plugin.dimension) || 0,
          // 与内建插件同构：把 descriptor 摊到 capabilities，设置页才能统一展示来源/量化/备注
          quantized: !!plugin.descriptor.quantized,
          source: plugin.descriptor.source,
          ...(plugin.descriptor.note ? { note: plugin.descriptor.note } : {}),
        },
      },
      embedding: {
        kind: 'embedding',
        id,
        dimension: Number(plugin.dimension) || 0,
        descriptor: plugin.descriptor,
        embed: plugin.embed.bind(plugin),
        ...(typeof plugin.ensureReady === 'function' ? { ensureReady: plugin.ensureReady.bind(plugin) } : {}),
      },
      source: 'local',
      path: dir,
      loaded: true,
      error: null,
    })
    report.loaded.push(manifest.id)
  }
}
