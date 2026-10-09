import { LlmFinishReason, LlmProvider, LlmProviderKind, LlmRequest, LlmResponse, LlmToolCall, LlmUsage } from './types'
import { LlmRequestError } from './errors'

/**
 * OpenAI 兼容 provider（S1-01，架构文档 §5.1）。
 *
 * 一个类覆盖 ADR-004 的两类「本轮实现」：`byo-openai`（自带 key）与 `local-openai`
 * （本地端点，key 可选）——两者协议完全相同，差别只在 base_url 与是否需要 key。
 * `hosted` 不在此实现（只注册契约，见 llmService）。
 *
 * 只依赖 Node 18+ 内置的 `fetch` + `ReadableStream`，**不引入任何新依赖**。
 * 非流式与流式共用同一套错误映射、同一套超时与取消策略（见各自注释）。
 */

/** 流式空闲超时：收到首个字节后，若 30s 内再无任何 SSE 行则判定卡死并中止 */
const STREAM_IDLE_TIMEOUT_MS = 30_000
const DEFAULT_TIMEOUT_MS = 60_000

export interface OpenAiProviderConfig {
  id: string
  kind: LlmProviderKind
  label: string
  /** 必含 `/v1`（例：https://api.openai.com/v1、http://127.0.0.1:11434/v1） */
  baseUrl: string
  model: string
  apiKey?: string | null
  timeoutMs?: number
  maxRetries?: number
  temperature?: number
  maxTokens?: number
}

/**
 * 把外部取消信号与超时合成为一个 AbortSignal。
 *
 * `isTimeout()` 用来在 catch 里区分「超时」与「用户取消」——两者都会让 fetch 抛 AbortError，
 * 但给用户的提示完全不同（超时=端点慢；取消=用户自己点的停止）。
 */
function linkSignal(external: AbortSignal | undefined, timeoutMs: number) {
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => { timedOut = true; controller.abort() }, timeoutMs)
  const onExternalAbort = () => controller.abort()
  if (external) {
    if (external.aborted) controller.abort()
    else external.addEventListener('abort', onExternalAbort, { once: true })
  }
  return {
    signal: controller.signal,
    isTimeout: () => timedOut,
    cleanup: () => {
      clearTimeout(timer)
      if (external) external.removeEventListener('abort', onExternalAbort)
    },
  }
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new LlmRequestError('CANCELLED', '请求已取消')) }, { once: true })
  })
}

function normalizeFinish(reason: string | null | undefined): LlmFinishReason {
  if (reason === 'length') return 'length'
  if (reason === 'tool_calls') return 'tool_calls'
  if (reason === 'stop') return 'stop'
  return reason ? 'stop' : 'stop'
}

function normalizeUsage(usage: any): LlmUsage | null {
  if (!usage) return null
  return {
    promptTokens: Number(usage.prompt_tokens ?? 0),
    completionTokens: Number(usage.completion_tokens ?? 0),
    totalTokens: Number(usage.total_tokens ?? 0),
  }
}

function parseToolCalls(raw: any): LlmToolCall[] {
  if (!Array.isArray(raw)) return []
  return raw
    .filter(c => c?.function?.name)
    .map((c, i) => ({ id: String(c.id || `call_${i}`), name: String(c.function.name), arguments: String(c.function.arguments ?? '') }))
}

export class OpenAiCompatibleProvider implements LlmProvider {
  readonly id: string
  readonly label: string
  readonly model: string
  readonly kind: LlmProviderKind
  readonly baseUrl: string
  private apiKey: string | null
  private timeoutMs: number
  private maxRetries: number
  private temperature?: number
  private maxTokens?: number

  constructor(config: OpenAiProviderConfig) {
    this.id = config.id
    this.kind = config.kind
    this.label = config.label
    this.baseUrl = String(config.baseUrl || '').replace(/\/+$/, '')
    this.model = config.model
    this.apiKey = config.apiKey ? String(config.apiKey) : null
    this.timeoutMs = Number(config.timeoutMs) > 0 ? Number(config.timeoutMs) : DEFAULT_TIMEOUT_MS
    this.maxRetries = Math.max(0, Number(config.maxRetries) || 0)
    this.temperature = config.temperature
    this.maxTokens = config.maxTokens
  }

  /** 三类差异的收敛点：本地端点不需要 key；`hosted` 本轮永不可用 */
  available(): boolean {
    if (this.kind === 'hosted') return false
    return Boolean(this.baseUrl && this.model)
  }

  /** 连通性探测：GET {base}/models（「一键检测」用） */
  async listModels(): Promise<string[]> {
    const link = linkSignal(undefined, this.timeoutMs)
    try {
      const res = await fetch(`${this.baseUrl}/models`, { method: 'GET', headers: this.headers(), signal: link.signal })
      if (!res.ok) throw this.httpError(res.status, res.headers.get('retry-after'))
      const json: any = await res.json()
      const data = json?.data
      return Array.isArray(data) ? data.map((d: any) => String(d?.id || '')).filter(Boolean) : []
    } catch (error) {
      throw this.normalizeError(error, link)
    } finally {
      link.cleanup()
    }
  }

