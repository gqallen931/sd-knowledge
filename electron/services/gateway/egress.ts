import DatabaseService from '../database'
import { scopeWhere } from '../scope'
import { LlmRequestError } from './errors'
import {
  EGRESS_SCOPE_RANK,
  EgressScopeMode,
  LlmEgressContext,
  LlmEgressGuard,
  LlmEgressOutcome,
} from './types'

/**
 * 出域范围闸门 + 审计（S1-02，架构文档 §5.1.4，ADR-004 决策 4）。
 *
 * 两件事：
 *   1. **范围闸门**：把「本次请求声明的范围」与「provider 策略允许的范围」逐条比对。
 *      声明的档位比策略更宽 → **拒绝**（写一条 `status='refused'` 的留痕 + 抛出可读错误），
 *      **不静默截断、不静默扩权**。默认策略是**最小档** `current_document`（写错等于默认把库上云）。
 *   2. **审计**：每次真实出域都写 `llm_egress_logs` + `audit_logs`；被拒绝的请求也留一条。
 *
 * 隐私约束：
 *   - 日志只记**时间 / provider / 目标 host / 范围档位 / 块数与字符数 / 文档与块 id**，
 *     **绝不写正文原文，也绝不写密钥**；目标只取 host（剥掉 query、userinfo、path）。
 *   - `local-openai` 同样留痕（供用户自查），但「是否数据出域」由 `kind` 区分，如实记录。
 */

/** 三档范围的可读名称（错误文案与设置页共用，遵守 UI 术语表口径） */
export const EGRESS_SCOPE_LABELS: Record<EgressScopeMode, string> = {
  current_document: '仅当前文档',
  selected_scope: '当前作用域',
  whole_library: '整库',
}

/** 三档范围的全量清单（设置页下拉按此顺序展示） */
export const EGRESS_SCOPE_MODES: EgressScopeMode[] = ['current_document', 'selected_scope', 'whole_library']

/**
 * 归一范围取值，兼容架构文档 §3.2.2 的旧口径（`selection` / `scope` / `whole_library`）。
 * 无法识别时返回 null（由调用方决定报错还是回落默认档）——**不猜测**。
 */
export function normalizeEgressMode(value: unknown): EgressScopeMode | null {
  const v = String(value ?? '').trim().toLowerCase()
  if (!v) return null
  if (v === 'current_document' || v === 'selection' || v === 'current') return 'current_document'
  if (v === 'selected_scope' || v === 'scope' || v === 'selection_scope') return 'selected_scope'
  if (v === 'whole_library' || v === 'library' || v === 'all') return 'whole_library'
  return null
}

/** 读取某 provider 允许的出域策略（库内缺省 / 非法值一律回落到最小档 `current_document`） */
export function readEgressPolicy(db: DatabaseService, providerId: string): EgressScopeMode {
  try {
    const row = db.prepare('SELECT egress_policy FROM llm_providers WHERE provider_id = ?').get(providerId) as any
    if (row?.egress_policy) {
      const parsed = JSON.parse(String(row.egress_policy))
      return normalizeEgressMode(parsed?.mode) ?? 'current_document'
    }
  } catch { /* 读不到策略时按最保守的默认档处理 */ }
  return 'current_document'
}

