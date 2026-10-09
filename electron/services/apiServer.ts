/**
 * REST 出口的返回契约（S0 契约统一；本注释是后续生成 OpenAPI 的输入）。
 *
 * 一、集合类端点 → 统一 ResultSet 封套
 *    `{ items, total, limit, truncated, truncated_reason?, scope }`（见 services/resultSet.ts）
 *    - `items` 中每个元素的字段与改造前逐一保持一致，改造不借机改名；
 *    - `limit` 一律经 `capLimit` + `RESULT_LIMITS` 收敛，不写裸数字；
 *    - `total` 与 `items` 用同一组过滤条件统计，`truncated` 由 `total > items.length` 推导。
 *      GET  /api/v1/search              → ResultSet（searchService.fullTextSearch）
 *      POST /api/v1/search/semantic     → ResultSet（近似 total：向量检索报不出精确命中数）
 *      GET  /api/v1/graph/nodes         → ResultSet（graphBuilder.getNodes）
 *      GET  /api/v1/graph/edges         → ResultSet（graphBuilder.getEdges）
 *      GET  /api/v1/documents           → ResultSet（fileService.listFiles + countFiles；限 documents）
 *      GET  /api/v1/entities            → ResultSet（限 graphEntities）
 *      GET  /api/v1/entities/search     → ResultSet（近似 total；限 search）
 *      GET  /api/v1/tags                → ResultSet（限 graphTags）
 *      GET  /api/v1/projects            → ResultSet（复用容器类上限 spaces）
 *
 * 二、单对象端点 → **保持裸对象**，全站统一，不套 ResultSet
 *    理由：封套的价值在于回答「集合有多大、有没有被截断」；单对象没有规模概念，
 *    硬套 `limit=1 / total=1` 只是噪音，还会把 `doc.title` 变成 `doc.item.title`，
 *    让「取一份文档」这种最常见的调用多剥一层。故这类端点只在错误形状上与全站对齐。
 *      GET  /api/v1/health              → { status, version, timestamp }
 *      GET  /api/v1/stats               → 聚合统计对象（total_files / file_types / trend …），非集合
 *      GET  /api/v1/documents/:id       → 文档详情对象（含 tags / entities …）
 *      GET  /api/v1/documents/:id/content → { content }
 *      GET  /api/v1/graph/entity/:name  → { nodes, edges, entity }（子图结构，内部数组各自带旧有上限）
 *      POST /api/v1/context             → token 预算语境专用封套
 *                                         { context, documents, entities, token_count, scope, truncated, truncated_reason }
 *                                         （字段名与语义都服务「塞进上下文」，故不并入 ResultSet 家族）
 *      POST /api/v1/documents/:id/process → { success, message }
 *      POST /api/v1/entities/:id/rename   → { success, entity, … }
 *      POST /api/v1/entities/batch-rename → { success, renamed, failed, details }
 *      POST /api/v1/entities/merge        → { success, merged, moved, deduped, … }
 *
 * 三、工作台域端点（ADR-003）→ 只做透传，形状由 workbench RPC 方法表决定，不在本轮范围内
 *      POST /api/v1/workbench/rpc
 *      GET  /api/v1/workbench/{dashboard,tasks,projects,projects/:id/tasks,timeline,search}
 *      （其中 workbench.search 的 documents 字段本身即 ResultSet）
 *
 * 四、错误分级（由文件末尾的错误中间件统一出口；处理器已显式 return 的状态码不进这里）
 *      400 参数/入参不合法——领域层抛出的校验类错误由路由显式标注（见 ApiError）
 *      401 缺少/无效凭证，以及工作台域的 `AUTH_REQUIRED`（与 webEntry 同一约定）
 *      403 密钥无效或写权限不足（鉴权中间件直接返回；本轮鉴权逻辑与状态码均未改动）
 *      404 资源不存在（处理器显式返回；404 兜底中间件同样保留）
 *      500 未预期异常：原始 message 只写日志，对外统一回「Internal server error」，不外泄内部细节
 */
