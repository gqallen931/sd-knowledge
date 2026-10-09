/**
 * 插件契约（ADR-005 §4）。
 *
 * 这里的类型是**对外契约**：本地插件（`<Data>/plugins/*`）与内建插件（编译进宿主）共用同一套。
 * 按 D25，扩展 API 只能加字段、不能改语义；破坏性变更必须提升 `apiVersion`。
 */
import type { PerfRecorder } from '../perfLogger'

/** 宿主当前实现的扩展 API 版本；manifest 声明与之不匹配即拒绝加载（D25 兼容表） */
export const HOST_API_VERSION = 1
/** 宿主兼容的扩展 API 版本清单（当前只支持 1，不做「尽力兼容」的猜测） */
export const SUPPORTED_API_VERSIONS: readonly number[] = [HOST_API_VERSION]

/** 扩展点类型：首批实现 parser / embedding，其余三类只放类型（D22 分两批） */
export type PluginKind = 'parser' | 'embedding' | 'rerank' | 'method' | 'panel'
/** 插件声明的调度方式（D24：宿主按声明派到 worker 池，本轮不引入进程隔离） */
export type PluginRuntime = 'inline' | 'worker'
/** 插件来源：内建（编译进宿主，不可卸载）/ 本地（`<Data>/plugins` 下的目录） */
export type PluginSource = 'builtin' | 'local'

/**
 * 权限声明。
 *
 * **当前强制手段只有「声明 + 校验 + 在设置页展示」**——宿主不向插件发放任何文件系统 / 网络能力
 * （见 host.ts）：声明了 `fsRead` 也不会拿到 fs 句柄，声明了 `net` 也不会拿到 fetch。
 * 未声明的权限在本轮等同于「不声明即拒绝」的语义占位，等进程隔离落地后才谈真正的沙箱。
 */
export interface PluginPermissions {
  /** 读取用户文件（解析器必需；未声明时该插件被拒绝加载） */
  fsRead?: boolean
  /** 联网（模型下载等）；默认 false，即「默认不联网」 */
  net?: boolean
  /** 允许下载的模型地址白名单；`net: true` 时必须非空，否则拒绝加载（M：不允许「允许任意联网」） */
  modelDownload?: string[]
}

/** 能力声明：parser 声明扩展名，embedding 声明模型标识与维度 */
export interface PluginCapabilities {
  /** parser：能处理的扩展名（小写、不含点） */
  extensions?: string[]
  /** parser（内建补充）：扩展名 → documents.file_type；缺省时取扩展名自身 */
  fileTypes?: Record<string, string>
  /** embedding：模型标识（应与插件 id 一致） */
  modelId?: string
  /** embedding：向量维度（用于设置页展示；实际维度以推理输出为准） */
  dimension?: number
  [key: string]: unknown
}

/** manifest.json（ADR-005 §4.2）与内建插件清单共用同一结构 */
export interface PluginManifest {
  /** 唯一标识，建议反向域名，如 `sd.parser.pptx`；embedding 插件的 id 必须与 vectors.model 写入值一致 */
  id: string
  /** 显示名（设置页展示） */
  name: string
  version: string
  /** 宿主扩展 API 版本 */
  apiVersion: number
  kind: PluginKind
  runtime: PluginRuntime
  /** 内建插件为 true（编译进宿主，UI 上不可卸载） */
  builtin: boolean
  permissions?: PluginPermissions
  capabilities?: PluginCapabilities
  /** 本地插件入口（CommonJS），如 `index.js` */
  entry?: string
  description?: string
}

/** 块级溯源锚点（D8）：解析结果必须尽量给出锚点 */
export type ChunkAnchorKind = 'page' | 'slide' | 'chapter' | 'sheet' | 'time'

export interface ChunkAnchor {
  kind: ChunkAnchorKind
  /** 锚点值：页码 / 幻灯片序 / 章节序 / 工作表序 / 时间（秒） */
  value: number | string
  /** 在返回文本中的起止偏移（字符）；解析器能给出时必须给 */
  start?: number
  end?: number
  /**
   * 音视频锚点的**结束时间（秒）**，仅 `kind='time'` 使用（D8：段落级时间范围）。
   * 只增字段，不影响既有字段语义（ADR-005 D25）；缺省时视为与 `value` 相同的瞬时点。
   */
  timeEnd?: number
}

export interface ParserParseInput {
  filePath: string
  /** documents.file_type（由宿主按扩展名判定后传入） */
  fileType: string
  settings: Readonly<Record<string, string>>
  /**
   * 性能采集钩子：**仅供宿主内建解析器**使用（分阶段耗时），第三方插件可忽略。
   * 按 D25 属「只增字段」，不影响既有契约。
   */
  perf?: PerfRecorder | null
}

export interface ParserParseResult {
  text: string
  /** 给不出锚点的格式返回空数组，不编造 */
  anchors?: ChunkAnchor[]
  metadata?: Record<string, unknown>
  thumbnailPath?: string | null
}

/** ① 解析器插件（ADR-005 §4.3） */
export interface ParserPlugin {
  kind: 'parser'
  /** 声明处理的扩展名（小写，不含点） */
  extensions: string[]
  parse(input: ParserParseInput): Promise<ParserParseResult>
}

/** 嵌入模型描述（设置页展示 + 下载白名单校验依据） */
export interface EmbeddingDescriptor {
  quantized: boolean
  /** 模型来源，如 `transformers.js · HuggingFace Hub` */
  source: string
  /** 备选模型标注（设置页展示）：例如「备选模型，未随默认路径实测」 */
  note?: string
}

/** ② 嵌入模型插件（ADR-005 §4.3） */
export interface EmbeddingPlugin {
  kind: 'embedding'
  /** 必须与写入 vectors.model 的值一致（宿主据此拒绝跨模型混算） */
  id: string
  dimension: number
  descriptor: EmbeddingDescriptor
  /**
   * 向量化：入参为逐条文本，返回与入参等长的向量（批量推理不可用时返回空数组，由宿主回退逐条）。
   */
  embed(texts: string[]): Promise<Float32Array[]>
  /**
   * 可选：宿主用它把「加载模型」与「推理」的耗时分开（内建插件实现；第三方可不实现）。
   * 缺失时模型加载成本会落在首次 `embed` 里。
   */
  ensureReady?(): Promise<void>
}

/**
 * 插件状态（设置页与技术出口共用）。
 *
 * `kind` 允许 `'unknown'`：本地插件清单缺字段 / 版本不匹配时，宿主仍登记一条失败状态，
 * 让「某个插件失效」在 UI 上可见（D23），而不是静默消失。
 */
export interface PluginStatus {
  id: string
  name: string
  version: string
  /** 声明的宿主 API 版本；清单缺字段时为 0 */
  apiVersion: number
  kind: PluginKind | 'unknown'
  runtime: PluginRuntime
  builtin: boolean
  source: PluginSource
  enabled: boolean
  /** 是否已成功装载（解析器/模型实现可用） */
  loaded: boolean
  /** 可读的失败原因（加载失败 / apiVersion 不匹配 / 缺字段 / 调用抛错），成功时为 null */
  error: string | null
  permissions: PluginPermissions
  capabilities: PluginCapabilities
  /** 扩展名 → 库内 file_type 的解析后映射（png→image、js→code）；供界面按类型筛选 */
  fileTypes?: Record<string, string>
  description?: string
  entry?: string
  /** 本地插件目录（内建插件为空） */
  path?: string
}
