import { SearchService, AnswerContextBundle } from './searchService'
import { LlmService } from './gateway/llmService'
import { EgressScopeMode } from './gateway/types'
import { normalizeEgressMode } from './gateway/egress'
import { hasScope, normalizeScope, toInt, ScopeFilter } from './scope'

/**
 * RAG 问答链路（S1-03，架构文档 §5.2）。
 *
 * 一条链路：**提问 → 混合检索（RRF，复用既有路径）→ 上下文组装（编号块）→ LLM 流式 → 答案 + 引用列表**。
 *
 * 两条红线（任务表 S1-03 的完成判定）：
 *   1. **引用必须可验证**：每块带编号（`[1] [2]`），提示词用同一编号喂给模型，返回体给出
 *      「编号 → 块」映射，且每条引用带 `chunk_id` / `document_id` / 文件名 / 锚点 / 片段原文——
 *      界面据此能定位到真实 `chunks` 记录。模型引用了不存在的编号、或答案里没有任何引用，
 *      都在返回体里**如实标注**（`citations_unverified`），绝不假装有据。
 *   2. **降级不抛异常**（ADR-004）：未配置 provider 时返回纯检索结果（`mode='retrieval_only'`），
 *      让界面直接降级为检索页；未开启向量化时检索降级为全文，并如实标注实际用到的通道。
 *
 * 出域闸门（S1-02）在本层声明范围：`answerService` 把「本次声明的范围 + 实际送出的块」塞进
 * `LlmRequest.egress / citations`，由网关在真正发请求前判定。默认档为最小档 `current_document`。
 */

/** 问答方法入参（四个出口共用同一形状） */
export interface AnswerAskInput {
  query?: string
  /** 作用域过滤（source_id / folder_path / project_id / unassigned），也可直接平铺在入参上 */
  scope?: ScopeFilter | Record<string, unknown>
  /** 限定到某一篇文档（`current_document` 档） */
  document_id?: number | string | null
  /** 本次声明的出域范围档位；缺省按入参推导（有 document_id → 当前文档；有 scope → 当前作用域；否则整库） */
  egress_scope?: string
  /** 返回的检索候选上限（默认 8） */
  limit?: number | string
  /** 上下文 token 预算（默认 4000） */
  max_tokens?: number | string
  /** 触发者标记，写进出域审计（user / api / mcp / system） */
  actor?: string
  signal?: AbortSignal
  /**
   * 真流式（S1-05）：为 true 时把 provider 的增量片段经 `onChunk` 逐块交出，
   * 由出口层（Web SSE / 桌面 IPC）转发给前端。**不改变最终 `AnswerResult` 的形态**——
   * 增量只是过程，答案文本仍以完整 `answer` 返回，引用解析口径也完全一致。
   */
  stream?: boolean
  /** 增量回调（仅 `stream=true` 时有意义）；每块是 provider 原样返回的文本增量 */
  onChunk?: (chunk: string) => void
}

export interface AnswerCitation {
  index: number
  chunk_id: number | null
  document_id: number
  title: string
  file_name: string
  anchor: any
  quote: string
}

export interface AnswerResult {
  /** answer = 模型答案；retrieval_only = 未配置模型，降级为检索；refused = 出域闸门拒绝；error = 其它失败 */
  mode: 'answer' | 'retrieval_only' | 'refused' | 'error'
  answer: string | null
  /** **实际被引用**的块（`[i]` 出现在答案中），每条可定位到 `chunks` 记录 */
  citations: AnswerCitation[]
  /** 编号 → 块 的映射（覆盖全部提供的上下文块），保证界面能凭编号定位 */
  citation_map: Record<number, { chunk_id: number | null; document_id: number }>
  /** 全部提供的上下文块（含未被引用的），供界面展示「送了什么」 */
  context_blocks: AnswerCitation[]
  /** 答案里出现的合法编号（升序） */
  cited_indexes: number[]
  /** 答案里出现但越界的编号（模型编的） */
  invalid_indexes: number[]
  /** 未引用告警：答案没有任何引用，或引用了不存在的编号 → true */
  citations_unverified: boolean
  /** 纯检索信封（降级 / 被拒时仍带上，界面可切检索页） */
  retrieval: any
  context_meta: {
    block_count: number
    chunk_count: number
    document_count: number
    prompt_chars: number
    estimated_tokens: number
    truncated: boolean
    truncated_reason: string | null
    channels: unknown
  }
  provider: { provider_id: string; model: string; kind: string } | null
  egress: { scope: EgressScopeMode; allowed: boolean | null; reason: string | null }
  usage: unknown
  /** 可读说明（降级/被拒/失败时给界面一句话） */
  message: string
  meta: { reason?: string }
}