import express from 'express'
import http from 'http'
import { WebSocketServer } from 'ws'
import cors from 'cors'
import rateLimit from 'express-rate-limit'
import { v4 as uuidv4 } from 'uuid'
import DatabaseService from './database'
import { FileService } from './fileService'
import { SearchService } from './searchService'
import { GraphBuilder } from './graphBuilder'
import { SecurityService } from './securityService'
import { ProcessingEngine } from './processingEngine'
import { RESULT_LIMITS, capLimit, makeApproximateResultSet, makeResultSet } from './resultSet'
import { createWorkbenchRpc, WorkbenchRpcDeps } from './workbench/rpcHandlers'

/** 供 REST / MCP 使用的只读方法后缀：reader 角色的密钥只能调这些 */
const READ_METHOD_SUFFIXES = new Set(['status', 'list', 'detail', 'search', 'stats', 'history', 'export', 'unread', 'dashboard', 'workspaces', 'groups', 'tasks', 'timeline', 'providers', 'logs'])

/**
 * `graphBuilder.searchEntities` 的服务端硬上限（该函数内部的 `Math.min(50, limit)`）。
 * 封套里的 `limit` 必须报**实际生效值**，否则会出现「请求 200、只回 50、却标 truncated=false」
 * 这类自相矛盾——那正是本模块要消灭的「隐式截断」。
 */
const ENTITY_SEARCH_CAP = 50

/**
 * 带状态码的接口错误。
 *
 * 存在的理由：领域层（graphBuilder / searchService 等）把「调用方传错了」也抛成普通 `Error`，
 * 而 Express 的错误中间件无法从 `Error` 本身区分「入参不合法」与「服务端炸了」。
 * 路由在自己清楚语义的地方把异常包成 ApiError；**没有包的一律按 500 处理**，
 * 不再像改造前那样把所有异常都谎报成 400。
 */
class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
    this.name = 'ApiError'
  }
}

export class APIServer {
  private app: express.Application
  private server: http.Server
  private wss: WebSocketServer | null = null
  private port: number
  private isRunningFlag = false
  private connectedClients: Set<any> = new Set()

  constructor(
    private db: DatabaseService,
    private fileService: FileService,
    private searchService: SearchService,
    private graphBuilder: GraphBuilder,
    private securityService: SecurityService,
    private processingEngine: ProcessingEngine,
    /** 工作台域（ADR-003）：不传则本轮不暴露工作台 REST 接口 */
    private workbenchDomains: Omit<WorkbenchRpcDeps, 'clientId' | 'trusted'> | null = null
  ) {
    this.app = express()
    this.port = 17890
    this.server = http.createServer(this.app)
    this.setupMiddleware()
    this.setupRoutes()
  }

  private setupMiddleware() {
    this.app.use(cors({ origin: (origin, callback) => {
      try { callback(null, !origin || ['127.0.0.1', 'localhost'].includes(new URL(origin).hostname)) }
      catch { callback(null, false) }
    } }))
    this.app.use(express.json({ limit: '10mb' }))

    const limiter = rateLimit({
      windowMs: 60 * 1000,
      max: async () => Math.max(1, Number((await this.db.getSettings()).rate_limit) || 100),
      message: { error: 'Too many requests' }
    })
    this.app.use('/api/', limiter)
  }

