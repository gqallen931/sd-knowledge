import { LlmEgressContext, LlmEgressGuard, LlmEgressOutcome, LlmGatewayStatus, LlmProvider, LlmRequest, LlmResponse } from './types'
import { LlmRequestError } from './errors'

/**
 * 尚未接入大语言模型时抛出的错误。
 *
 * 用 code 而不是靠消息字符串判断，是为了让 IPC / REST / MCP 三种出口
 * 都能稳定地把它翻译成「未配置」而不是「服务异常」。
 */
export class LlmNotConfiguredError extends Error {
  readonly code = 'LLM_NOT_CONFIGURED'

  constructor(reason = '尚未接入大语言模型') {
    super(reason)
    this.name = 'LlmNotConfiguredError'
  }
}

/**
 * LLM 网关（ADR-003 决策 5）。
 *
 * 本阶段只落「接缝」：网关本身是一个 provider 注册表 + 可用性探针，
 * 不含任何厂商 SDK、密钥管理或网络调用。真正的实现（OpenAI 兼容 / 本地模型）
 * 以后作为 LlmProvider 注册进来即可，调用方代码不需要改动。
 *
 * 这样做的收益是：任务、文档、检索这些既有能力现在就可以按「将来会有一个模型」
 * 的形态组织接口，而不必等模型接完再返工。
 */
export class LlmGateway {
  private provider: LlmProvider | null = null
  /** 出域检查钩子：真正发起外部调用前的强制闸门（S1-01 预留，S1-02 替换策略） */
  private egressGuard: LlmEgressGuard | null = null

  /** 注册（或传 null 卸载）当前生效的 provider */
  register(provider: LlmProvider | null): void {
    this.provider = provider
  }

  /** 装配出域检查钩子；传 null 关闭闸门（仅测试等明确场景使用） */
  setEgressGuard(guard: LlmEgressGuard | null): void {
    this.egressGuard = guard
  }

  current(): LlmProvider | null {
    return this.provider
  }

  status(): LlmGatewayStatus {
    if (!this.provider) {
      return { configured: false, providerId: null, label: '', model: '', reason: '尚未注册任何 LlmProvider' }
    }
    const available = this.provider.available()
    return {
      configured: available,
      providerId: this.provider.id,
      label: this.provider.label,
      model: this.provider.model,
      reason: available ? '' : `${this.provider.label} 当前不可用（未配置密钥或本地服务未启动）`,
    }
  }

  async chat(request: LlmRequest): Promise<LlmResponse> {
    const provider = this.requireProvider()
    const context = this.egressContext(request, provider)
    await this.beforeEgress(context)
    const started = Date.now()
    try {
      const response = await provider.chat(request)
      this.afterEgress(context, {
        status: 'ok',
        promptChars: promptChars(request),
        completionChars: response.content?.length ?? 0,
        latencyMs: Date.now() - started,
      })
      return response
    } catch (error) {
      this.afterEgress(context, failureOutcome(error, request, started))
      throw error
    }
  }

  /**
   * 流式对话。
   *
   * provider 未实现 stream 时退化为一次性返回，并把完整内容作为单个 chunk 回放——
   * 上层因此不必关心「这家是否支持流式」。
   * 流式与非流式共用同一套出域闸门：无论哪条路径，真正发请求前都会过 `beforeEgress`。
   */
  async stream(request: LlmRequest, onChunk: (chunk: string) => void): Promise<LlmResponse> {
    const provider = this.requireProvider()
    const context = this.egressContext(request, provider)
    await this.beforeEgress(context)
    const started = Date.now()
    let completionChars = 0
    try {
      let response: LlmResponse
      if (provider.stream) {
        response = await provider.stream(request, chunk => { completionChars += chunk.length; onChunk(chunk) })
      } else {
        const fallback = await provider.chat({ ...request })
        if (fallback.content) { completionChars += fallback.content.length; onChunk(fallback.content) }
        response = { ...fallback, chunks: fallback.content ? [fallback.content] : [] }
      }
      this.afterEgress(context, { status: 'ok', promptChars: promptChars(request), completionChars, latencyMs: Date.now() - started })
      return response
    } catch (error) {
      this.afterEgress(context, failureOutcome(error, request, started))
      throw error
    }
  }

  private requireProvider(): LlmProvider {
    if (!this.provider) throw new LlmNotConfiguredError('尚未接入大语言模型：请先注册一个 LlmProvider（OpenAI 兼容 / 本地模型）')
    if (!this.provider.available()) throw new LlmNotConfiguredError(this.status().reason)
    return this.provider
  }

  private egressContext(request: LlmRequest, provider: LlmProvider): LlmEgressContext {
    return {
      providerId: provider.id,
      kind: provider.kind ?? 'byo-openai',
      model: provider.model,
      baseUrl: provider.baseUrl ?? '',
      messages: request.messages ?? [],
      citations: request.citations ?? [],
      // 声明的出域范围：缺省 = 最小档（S1-02 的范围闸门据此判定）
      egressScope: request.egress?.scope ?? 'current_document',
      documentIds: request.egress?.document_ids,
      scopeFilter: request.egress?.scope_filter,
      actor: request.requester,
    }
  }

  private async beforeEgress(context: LlmEgressContext): Promise<void> {
    if (!this.egressGuard) return
    // 闸门拒绝时会抛出可读的结构化错误（并已写好 refused 留痕），此处原样向上传播
    const allowed = await this.egressGuard.check(context)
    if (!allowed) throw new LlmRequestError('FORBIDDEN', '出域被拒绝：本次内容超出当前授权范围。')
  }

  private afterEgress(context: LlmEgressContext, outcome: LlmEgressOutcome): void {
    if (!this.egressGuard) return
    try { this.egressGuard.record(context, outcome) } catch { /* 审计失败不影响主流程 */ }
  }
}

/** 出域审计里的 prompt 规模口径：按字符数（与 completionChars 同口径，仅用于日志） */
function promptChars(request: LlmRequest): number {
  return (request.messages ?? []).reduce((sum, m) => sum + String(m.content ?? '').length, 0)
}

function failureOutcome(error: unknown, request: LlmRequest, started: number): LlmEgressOutcome {
  const code = (error as any)?.code as string | undefined
  const status: LlmEgressOutcome['status'] = code === 'CANCELLED' ? 'refused'
    : code === 'UNAVAILABLE' ? 'timeout'
    : code === 'FORBIDDEN' ? 'refused'
    : 'error'
  return { status, errorCode: code, promptChars: promptChars(request), completionChars: 0, latencyMs: Date.now() - started }
}
