/**
 * LLM 网关的结构化错误（S1-01）。
 *
 * 为什么要单独一个错误类型：上游是 HTTP 服务，失败原因（密钥错 / 模型名错 / 限流 / 上游故障 /
 * 连不上）语义完全不同，但都会表现为「fetch 抛了个错」。把判定收敛到 provider 一处，
 * 用 `code` 而不是靠 message 字符串，才能让 IPC / REST / MCP 三种出口稳定地把它翻译成
 * 「未配置 / 限流 / 不可用」，并且**任何出口都不会把原始堆栈或上游报文丢给界面**。
 *
 * code 取值对齐架构文档 §4.2 的 `SdErrorCode`（NOT_CONFIGURED / RATE_LIMITED / UNAVAILABLE /
 * INVALID_ARGUMENT / NOT_IMPLEMENTED / FORBIDDEN），额外补一个 CANCELLED 区分「用户主动取消」。
 */
export type LlmErrorCode =
  | 'NOT_CONFIGURED'
  | 'RATE_LIMITED'
  | 'UNAVAILABLE'
  | 'INVALID_ARGUMENT'
  | 'NOT_IMPLEMENTED'
  | 'FORBIDDEN'
  | 'CANCELLED'

export class LlmRequestError extends Error {
  readonly code: LlmErrorCode
  /** 上游 HTTP 状态码（网络层失败时为 undefined） */
  readonly httpStatus?: number
  /** 429 时上游给出的 Retry-After（毫秒），供退避使用 */
  readonly retryAfterMs?: number

  constructor(code: LlmErrorCode, message: string, options: { httpStatus?: number; retryAfterMs?: number } = {}) {
    super(message)
    this.name = 'LlmRequestError'
    this.code = code
    this.httpStatus = options.httpStatus
    this.retryAfterMs = options.retryAfterMs
  }
}
