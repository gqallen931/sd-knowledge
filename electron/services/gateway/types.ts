/**
 * LLM 网关的共享类型（ADR-003 决策 5：本阶段只定接口不实现）。
 *
 * 这里刻意对齐 OpenAI Chat Completions 的语义（messages / tools / usage），
 * 因为绝大多数本地推理服务（Ollama、vLLM、LM Studio）都提供 OpenAI 兼容端点：
 * 以后接哪一家，都只是写一个实现 LlmProvider 的适配器，不动上层调用方。
 */

export type LlmRole = 'system' | 'user' | 'assistant' | 'tool'

export interface LlmMessage {
  role: LlmRole
  content: string
  /** role = 'tool' 时标识是哪个工具调用的返回 */
  toolCallId?: string
  name?: string
}

/** 工具声明，parameters 用 JSON Schema 描述（与 MCP 的 inputSchema 同构） */
export interface LlmToolSpec {
  name: string
  description: string
  parameters: Record<string, unknown>
}

export interface LlmToolCall {
  id: string
  name: string
  /** 模型原始输出的 JSON 字符串，解析交给调用方（模型可能吐出不合法 JSON） */
  arguments: string
}

export interface LlmRequest {
  messages: LlmMessage[]
  tools?: LlmToolSpec[]
  temperature?: number
  maxTokens?: number
  /** 请求方标识，便于按来源做限流或计费 */
  requester?: string
  /**
   * 取消信号（S1-01）：流式/非流式共用。用户点「停止」时上层 abort 即可。
   * 归属 LLM 层而非 provider 私有字段，是为了让网关能统一处理取消与超时的区分。
   */
  signal?: AbortSignal
  /**
   * 本次实际送入模型的上下文出处（S1-03 组装后填充）。
   * 出域闸门（S1-02 的 §5.1.4）据此判断「送出的块是否全部落在授权范围内」。
   */
  citations?: LlmCitationRef[]
  /**
   * 本次请求**声明的出域范围**（S1-02）。缺省时闸门按最小档 `current_document` 处理。
   * 之所以由请求方声明而非闸门猜测：出域是「用户这次想送多远」，只有调用方知道。
   */
  egress?: LlmEgressRequest
}

/**
 * 出域范围的三个档位（S1-02，架构文档 §5.1.4）。
 *
 * - `current_document`：仅当前文档的命中块（**默认档**，ADR-004/D5 的硬约束）
 * - `selected_scope` ：当前作用域（项目 / 文件夹 / 标签 / 来源）内的命中块
 * - `whole_library`  ：整库（必须由用户显式开启，设置页给出明确风险提示）
 */
export type EgressScopeMode = 'current_document' | 'selected_scope' | 'whole_library'

/** 出域范围由宽到窄的秩：声明范围必须 ≤ 策略允许范围才放行 */
export const EGRESS_SCOPE_RANK: Record<EgressScopeMode, number> = {
  current_document: 1,
  selected_scope: 2,
  whole_library: 3,
}

/** 本次请求声明的出域范围明细（供闸门逐条校验块是否落在范围内） */
export interface LlmEgressRequest {
  scope?: EgressScopeMode
  /** `current_document` 档：本次允许出域的文档 id（通常只有一个） */
  document_ids?: number[]
  /** `selected_scope` 档：当前作用域过滤（source_id / folder_path / project_id / unassigned） */
  scope_filter?: {
    source_id?: number | string | null
    folder_path?: string | null
    project_id?: number | string | null
    unassigned?: boolean
    document_ids?: number[]
  }
}

/** 一条送入上下文的最小出处引用：只带定位 id，不复制正文 */
export interface LlmCitationRef {
  document_id: number
  chunk_id?: number | null
}

export interface LlmUsage {
  promptTokens: number
  completionTokens: number
  totalTokens: number
}

export type LlmFinishReason = 'stop' | 'length' | 'tool_calls' | 'error'

export interface LlmResponse {
  model: string
  content: string
  toolCalls: LlmToolCall[]
  usage: LlmUsage | null
  finishReason: LlmFinishReason
  /** 流式调用时按序到达的增量片段（非流式为空数组） */
  chunks?: string[]
}

