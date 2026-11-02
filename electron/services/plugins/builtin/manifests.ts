/**
 * 内建插件清单工厂（ADR-005 D21）。
 *
 * 内建插件不落地到 `<Data>/plugins`，而是编译进宿主；但它们与本地插件**共用同一套 manifest 结构**
 * 与同一套注册接口——这正是「内建能力也走插件路径」的具体形态。
 */
import { HOST_API_VERSION, PluginManifest, PluginRuntime } from '../types'

/** 解析器插件清单（内建） */
export function builtinParserManifest(opts: {
  id: string
  name: string
  extensions: string[]
  description: string
  /**
   * `worker` 表示该解析是重活（OCR / 音视频 / PDF 渲染）。本轮宿主尚未接入 worker 池
   * （D13 属 S1），声明只用于设置页展示与后续调度，实际仍由解析队列在主进程内执行。
   */
  runtime?: PluginRuntime
}): PluginManifest {
  return {
    id: opts.id,
    name: opts.name,
    version: '1.0.0',
    apiVersion: HOST_API_VERSION,
    kind: 'parser',
    runtime: opts.runtime || 'inline',
    builtin: true,
    // 解析器必须读用户文件；内建解析器不需要联网（OCR/whisper 模型走 transformers.js 自身缓存）
    permissions: { fsRead: true, net: false, modelDownload: [] },
    capabilities: { extensions: opts.extensions },
    description: opts.description,
  }
}

/**
 * 模型接入插件清单（内建，ADR-006）。
 *
 * 与前两类不同：这个插件的清单里**没有端点、没有密钥、没有厂商 SDK**，只声明
 * 「我能把哪种 provider 配置变成 LlmProvider」。没有用户配置时它不注册 provider、不发起请求，
 * 所以「内建插件存在」并不等于「已接入模型」——模型接入默认是关闭的。
 *
 * `modelDownload` 留空是有意的：模型接入的目标域名由用户配置，写不进清单白名单，
 * 联网边界改由宿主的出口守卫（`gateway/egress.ts`）按端点逐次校验。
 */
export function builtinLlmManifest(opts: {
  id: string
  name: string
  /** 该插件覆盖的 provider 类型（装载前设置页据此展示可选项） */
  providerTypes: string[]
  description: string
  /** 占位插件（如「托管模型」）声明 false：它不联网，因为还没有实现 */
  net?: boolean
}): PluginManifest {
  return {
    id: opts.id,
    name: opts.name,
    version: '1.0.0',
    apiVersion: HOST_API_VERSION,
    kind: 'llm',
    runtime: 'inline',
    builtin: true,
    permissions: { fsRead: false, net: opts.net !== false, modelDownload: [] },
    capabilities: { providerTypes: opts.providerTypes },
    description: opts.description,
  }
}

/** 嵌入模型插件清单（内建） */
export function builtinEmbeddingManifest(opts: {
  id: string
  name: string
  dimension: number
  description: string
  /** 允许下载的模型地址白名单（net 为 true 时必填，拒绝「允许任意联网」） */
  modelDownload: string[]
  /** 是否量化、模型来源与备选标注：随 capabilities 一起暴露给设置页展示（只增字段） */
  descriptor: { quantized: boolean; source: string; note?: string }
}): PluginManifest {
  return {
    id: opts.id,
    name: opts.name,
    version: '1.0.0',
    apiVersion: HOST_API_VERSION,
    kind: 'embedding',
    // 模型类插件天然是 worker（形态同 D13「每 worker 一个模型实例」）；本轮仍内联执行
    runtime: 'worker',
    builtin: true,
    permissions: { fsRead: false, net: true, modelDownload: opts.modelDownload },
    capabilities: {
      modelId: opts.id,
      dimension: opts.dimension,
      quantized: opts.descriptor.quantized,
      source: opts.descriptor.source,
      ...(opts.descriptor.note ? { note: opts.descriptor.note } : {}),
    },
    description: opts.description,
  }
}
