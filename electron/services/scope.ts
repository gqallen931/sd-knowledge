/**
 * 统一作用域寻址（ADR-002）。
 *
 * `scope` 是「限定查询范围」的统一维度——图谱、搜索、MCP、REST 共享同一套语义，
 * 避免每个入口各自发明过滤参数（历史上 `graph.nodes()` 干脆不接受任何过滤）。
 *
 * 四个维度正交且可组合：
 *   - `source_id`   空间：`folder_sources` 的一个映射根
 *   - `folder_path` 目录：空间内的相对目录前缀，`''` 表示空间根（含全部子目录）
 *   - `project_id`  项目集：横跨空间的正交分组
 *   - `unassigned`  未归属：不属于任何空间的文档（本地逐份导入，或映射源被「解除归属」后留下）
 *
 * `unassigned` 与 `source_id` 互斥。它存在的理由：文档可以不来自任何映射根，
 * 这类数据若没有寻址入口，在按空间折叠的 L0 总览里会**彻底不可见**，
 * 而统计面板又照常把它们算进去——同一份数据，两张页面自相矛盾。
 *
 * 另有 `document_ids`：已持有文档 id 集合时（如向量检索候选）用它做二次收敛。
 */

export interface ScopeFilter {
  source_id?: number | string | null
  folder_path?: string | null
  project_id?: number | string | null
  /** 未归入任何空间（`documents.source_id IS NULL`）；与 `source_id` 互斥 */
  unassigned?: boolean
  document_ids?: number[]
}

/** 回传给调用方的作用域描述——让 Agent 知道「这次查询实际落在哪个范围」 */
export interface ScopeDescriptor {
  source_id: number | null
  source_name: string | null
  folder_path: string | null
  project_id: number | null
  project_name: string | null
  /** 本次范围是「未归入任何空间的文档」 */
  unassigned: boolean
}

const EMPTY_DESCRIPTOR: ScopeDescriptor = {
  source_id: null,
  source_name: null,
  folder_path: null,
  project_id: null,
  project_name: null,
  unassigned: false,
}

/** `source_id` 的哨兵值：显式表达「未归属」。与「没传 source_id」= 全局不是一回事 */
const UNASSIGNED_TOKENS = new Set(['unassigned', 'none', 'null', 'orphan'])

/**
 * 这组筛选条件要的是不是「未归入空间」。
 *
 * 单独导出而非只藏在 `normalizeScope` 里：`fileService` 的 `listFiles` / `countFiles`
 * 是各自手拼 SQL 条件的（不走 `scopeWhere`），但同一个筛选对象在两条路径下
 * 必须表示同一件事，否则同一份条件在两个入口会得到不同的结果。
 */
export function wantsUnassigned(raw: any): boolean {
  if (!raw || typeof raw !== 'object') return false
  if (
    raw.unassigned === true ||
    raw.unassigned === 1 ||
    raw.unassigned === '1' ||
    raw.unassigned === 'true'
  ) {
    return true
  }
  const rawSource = raw.source_id ?? raw.sourceId
  return typeof rawSource === 'string' && UNASSIGNED_TOKENS.has(rawSource.trim().toLowerCase())
}

/** 宽松地把 IPC / RPC / HTTP 传来的字符串转成整数；非法值一律视为「未指定」 */
export function toInt(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const n = Number(value)
  return Number.isInteger(n) ? n : null
}

/** 目录前缀归一：统一分隔符、去掉首尾斜杠、把 `.` 视为「空间根」 */
export function normalizeFolderPath(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
  if (!trimmed || trimmed === '.') return null
  return trimmed
}

/**
 * 从松散的入参对象里归一出一个 scope。
 * 入参可能来自 IPC（任意值）、REST（`req.query` 全是字符串）或 MCP（JSON）。
 */
export function normalizeScope(raw: any): ScopeFilter {
  if (!raw || typeof raw !== 'object') return {}
  const scope: ScopeFilter = {}
  const rawSource = raw.source_id ?? raw.sourceId
  if (wantsUnassigned(raw)) {
    // 显式说了「未归属」就不再认 source_id：两者互斥，避免同时给出时条件互相掐死
    scope.unassigned = true
  } else {
    const sourceId = toInt(rawSource)
    if (sourceId !== null) scope.source_id = sourceId
  }
  const projectId = toInt(raw.project_id ?? raw.projectId)
  if (projectId !== null) scope.project_id = projectId
  const folderPath = normalizeFolderPath(raw.folder_path ?? raw.folderPath ?? raw.path)
  if (folderPath) scope.folder_path = folderPath
  if (Array.isArray(raw.document_ids) && raw.document_ids.length > 0) {
    const ids = raw.document_ids.map(toInt).filter((id): id is number => id !== null)
    if (ids.length > 0) scope.document_ids = ids
  }
  return scope
}

