/**
 * 插件注册表（ADR-005 §4.4）。
 *
 * 两条原则落在本文件里：
 * 1. **吃自己的狗粮（D21）**：内建解析器 / 内建嵌入模型也走 `registerParser` / `registerEmbedding`，
 *    核心只认注册表，不认「哪些 id 是内建」——所以停用内建插件同样会让对应能力消失；
 * 2. **失败只记状态、不带崩宿主（D23）**：插件调用抛错时记 `error` 并把原错误继续抛给调用方
 *    （调用方据此把文档标 failed），宿主进程与其它插件不受影响。
 */
import { PerfRecorder } from '../perfLogger'
import {
  ChunkAnchor,
  EmbeddingPlugin,
  ParserParseResult,
  ParserPlugin,
  PluginCapabilities,
  PluginKind,
  PluginManifest,
  PluginPermissions,
  PluginRuntime,
  PluginSource,
  PluginStatus,
} from './types'

/** 注册入参：manifest 是唯一必需的声明，实现按 kind 二选一 */
export interface PluginRegisterInput {
  manifest: PluginManifest
  parser?: ParserPlugin
  embedding?: EmbeddingPlugin
  /** 解析器：扩展名 → documents.file_type（缺省时取扩展名自身） */
  fileTypes?: Record<string, string>
  source?: PluginSource
  path?: string
  loaded?: boolean
  error?: string | null
  /** 覆盖 kind（仅用于清单缺字段的失败登记：`'unknown'`） */
  kind?: PluginKind | 'unknown'
}

interface PluginEntry {
  manifest: PluginManifest
  kind: PluginKind | 'unknown'
  parser?: ParserPlugin
  embedding?: EmbeddingPlugin
  fileTypes: Record<string, string>
  source: PluginSource
  path?: string
  enabled: boolean
  loaded: boolean
  error: string | null
}

/** 解析器注册入参（扩展名 → file_type 的映射由调用方给出，缺省时取扩展名自身） */
export interface ParserRegisterInput extends Omit<PluginRegisterInput, 'embedding' | 'parser'> {
  parser: ParserPlugin
}

/** 嵌入模型注册入参 */
export interface EmbeddingRegisterInput extends Omit<PluginRegisterInput, 'embedding' | 'parser'> {
  embedding: EmbeddingPlugin
}

/** 解析器查询结果：带上 `enabled`，让调用方能区分「没有这个格式」与「有这个格式但插件被停用」 */
export interface ParserResolution {
  id: string
  name: string
  enabled: boolean
  plugin?: ParserPlugin
}

export class PluginRegistry {
  private entries = new Map<string, PluginEntry>()
  /**
   * 被显式停用的插件 id。
   *
   * 单独记一份的理由：启停状态没有落库（本轮不动表结构），但重新扫描目录 / 同一进程内重复装配
   * 都会重新 register，若只看「上一次的 entry.enabled」会在 clearLocal 后丢掉停用状态。
   * 用集合记住「用户明确停用过哪些」，重扫后仍是停用状态，不会被悄悄打开。
   */
  private disabled = new Set<string>()
  /** 扩展名 → file_type 的派生缓存（注册 / 启停时失效） */
  private fileTypeCache: Record<string, string> | null = null

  /** 注册（内建插件由 ProcessingEngine 装配，本地插件由 PluginLoader 校验后登记） */
  register(input: PluginRegisterInput): PluginStatus {
    const entry: PluginEntry = {
      manifest: input.manifest,
      kind: input.kind ?? input.manifest.kind,
      parser: input.parser,
      embedding: input.embedding,
      fileTypes: input.fileTypes || this.deriveFileTypes(input.manifest),
      source: input.source || (input.manifest.builtin ? 'builtin' : 'local'),
      path: input.path,
      // 默认启用；用户显式停用过的保持停用（重新扫描不会把它打开）
      enabled: input.loaded !== false && !this.disabled.has(input.manifest.id),
      loaded: input.loaded !== false,
      error: input.error ?? null,
    }
    this.entries.set(entry.manifest.id, entry)
    this.invalidate()
    return this.toStatus(entry)
  }

  /** 注册解析器插件（内建装配与本地装载走同一入口） */
  registerParser(input: ParserRegisterInput): PluginStatus {
    return this.register(input)
  }