const DEFAULT_MAX_TOKENS = 4000
const DEFAULT_BLOCK_LIMIT = 8
const ANSWER_MAX_TOKENS = 1024

/** 系统提示：固定模板 + 强约束（只依据片段、每个事实标注编号、不足则明说不知道） */
const SYSTEM_PROMPT = [
  '你是本地知识库问答助手。请严格依据下面给出的编号片段回答问题。',
  '规则：',
  '1. 只使用片段中的信息，不要引入片段之外的常识或猜测；',
  '2. 每个事实性结论后必须标注来源编号，格式如 [1]；可同时标注多个，如 [1][3]；',
  '3. 若片段不足以回答，直接说明「资料中没有相关内容」，不要编造；',
  '4. 使用简洁的中文作答。',
].join('\n')

export class AnswerService {
  constructor(
    private search: SearchService,
    private llm: LlmService,
  ) {}

  async ask(input: AnswerAskInput = {}): Promise<AnswerResult> {
    const query = String(input.query ?? '').trim()
    if (!query) throw new Error('提问不能为空')

    const scope = normalizeScope(input.scope ?? (input as Record<string, unknown>))
    const documentId = toInt(input.document_id)
    const declared = normalizeEgressMode(input.egress_scope)
      ?? (documentId != null ? 'current_document' : hasScope(scope) ? 'selected_scope' : 'whole_library')

    // 1) 上下文组装（复用 RRF 混合检索路径 + 块级预算）
    let bundle = await this.search.buildAnswerContext(query, scope, {
      budgetTokens: clampInt(input.max_tokens, DEFAULT_MAX_TOKENS, 200, 32000),
      maxBlocks: DEFAULT_BLOCK_LIMIT,
      document_id: documentId ?? undefined,
      limit: clampInt(input.limit, DEFAULT_BLOCK_LIMIT, 1, 50),
    })

    // 最小档 `current_document`：只允许「当前文档的命中块」。没显式给 document_id 时，
    // 收敛到命中排序第一的文档（这正是「当前文档」在该档下的含义），不把多篇拼在一起送出去。
    if (declared === 'current_document') {
      const targetDoc = documentId ?? bundle.blocks[0]?.document_id ?? null
      const narrowed = targetDoc == null ? [] : bundle.blocks.filter(b => b.document_id === targetDoc)
      bundle = { ...bundle, blocks: narrowed, token_count: narrowed.reduce((sum, b) => sum + b.tokens, 0) }
    }

    // 2) 未配置 provider：返回纯检索结果（不抛异常，不阻塞其它功能）
    const status = this.llm.status()
    if (!status.configured) {
      return this.retrievalOnly(bundle, declared, status, 'NOT_CONFIGURED',
        `${status.reason || '尚未接入大语言模型'}：以下为本地检索结果，可在「设置 → AI 引擎」配置模型后获得带出处的答案。`)
    }

    // 3) 组装提示词（编号块）+ 声明出域范围（供 S1-02 闸门判定）
    const blocks = bundle.blocks
    const messages = buildMessages(query, blocks)
    const allowedDocIds = Array.from(new Set(blocks.map(b => b.document_id)))

    let answer = ''
    let usage: unknown = null
    // 真流式：用户显式要求且给了回调时，把 provider 的增量逐块转发（出口层据此推给前端）
    const onChunk = input.stream && input.onChunk ? input.onChunk : undefined
    try {
      const response = await this.llm.stream({
        messages,
        maxTokens: ANSWER_MAX_TOKENS,
        requester: input.actor || 'user',
        signal: input.signal,
        // 出域声明：范围档位 + 允许的文档 + 作用域过滤（闸门据此逐条校验）
        egress: { scope: declared, document_ids: allowedDocIds, scope_filter: scope },
        citations: blocks.map(b => ({ document_id: b.document_id, chunk_id: b.chunk_id })),
      }, onChunk)
      answer = String(response.content || '')
      usage = response.usage ?? null
    } catch (error: any) {
      const code = error?.code
      if (code === 'LLM_NOT_CONFIGURED' || code === 'NOT_CONFIGURED') {
        return this.retrievalOnly(bundle, declared, status, 'NOT_CONFIGURED',
          `${error?.message || '尚未接入大语言模型'}：以下为本地检索结果。`)
      }
      if (code === 'FORBIDDEN') {
        return this.withMeta(bundle, declared, {
          mode: 'refused',
          answer: null,
          message: error?.message || '出域被拒绝：本次内容超出当前授权范围。',
          meta: { reason: 'EGRESS_REFUSED' },
          egress: { scope: declared, allowed: false, reason: error?.message || null },
        })
      }
      return this.withMeta(bundle, declared, {
        mode: 'error',
        answer: null,
        message: `调用模型失败：${error?.message || String(error)}`,
        meta: { reason: code || 'LLM_ERROR' },
      })
    }

    return this.answerResult(bundle, declared, answer, usage, messages, status)
  }