/** 这个 scope 是否真的限定了范围（不含 document_ids——那是候选集而非寻址） */
export function hasScope(scope: ScopeFilter | null | undefined): boolean {
  if (!scope) return false
  return (
    scope.unassigned === true ||
    scope.source_id != null ||
    scope.project_id != null ||
    normalizeFolderPath(scope.folder_path) !== null
  )
}

/** 转义 LIKE 通配符；配合 `ESCAPE '\'` 使用 */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`)
}

/**
 * 把 scope 编译成针对 `documents` 表的 SQL 条件片段。
 *
 * 返回的 `where` 不含前导 `WHERE` / `AND`：调用方按需拼接，
 * 这样在同一张表上叠加其他条件（`is_available`、`file_type`…）时不会打架。
 *
 * `alias` 指定 documents 表在该查询里的别名——实体侧的范围判定要靠
 * `EXISTS (... FROM documents d ...)` 子查询，别名必须与调用处一致。
 */
export function scopeWhere(scope: ScopeFilter | null | undefined, alias = 'd'): { where: string; params: any[] } {
  const normalized = normalizeScope(scope)
  const conditions: string[] = []
  const params: any[] = []

  if (normalized.source_id != null) {
    conditions.push(`${alias}.source_id = ?`)
    params.push(normalized.source_id)
  }
  if (normalized.folder_path) {
    // 目录前缀匹配：自己 + 所有后代（`a/b` 命中 `a/b` 与 `a/b/c`）
    conditions.push(`(${alias}.relative_path = ? OR ${alias}.relative_path LIKE ? ESCAPE '\\')`)
    params.push(normalized.folder_path, `${escapeLike(normalized.folder_path)}/%`)
  }
  if (normalized.project_id != null) {
    conditions.push(`${alias}.project_id = ?`)
    params.push(normalized.project_id)
  }
  if (normalized.unassigned) {
    conditions.push(`${alias}.source_id IS NULL`)
  }
  if (normalized.document_ids && normalized.document_ids.length > 0) {
    conditions.push(`${alias}.id IN (${normalized.document_ids.map(() => '?').join(',')})`)
    params.push(...normalized.document_ids)
  }

  return { where: conditions.join(' AND '), params }
}

/**
 * 把 scope 编译成「限定到某实体的出现范围」的条件片段。
 *
 * 实体是全局共享池（`UNIQUE(name,type)`），本身不带归属；范围判定必须
 * 反查「哪些范围内的文档提到了它」。
 */
export function entityScopeWhere(
  scope: ScopeFilter | null | undefined,
  entityRef = 'e.id',
  documentAlias = 'sd'
): { where: string; params: any[] } {
  if (!hasScope(scope)) return { where: '', params: [] }
  const { where, params } = scopeWhere(scope, documentAlias)
  const condition = `EXISTS (SELECT 1 FROM relationships sr
      JOIN documents ${documentAlias} ON ${documentAlias}.id = sr.source_id
      WHERE sr.source_type = 'document' AND sr.target_type = 'entity'
        AND sr.target_id = ${entityRef} AND ${documentAlias}.is_available = 1
        AND ${where})`
  return { where: condition, params }
}

/** 稳定字符串标识，用于日志 / 缓存键 */
export function scopeKey(scope: ScopeFilter | null | undefined): string {
  const n = normalizeScope(scope)
  return [n.unassigned ? 'unassigned' : n.source_id ?? '-', n.folder_path ?? '-', n.project_id ?? '-'].join('|')
}

/**
 * 可读描述，用于 /api 响应与 MCP 结果里的 `scope` 字段。
 *
 * 完全没有限定范围时返回 `null`，而不是一个「全 null 的描述对象」——
 * 后者会让调用方误以为「限定过，只是值为空」，`null` 才是明确的「本次查询是全局的」。
 */
export function describeScope(db: any, scope: ScopeFilter | null | undefined): ScopeDescriptor | null {
  const n = normalizeScope(scope)
  if (!hasScope(n)) return null
  const descriptor: ScopeDescriptor = { ...EMPTY_DESCRIPTOR, folder_path: n.folder_path ?? null }
  if (n.unassigned) descriptor.unassigned = true
  const sourceId = toInt(n.source_id)
  if (sourceId != null) {
    descriptor.source_id = sourceId
    const row = db.prepare('SELECT name FROM folder_sources WHERE id = ?').get(sourceId) as any
    descriptor.source_name = row?.name ?? null
  }
  const projectId = toInt(n.project_id)
  if (projectId != null) {
    descriptor.project_id = projectId
    const row = db.prepare('SELECT name FROM projects WHERE id = ?').get(projectId) as any
    descriptor.project_name = row?.name ?? null
  }
  return descriptor
}