  /** 注册嵌入模型插件（内建装配与本地装载走同一入口） */
  registerEmbedding(input: EmbeddingRegisterInput): PluginStatus {
    return this.register(input)
  }

  /** 扩展名 → file_type：manifest 未显式声明时退化为「扩展名即类型」 */
  private deriveFileTypes(manifest: PluginManifest): Record<string, string> {
    const declared = manifest.capabilities?.fileTypes
    const map: Record<string, string> = {}
    for (const ext of manifest.capabilities?.extensions || []) {
      const key = String(ext).toLowerCase().replace(/^\./, '')
      if (!key) continue
      map[key] = declared?.[key] || declared?.[ext] || key
    }
    return map
  }

  private invalidate(): void {
    this.fileTypeCache = null
  }

  private toStatus(entry: PluginEntry): PluginStatus {
    return {
      id: entry.manifest.id,
      name: entry.manifest.name,
      version: entry.manifest.version,
      apiVersion: entry.manifest.apiVersion,
      kind: entry.kind,
      runtime: entry.manifest.runtime,
      builtin: entry.source === 'builtin',
      source: entry.source,
      enabled: entry.enabled,
      loaded: entry.loaded,
      error: entry.error,
      permissions: entry.manifest.permissions || {},
      capabilities: entry.manifest.capabilities || {},
      fileTypes: entry.fileTypes,
      description: entry.manifest.description,
      entry: entry.manifest.entry,
      path: entry.path,
    }
  }

  list(): PluginStatus[] {
    return Array.from(this.entries.values())
      .map(e => this.toStatus(e))
      // 内建在前、本地在后，组内按 id 稳定排序，便于设置页与快照对比
      .sort((a, b) => (a.builtin === b.builtin ? a.id.localeCompare(b.id) : a.builtin ? -1 : 1))
  }

  status(id: string): PluginStatus | null {
    const entry = this.entries.get(id)
    return entry ? this.toStatus(entry) : null
  }

  /** 清空本地插件（重新扫描前调用；内建插件不受影响） */
  clearLocal(): void {
    for (const [id, entry] of Array.from(this.entries.entries())) {
      if (entry.source === 'local') this.entries.delete(id)
    }
    this.invalidate()
  }

  enable(id: string): PluginStatus {
    const entry = this.require(id)
    if (!entry.loaded) throw new Error(`「${entry.manifest.name}」加载失败，无法启用：${entry.error || '原因未知'}`)
    this.disabled.delete(id)
    entry.enabled = true
    this.invalidate()
    return this.toStatus(entry)
  }

  disable(id: string): PluginStatus {
    const entry = this.require(id)
    // 内建插件允许停用（停用即该能力消失），但宿主不提供卸载入口（ADR-005 D27）
    this.disabled.add(id)
    entry.enabled = false
    this.invalidate()
    return this.toStatus(entry)
  }

  /** 已登记插件的来源与目录（装载器判断「同一目录的重复扫描」用，避免误报 id 冲突） */
  describeRegistration(id: string): { source: PluginSource; path?: string } | null {
    const entry = this.entries.get(id)
    return entry ? { source: entry.source, path: entry.path } : null
  }

  /** 记录某插件最近一次调用失败原因（D23：失败在 UI 可见，不带崩宿主） */
  noteError(id: string, reason: string): void {
    const entry = this.entries.get(id)
    if (entry) entry.error = reason
  }

  clearError(id: string): void {
    const entry = this.entries.get(id)
    if (entry && !entry.loaded) return
    if (entry) entry.error = null
  }

  private require(id: string): PluginEntry {
    const entry = this.entries.get(id)
    if (!entry) throw new Error(`插件不存在：${id}`)
    return entry
  }

  /** 已启用解析器声明的扩展名集合（fileService 据此派生「支持哪些格式」） */
  parserExtensions(): string[] {
    return Object.keys(this.fileTypeMap())
  }

  /** 扩展名 → file_type：只统计**已启用**的解析器插件 */
  fileTypeMap(): Record<string, string> {
    if (this.fileTypeCache) return this.fileTypeCache
    const map: Record<string, string> = {}
    for (const entry of this.entries.values()) {
      if (entry.kind !== 'parser' || !entry.enabled || !entry.loaded) continue
      for (const [ext, fileType] of Object.entries(entry.fileTypes)) map[ext] = fileType
    }
    this.fileTypeCache = map
    return map
  }

