import express from 'express'
import multer from 'multer'
import * as path from 'path'
import * as fs from 'fs'
import { randomBytes } from 'crypto'
import { createRuntime } from './services/runtime'
import { QUEUE_PRIORITY } from './services/processingQueue'
import { APIServer } from './services/apiServer'
import { createWorkbenchRpc } from './services/workbench/rpcHandlers'

async function main() {
  const dataDir = process.env.SD_DATA_PATH || path.resolve(__dirname, '../Data')
  const r = await createRuntime(dataDir)
  const api = new APIServer(r.db, r.files, r.search, r.graph, r.security, r.processing, {
    workbench: r.workbench, tasks: r.tasks, auth: r.auth, reminders: r.reminders, dataManager: r.dataManager, search: r.search,
    llm: r.llm, llmService: r.llmService, answer: r.answer, camera: r.camera,
  })
  const settings = await r.db.getSettings()
  let apiError = ''
  if (settings.api_enabled === 'true') await api.start(Number(settings.api_port)).catch(e => { apiError = e.message })
  const app = express()
  const token = randomBytes(32).toString('hex')
  app.use(express.json())
  // 仅放行本机开发 origins（Vite 5173 等）：经 Vite 代理的 SSE 响应即使完整收完，
  // Chromium 也会记一条 net::ERR_ABORTED——开发态前端直连本端口绕开代理（api.ts 的 VITE_RPC_ORIGIN）。
  // 生产 Web 构建由本服务托管静态文件，同源请求不携带 origin，不受影响。
  app.use((req, res, next) => {
    const origin = req.headers.origin as string | undefined
    if (origin && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin)
      res.setHeader('Vary', 'Origin')
      if (req.method === 'OPTIONS') {
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-SD-Session')
        res.setHeader('Access-Control-Max-Age', '600')
        return res.sendStatus(204)
      }
    }
    next()
  })
  app.get('/local/session', (_req, res) => res.json({ token }))
  app.use('/local', (req, res, next) => {
    if (req.headers['x-sd-session'] !== token) return res.status(403).json({ error: '无效的本地会话，请刷新页面' })
    next()
  })
  const uploadDir = path.join(dataDir, 'uploads')
  fs.mkdirSync(uploadDir, { recursive: true })
  const upload = multer({ dest: uploadDir, limits: { fileSize: 500 * 1048576, files: 100 }, preservePath: false })
  app.post('/local/upload', upload.array('files'), async (req, res, next) => {
    const uploads = req.files as Express.Multer.File[]
    const staged: string[] = []
    try {
      for (const file of uploads) {
        const dir = file.path + '-source'
        fs.mkdirSync(dir)
        const target = path.join(dir, path.basename(Buffer.from(file.originalname, 'latin1').toString('utf8')))
        fs.renameSync(file.path, target)
        staged.push(target)
      }
      res.json(await r.importFiles(staged))
    } catch (e) { next(e) }
    finally { for (const file of staged) { fs.unlinkSync(file); fs.rmdirSync(path.dirname(file)) } }
  })
  const handlers: Record<string, (...args: any[]) => any> = {
    // 工作台域（含登录 / 备份）与桌面端共用同一份方法表，避免两端走偏
    ...createWorkbenchRpc({ ...r, clientId: token }),
    'dashboard.stats': async () => ({ ...await r.db.getDashboardStats(), api_running: api.isRunning(), api_error: apiError, api_port: (await r.db.getSettings()).api_port }),
    'dashboard.recent': () => r.db.getRecentFiles(),
    'file.list': f => r.files.listFiles(f), 'file.detail': id => r.files.getFileDetail(id),
    'file.delete': id => { if (r.isQueued(id)) throw new Error('文件正在解析，请完成后删除'); return r.files.deleteFile(id) },
    'file.process': id => { r.enqueue(id, QUEUE_PRIORITY.manual); return { success: true } },
    'folder.list': () => r.folderSources.listSources(),
    'folder.preview': (rootPath: string, options: any) => r.folderSources.previewScan(rootPath, options || {}),
    'folder.create': (payload: any) => r.folderSources.createSource(payload || {}),
    'folder.update': (id: number, patch: any) => r.folderSources.updateSource(id, patch || {}),
    'folder.remove': (id: number, deleteDocuments = false) => r.folderSources.removeSource(id, { deleteDocuments }),
    'folder.sync': (id: number) => r.folderSources.syncSource(id),
    'folder.syncAll': () => r.folderSources.syncAllSources(),
    'folder.cleanup': (id?: number) => r.folderSources.cleanupUnavailable(id),
    'folder.listFolders': (sourceId?: number) => r.folderSources.listFolders(sourceId ?? null),
    'queue.status': () => r.queueStatus(),
    'project.list': () => r.files.listProjects(),
    'project.create': (n: string, d: string, c: string) => {
      if (!n?.trim()) throw new Error('项目名称不能为空')
      return r.files.createProject(n.trim(), d || '', c || '#6366f1')
    },
    'project.update': (id: number, n: string, d: string, c: string) => r.files.updateProject(id, n, d, c),
    'project.remove': (id: number) => r.files.deleteProject(id),
    'project.assign': (docId: number, projectId: number | null) =>
      projectId == null ? r.files.removeFromProject(docId) : r.files.assignToProject(docId, projectId),
    'project.assignMany': (docIds: number[], projectId: number | null) =>
      r.files.assignManyToProject(docIds, projectId),
    'search.fulltext': (q, f) => r.search.fullTextSearch(q, f),
    'search.semantic': (q, o) => r.search.semanticSearch(q, o),
    'search.hybrid': (q, o) => r.search.hybridSearch(q, o),
    'search.savedList': () => r.search.listSavedSearches(),
    'search.savedCreate': (i: any) => r.search.saveSearch(i || {}),
    'search.savedRemove': (id: number) => r.search.removeSavedSearch(Number(id)),
    'search.savedRerun': (id: number) => r.search.rerunSavedSearch(Number(id)),
    'graph.nodes': f => r.graph.getNodes(f), 'graph.edges': f => r.graph.getEdges(f),
    'graph.overview': () => r.graph.getOverview(),
    'graph.bridges': o => r.graph.getBridges(o || {}),
    'graph.entities': o => r.graph.getEntities(o || {}),
    'graph.entity': n => r.graph.getEntityGraph(n), 'graph.stats': () => r.graph.getStats(),
    'graph.addRelationship': (st, si, tt, ti, rt) => r.graph.addRelationship(st, si, tt, ti, rt),
    'graph.deleteRelationship': id => r.graph.deleteRelationship(id),
    'graph.mergeEntities': (s, t) => r.graph.mergeEntities(s, t),
    'graph.mergeEntitiesBatch': (ids, t) => r.graph.mergeEntitiesBatch(ids, t),
    'graph.renameEntity': (id, n, t) => r.graph.renameEntity(id, n, t),
    'graph.batchRenameEntities': items => r.graph.batchRenameEntities(items),
    'graph.searchNodes': (q, l) => r.graph.searchNodes(q, l),
    'graph.searchEntities': (q, l) => r.graph.searchEntities(q, l),
    'graph.suggestEntityMerges': o => r.graph.suggestEntityMerges(o),
    // S2-08：实体别名 / 合并历史 / 忽略记忆
    'graph.listAliases': (id?: number) => r.graph.listAliases(id),
    'graph.addAlias': (id: number, alias: string) => r.graph.addAlias(id, alias),
    'graph.removeAlias': (id: number) => r.graph.removeAlias(id),
    'graph.listMergeHistory': (l?: number) => r.graph.listMergeHistory(l),
    'graph.ignoreMergeSuggestion': (a: string, b: string) => r.graph.ignoreMergeSuggestion(a, b),
    'graph.listIgnoredMergePairs': () => r.graph.listIgnoredMergePairs(),
    'settings.get': () => r.db.getSettings(),
    'settings.update': async s => {
      if (s.api_port && (!Number.isInteger(Number(s.api_port)) || Number(s.api_port) < 1024 || Number(s.api_port) > 65535)) throw new Error('端口必须为 1024–65535 的整数')
      if (s.queue_concurrency != null && s.queue_concurrency !== '' && (!Number.isInteger(Number(s.queue_concurrency)) || Number(s.queue_concurrency) < 1 || Number(s.queue_concurrency) > 32)) throw new Error('解析并发度必须为 1–32 的整数')
      const result = await r.db.updateSettings(s)
      const current = await r.db.getSettings()
      if ('queue_concurrency' in s) r.setQueueConcurrency(Number(current.queue_concurrency))
      if ('api_port' in s || 'api_enabled' in s) {
        await api.stop(); apiError = ''
        if (current.api_enabled === 'true') await api.start(Number(current.api_port)).catch(e => { apiError = e.message; throw e })
      }
      return result
    },
    'security.status': () => r.security.getStatus(), 'security.setup': p => r.security.setup(p),
    'security.verify': p => r.security.verify(p), 'security.apiKeys.list': () => r.security.listApiKeys(),
    'security.apiKeys.create': (n, role) => r.security.createApiKey(n, role),
    'security.apiKeys.revoke': id => r.security.revokeApiKey(id),
    'audit.list': f => r.security.getAuditLogs(f),
    // S2-10：审计保留天数与清理
    'audit.retentionGet': () => r.security.getAuditRetentionDays(),
    'audit.retentionSet': (days: number) => r.security.setAuditRetentionDays(days),
    'audit.prune': () => r.security.pruneAuditLogs(),
    // S2-02：分析页聚合（知识库规模 + 入库/命中趋势）
    'analytics.overview': (options?: { days?: number }) => r.db.getAnalyticsOverview(options?.days),
    // S2-05：共享快照导出（自包含 JSON，剥离密钥/明文敏感字段）
    'share.exportSnapshot': () => r.backup.exportSnapshot(r.dataManager),
  }
  app.post('/local/rpc', async (req, res, next) => {
    try {
      const fn = handlers[req.body.method]
      if (!fn) return res.status(404).json({ error: '不支持的操作' })
      res.json(await fn(...(req.body.args || [])))
    } catch (e) { next(e) }
  })
  /**
   * 问答流式出口（S1-05，SSE）。
   *
   * 与 `/local/rpc` 同一鉴权口径（同在一个 `/local` 会话中间件之后，缺 `X-SD-Session` 一律 403）。
   * 逐块把 `answerService.ask({stream:true, onChunk})` 的增量推给前端，末尾再推完整结果：
   *   - `{type:'chunk', chunk}`   —— 真增量（时间上有间隔地到达，不是一次性回放）；
   *   - `{type:'result', result}` —— 完整 `AnswerResult`（引用 / 降级 / 被拒信息全在这里）；
   *   - `{type:'error', message, code}` —— 流式过程中的失败（超时 / 401 / 被拒），可读原因。
   * 客户端断开（用户离开页面或再次提问）→ 本请求 close → abort → provider 请求随即取消。
   */
  app.post('/local/ask/stream', async (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    })
    const send = (payload: Record<string, unknown>) => { if (!res.writableEnded) res.write(`data: ${JSON.stringify(payload)}\n\n`) }
    const controller = new AbortController()
    // 只在「响应还没写完、连接先断」时取消生成（writableEnded=false + close = 客户端真断开）。
    // 两个坑：① 挂 req 的 close 不行——JSON 请求体读完它就触发，会把刚开始的 LLM 调用杀成 CANCELLED；
    // ② res.end() 正常收尾也会触发 res 的 close——此时 writableEnded 已为 true，必须放行，否则误报中断。
    res.on('close', () => {
      if (!res.writableEnded) controller.abort()
    })
    try {
      const result = await r.answer.ask({
        ...(req.body || {}),
        actor: 'user',
        signal: controller.signal,
        stream: true,
        onChunk: chunk => send({ type: 'chunk', chunk }),
      })
      send({ type: 'result', result })
    } catch (e: any) {
      // 会话已断时不再写（写会抛错，且前端已不关心）
      send({ type: 'error', message: e?.message || String(e), code: e?.code || null })
    } finally {
      if (!res.writableEnded) res.end()
    }
  })
  app.use(express.static(path.resolve(__dirname, '../dist')))
  // SPA history 回退：/files、/search 这类前端路由直达时返回 index.html，由 react-router 接管。
  // API 与 /local 前缀不走回退，保持 404/JSON 语义。
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api') || req.path.startsWith('/local')) return next()
    res.sendFile(path.resolve(__dirname, '../dist', 'index.html'))
  })
  app.use((err: Error, _req: any, res: any, _next: any) => {
    const unauthenticated = err.message === 'AUTH_REQUIRED'
    res.status(unauthenticated ? 401 : 400).json({ error: unauthenticated ? '请先登录' : err.message })
  })
  const port = Number(process.env.SD_WEB_PORT || 5173)
  // 退出前把向量索引快照落盘，避免最后一次变更随进程一起丢（ADR-002 P2）
  const shutdown = () => { try { r.processing.flushIndexes() } finally { process.exit(0) } }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
  app.listen(port, '127.0.0.1', () => console.log(`SD Knowledge: http://127.0.0.1:${port} | Data: ${dataDir}`))
}
main().catch(e => { console.error(e); process.exit(1) })