  /** 由答案解析引用编号，产出可验证的引用列表 + 如实标注 */
  private answerResult(
    bundle: AnswerContextBundle,
    declared: EgressScopeMode,
    answer: string,
    usage: unknown,
    messages: Array<{ content: string }>,
    status: { providerId: string | null; model: string; label: string },
  ): AnswerResult {
    const blocks = bundle.blocks
    const citedIndexes: number[] = []
    const invalidIndexes: number[] = []
    for (const match of answer.matchAll(/\[(\d{1,3})\]/g)) {
      const index = Number(match[1])
      if (index >= 1 && index <= blocks.length) {
        if (!citedIndexes.includes(index)) citedIndexes.push(index)
      } else if (!invalidIndexes.includes(index)) {
        invalidIndexes.push(index)
      }
    }
    citedIndexes.sort((a, b) => a - b)
    invalidIndexes.sort((a, b) => a - b)

    const citations = citedIndexes.map(i => toCitation(blocks[i - 1]))
    const contextBlocks = blocks.map(toCitation)
    const citationsUnverified = citedIndexes.length === 0 || invalidIndexes.length > 0
    const message = citedIndexes.length === 0
      ? '答案未标注任何来源编号，引用不可核验。'
      : invalidIndexes.length > 0
        ? `答案引用了不存在的编号 [${invalidIndexes.join('][')}]，已如实标注。`
        : ''

    return {
      mode: 'answer',
      answer,
      citations,
      citation_map: citationMap(blocks),
      context_blocks: contextBlocks,
      cited_indexes: citedIndexes,
      invalid_indexes: invalidIndexes,
      citations_unverified: citationsUnverified,
      retrieval: bundle.retrieval,
      context_meta: contextMeta(bundle, messages),
      provider: status.providerId
        ? { provider_id: status.providerId, model: status.model, kind: status.label }
        : null,
      egress: { scope: declared, allowed: true, reason: null },
      usage,
      message,
      meta: {},
    }
  }

  /** 未配置模型时的纯检索降级 */
  private retrievalOnly(bundle: AnswerContextBundle, declared: EgressScopeMode, status: { providerId: string | null; model: string; label: string }, reason: string, message: string): AnswerResult {
    return this.withMeta(bundle, declared, {
      mode: 'retrieval_only',
      answer: null,
      message,
      meta: { reason },
      provider: status.providerId ? { provider_id: status.providerId, model: status.model, kind: status.label } : null,
    })
  }