  /**
   * 非流式对话。
   *
   * 重试策略（架构文档 §5.1.6）：仅对 5xx / 网络错误 / 429 重试，指数退避 1s / 3s；
   * 4xx（除 429）与取消不重试。默认 `maxRetries=0`（保守），可由配置开启。
   */
  async chat(request: LlmRequest): Promise<LlmResponse> {
    const attempts = this.maxRetries + 1
    let lastError: unknown
    for (let i = 0; i < attempts; i++) {
      try {
        return await this.chatOnce(request)
      } catch (error) {
        lastError = error
        const retriable = error instanceof LlmRequestError && (error.code === 'UNAVAILABLE' || error.code === 'RATE_LIMITED')
        if (!retriable || i === attempts - 1) throw error
        await delay((error as LlmRequestError).retryAfterMs ?? (i === 0 ? 1000 : 3000), request.signal)
      }
    }
    throw lastError
  }

  private async chatOnce(request: LlmRequest): Promise<LlmResponse> {
    const link = linkSignal(request.signal, this.timeoutMs)
    try {
      const res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(this.buildBody(request, false)),
        signal: link.signal,
      })
      if (!res.ok) throw this.httpError(res.status, res.headers.get('retry-after'))
      const json: any = await res.json()
      return this.parseChatResponse(json)
    } catch (error) {
      throw this.normalizeError(error, link)
    } finally {
      link.cleanup()
    }
  }

  /**
   * 流式对话（SSE）。
   *
   * 逐行解析 `data: {json}`，末帧 `data: [DONE]`。三个关键点：
   * 1. 不做整包缓冲：用 `body.getReader()` 增量解码，跨 chunk 的半行留残片缓冲（按 `\n\n` 切事件）。
   * 2. 首字节与空闲超时分开：连接 + 首字节走 `timeout_ms`，此后每收到一块就把看门狗重置为 30s，
   *    否则长答案会被总超时误杀。
   * 3. usage 只在 `stream_options.include_usage` 下由末帧给出；缺失时按估算补齐。
   *
   * 与非流式**共用**同一套错误映射（`httpError` / `normalizeError`）与取消语义。
   */
  async stream(request: LlmRequest, onChunk: (chunk: string) => void): Promise<LlmResponse> {
    const controller = new AbortController()
    let timedOut = false
    let watchdog: NodeJS.Timeout | null = null
    const arm = (ms: number) => {
      if (watchdog) clearTimeout(watchdog)
      watchdog = setTimeout(() => { timedOut = true; controller.abort() }, ms)
    }
    const onExternalAbort = () => controller.abort()
    if (request.signal) {
      if (request.signal.aborted) controller.abort()
      else request.signal.addEventListener('abort', onExternalAbort, { once: true })
    }
    arm(this.timeoutMs)

    try {
      const res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(this.buildBody(request, true)),
        signal: controller.signal,
      })
      if (!res.ok) throw this.httpError(res.status, res.headers.get('retry-after'))

      // 少数端点忽略 stream:true 直接回 JSON——按非流式处理，避免把整包 JSON 当成 SSE 解析
      const contentType = res.headers.get('content-type') || ''
      if (contentType.includes('application/json')) {
        const json: any = await res.json()
        const parsed = this.parseChatResponse(json)
        if (parsed.content) onChunk(parsed.content)
        return { ...parsed, chunks: parsed.content ? [parsed.content] : [] }
      }
      if (!res.body) throw new LlmRequestError('UNAVAILABLE', '端点未返回流式响应体，无法读取内容。')

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      const chunks: string[] = []
      let content = ''
      let model = this.model
      let usage: LlmUsage | null = null
      let finishReason: LlmFinishReason = 'stop'
      let done = false

      while (!done) {
        const read = await reader.read()
        if (read.done) break
        // 首字节之后改用空闲超时：每收到一块就重置看门狗，长答案不会被总超时误杀
        arm(STREAM_IDLE_TIMEOUT_MS)

        buffer += decoder.decode(read.value, { stream: true })
        buffer = buffer.replace(/\r\n/g, '\n')

        let sep: number
        while ((sep = buffer.indexOf('\n\n')) !== -1) {
          const rawEvent = buffer.slice(0, sep)
          buffer = buffer.slice(sep + 2)
          for (const line of rawEvent.split('\n')) {
            if (!line.startsWith('data:')) continue
            const payload = line.slice(5).trim()
            if (payload === '[DONE]') { done = true; break }
            if (!payload) continue
            let json: any
            try { json = JSON.parse(payload) } catch { continue }
            if (json.model) model = String(json.model)
            if (json.usage) usage = normalizeUsage(json.usage)
            const choice = json.choices?.[0]
            if (!choice) continue
            const delta = choice.delta || {}
            if (typeof delta.content === 'string' && delta.content) {
              content += delta.content
              chunks.push(delta.content)
              onChunk(delta.content)
            }
            if (choice.finish_reason) finishReason = normalizeFinish(choice.finish_reason)
          }
          if (done) break
        }
      }

      return {
        model,
        content,
        toolCalls: [],
        usage: usage ?? { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        finishReason,
        chunks,
      }
    } catch (error) {
      throw this.normalizeError(error, { isTimeout: () => timedOut, signal: controller.signal })
    } finally {
      if (watchdog) clearTimeout(watchdog)
      if (request.signal) request.signal.removeEventListener('abort', onExternalAbort)
    }
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (this.apiKey && this.apiKey.trim()) headers.Authorization = `Bearer ${this.apiKey.trim()}`
    return headers
  }

  private buildBody(request: LlmRequest, stream: boolean): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages: request.messages.map(m => ({
        role: m.role,
        content: m.content,
        ...(m.toolCallId ? { tool_call_id: m.toolCallId } : {}),
        ...(m.name ? { name: m.name } : {}),
      })),
      stream,
    }
    if (request.tools?.length) {
      body.tools = request.tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }))
    }
    const temperature = request.temperature ?? this.temperature
    if (temperature != null) body.temperature = temperature
    const maxTokens = request.maxTokens ?? this.maxTokens
    if (maxTokens != null) body.max_tokens = maxTokens
    if (stream) body.stream_options = { include_usage: true }
    return body
  }

  private parseChatResponse(json: any): LlmResponse {
    const choice = json?.choices?.[0] ?? {}
    const message = choice.message ?? {}
    return {
      model: String(json?.model || this.model),
      content: typeof message.content === 'string' ? message.content : '',
      toolCalls: parseToolCalls(message.tool_calls),
      usage: normalizeUsage(json?.usage),
      finishReason: normalizeFinish(choice.finish_reason),
    }
  }

  /**
   * HTTP 状态 → 结构化错误（中文可读，不外泄原始堆栈/报文）。
   * 与架构文档 §5.1.2 第 5 条一致：401/403/404 归 NOT_CONFIGURED，429 → RATE_LIMITED，5xx → UNAVAILABLE。
   */
  private httpError(status: number, retryAfterHeader?: string | null): LlmRequestError {
    const retryAfterMs = retryAfterHeader ? Math.max(0, Number(retryAfterHeader) * 1000) : undefined
    if (status === 401) return new LlmRequestError('NOT_CONFIGURED', '密钥无效或无权访问（上游返回 401），请检查 API Key 是否正确。', { httpStatus: status })
    if (status === 403) return new LlmRequestError('NOT_CONFIGURED', '密钥无权访问该端点或模型（上游返回 403），请确认账号权限与模型名。', { httpStatus: status })
    if (status === 404) return new LlmRequestError('NOT_CONFIGURED', '端点或模型名不正确（上游返回 404），请检查 base_url 是否含 /v1、模型名是否拼写正确。', { httpStatus: status })
    if (status === 429) return new LlmRequestError('RATE_LIMITED', '触发上游限流（HTTP 429），请稍后重试。', { httpStatus: status, retryAfterMs })
    if (status >= 500) return new LlmRequestError('UNAVAILABLE', `上游服务暂时不可用（HTTP ${status}），请稍后重试。`, { httpStatus: status, retryAfterMs })
    return new LlmRequestError('INVALID_ARGUMENT', `请求被上游拒绝（HTTP ${status}），请检查请求参数与模型是否匹配。`, { httpStatus: status })
  }

  /** 已归类错误原样透传；AbortError 区分超时/取消；其余按网络不可达处理 */
  private normalizeError(error: unknown, link: { isTimeout: () => boolean; signal: AbortSignal }): LlmRequestError {
    if (error instanceof LlmRequestError) return error
    const name = (error as any)?.name
    const code = (error as any)?.cause?.code || (error as any)?.code
    if (name === 'AbortError' || code === 'ABORT_ERR') {
      if (link.isTimeout()) return new LlmRequestError('UNAVAILABLE', `请求超时（${this.timeoutMs}ms）：端点未在预期时间内响应。`)
      return new LlmRequestError('CANCELLED', '请求已取消。')
    }
    const detail = code === 'ECONNREFUSED' ? '连接被拒绝'
      : code === 'ENOTFOUND' ? '域名无法解析'
      : code === 'ECONNRESET' ? '连接被重置'
      : code ? String(code) : ''
    return new LlmRequestError('UNAVAILABLE', `端点不可达：无法连接 ${this.baseUrl}${detail ? `（${detail}）` : ''}，请确认本地推理服务已启动或网络可用。`)
  }
}