/**
 * provider 类型（ADR-004 决策 1）。
 *
 * 三类共用同一份 `LlmProvider` 接口与同一套 chat/stream 调用路径，
 * 差别只在 base_url 与「是否需要用户密钥」。`hosted` 本轮只注册契约。
 */
export type LlmProviderKind = 'byo-openai' | 'local-openai' | 'hosted'

export interface LlmProvider {
  readonly id: string
  readonly label: string
  readonly model: string
  /** 类型：出域审计按类型区分「是否数据出域」（本地端点不计入，但仍留痕自查） */
  readonly kind?: LlmProviderKind
  /** 实际端点：出域审计需要记录「送到哪里」，因此单独暴露 */
  readonly baseUrl?: string
  /** 当前是否可用：密钥已配置 / 本地服务在线。网关据此决定是否直接抛错 */
  available(): boolean
  chat(request: LlmRequest): Promise<LlmResponse>
  /** 可选：不支持流式的 provider 可以不实现 */
  stream?(request: LlmRequest, onChunk: (chunk: string) => void): Promise<LlmResponse>
  /** 可选：连通性/模型清单探测（「一键检测」用）。失败时应抛结构化错误而非返回空数组 */
  listModels?(): Promise<string[]>
}

export interface LlmGatewayStatus {
  configured: boolean
  providerId: string | null
  label: string
  model: string
  /** 未接入时给出可读原因，前端据此展示「尚未接入大语言模型」而不是空白 */
  reason: string
}

/**
 * 出域检查钩子（S1-01 预留，S1-02 落地为「范围闸门 + 审计」）。
 *
 * 网关在**真正发起外部调用之前**必须经过 `check()`；调用结束（无论成败）走 `record()`。
 * S1-02 的默认实现（`gateway/egress.ts::createEgressGuard`）语义：
 * - `check()`：按「本次声明的范围（`egressScope`）≤ provider 策略允许的范围」判定；
 *   超范围则**拒绝**（写一条 `status='refused'` 的 `llm_egress_logs` + 审计后抛出可读错误），
 *   **不静默截断、不静默扩权**；放行时写一条意图审计。
 * - `record()`：调用收尾写一条 `llm_egress_logs`（只记 id 与长度，**绝不记正文与密钥**）。
 *
 * 因此 `check()` 的实现允许抛出结构化错误（拒绝时），网关会原样向上传播。
 */
export interface LlmEgressContext {
  providerId: string
  kind: LlmProviderKind
  model: string
  baseUrl: string
  /** 本次实际要送出的消息（含 S1-03 组装的上下文） */
  messages: LlmMessage[]
  /** 本次实际送入的上下文出处 */
  citations: LlmCitationRef[]
  /** 本次声明的出域范围（缺省 = current_document，最小档） */
  egressScope?: EgressScopeMode
  /** current_document 档允许的文档 id */
  documentIds?: number[]
  /** selected_scope 档的作用域过滤 */
  scopeFilter?: LlmEgressRequest['scope_filter']
  /** 触发者：人（用户）/ 机器（apiKey）/ 系统 */
  actor?: string
}

export interface LlmEgressOutcome {
  status: 'ok' | 'error' | 'timeout' | 'refused'
  errorCode?: string
  promptChars: number
  completionChars: number
  latencyMs: number
}

export interface LlmEgressGuard {
  /** 出域前检查：返回 false 表示拒绝（网关抛 FORBIDDEN）。实现不得吞掉/掩盖调用本身 */
  check(context: LlmEgressContext): Promise<boolean> | boolean
  /** 调用收尾写审计。实现内部必须自吞异常，不得影响主流程 */
  record(context: LlmEgressContext, outcome: LlmEgressOutcome): void
}

/** `llm.test` 的返回：连通性 + 极短 prompt 实测（供 UI 展示成功/失败与耗时） */
export interface LlmTestResult {
  ok: boolean
  providerId: string
  kind: LlmProviderKind
  model: string
  latencyMs: number
  /** 探测到的可用模型清单（本地端点可能不支持 /models，为空数组不算失败） */
  models: string[]
  /** 极短 prompt 的模型回显（截断展示） */
  echo: string | null
  error: { code: string; message: string } | null
}