  /**
   * 按 `documents.file_type` 找解析器。
   *
   * 注意这里**不按 enabled 过滤**：停用的插件仍要能被找到，调用方才说得清
   * 「pptx 不是不支持，而是 sd.parser.pptx 被停用了」。
   */
  resolveParser(fileType: string): ParserResolution | null {
    const type = String(fileType || '').toLowerCase()
    if (!type) return null
    for (const entry of this.entries.values()) {
      if (entry.kind !== 'parser' || !entry.parser) continue
      if (Object.values(entry.fileTypes).includes(type)) {
        return { id: entry.manifest.id, name: entry.manifest.name, enabled: entry.enabled, plugin: entry.parser }
      }
    }
    return null
  }

  /**
   * 解析分发（注册表是唯一入口）。
   *
   * 三种情形分别处理：
   * - 没有插件认领该 file_type → 返回空文本（与改造前 `default: { text: '' }` 行为一致，由调用方判失败）；
   * - 有插件但被停用 → 抛可读错误（让文档以「插件已停用」失败，而不是静默空文本）；
   * - 有插件且启用 → 调用插件，**抛错时记状态并把错误原样上抛**（调用方标 failed，宿主不崩）。
   */
  async parse(
    filePath: string,
    fileType: string,
    settings: Readonly<Record<string, string>>,
    perf?: PerfRecorder | null
  ): Promise<ParserParseResult> {
    const target = this.resolveParser(fileType)
    if (!target) return { text: '', anchors: [] }
    if (!target.enabled || !target.plugin) {
      throw new Error(`「${target.name}」已停用，暂不支持 ${fileType} 格式（可在 设置 → 扩展 中启用）`)
    }
    try {
      const out = await target.plugin.parse({ filePath, fileType, settings, perf })
      this.clearError(target.id)
      return {
        text: String(out?.text ?? ''),
        anchors: Array.isArray(out?.anchors) ? (out.anchors as ChunkAnchor[]) : [],
        metadata: out?.metadata || {},
        thumbnailPath: out?.thumbnailPath ?? null,
      }
    } catch (e: any) {
      const reason = e?.message || String(e)
      this.noteError(target.id, reason)
      throw e
    }
  }

  /** 已启用的嵌入模型插件（宿主取模型 / 设置页下拉的取值来源） */
  embeddingPlugins(): EmbeddingPlugin[] {
    const out: EmbeddingPlugin[] = []
    for (const entry of this.entries.values()) {
      if (entry.kind === 'embedding' && entry.enabled && entry.loaded && entry.embedding) out.push(entry.embedding)
    }
    return out
  }

  /** 按 id（= vectors.model 写入值）取嵌入模型插件 */
  getEmbedding(id: string): EmbeddingPlugin | undefined {
    const entry = this.entries.get(String(id))
    if (!entry || entry.kind !== 'embedding' || !entry.enabled || !entry.loaded) return undefined
    return entry.embedding
  }
}

/** 进程内唯一注册表：宿主服务层（ProcessingEngine / FileService / RPC 方法表）共用同一个实例 */
export const pluginRegistry = new PluginRegistry()

/** 便于测试与诊断：把一个显式构造的 manifest 规范化成状态里的权限字段 */
export function normalizePermissions(permissions?: PluginPermissions): PluginPermissions {
  return { fsRead: !!permissions?.fsRead, net: !!permissions?.net, modelDownload: permissions?.modelDownload || [] }
}

/** 运行时声明校验用的小工具（loader 与注册表共用同一口径） */
export function normalizeRuntime(runtime: unknown): PluginRuntime {
  return runtime === 'worker' ? 'worker' : 'inline'
}

export function normalizeCapabilities(capabilities?: PluginCapabilities): PluginCapabilities {
  return {
    extensions: Array.isArray(capabilities?.extensions) ? capabilities!.extensions!.map(String) : [],
    ...(capabilities?.fileTypes ? { fileTypes: capabilities.fileTypes } : {}),
    ...(capabilities?.modelId ? { modelId: String(capabilities.modelId) } : {}),
    ...(capabilities?.dimension != null ? { dimension: Number(capabilities.dimension) } : {}),
  }
}