/** 目标 host：只保留 `hostname:port`，剥掉协议、userinfo、path 与 query（query 里可能带 key） */
export function egressHostOf(baseUrl: unknown): string {
  const raw = String(baseUrl ?? '').trim()
  if (!raw) return ''
  try {
    const parsed = new URL(raw)
    return parsed.host || ''
  } catch {
    // 非法 URL 时退化为「去掉 query/fragment 的原文前缀」，仍不携带 query
    return raw.split(/[?#]/)[0].replace(/^[a-z]+:\/\//i, '').replace(/@.*$/, '')
  }
}

/** 出域日志里 id 列表的存储上限：超出只留计数（避免日志变成「整库清单」，反成隐私风险） */
const ID_LIST_STORAGE_LIMIT = 50

function uniqueIds(values: Array<number | null | undefined>): number[] {
  const out: number[] = []
  for (const value of values) {
    const n = Number(value)
    if (Number.isInteger(n) && !out.includes(n)) out.push(n)
  }
  return out
}

/** 一次出域的留痕数据（成功 / 失败 / 被拒共用同一写入路径） */
interface EgressLogInput {
  status: LlmEgressOutcome['status']
  errorCode?: string | null
  promptChars: number
  completionChars: number
  latencyMs: number
  declared: EgressScopeMode
  policy: EgressScopeMode
}

function promptCharsOf(messages: LlmEgressContext['messages']): number {
  return (messages ?? []).reduce((sum, m) => sum + String(m?.content ?? '').length, 0)
}

export function createEgressGuard(db: DatabaseService): LlmEgressGuard {
  /** 写一条 `llm_egress_logs`（只记 id 与长度，绝无正文与密钥） */
  const writeLog = (context: LlmEgressContext, input: EgressLogInput): void => {
    try {
      const docIds = uniqueIds(context.citations.map(c => c.document_id))
      const chunkIds = uniqueIds(context.citations.map(c => c.chunk_id))
      const scopeJson = JSON.stringify({
        declared: input.declared,
        policy: input.policy,
        kind: context.kind,
      })
      db.prepare(`
        INSERT INTO llm_egress_logs
          (provider_id, model, target_host, scope_mode, scope_json, document_ids, chunk_ids,
           document_count, chunk_count, prompt_chars, completion_chars, status, error_code, latency_ms, actor)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        context.providerId,
        context.model,
        egressHostOf(context.baseUrl),
        input.declared,
        scopeJson,
        JSON.stringify(docIds.slice(0, ID_LIST_STORAGE_LIMIT)),
        JSON.stringify(chunkIds.slice(0, ID_LIST_STORAGE_LIMIT)),
        docIds.length,
        chunkIds.length,
        input.promptChars,
        input.completionChars,
        input.status,
        input.errorCode || null,
        input.latencyMs,
        context.actor || 'system',
      )
    } catch { /* 审计失败不阻断调用 */ }
  }

  /** 写一条 `audit_logs`（意图 / 被拒），details 只含元信息 */
  const writeAudit = (context: LlmEgressContext, declared: EgressScopeMode, policy: EgressScopeMode, status: 'success' | 'refused', reason?: string): void => {
    try {
      const docIds = uniqueIds(context.citations.map(c => c.document_id))
      const chunkIds = uniqueIds(context.citations.map(c => c.chunk_id))
      db.prepare(`
        INSERT INTO audit_logs (actor_type, actor_name, action, resource_type, details, status)
        VALUES ('system', ?, 'llm_egress', 'llm', ?, ?)
      `).run(
        context.actor || 'system',
        JSON.stringify({
          provider_id: context.providerId,
          kind: context.kind,
          host: egressHostOf(context.baseUrl),
          model: context.model,
          declared_scope: declared,
          policy_scope: policy,
          messages: context.messages.length,
          document_count: docIds.length,
          chunk_count: chunkIds.length,
          ...(reason ? { reason } : {}),
        }),
        status,
      )
    } catch { /* 审计失败不阻断调用 */ }
  }

  return {
    check(context: LlmEgressContext): boolean {
      const policy = readEgressPolicy(db, context.providerId)
      const declared = context.egressScope ?? 'current_document'
      const overPolicy = EGRESS_SCOPE_RANK[declared] > EGRESS_SCOPE_RANK[policy]

      // 逐条校验：实际要送出的块是否都落在「声明范围」内（防止声明与内容不一致）
      const violation = overPolicy ? null : verifyCitationsWithinScope(db, context, declared)

      if (overPolicy || violation) {
        const reason = overPolicy
          ? `declare ${declared} > policy ${policy}`
          : violation
        const message = overPolicy
          ? `本次请求需要出域范围「${EGRESS_SCOPE_LABELS[declared]}」，当前设置只允许「${EGRESS_SCOPE_LABELS[policy]}」，`
            + '请在「设置 → AI 引擎 → 数据出域」中调整后再试。'
          : `本次请求声明出域范围为「${EGRESS_SCOPE_LABELS[declared]}」，但有内容超出该范围（${violation}），已拒绝出域。`
        writeAudit(context, declared, policy, 'refused', reason || undefined)
        writeLog(context, {
          status: 'refused',
          errorCode: 'FORBIDDEN',
          promptChars: promptCharsOf(context.messages),
          completionChars: 0,
          latencyMs: 0,
          declared,
          policy,
        })
        // 抛结构化错误：网关会原样传播，让上层给出可读提示（绝不静默截断或静默上云）
        throw new LlmRequestError('FORBIDDEN', message)
      }

      writeAudit(context, declared, policy, 'success')
      return true
    },

    record(context: LlmEgressContext, outcome: LlmEgressOutcome): void {
      const policy = readEgressPolicy(db, context.providerId)
      const declared = context.egressScope ?? 'current_document'
      writeLog(context, {
        status: outcome.status,
        errorCode: outcome.errorCode,
        promptChars: outcome.promptChars,
        completionChars: outcome.completionChars,
        latencyMs: outcome.latencyMs,
        declared,
        policy,
      })
    },
  }
}

/**
 * 校验引用的文档是否全部落在声明范围内。
 * 返回违规说明（可读），全部合规时返回 null。
 * 无引用（空上下文）时视为合规——没有内容要送出。
 */
function verifyCitationsWithinScope(db: DatabaseService, context: LlmEgressContext, declared: EgressScopeMode): string | null {
  if (declared === 'whole_library') return null
  const docIds = uniqueIds(context.citations.map(c => c.document_id))
  if (!docIds.length) return null
  const placeholders = docIds.map(() => '?').join(',')

  if (declared === 'current_document') {
    const allowed = new Set(uniqueIds(context.documentIds ?? []))
    if (!allowed.size) return `未声明当前文档 id，无法确认 ${docIds.length} 篇文档在范围内`
    const outside = docIds.filter(id => !allowed.has(id))
    return outside.length ? `超出当前文档范围（document_id=${outside.slice(0, 5).join(',')}）` : null
  }

  // selected_scope：用作用域条件反查文档，全部命中才算合规
  try {
    const { where, params } = scopeWhere(context.scopeFilter ?? {}, 'd')
    const condition = where ? `AND ${where}` : ''
    const hit = (db.prepare(`SELECT COUNT(*) AS n FROM documents d WHERE d.id IN (${placeholders}) ${condition}`)
      .get(...docIds, ...params) as any)?.n || 0
    return hit === docIds.length ? null : `有 ${docIds.length - hit} 篇文档不在声明的当前作用域内`
  } catch {
    return '无法校验作用域范围'
  }
}