  private async authenticate(req: express.Request, res: express.Response, next: express.NextFunction) {
    if (!(await this.securityService.getStatus()).enabled) return next()
    const authHeader = req.headers.authorization || (req.headers['x-api-key'] ? 'Bearer ' + req.headers['x-api-key'] : '')
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Missing API key' })
    }
    const token = authHeader.substring(7)
    const valid = await this.securityService.validateApiKey(token)
    if (!valid) {
      return res.status(403).json({ error: 'Invalid API key' })
    }
    if (req.method !== 'GET') {
      const role = await this.securityService.getApiKeyRole(token)
      const needsWrite = req.path.endsWith('/process') || req.path.startsWith('/api/v1/entities')
      if (needsWrite && role === 'reader') return res.status(403).json({ error: '此密钥没有写入权限' })
    }
    next()
  }

  private route(handler: (req: express.Request, res: express.Response) => Promise<any>) {
    return (req: express.Request, res: express.Response, next: express.NextFunction) => { Promise.resolve(handler(req, res)).catch(next) }
  }

  /**
   * 把领域层已知的「入参 / 前置条件不合法」标注成 400。
   *
   * 只在路由明确知道该调用**只会**因调用方原因失败时使用（实体写操作、语义检索前置校验）；
   * 不作为兜底——真正的内部故障应保持未标注状态，由中间件按 500 上报并记录原始堆栈。
   * 文案原样透传：这些 message（「不能为空」「语义搜索尚未开启」）本身就是给调用方的修复指引。
   */
  private async asClientError<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run()
    } catch (e: any) {
      throw new ApiError(400, e?.message || String(e))
    }
  }

  private setupRoutes() {
    this.app.get('/api/v1/health', (req, res) => {
      res.json({ status: 'ok', version: '1.0.0', timestamp: new Date().toISOString() })
    })

    // 单对象端点：保持裸对象（见文件头契约「二」）
    this.app.get('/api/v1/stats', this.authenticate.bind(this), this.route(async (req, res) => {
      const stats = await this.db.getDashboardStats()
      res.json(stats)
    }))

    this.app.get('/api/v1/documents', this.authenticate.bind(this), this.route(async (req, res) => {
      const filters = {
        file_type: req.query.file_type as string,
        storage_type: req.query.storage_type as string,
        limit: capLimit(req.query.limit, RESULT_LIMITS.documents)
      }
      const docs = await this.fileService.listFiles(filters)
      // total 必须与 items 用同一组 filters 统计（countFiles 会忽略 limit），否则 truncated 会撒谎
      const total = await this.fileService.countFiles(filters)
      res.json(makeResultSet(docs, total, filters.limit, null, 'limit'))
    }))

    // 单对象端点：保持裸对象（见文件头契约「二」）
    this.app.get('/api/v1/documents/:id', this.authenticate.bind(this), this.route(async (req, res) => {
      const doc = await this.fileService.getFileDetail(parseInt(req.params.id))
      if (!doc) return res.status(404).json({ error: 'Not found' })
      res.json(doc)
    }))

    this.app.get('/api/v1/documents/:id/content', this.authenticate.bind(this), this.route(async (req, res) => {
      const doc = this.db.prepare('SELECT content_text FROM documents WHERE id = ?')
        .get(parseInt(req.params.id)) as any
      if (!doc) return res.status(404).json({ error: 'Not found' })
      res.json({ content: doc.content_text })
    }))

    this.app.get('/api/v1/search', this.authenticate.bind(this), this.route(async (req, res) => {
      const q = req.query.q as string
      if (!q) return res.status(400).json({ error: 'Missing query parameter "q"' })
      // searchService 内部同样走 capLimit + RESULT_LIMITS.search，这里只负责把 query 收敛成合法值
      const limit = capLimit(req.query.limit, RESULT_LIMITS.search)
      // 语义分支与 POST /search/semantic 保持同一映射：向量未开启/语料未向量化属调用方前置条件（400）
      const results = req.query.mode === 'semantic'
        ? await this.asClientError(() => this.searchService.semanticSearch(q, limit))
        : await this.searchService.fullTextSearch(q, { ...req.query, limit })
      res.json(results)
    }))

    this.app.post('/api/v1/search/semantic', this.authenticate.bind(this), this.route(async (req, res) => {
      const { query, limit } = req.body
      if (!query) return res.status(400).json({ error: 'Missing "query" in body' })
      // 「向量化未开启 / 语料尚未向量化」是调用方需要处理的配置前置条件，属 400 而非 500
      const results = await this.asClientError(() => this.searchService.semanticSearch(query, limit || 10))
      res.json(results)
    }))

    this.app.post('/api/v1/context', this.authenticate.bind(this), this.route(async (req, res) => {
      const { query, max_tokens, filters } = req.body
      if (!query) return res.status(400).json({ error: 'Missing "query" in body' })
      // token 预算专用封套（见文件头契约「二」）
      const context = await this.searchService.getContext(query, max_tokens || 4000, filters)
      res.json(context)
    }))

    /**
     * RAG 问答流式出口（S1-05，SSE）。
     *
     * 与 `/api/v1/workbench/rpc`（method='chat.ask'，非流式）**共用同一个 `answerService`**，
     * 只是把增量按 SSE 推给调用方——不写第二套业务逻辑。鉴权口径与其它 REST 端点一致
     * （`authenticate` 中间件：默认 `security_enabled=false` 放行，开启后要求 API Key）。
     * 事件：`{type:'chunk',chunk}` / `{type:'result',result}` / `{type:'error',message,code}`。
     */
    this.app.post('/api/v1/ask/stream', this.authenticate.bind(this), async (req, res) => {
      const answer = this.workbenchDomains?.answer
      if (!answer) return res.status(400).json({ error: '问答服务尚未装配' })
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      })
      const send = (payload: Record<string, unknown>) => { if (!res.writableEnded) res.write(`data: ${JSON.stringify(payload)}\n\n`) }
      const controller = new AbortController()
      // 在 response 的 close 上取消（req 的 close 在请求体读完时就会触发，会误杀尚未开始的生成）
      res.on('close', () => controller.abort())
      try {
        const result = await answer.ask({ ...(req.body || {}), actor: 'api', signal: controller.signal, stream: true, onChunk: chunk => send({ type: 'chunk', chunk }) })
        send({ type: 'result', result })
      } catch (e: any) {
        send({ type: 'error', message: e?.message || String(e), code: e?.code || null })
      } finally {
        if (!res.writableEnded) res.end()
      }
    })

    this.app.get('/api/v1/graph/nodes', this.authenticate.bind(this), this.route(async (req, res) => {
      const nodes = await this.graphBuilder.getNodes(req.query)
      res.json(nodes)
    }))

    this.app.get('/api/v1/graph/edges', this.authenticate.bind(this), this.route(async (req, res) => {
      const edges = await this.graphBuilder.getEdges(req.query)
      res.json(edges)
    }))

    // 单对象端点：{ nodes, edges, entity } 子图结构，不套 ResultSet（见文件头契约「二」）
    this.app.get('/api/v1/graph/entity/:name', this.authenticate.bind(this), this.route(async (req, res) => {
      const graph = await this.graphBuilder.getEntityGraph(req.params.name)
      res.json(graph)
    }))

    this.app.get('/api/v1/entities', this.authenticate.bind(this), this.route(async (req, res) => {
      const type = req.query.type as string
      const limit = capLimit(req.query.limit, RESULT_LIMITS.graphEntities)
      const where = type ? ' WHERE type = ?' : ''
      const params: any[] = type ? [type] : []
      const total = ((this.db.prepare(`SELECT COUNT(*) AS n FROM entities${where}`).get(...params) as any)?.n) || 0
      const entities = this.db.prepare(`SELECT id, name, type, description FROM entities${where} LIMIT ?`).all(...params, limit)
      res.json(makeResultSet(entities, total, limit, null, 'limit'))
    }))

    this.app.get('/api/v1/tags', this.authenticate.bind(this), this.route(async (req, res) => {
      const limit = capLimit(req.query.limit, RESULT_LIMITS.graphTags)
      const total = ((this.db.prepare('SELECT COUNT(*) AS n FROM tags').get() as any)?.n) || 0
      const tags = this.db.prepare('SELECT id, name, color FROM tags LIMIT ?').all(limit)
      res.json(makeResultSet(tags, total, limit, null, 'limit'))
    }))

    this.app.get('/api/v1/projects', this.authenticate.bind(this), this.route(async (req, res) => {
      // 项目与空间同属「容器」量级，复用 spaces 的上限，不另造一组数字
      const limit = capLimit(req.query.limit, RESULT_LIMITS.spaces)
      const total = ((this.db.prepare('SELECT COUNT(*) AS n FROM projects').get() as any)?.n) || 0
      const projects = this.db.prepare('SELECT * FROM projects LIMIT ?').all(limit)
      res.json(makeResultSet(projects, total, limit, null, 'limit'))
    }))

    this.app.get('/api/v1/entities/search', this.authenticate.bind(this), this.route(async (req, res) => {
      const q = req.query.q as string
      if (!q) return res.status(400).json({ error: 'Missing query parameter "q"' })
      const requested = capLimit(req.query.limit, RESULT_LIMITS.search)
      // searchEntities 只回命中行、不回报总数，故 total 只能用近似封套（命中数即候选窗口内的数量）；
      // 触到服务端上限时标 truncated，宁可说「结果可能不全」，也不假装拿到了全部
      const effective = Math.min(requested, ENTITY_SEARCH_CAP)
      const entities = await this.graphBuilder.searchEntities(q, requested)
      res.json(makeApproximateResultSet(entities, effective, null, entities.length >= effective ? 'limit' : undefined))
    }))

    this.app.post('/api/v1/documents/:id/process', this.authenticate.bind(this), this.route(async (req, res) => {
      const id = parseInt(req.params.id)
      if (!await this.fileService.getFileDetail(id)) return res.status(404).json({ error: 'Not found' })
      await this.processingEngine.processDocument(id)
      const processed = await this.fileService.getFileDetail(id)
      if (processed.processing_status === 'failed') return res.status(422).json({ error: processed.processing_error })
      this.broadcastEvent('document.updated', { document_id: id })
      res.json({ success: true, message: 'Document processed' })
    }))

    this.app.post('/api/v1/entities/:id/rename', this.authenticate.bind(this), this.route(async (req, res) => {
      const id = parseInt(req.params.id)
      if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid entity id' })
      const { name, type } = req.body || {}
      if (!name) return res.status(400).json({ error: 'Missing "name" in body' })
      // graphBuilder 的写操作只在「名称为空 / 与既有实体重名 / 实体不存在」这类入参问题上抛错，属 400
      const result = await this.asClientError(() => this.graphBuilder.renameEntity(id, name, type))
      this.broadcastEvent('graph.updated', { action: 'rename', entity_id: id })
      res.json(result)
    }))

    this.app.post('/api/v1/entities/batch-rename', this.authenticate.bind(this), this.route(async (req, res) => {
      const { items } = req.body || {}
      if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: 'Missing non-empty "items" array in body' })
      const result = await this.asClientError(() => this.graphBuilder.batchRenameEntities(items))
      this.broadcastEvent('graph.updated', { action: 'batch_rename', count: result.renamed })
      res.json(result)
    }))

    this.app.post('/api/v1/entities/merge', this.authenticate.bind(this), this.route(async (req, res) => {
      const { source_ids, target_id } = req.body || {}
      if (!Array.isArray(source_ids) || source_ids.length === 0) return res.status(400).json({ error: 'Missing non-empty "source_ids" array in body' })
      if (!Number.isInteger(Number(target_id))) return res.status(400).json({ error: 'Missing "target_id" in body' })
      // 源与目标相同、目标不存在、批量超限等均为调用方入参问题，保持 400
      const result = await this.asClientError(() => this.graphBuilder.mergeEntitiesBatch(source_ids, Number(target_id)))
      this.broadcastEvent('graph.updated', { action: 'merge', merged: result.merged })
      res.json(result)
    }))

    if (this.workbenchDomains) this.setupWorkbenchRoutes()

    // 错误分级（见文件头契约「四」）：处理器已显式 return 的状态码不进这里
    this.app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      const status = err instanceof ApiError
        ? err.status
        // 与 Web 入口（webEntry）同一约定：会话失效标记统一转 401
        : (err as any)?.message === 'AUTH_REQUIRED' ? 401 : 500
      if (status >= 500) {
        // 未预期异常：原始文案可能带 SQL、文件路径等内部细节，只写日志，不外泄给调用方
        console.error('[api] 未预期异常:', err)
        return res.status(500).json({ error: 'Internal server error' })
      }
      res.status(status).json({ error: (err as any)?.message || String(err) })
    })
    this.app.use((req, res) => {
      res.status(404).json({ error: 'Not found', path: req.path })
    })
  }

  /**
   * 工作台域的 REST 出口。
   *
   * 与前端走的 /local/rpc 共用同一份方法表，差别只在身份来源：
   * 这里是 api_keys（机器凭证），所以交给 RPC 时带 trusted 跳过人工会话。
   * MCP / 未来的 LLM 网关都从这里拿结构化数据。
   */
  private setupWorkbenchRoutes() {
    const rpc = createWorkbenchRpc({ ...(this.workbenchDomains as Omit<WorkbenchRpcDeps, 'clientId' | 'trusted'>), clientId: 'api', trusted: true })

    /**
     * 调用工作台 RPC。
     *
     * 工作台域的错误目前只有「throw new Error(中文说明)」一种形态（见 rpcHandlers / taskService），
     * 「任务不存在」「任务优先级无效」与真正的内部故障无法从 `Error` 上区分。本轮不改该域的错误类型，
     * 因此这里保持该域对外的既有行为（400），避免把校验类错误吞成 500；
     * 待该域引入带状态码的错误类型后，应去掉这层包装、改由中间件统一分级。
     */
    const call = (method: string, ...args: any[]) => {
      const fn = rpc[method]
      if (!fn) throw new ApiError(400, `未知方法: ${method}`)
      const relay = (e: any): never => { throw new ApiError(400, e?.message || String(e)) }
      try {
        const out = fn(...args)
        // 部分方法（如 workbench.search）是异步的，拒绝同样要落在这层映射里，否则会变成 500
        return out instanceof Promise ? out.catch(relay) : out
      } catch (e) {
        relay(e)
      }
    }

    // reader 角色的密钥只允许调用只读方法（方法名末段可判定）
    const assertWriteAllowed = async (req: express.Request, method: string) => {
      if (!(await this.securityService.getStatus()).enabled) return
      const token = String(req.headers['x-api-key'] || String(req.headers.authorization || '').slice(7))
      const isRead = READ_METHOD_SUFFIXES.has(method.split('.').pop() || '')
      if (!isRead && (await this.securityService.getApiKeyRole(token)) === 'reader') {
        // 与改造前状态码保持一致（400）：本轮只调整非鉴权类错误的映射，鉴权/权限类响应不动
        throw new ApiError(400, '此密钥没有写入权限')
      }
    }

    this.app.post('/api/v1/workbench/rpc', this.authenticate.bind(this), this.route(async (req, res) => {
      const { method, args } = req.body || {}
      if (!method) return res.status(400).json({ error: 'Missing "method" in body' })
      await assertWriteAllowed(req, String(method))
      res.json(await call(String(method), ...(Array.isArray(args) ? args : [])))
    }))

    this.app.get('/api/v1/workbench/dashboard', this.authenticate.bind(this), this.route(async (_req, res) => {
      res.json(call('workbench.dashboard'))
    }))

    this.app.get('/api/v1/workbench/tasks', this.authenticate.bind(this), this.route(async (req, res) => {
      res.json(req.query.group === 'tree' ? call('task.groups') : call('task.list'))
    }))

    this.app.get('/api/v1/workbench/projects', this.authenticate.bind(this), this.route(async (_req, res) => {
      res.json(call('workbench.project.list'))
    }))

    this.app.get('/api/v1/workbench/projects/:id/tasks', this.authenticate.bind(this), this.route(async (req, res) => {
      res.json(call('workbench.project.tasks', req.params.id))
    }))

    // 跨域时间线：任务截止 + 文档入库同一条流（ADR-003 跨域打通）
    this.app.get('/api/v1/workbench/timeline', this.authenticate.bind(this), this.route(async (req, res) => {
      res.json(call('workbench.timeline', { days: req.query.days, limit: req.query.limit }))
    }))

    /** 统一检索：任务/项目/工作台文件与知识文档一次返回，文档部分保留 ResultSet 信封。 */
    this.app.get('/api/v1/workbench/search', this.authenticate.bind(this), this.route(async (req, res) => {
      const query = String(req.query.q || '').trim()
      if (!query) return res.status(400).json({ error: 'Missing query parameter "q"' })
      res.json(await call('workbench.search', query, {
        limit: req.query.limit,
        source_id: req.query.source_id,
        folder_path: req.query.folder_path,
        project_id: req.query.project_id,
      }))
    }))
  }

  private setupWebSocket() {
    this.wss = new WebSocketServer({ server: this.server, path: '/ws' })

    this.wss.on('connection', (ws: any, req: any) => {
      const sessionId = uuidv4()
      this.connectedClients.add(ws)

      this.db.prepare(`
        INSERT INTO agent_sessions (id, agent_name, agent_type, status)
        VALUES (?, 'unknown', 'custom', 'active')
      `).run(sessionId)

      ws.send(JSON.stringify({
        event: 'session.connected',
        data: { session_id: sessionId }
      }))

      ws.on('message', (message: string) => {
        try {
          const data = JSON.parse(message)
          if (data.type === 'register') {
            this.db.prepare('UPDATE agent_sessions SET agent_name = ?, agent_type = ? WHERE id = ?')
              .run(data.name || 'unknown', data.type || 'custom', sessionId)
          }
          this.db.prepare('UPDATE agent_sessions SET last_active_at = CURRENT_TIMESTAMP, queries_count = queries_count + 1 WHERE id = ?')
            .run(sessionId)
        } catch (e) {
          console.error('WebSocket message error:', e)
        }
      })

      ws.on('close', () => {
        this.connectedClients.delete(ws)
        this.db.prepare('UPDATE agent_sessions SET status = ?, last_active_at = CURRENT_TIMESTAMP WHERE id = ?')
          .run('disconnected', sessionId)
      })
    })
  }

  broadcastEvent(event: string, data: any) {
    const message = JSON.stringify({
      event,
      timestamp: new Date().toISOString(),
      data
    })
    this.connectedClients.forEach(client => {
      if (client.readyState === 1) {
        client.send(message)
      }
    })
  }

  async start(port: number = 17890): Promise<void> {
    this.port = port
    return new Promise((resolve, reject) => {
      this.server.once('error', reject)
      this.server.listen(port, '127.0.0.1', () => {
        this.isRunningFlag = true
        this.server.removeListener('error', reject)
        this.setupWebSocket()
        console.log(`SD API Server running on http://127.0.0.1:${port}`)
        resolve()
      })
    })
  }

  async stop(): Promise<void> {
    if (this.wss) {
      this.connectedClients.forEach(client => client.close())
      this.wss.close()
    }
    if (this.server.listening) await new Promise<void>(resolve => this.server.close(() => resolve()))
    this.isRunningFlag = false
  }

  isRunning(): boolean {
    return this.isRunningFlag
  }
}