  /** 统一补齐引用映射、上下文元信息与检索信封（降级/被拒/失败共用） */
  private withMeta(bundle: AnswerContextBundle, declared: EgressScopeMode, partial: Partial<AnswerResult> & { mode: AnswerResult['mode']; message: string }): AnswerResult {
    return {
      mode: partial.mode,
      answer: partial.answer ?? null,
      citations: partial.citations ?? [],
      citation_map: citationMap(bundle.blocks),
      context_blocks: bundle.blocks.map(toCitation),
      cited_indexes: partial.cited_indexes ?? [],
      invalid_indexes: partial.invalid_indexes ?? [],
      citations_unverified: partial.citations_unverified ?? true,
      retrieval: bundle.retrieval,
      context_meta: contextMeta(bundle, []),
      provider: partial.provider ?? null,
      egress: partial.egress ?? { scope: declared, allowed: null, reason: null },
      usage: partial.usage ?? null,
      message: partial.message,
      meta: partial.meta ?? {},
    }
  }
}

/** 块 → 引用条目（只带定位 id 与片段原文，界面据此跳转） */
function toCitation(block: { index: number; chunk_id: number | null; document_id: number; title: string; file_name: string; anchor: any; content: string }): AnswerCitation {
  return {
    index: block.index,
    chunk_id: block.chunk_id,
    document_id: block.document_id,
    title: block.title,
    file_name: block.file_name,
    anchor: block.anchor,
    quote: block.content,
  }
}

function citationMap(blocks: Array<{ index: number; chunk_id: number | null; document_id: number }>): Record<number, { chunk_id: number | null; document_id: number }> {
  const map: Record<number, { chunk_id: number | null; document_id: number }> = {}
  for (const block of blocks) map[block.index] = { chunk_id: block.chunk_id, document_id: block.document_id }
  return map
}

function contextMeta(bundle: AnswerContextBundle, messages: Array<{ content: string }>): AnswerResult['context_meta'] {
  const documentIds = new Set<number>(bundle.blocks.map(b => b.document_id))
  const chunkIds = new Set<number>(bundle.blocks.map(b => b.chunk_id).filter((v): v is number => v != null))
  return {
    block_count: bundle.blocks.length,
    chunk_count: chunkIds.size,
    document_count: documentIds.size,
    prompt_chars: messages.reduce((sum, m) => sum + String(m?.content ?? '').length, 0),
    estimated_tokens: bundle.token_count,
    truncated: bundle.truncated,
    truncated_reason: bundle.truncated_reason ?? null,
    channels: bundle.retrieval?.channels ?? null,
  }
}

/** 组装消息：system 固定模板 + user 内含编号块与问题 */
export function buildMessages(query: string, blocks: Array<{ index: number; title: string; anchor: any; content: string }>): Array<{ role: 'system' | 'user'; content: string }> {
  if (!blocks.length) {
    return [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: `问题：${query}\n\n（本地检索没有找到相关片段。）` },
    ]
  }
  const body = blocks.map(block => `${blockHeader(block)}\n${block.content}`).join('\n\n')
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: `请依据以下片段回答问题。\n\n${body}\n\n问题：${query}` },
  ]
}

/** 块前缀：`【i】《标题》 · 第 N 页 / 12:30` —— 编号是引用回查的锚 */
function blockHeader(block: { index: number; title: string; anchor: any }): string {
  return `【${block.index}】《${block.title}》${anchorText(block.anchor)}`
}

function anchorText(anchor: any): string {
  if (!anchor) return ''
  const kind = anchor.anchor_kind
  if (kind === 'page' && anchor.anchor_index != null) return ` · 第 ${anchor.anchor_index} 页`
  if (kind === 'slide' && anchor.anchor_index != null) return ` · 第 ${anchor.anchor_index} 张幻灯片`
  if (kind === 'chapter' && anchor.anchor_index != null) return ` · 第 ${anchor.anchor_index} 章`
  if (kind === 'sheet' && anchor.anchor_index != null) return ` · 第 ${anchor.anchor_index} 个工作表`
  if (kind === 'time' && anchor.time_start_ms != null) {
    const seconds = Math.round(anchor.time_start_ms / 1000)
    const mm = String(Math.floor(seconds / 60)).padStart(2, '0')
    const ss = String(seconds % 60).padStart(2, '0')
    return ` · ${mm}:${ss}`
  }
  return ''
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  if (value == null || value === '') return fallback
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}
