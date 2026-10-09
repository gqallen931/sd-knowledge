import DatabaseService from './database'
import type { ProcessingEngine } from './processingEngine'
import {
  ResultSet,
  RESULT_LIMITS,
  capLimit,
  makeResultSet,
  makeApproximateResultSet,
  makeFusedResultSet,
} from './resultSet'
import { ScopeFilter, describeScope, hasScope, normalizeScope, scopeWhere } from './scope'
import { anchorOf, estimateTokens, readChunks, StoredChunk } from './chunks'

/**
 * 检索入参。
 *
 * 四个入口（IPC / RPC / HTTP / MCP）传进来的形状各不相同，这里统一成一种：
 * 作用域三维（`source_id` / `folder_path` / `project_id`）+ 检索自带过滤（`file_type` / `storage_type`）+ `limit`。
 */
export interface SearchOptions extends ScopeFilter {
  limit?: number | string
  file_type?: string
  storage_type?: string
}

/** 归一后的检索入参——`limit` 已保证是数字，调用侧无需再防御 `string` */
type NormalizedSearchOptions = Omit<SearchOptions, 'limit'> & { limit: number }

/**
 * RRF 常数（架构文档 §5.3.2）。
 *
 * k=60 是业界经验值：它压制「头部名次」的差距，使「两路都排第 3」优于「一路第 1、另一路没命中」，
 * 这正是融合想要的稳健性——单一通道的偶然高分不该直接决定最终排名。
 */
const RRF_K = 60
/** 通道权重默认值与取值范围（设置项 `search.rrf.*`，范围 [0,3]） */
const RRF_WEIGHT_DEFAULT = 1
const RRF_WEIGHT_MIN = 0
const RRF_WEIGHT_MAX = 3
/** 规则重排默认系数（§5.3.3，全部 ∈ [0,1]） */
const RERANK_DEFAULT = { alpha: 0.15, beta: 0.10, gamma: 0.05, delta: 0.05, epsilon: 0.20 }
/** 时间权重上限：防止「最近导入的总是赢」把相关性挤掉（规则重排最常见的失败模式） */
const RERANK_ALPHA_MAX = 0.2
/** recency 的半衰期（天） */
const RECENCY_HALF_LIFE_DAYS = 30
/** 混合检索的候选窗口：两路各自取这么宽再融合（作用域过滤会在此基础上按倍数放大） */
const HYBRID_WINDOW_MIN = 30
const HYBRID_WINDOW_MAX = 200

interface RrfWeights {
  fulltext: number
  semantic: number
}

interface RerankCoefs {
  alpha: number
  beta: number
  gamma: number
  delta: number
  epsilon: number
}

/**
 * 问答上下文的一块（S1-03）：带**编号**与**可验证定位**。
 *
 * 与 `getContext` 的差别：`getContext` 是文档级文本（给 Agent 读的语境），
 * 这里必须是**块级**且带回 `chunk_id` / `anchor` —— 引用要能被逐条定位到 `chunks` 记录上，
 * 「不能只把 chunk 一股脑塞回去」。
 */
export interface AnswerContextBlock {
  /** 提示词里的编号，从 1 起；答案中的 `[i]` 与之一一对应 */
  index: number
  document_id: number
  chunk_id: number | null
  title: string
  file_name: string
  anchor: ReturnType<typeof anchorOf>
  content: string
  tokens: number
}

/** `buildAnswerContext` 的返回：块列表 + 原检索信封（供降级为检索页）+ 预算状态 */
export interface AnswerContextBundle {
  blocks: AnswerContextBlock[]
  retrieval: ResultSet<any>
  token_count: number
  truncated: boolean
  truncated_reason: ResultSet<any>['truncated_reason']
}

export interface AnswerContextOptions {
  /** token 预算（默认 4000）；超出时**整段丢弃**，不截半段（避免引用与原文不符） */
  budgetTokens?: number
  /** 限定到某一篇文档（`current_document` 档用） */
  document_id?: number
  /** 最多几个块（默认 8），避免把整库塞进一次请求 */
  maxBlocks?: number
  limit?: number | string
}

