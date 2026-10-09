/**
 * 统一结果形状（ADR-002）。
 *
 * 背景：历史上每个查询返回结构各不相同（图谱返回裸数组、搜索返回自己的包装），
 * 且上限是硬编码的（图谱 `500/200/100`）——**超出部分被静默丢弃，调用方无从感知**。
 * Agent 面对这种接口，只能假设「看到的就是全部」。
 *
 * 本模块统一两件事：
 *   1. 每类查询返回同构信封 `{ items, total, limit, truncated, scope }`
 *   2. 上限由调用方指定，超出时 `truncated = true` —— 截断从「隐式」变「显式」
 */
import { ScopeDescriptor } from './scope'

export interface ResultSet<T> {
  items: T[]
  /** 满足条件的总数（不受 limit 影响）；无法精确统计时表示「已在候选窗口内找到的数量」 */
  total: number
  /** 实际生效的上限 */
  limit: number
  /** true = 结果被截断，调用方应缩小范围或提高 limit */
  truncated: boolean
  /**
   * 截断原因，让调用方能区分「只是取够了」和「根本取不全」：
   *   - `limit`            命中数超过 limit，属于正常截断
   *   - `candidate_window` 语义检索的候选窗口用尽仍不满足，**结果可能不完整**
   *   - `scope_filter`     按作用域过滤后候选耗尽（限定范围可能漏召回）
   *   - `token_budget`     上下文超出预算，只带了一部分段落（`getContext` 专用）
   */
  truncated_reason?: 'limit' | 'candidate_window' | 'scope_filter' | 'token_budget'
  /** 本次查询实际落在的作用域；未限定范围时为 null */
  scope?: ScopeDescriptor | null
  /**
   * `total` 是近似值（向量检索不扫全量索引就报不出确数）。UI 据此显示「约 N 条」，
   * **不允许伪造精确数字**（D10）。
   */
  total_is_approx?: boolean
  /** 本次实际参与融合的通道（混合检索只增字段，便于调用方在 UI 上说明降级原因） */
  channels?: { fulltext: boolean; semantic: boolean }
}

/**
 * 总数无法精确统计时的信封（典型场景：向量检索——不扫全量索引就报不出真实 total）。
 *
 * `total` 退化为「已检查的候选窗口内的命中数」，同时用 `truncated_reason`
 * 明确告知调用方结果**可能不完整**，而不是伪造一个看起来很确定的数字。
 */
export function makeApproximateResultSet<T>(
  items: T[],
  limit: number,
  scope: ScopeDescriptor | null | undefined,
  reason?: ResultSet<T>['truncated_reason'],
  channels?: ResultSet<T>['channels']
): ResultSet<T> {
  return {
    items,
    total: items.length,
    limit,
    truncated: Boolean(reason),
    ...(reason ? { truncated_reason: reason } : {}),
    scope: scope ?? null,
    total_is_approx: true,
    ...(channels ? { channels } : {}),
  }
}

/**
 * 混合检索（RRF 融合）的信封。
 *
 * `total` 是融合后的候选文档数（两个通道的并集，**近似值**）；
 * `truncated` 由「显式原因」与「total > 实际返回条数」共同决定——
 * **不允许乐观地报 false**：候选窗口耗尽、作用域过滤耗尽都算截断。
 */
export function makeFusedResultSet<T>(
  items: T[],
  total: number,
  limit: number,
  scope: ScopeDescriptor | null | undefined,
  reason?: ResultSet<T>['truncated_reason'],
  channels?: ResultSet<T>['channels']
): ResultSet<T> {
  const truncated = Boolean(reason) || total > items.length
  return {
    items,
    total,
    limit,
    truncated,
    ...(truncated && reason ? { truncated_reason: reason } : {}),
    scope: scope ?? null,
    total_is_approx: true,
    ...(channels ? { channels } : {}),
  }
}

/** 各类查询的默认与上限。上限存在的意义是防止单次响应撑爆 IPC / context，而非限制能力 */
export const RESULT_LIMITS = {
  /** 图谱：文档节点 */
  graphNodes: { default: 300, max: 2000 },
  /** 图谱：实体节点 */
  graphEntities: { default: 200, max: 2000 },
  /** 图谱：标签节点 */
  graphTags: { default: 100, max: 1000 },
  /** 图谱：边 */
  graphEdges: { default: 1000, max: 5000 },
  /** 全文 / 语义搜索 */
  search: { default: 20, max: 200 },
  /** 文档列表 */
  documents: { default: 50, max: 500 },
  /** 空间列表 */
  spaces: { default: 100, max: 500 },
} as const

/** 把外部传入的 limit 收敛到 `[1, max]`；非法值回落到 default */
export function capLimit(raw: unknown, bounds: { default: number; max: number }): number {
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) return bounds.default
  return Math.min(bounds.max, Math.max(1, Math.floor(n)))
}

/**
 * 组装结果信封。
 *
 * `total` 由调用方给出（通常配一条 `COUNT(*)` 同条件查询）；
 * `truncated` 一律由 `total > items.length` 推导，不手写——避免出现
 * 「标了 truncated=false 但其实是直接截断的」这类自相矛盾。
 */
export function makeResultSet<T>(
  items: T[],
  total: number,
  limit: number,
  scope?: ScopeDescriptor | null,
  reason?: ResultSet<T>['truncated_reason']
): ResultSet<T> {
  const truncated = total > items.length
  return {
    items,
    total,
    limit,
    truncated,
    ...(truncated && reason ? { truncated_reason: reason } : {}),
    scope: scope ?? null,
  }
}