function clampNumber(raw: unknown, fallback: number, min: number, max: number): number {
  const n = Number(raw)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

export class SearchService {
  private processingEngine: ProcessingEngine | null = null

  constructor(private db: DatabaseService) {}

  setProcessingEngine(engine: ProcessingEngine) { this.processingEngine = engine }

  /**
   * 归一检索入参。
   *
   * 兼容历史调用形态——`search.semantic(query, 10)` 这种「第二个参数直接是 limit」的写法
   * 曾在四个入口同时存在，保留兼容可避免「漏改一处就静默失效」。
   */
  private normalizeOptions(raw: SearchOptions | number | undefined): NormalizedSearchOptions {
    const source: any = typeof raw === 'number' ? { limit: raw } : (raw || {})
    return {
      ...normalizeScope(source),
      limit: capLimit(source.limit, RESULT_LIMITS.search),
      file_type: source.file_type,
      storage_type: source.storage_type,
    }
  }

  /**
   * 拼检索条件。
   *
   * `textAlias` 指向承载 title / content_text 的表——FTS5 路径下是 `documents_fts f`，
   * 回退路径下是 `documents d`；其余条件（可用性、类型、作用域）恒指向 `d`。
   */
  private buildConditions(
    terms: string[],
    textAlias: string,
    options: SearchOptions
  ): { where: string; params: any[] } {
    const conditions = ['d.is_available = 1']
    const params: any[] = []
    for (const term of terms) {
      conditions.push(`(${textAlias}.title LIKE ? ESCAPE '\\' OR ${textAlias}.content_text LIKE ? ESCAPE '\\')`)
      const pattern = '%' + term.replace(/[\\%_]/g, '\\$&') + '%'
      params.push(pattern, pattern)
    }
    if (options.file_type) { conditions.push('d.file_type = ?'); params.push(options.file_type) }
    if (options.storage_type) { conditions.push('d.storage_type = ?'); params.push(options.storage_type) }

    const scoped = scopeWhere(options, 'd')
    if (scoped.where) { conditions.push(scoped.where); params.push(...scoped.params) }

    return { where: conditions.join(' AND '), params }
  }

  /** 同条件统计 + 取页——`total` 必须与 `items` 用同一组条件，否则 truncated 会撒谎 */
  private runDocumentQuery(fromClause: string, where: string, params: any[], limit: number) {
    const total = ((this.db.prepare(`SELECT COUNT(*) AS n FROM ${fromClause} WHERE ${where}`).get(...params) as any)?.n) || 0
    const rows = this.db.prepare(`
      SELECT d.id, d.title, d.file_name, d.file_type, d.file_size, d.storage_type, d.summary, d.content_text, d.imported_at,
             d.source_id, d.relative_path, d.project_id
      FROM ${fromClause}
      WHERE ${where}
      ORDER BY d.imported_at DESC
      LIMIT ?
    `).all(...params, limit) as any[]
    return { total, rows }
  }

  async fullTextSearch(query: string, rawOptions: SearchOptions | number = {}): Promise<ResultSet<any>> {
    const options = this.normalizeOptions(rawOptions)
    const descriptor = describeScope(this.db, options)
    const text = String(query || '').trim()
    if (!text) return makeResultSet([], 0, options.limit, descriptor)

    const terms = text.split(/\s+/).slice(0, 12)
    const limit = options.limit
    const excerptOf = (content_text: any, doc: any) => {
      const content = String(content_text || '')
      const index = content.toLowerCase().indexOf(terms[0].toLowerCase())
      return { ...doc, excerpt: content.slice(Math.max(0, index - 60), Math.max(0, index - 60) + 320), rank: 1 }
    }

    // 首选 FTS5 trigram 索引：对 f 列的 LIKE 可被 trigram 索引加速（含中文子串），
    // 语义与逐列 LIKE 完全一致；FTS 表不可用时回退到 documents 全表 LIKE。
    try {
      const { where, params } = this.buildConditions(terms, 'f', options)
      const { total, rows } = this.runDocumentQuery('documents_fts f JOIN documents d ON d.id = f.rowid', where, params, limit)
      return makeResultSet(rows.map(({ content_text, ...doc }) => excerptOf(content_text, doc)), total, limit, descriptor, 'limit')
    } catch (e) {
      console.warn('FTS5 search unavailable, falling back to LIKE scan:', (e as Error).message)
      const { where, params } = this.buildConditions(terms, 'd', options)
      const { total, rows } = this.runDocumentQuery('documents d', where, params, limit)
      return makeResultSet(rows.map(({ content_text, ...doc }) => excerptOf(content_text, doc)), total, limit, descriptor, 'limit')
    }
  }

  /**
   * 语义检索（ADR-002 起支持作用域）。
   *
   * `total` 是**近似值**——向量索引不扫全量就报不出真实命中数，
   * 因此退化为「候选窗口内的命中数」，并用 `truncated_reason` 标注结果是否可能不完整。
   */
  async semanticSearch(query: string, rawOptions: SearchOptions | number = {}): Promise<ResultSet<any>> {
    const options = this.normalizeOptions(rawOptions)
    const descriptor = describeScope(this.db, options)
    const limit = options.limit

    const settings = await this.db.getSettings()
    if (settings.vector_enabled !== 'true') throw new Error('语义搜索尚未开启，请在设置中启用向量化，并重新解析文件')
    if (!this.processingEngine) throw new Error('语义引擎未连接')
    const count = this.db.prepare('SELECT COUNT(*) AS n FROM vectors').get() as any
    if (!count.n) throw new Error('还没有语义向量，请等待模型下载和文件向量化完成，或先使用全文搜索')

    const { items, complete } = await this.processingEngine.semanticSearch(query, limit, options)
    const reason = !complete
      ? ('candidate_window' as const)
      : (items.length >= limit ? ('limit' as const) : undefined)
    return makeApproximateResultSet(items, limit, descriptor, reason)
  }

  /**
   * 混合检索（D10）：全文（FTS5）与向量两路**各自排名后按 RRF 融合**，再叠加规则重排。
   *
   * 与改造前的串行回退（「全文零命中才试语义」）的根本差别：
   *   - 两路结果都参与排序，语义召回不会被任意一条全文命中「挡掉」；
   *   - 全文命中也不再只按 `imported_at DESC` 排序，而是先按命中质量排名再融合。
   *
   * 融合粒度（§5.3.2）：**检索阶段按文档融合**（FTS 只到文档粒度），展示阶段回填文档内最高分块。
   * 规则重排只用规则（时间 / 作用域 / 类型 / 实体 / 标题），**不引入外部 rerank 模型**。
   */
  async hybridSearch(query: string, rawOptions: SearchOptions | number = {}): Promise<ResultSet<any>> {
    const options = this.normalizeOptions(rawOptions)
    const descriptor = describeScope(this.db, options)
    const limit = options.limit
    const text = String(query || '').trim()
    const settings = await this.db.getSettings()
    const channels = { fulltext: true, semantic: false }
    if (!text) return makeFusedResultSet([], 0, limit, descriptor, undefined, channels)

    const scoped = hasScope(options)
    // 候选窗口：作用域限定会「先取后筛」，因此先把窗口放大，再按倍数迭代（§5.3.4 手段 A 的现状口径）
    const window = Math.min(HYBRID_WINDOW_MAX, Math.max(HYBRID_WINDOW_MIN, limit * 5))

    const terms = text.split(/\s+/).slice(0, 12)
    const weights = this.readRrfWeights(settings)
    const coefs = this.readRerankCoefs(settings)
    const model = settings.embedding_model || null

    // —— 通道 A：全文（命中质量排名） ——
    const fulltext = this.fullTextChannel(terms, options, window)

    // —— 通道 B：向量（余弦降序，索引侧已按文档去重并带回最高分块） ——
    // 前置条件与 `semanticSearch` 一致（未开启向量化 / 库里没有向量都不算「跑过语义通道」）：
    // 这样 channels.semantic=false 才是诚实的「本次只有全文参与」，而不是「跑了但没东西」。
    const semanticReady = settings.vector_enabled === 'true' && this.vectorCount() > 0
    let semanticItems: any[] = []
    let semanticComplete = true
    let semanticExamined = 0
    if (this.processingEngine && semanticReady) {
      try {
        const result = await this.processingEngine.semanticSearch(text, scoped ? window * 2 : window, options)
        semanticItems = result.items
        semanticComplete = result.complete
        semanticExamined = result.examined
        channels.semantic = true
      } catch (e) {
        // 语义不可用（模型缺失 / 推理失败）不是错误：全文通道仍然给出可用的结果，
        // 但**不谎报完整**——通道状态随信封回传，调用方据此说明「本次只有全文命中」。
        console.warn('[search] 语义通道不可用，混合检索降级为全文：', (e as Error).message)
        semanticItems = []
      }
    }

    // —— RRF 融合（文档粒度） ——
    interface Fused {
      doc: any
      rrf: number
      rankFulltext: number | null
      rankSemantic: number | null
      semanticScore: number | null
      chunk: StoredChunk | null
    }
    const fused = new Map<number, Fused>()
    const upsert = (doc: any) => {
      const id = Number(doc.id)
      let entry = fused.get(id)
      if (!entry) {
        entry = { doc, rrf: 0, rankFulltext: null, rankSemantic: null, semanticScore: null, chunk: null }
        fused.set(id, entry)
      }
      return entry
    }
    fulltext.items.forEach((doc, index) => {
      const entry = upsert(doc)
      entry.rankFulltext = index + 1
      entry.rrf += weights.fulltext / (RRF_K + index + 1)
    })
    // 语义通道带回的 chunk_id 按批查回真实块（含字符偏移与锚点），不从命中结果里拼一个假的块
    const semanticChunks = this.chunksByIds(semanticItems.map(doc => doc.chunk_id))
    semanticItems.forEach((doc, index) => {
      const entry = upsert(doc)
      entry.rankSemantic = index + 1
      entry.semanticScore = typeof doc.score === 'number' ? doc.score : null
      entry.rrf += weights.semantic / (RRF_K + index + 1)
      entry.chunk = doc.chunk_id != null ? (semanticChunks.get(Number(doc.chunk_id)) ?? null) : null
    })

    // —— 规则重排（§5.3.3） ——
    const docIds = Array.from(fused.keys())
    const queryEntities = this.processingEngine ? this.processingEngine.extractQueryEntities(text) : []
    const docEntities = this.entitiesForDocuments(docIds)
    const queryTypeTokens = this.queryTypeTokens(text, docIds)
    const lowered = text.toLowerCase()

    const ranked = Array.from(fused.values()).map((entry) => {
      const recency = this.recency(entry.doc.imported_at)
      const scopeMatch = this.scopeMatch(entry.doc, options)
      const typeMatch = queryTypeTokens.size && queryTypeTokens.has(String(entry.doc.file_type || '').toLowerCase()) ? 1 : 0
      const titleHit = this.titleHit(entry.doc, lowered) ? 1 : 0
      const entityOverlap = this.entityOverlap(queryEntities, docEntities.get(Number(entry.doc.id)) || [])
      const factor = 1
        + coefs.alpha * recency
        + coefs.beta * scopeMatch
        + coefs.gamma * typeMatch
        + coefs.delta * entityOverlap
        + coefs.epsilon * titleHit
      return {
        entry,
        parts: {
          rrf: entry.rrf,
          rank_fulltext: entry.rankFulltext,
          rank_semantic: entry.rankSemantic,
          semantic_score: entry.semanticScore,
          recency, scope_match: scopeMatch, type_match: typeMatch,
          entity_overlap: entityOverlap, title_hit: titleHit,
        },
        final: entry.rrf * factor,
      }
    }).sort((a, b) => b.final - a.final || Number(a.entry.doc.id) - Number(b.entry.doc.id))

    const total = ranked.length
    const items = ranked.slice(0, limit).map((row, index) => {
      const doc = row.entry.doc
      // 展示阶段回填「哪一块相关」：语义通道已有块就用它，否则在当前文档里按查询词找最相关的一块
      const chunk = row.entry.chunk || this.bestChunk(Number(doc.id), terms)
      const excerpt = chunk?.content
        ? chunk.content.slice(0, 320)
        : String(doc.content_text || '').slice(0, 320)
      const { content_text, ...rest } = doc
      return {
        ...rest,
        excerpt,
        // 与原全文结果的同名字段保持兼容（顺序即名次），新增字段一律只增不改
        rank: index + 1,
        score: row.final,
        score_parts: { ...row.parts, final: row.final, model },
        model_id: row.entry.rankSemantic != null ? model : null,
        search_mode: 'hybrid',
        chunk_id: chunk?.id ?? null,
        chunk_index: chunk?.chunk_index ?? null,
        matched_chunk: chunk ? { id: chunk.id, chunk_index: chunk.chunk_index, content: chunk.content } : null,
        // 没有块（回填未完成的旧向量）时 anchor 为 null：前端显示「暂无可定位出处」，不伪造页码
        anchor: chunk ? anchorOf(chunk) : null,
      }
    })

    // —— 截断四态（§5.3.5）：如实判定，不乐观报 false ——
    const filteredOut = channels.semantic && semanticExamined > 0 && semanticItems.length === 0
    let reason: ResultSet<any>['truncated_reason']
    if (channels.semantic && (filteredOut || !semanticComplete)) {
      // 限定范围时「候选耗尽」的成因就是作用域过滤（可能漏召回），要如实说不是「取够了」
      reason = scoped ? 'scope_filter' : 'candidate_window'
    } else if (total > items.length) {
      reason = 'limit'
    }
    return makeFusedResultSet(items, total, limit, descriptor, reason, channels)
  }

  /** 全库向量行数：混合检索用它判断「语义通道是否真的可用」（不扫索引，只查一行计数） */
  private vectorCount(): number {
    try {
      return Number((this.db.prepare('SELECT COUNT(*) AS n FROM vectors').get() as any)?.n || 0)
    } catch {
      return 0
    }
  }

  /** 全文通道：命中质量排序后的文档（用于本通道排名） */
  private fullTextChannel(terms: string[], options: SearchOptions, window: number): { items: any[]; total: number } {
    if (!terms.length) return { items: [], total: 0 }
    let rows: any[] = []
    let total = 0
    try {
      const { where, params } = this.buildConditions(terms, 'f', options)
      const result = this.runDocumentQuery('documents_fts f JOIN documents d ON d.id = f.rowid', where, params, window)
      rows = result.rows
      total = result.total
    } catch (e) {
      console.warn('FTS5 search unavailable, falling back to LIKE scan:', (e as Error).message)
      const { where, params } = this.buildConditions(terms, 'd', options)
      const result = this.runDocumentQuery('documents d', where, params, window)
      rows = result.rows
      total = result.total
    }
    const lowered = terms.map(t => t.toLowerCase())
    const scored = rows.map((row) => {
      const title = String(row.title || '').toLowerCase()
      const content = String(row.content_text || '').toLowerCase()
      let score = 0
      for (const term of lowered) {
        if (title.includes(term)) score += 3          // 标题命中是最强信号
        score += Math.min(3, this.countOccurrences(content, term))
      }
      return { row, score }
    })
    // 命中质量降序；同分按导入时间倒序（与全文检索的既有口径一致，保证结果稳定）
    scored.sort((a, b) => b.score - a.score || String(b.row.imported_at || '').localeCompare(String(a.row.imported_at || '')))
    return { items: scored.map(s => s.row), total }
  }

  private countOccurrences(haystack: string, needle: string): number {
    if (!needle) return 0
    let count = 0
    let index = haystack.indexOf(needle)
    while (index >= 0 && count < 3) {
      count++
      index = haystack.indexOf(needle, index + needle.length)
    }
    return count
  }

  /** 通道权重（设置项 `search.rrf.fulltext` / `search.rrf.semantic`，范围 [0,3]） */
  private readRrfWeights(settings: Record<string, string>): RrfWeights {
    return {
      fulltext: clampNumber(settings['search.rrf.fulltext'], RRF_WEIGHT_DEFAULT, RRF_WEIGHT_MIN, RRF_WEIGHT_MAX),
      semantic: clampNumber(settings['search.rrf.semantic'], RRF_WEIGHT_DEFAULT, RRF_WEIGHT_MIN, RRF_WEIGHT_MAX),
    }
  }

  /**
   * 规则重排系数（设置项可覆盖）。
   *
   * 两条硬约束（§5.3.3）：α ≤ 0.2（时间不得主导相关性）；α+β+γ+δ+ε ≤ 1.0（整体加权不超过 2 倍）。
   * 越界时按比例缩小，而不是静默接受一个「配置写错但看起来能跑」的组合。
   */
  private readRerankCoefs(settings: Record<string, string>): RerankCoefs {
    const coefs: RerankCoefs = {
      alpha: clampNumber(settings['search.rerank.alpha'], RERANK_DEFAULT.alpha, 0, 1),
      beta: clampNumber(settings['search.rerank.beta'], RERANK_DEFAULT.beta, 0, 1),
      gamma: clampNumber(settings['search.rerank.gamma'], RERANK_DEFAULT.gamma, 0, 1),
      delta: clampNumber(settings['search.rerank.delta'], RERANK_DEFAULT.delta, 0, 1),
      epsilon: clampNumber(settings['search.rerank.epsilon'], RERANK_DEFAULT.epsilon, 0, 1),
    }
    coefs.alpha = Math.min(coefs.alpha, RERANK_ALPHA_MAX)
    const sum = coefs.alpha + coefs.beta + coefs.gamma + coefs.delta + coefs.epsilon
    if (sum > 1) {
      const scale = 1 / sum
      coefs.alpha *= scale; coefs.beta *= scale; coefs.gamma *= scale
      coefs.delta *= scale; coefs.epsilon *= scale
    }
    return coefs
  }

  /** 时间权重：`1 / (1 + days/30)`，30 天半衰 */
  private recency(importedAt: unknown): number {
    const raw = String(importedAt || '')
    if (!raw) return 0
    // SQLite CURRENT_TIMESTAMP 是 UTC 的 'YYYY-MM-DD HH:MM:SS'
    const time = Date.parse(raw.includes('T') ? raw : `${raw.replace(' ', 'T')}Z`)
    if (!Number.isFinite(time)) return 0
    const days = Math.max(0, (Date.now() - time) / 86400000)
    return 1 / (1 + days / RECENCY_HALF_LIFE_DAYS)
  }

  /**
   * 作用域命中度：1 = 精确落在 scope 指定的目录/项目内，0.5 = 落在 scope 的祖先目录，0 = 否则。
   * scope 为空时不参与（所有文档同值，等价于权重归零），不需要特判。
   */
  private scopeMatch(doc: any, options: SearchOptions): number {
    if (!hasScope(options)) return 0
    let best = 0
    if (options.source_id != null && doc.source_id != null) {
      best = Math.max(best, Number(doc.source_id) === Number(options.source_id) ? 1 : 0)
    }
    if (options.project_id != null && doc.project_id != null) {
      best = Math.max(best, Number(doc.project_id) === Number(options.project_id) ? 1 : 0)
    }
    const folderPath = String(options.folder_path || '')
    const relative = String(doc.relative_path || '')
    if (folderPath) {
      if (relative === folderPath || relative.startsWith(`${folderPath}/`)) best = Math.max(best, 1)
      else if (relative && folderPath.startsWith(`${relative}/`)) best = Math.max(best, 0.5)
    }
    if (options.unassigned === true && doc.source_id == null) best = Math.max(best, 1)
    return best
  }

  /** 查询里显式提到的文件类型（如「pdf 里…」）：只在文档集真实存在的类型上认，避免误判 */
  private queryTypeTokens(query: string, docIds: number[]): Set<string> {
    const tokens = new Set((query.toLowerCase().match(/[a-z][a-z0-9]{1,9}/g) || []))
    if (!tokens.size || !docIds.length) return new Set()
    const placeholders = docIds.map(() => '?').join(',')
    const rows = this.db.prepare(
      `SELECT DISTINCT lower(file_type) AS type FROM documents WHERE id IN (${placeholders})`
    ).all(...docIds) as any[]
    const present = new Set(rows.map(r => String(r.type || '')))
    const matched = new Set<string>()
    for (const token of tokens) if (present.has(token)) matched.add(token)
    return matched
  }

  /** 标题命中：查询词整体出现在 title / file_name 中（最强信号，权重 ε 最高） */
  private titleHit(doc: any, loweredQuery: string): boolean {
    if (!loweredQuery) return false
    return String(doc.title || '').toLowerCase().includes(loweredQuery)
      || String(doc.file_name || '').toLowerCase().includes(loweredQuery)
  }

  /** 实体重合度：|查询实体 ∩ 文档实体| / max(1, 查询实体数) */
  private entityOverlap(queryEntities: Array<{ name: string; type: string }>, docEntityNames: string[]): number {
    if (!queryEntities.length || !docEntityNames.length) return 0
    const docNames = new Set(docEntityNames.map(name => name.toLowerCase()))
    let hit = 0
    for (const entity of queryEntities) if (docNames.has(String(entity.name).toLowerCase())) hit++
    return hit / Math.max(1, queryEntities.length)
  }

  /** 批量取候选文档的实体名（一次查询，避免每篇一条 SQL） */
  private entitiesForDocuments(documentIds: number[]): Map<number, string[]> {
    const out = new Map<number, string[]>()
    const ids = Array.from(new Set(documentIds.filter(id => Number.isInteger(id))))
    if (!ids.length) return out
    const rows = this.db.prepare(`
      SELECT r.source_id AS document_id, e.name AS name
      FROM relationships r JOIN entities e ON e.id = r.target_id
      WHERE r.source_type = 'document' AND r.target_type = 'entity'
        AND r.source_id IN (${ids.map(() => '?').join(',')})
    `).all(...ids) as any[]
    for (const row of rows) {
      const list = out.get(Number(row.document_id)) || []
      list.push(String(row.name))
      out.set(Number(row.document_id), list)
    }
    return out
  }

  /** 文档内最相关的一块（查询词出现最多的一块的正文），用于展示与块级溯源 */
  private bestChunk(documentId: number, terms: string[]): StoredChunk | null {
    const chunks = this.db.prepare(`
      SELECT id, document_id, chunk_index, content, char_start, char_end,
             anchor_kind, anchor_index, time_start_ms, time_end_ms, bbox,
             token_count, chunk_size, chunk_overlap
      FROM chunks WHERE document_id = ? ORDER BY chunk_index
    `).all(documentId) as StoredChunk[]
    if (!chunks.length) return null
    let best = chunks[0]
    let bestScore = -1
    for (const chunk of chunks) {
      const content = chunk.content.toLowerCase()
      let score = 0
      for (const term of terms) score += this.countOccurrences(content, term.toLowerCase())
      if (score > bestScore) { bestScore = score; best = chunk }
    }
    return best
  }

  /** 按 chunk id 批量取块（语义通道命中后回填真实块信息） */
  private chunksByIds(ids: Array<number | null | undefined>): Map<number, StoredChunk> {
    const wanted = Array.from(new Set(ids.filter((id): id is number => typeof id === 'number' && Number.isInteger(id))))
    const out = new Map<number, StoredChunk>()
    if (!wanted.length) return out
    const rows = this.db.prepare(`
      SELECT id, document_id, chunk_index, content, char_start, char_end,
             anchor_kind, anchor_index, time_start_ms, time_end_ms, bbox,
             token_count, chunk_size, chunk_overlap
      FROM chunks WHERE id IN (${wanted.map(() => '?').join(',')})
    `).all(...wanted) as StoredChunk[]
    for (const row of rows) out.set(row.id, row)
    return out
  }

  /**
   * 组装给 Agent 的上下文。
   *
   * 三项改动（ADR-002）：① 支持作用域；② 带上命中文档的关联实体——Agent 此前拿到的
   * `entities` 恒为空数组，等于丢掉了图上最有价值的那部分；③ 回传截断状态。
   * S0 起检索本身走**混合检索（RRF）**，不再「全文零命中才试语义」。
   */
  async getContext(query: string, maxTokens: number = 4000, rawOptions: SearchOptions | number = {}): Promise<any> {
    const options = this.normalizeOptions(rawOptions)
    const descriptor = describeScope(this.db, options)

    const set = await this.hybridSearch(query, { ...options, limit: 10 })

    const budget = Math.max(0, Math.min(32000, Number(maxTokens) || 4000))
    let context = ''
    const usedDocs: any[] = []
    for (const doc of set.items) {
      const content = `${doc.title}: ${doc.summary || doc.excerpt || ''}\n`
      if (Math.ceil((context.length + content.length) / 2) > budget) break
      context += content
      usedDocs.push(doc)
    }

    return {
      context,
      documents: usedDocs,
      entities: this.entitiesForContext(usedDocs.map((doc) => doc.id)),
      token_count: Math.ceil(context.length / 2),
      scope: descriptor,
      truncated: set.truncated || usedDocs.length < set.items.length,
      truncated_reason: usedDocs.length < set.items.length ? 'token_budget' : (set.truncated_reason ?? null),
    }
  }

  /**
   * 组装问答上下文（S1-03 的「上下文组装」）。
   *
   * 与 `getContext` 共用同一条检索路径（`hybridSearch` 的 RRF 融合）与同一套截断词汇，
   * 差别是**块级 + 带回块 id 与锚点**：每块编号（1 起），供提示词标记与答案引用回查。
   *
   * 预算两条硬上限（架构文档 §5.2）：
   *   - `budgetTokens`：按 `estimateTokens` 单点估算，超出时**整段丢弃**（不截半段）；
   *   - `maxBlocks`：块数上限，避免把整库塞进一次请求。
   * 任一触顶都如实报 `truncated_reason='token_budget'`，**不乐观报 complete**。
   */
  async buildAnswerContext(query: string, rawOptions: SearchOptions | number = {}, options: AnswerContextOptions = {}): Promise<AnswerContextBundle> {
    const normalized = this.normalizeOptions(rawOptions)
    const limit = capLimit(options.limit ?? 8, RESULT_LIMITS.search)
    const retrieval = await this.hybridSearch(query, { ...normalized, limit })

    const budget = Math.max(0, Math.min(32000, Number(options.budgetTokens) || 4000))
    const maxBlocks = Math.max(1, Math.min(30, Math.floor(Number(options.maxBlocks) || 8)))
    const onlyDocument = options.document_id != null ? Number(options.document_id) : null
    const terms = String(query || '').trim().split(/\s+/).filter(Boolean).slice(0, 12)

    // 候选块：`current_document` 档直接取该文档的块（按查询词命中度排序），
    // 否则取混合检索每个命中文档带回的相关块——两种来源都带回真实 chunk_id 与锚点。
    interface Candidate { document_id: number; chunk_id: number | null; title: string; file_name: string; anchor: any; content: string }
    let candidates: Candidate[]
    if (onlyDocument != null) {
      const doc = this.db.prepare('SELECT id, title, file_name FROM documents WHERE id = ?').get(onlyDocument) as any
      const chunks = doc ? readChunks(this.db, onlyDocument) : []
      const scored = chunks
        .map(chunk => ({ chunk, hit: terms.reduce((sum, t) => sum + this.countOccurrences(chunk.content.toLowerCase(), t.toLowerCase()), 0) }))
        .sort((a, b) => b.hit - a.hit || a.chunk.chunk_index - b.chunk.chunk_index)
      candidates = scored.map(({ chunk }) => ({
        document_id: onlyDocument,
        chunk_id: chunk.id,
        title: String(doc?.title || doc?.file_name || `文档 #${onlyDocument}`),
        file_name: String(doc?.file_name || ''),
        anchor: anchorOf(chunk),
        content: chunk.content,
      }))
    } else {
      candidates = retrieval.items.map(doc => ({
        document_id: Number(doc.id),
        chunk_id: doc.chunk_id != null ? Number(doc.chunk_id) : null,
        title: String(doc.title || doc.file_name || `文档 #${doc.id}`),
        file_name: String(doc.file_name || ''),
        // 优先用语义通道带回的真实块正文；无块（回填未完成的旧向量）时退化为摘录
        anchor: doc.anchor ?? null,
        content: String(doc.matched_chunk?.content ?? doc.excerpt ?? ''),
      }))
    }

    const blocks: AnswerContextBlock[] = []
    let tokens = 0
    let budgetHit = false
    const usable = candidates.filter(c => c.content.trim())
    for (const candidate of usable) {
      if (blocks.length >= maxBlocks) { budgetHit = true; break }
      const cost = estimateTokens(candidate.content)
      if (tokens + cost > budget) { budgetHit = true; break }
      tokens += cost
      blocks.push({
        index: blocks.length + 1,
        document_id: candidate.document_id,
        chunk_id: candidate.chunk_id,
        title: candidate.title,
        file_name: candidate.file_name,
        anchor: candidate.anchor,
        content: candidate.content,
        tokens: cost,
      })
    }

    const truncatedByContext = budgetHit || blocks.length < usable.length
    const reason: ResultSet<any>['truncated_reason'] = truncatedByContext
      ? 'token_budget'
      : (retrieval.truncated_reason ?? (retrieval.truncated ? 'limit' : undefined))

    return {
      blocks,
      retrieval,
      token_count: tokens,
      truncated: truncatedByContext || retrieval.truncated,
      truncated_reason: reason,
    }
  }

  /** 命中文档所关联的实体（按提及次数排序）——`get_context` 的图谱侧内容 */
  private entitiesForContext(documentIds: number[], limit = 30): any[] {
    const ids = documentIds.filter((id) => Number.isInteger(id))
    if (!ids.length) return []
    const placeholders = ids.map(() => '?').join(',')
    return this.db.prepare(`
      SELECT e.id, e.name, e.type, e.description, COUNT(*) AS mentions
      FROM relationships r
      JOIN entities e ON e.id = r.target_id
      WHERE r.source_type = 'document' AND r.target_type = 'entity'
        AND r.source_id IN (${placeholders})
      GROUP BY e.id
      ORDER BY mentions DESC, e.name
      LIMIT ?
    `).all(...ids, limit) as any[]
  }
}
