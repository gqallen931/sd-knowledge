import { app, BrowserWindow, ipcMain, dialog, shell, Tray, Menu, nativeImage } from 'electron'
import * as path from 'path'
import * as fs from 'fs'
import DatabaseService from './services/database'
import { APIServer } from './services/apiServer'
import { FileService } from './services/fileService'
import { ProcessingEngine } from './services/processingEngine'
import { GraphBuilder } from './services/graphBuilder'
import { SearchService } from './services/searchService'
import { SecurityService } from './services/securityService'
import { FileWatcher } from './services/fileWatcher'
import { BackupService } from './services/backupService'
import { setPerfSink } from './services/perfLogger'
import { FolderSourceService } from './services/folderSourceService'
import { ProcessingQueue, QUEUE_PRIORITY } from './services/processingQueue'
import { TaskRepository } from './services/workbench/taskRepository'
import { TaskService } from './services/workbench/taskService'
import { WorkbenchService } from './services/workbench/workbenchService'
import { AuthService } from './services/workbench/authService'
import { ReminderService } from './services/workbench/reminderService'
import { DataManager } from './services/workbench/dataManager'
import { createWorkbenchRpc } from './services/workbench/rpcHandlers'
import { LlmGateway } from './services/gateway/llmGateway'
import { LlmService } from './services/gateway/llmService'
import { AnswerService } from './services/answerService'
import { ResourceService } from './services/resourceService'
import { CameraService } from './services/perception/cameraService'

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let apiServer: APIServer | null = null
let db: DatabaseService
let fileService: FileService
let processingEngine: ProcessingEngine
let graphBuilder: GraphBuilder
let searchService: SearchService
let securityService: SecurityService
let fileWatcher: FileWatcher
let backupService: BackupService
let folderSourceService: FolderSourceService
let queue: ProcessingQueue
// 工作台域（ADR-003）：与内核域共用同一个 sd.db
let workbenchService: WorkbenchService
let taskService: TaskService
let authService: AuthService
let reminderService: ReminderService
let dataManager: DataManager
let llmGateway: LlmGateway
let llmService: LlmService
let answerService: AnswerService
let resourceService: ResourceService
let cameraService: CameraService
const DESKTOP_CLIENT_ID = 'desktop'
let reminderTimer: NodeJS.Timeout | null = null

const isDev = process.env.NODE_ENV === 'development'
let apiError = ''
let minimizeToTray = true
let logDir = ''

const LOG_RETAIN_DAYS = 7
const LOG_NAME_RE = /^main-(\d{4}-\d{2}-\d{2})\.log$/
let lastLogDate = ''

function currentLogDate(d = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function cleanupOldLogs(dir: string) {
  try {
    const cutoff = Date.now() - LOG_RETAIN_DAYS * 24 * 60 * 60 * 1000
    let removed = 0
    for (const name of fs.readdirSync(dir)) {
      if (!LOG_NAME_RE.test(name)) continue
      const full = path.join(dir, name)
      try {
        if (fs.statSync(full).mtimeMs < cutoff) { fs.unlinkSync(full); removed++ }
      } catch { /* 单个文件删除失败忽略 */ }
    }
    if (removed) logToFile('info', `清理过期日志 ${removed} 个（保留 ${LOG_RETAIN_DAYS} 天）`)
  } catch { /* 目录不可读忽略 */ }
}

function logToFile(level: 'info' | 'warn' | 'error', message: string) {
  try {
    const dir = logDir || path.join(app.getPath('userData'), 'logs')
    fs.mkdirSync(dir, { recursive: true })
    const today = currentLogDate()
    fs.appendFileSync(path.join(dir, `main-${today}.log`), `[${new Date().toISOString()}] [${level}] ${message}\n`)
    if (lastLogDate !== today) {
      lastLogDate = today
      cleanupOldLogs(dir)
    }
  } catch { /* 日志写入失败不中断主流程 */ }
}

function handle(channel: string, fn: (...args: any[]) => any) {
  ipcMain.handle(channel, async (...args: any[]) => {
    try {
      return await fn(...args)
    } catch (err: any) {
      const message = err instanceof Error ? err.message : String(err)
      logToFile('error', `IPC ${channel} 失败: ${message}`)
      throw new Error(message)
    }
  })
}

process.on('uncaughtException', (err) => {
  logToFile('error', `UncaughtException: ${err?.stack || err}`)
})
process.on('unhandledRejection', (reason: any) => {
  logToFile('error', `UnhandledRejection: ${reason?.stack || reason}`)
})

/**
 * 入队解析。优先级：手动重新解析 > 导入/引用 > 断点恢复 > 目录映射批量，
 * 让用户交互任务能插到大批量后台任务前面；同一文档重复入队只提升优先级，不重复执行。
 */
function enqueue(id: number, priority: number = QUEUE_PRIORITY.import) {
  queue.enqueue(id, priority)
}

function recoverInterruptedProcessing() {
  const interrupted = db.prepare("SELECT id, file_name FROM documents WHERE processing_status = 'processing'").all() as any[]
  if (interrupted.length) {
    db.prepare("UPDATE documents SET processing_status = 'pending', processing_error = NULL WHERE processing_status = 'processing'").run()
  }

  // 队列持久化恢复：上次退出时仍处于排队状态（pending/中断未收尾）的任务，按持久化优先级还原出队顺序
  const pendingTasks = new Map<number, number>()
  for (const row of interrupted) pendingTasks.set(row.id, QUEUE_PRIORITY.restore)
  for (const task of db.getQueuedTasks()) {
    if (!pendingTasks.has(task.documentId)) pendingTasks.set(task.documentId, task.priority)
  }
  if (!pendingTasks.size) return

  let restored = 0
  let skipped = 0
  for (const [id, priority] of pendingTasks) {
    const doc = db.prepare('SELECT id, file_name, processing_status FROM documents WHERE id = ?').get(id) as any
    if (!doc || doc.processing_status === 'ready') {
      db.unmarkQueued(id)
      skipped++
      continue
    }
    db.prepare("UPDATE documents SET processing_status = 'pending', processing_error = NULL WHERE id = ?").run(id)
    logToFile('info', `恢复上次异常退出时中断的解析任务: #${id} ${doc.file_name}`)
    enqueue(id, priority)
    restored++
  }
  logToFile('info', `解析队列断点续传完成：恢复 ${restored} 个任务，跳过 ${skipped} 个已失效条目`)
}

function getDataDir(): string {
  const dataDir = process.env.SD_DATA_PATH || (isDev ? path.resolve(__dirname, '../Data') : path.join(app.getPath('userData'), 'Data'))

  const fs = require('fs')
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true })
  }
  const subDirs = ['files/documents', 'files/spreadsheets', 'files/images', 'files/videos', 'files/others', 'references', 'thumbnails', 'indexes', 'backups', 'logs']
  subDirs.forEach(d => {
    const dir = path.join(dataDir, d)
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  })
  return dataDir
}

function getLogDir(dataDir: string): string {
  return path.join(dataDir, 'logs')
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    title: 'SD 知识图谱数据管理',
    backgroundColor: '#0B0C0E',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    },
    show: false,
    icon: path.join(__dirname, '../resources/icon.png')
  })

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show()
  })

  if (isDev) {
    mainWindow.loadURL('http://localhost:5173')
    mainWindow.webContents.openDevTools()
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'))
  }

  mainWindow.on('close', (e) => {
    if (tray && minimizeToTray && !(app as any).isQuitting) {
      e.preventDefault()
      mainWindow?.hide()
    }
  })
}

function createTray() {
  try {
    const iconPath = path.join(__dirname, '../resources/tray-icon.png')
    let trayIcon = nativeImage.createFromPath(iconPath)
    if (trayIcon.isEmpty()) {
      trayIcon = nativeImage.createEmpty()
    }
    tray = new Tray(trayIcon)
    const contextMenu = Menu.buildFromTemplate([
      { label: '打开主窗口', click: () => mainWindow?.show() },
      { label: 'API 服务状态', click: () => {
        const status = apiServer?.isRunning() ? '运行中' : '已停止'
        dialog.showMessageBox(mainWindow!, { message: `API 服务: ${status}\n地址: 127.0.0.1:17890` })
      }},
      { type: 'separator' },
      { label: '退出', click: () => {
        (app as any).isQuitting = true
        app.quit()
      }}
    ])
    tray.setContextMenu(contextMenu)
    tray.setToolTip('SD 知识图谱数据管理')
    tray.on('click', () => mainWindow?.show())
  } catch (err: any) {
    tray = null
    logToFile('warn', `系统托盘创建失败，已降级为常规窗口模式: ${err?.message || err}`)
  }
}

function registerIPC() {
  handle('file:import', async (_, filePaths: string[]) => {
    const results = await fileService.importFiles(filePaths)
    results.filter(r => r.success).forEach(r => enqueue(r.documentId, QUEUE_PRIORITY.import))
    return results
  })

  handle('file:reference', async (_, filePaths: string[]) => {
    const results = await fileService.addReferences(filePaths)
    results.filter(r => r.success).forEach(r => enqueue(r.documentId, QUEUE_PRIORITY.import))
    return results
  })

  handle('file:list', async (_, filters: any) => {
    return await fileService.listFiles(filters)
  })

  handle('file:detail', async (_, id: number) => {
    return await fileService.getFileDetail(id)
  })

  handle('file:delete', async (_, id: number) => {
    if (queue.isQueued(id)) throw new Error('文件正在解析，请等待完成后删除')
    return await fileService.deleteFile(id)
  })
  handle('file:process', async (_, id: number) => { enqueue(id, QUEUE_PRIORITY.manual); return { success: true } })

  handle('project:list', async () => fileService.listProjects())
  handle('project:create', async (_, name: string, description: string, color: string) => {
    if (!name?.trim()) throw new Error('项目名称不能为空')
    return await fileService.createProject(name.trim(), description || '', color || '#6366f1')
  })
  handle('project:update', async (_, id: number, name: string, description: string, color: string) =>
    fileService.updateProject(id, name, description, color))
  handle('project:delete', async (_, id: number) => fileService.deleteProject(id))
  handle('project:assign', async (_, documentId: number, projectId: number | null) => {
    if (projectId == null) return await fileService.removeFromProject(documentId)
    return await fileService.assignToProject(documentId, projectId)
  })
  handle('project:assignMany', async (_, documentIds: number[], projectId: number | null) =>
    fileService.assignManyToProject(documentIds, projectId))

  handle('file:select', async () => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      properties: ['openFile', 'multiSelections']
    })
    return result.filePaths
  })

  handle('folder:select', async () => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      properties: ['openDirectory']
    })
    return result.filePaths
  })

  // 目录映射：把文件夹作为长期知识来源，而非逐个导入文件
  handle('folder:preview', async (_, rootPath: string, options: any) => folderSourceService.previewScan(rootPath, options || {}))
  handle('folder:create', async (_, payload: any) => folderSourceService.createSource(payload || {}))
  handle('folder:list', async () => folderSourceService.listSources())
  handle('folder:update', async (_, id: number, patch: any) => folderSourceService.updateSource(id, patch || {}))
  handle('folder:remove', async (_, id: number, deleteDocuments = false) => folderSourceService.removeSource(id, { deleteDocuments }))
  handle('folder:sync', async (_, id: number) => folderSourceService.syncSource(id))
  handle('folder:syncAll', async () => folderSourceService.syncAllSources())
  handle('folder:cleanup', async (_, id?: number) => folderSourceService.cleanupUnavailable(id))
  // 目录树（ADR-002）：作用域寻址的第二级，前端面包屑与图谱下钻共用
  handle('folder:listFolders', async (_, sourceId?: number) => folderSourceService.listFolders(sourceId ?? null))

  // 解析队列运行状态（进行中 / 排队中 / 当前并发度），供界面展示
  handle('queue:status', async () => queue.status())

  handle('search:fulltext', async (_, query: string, filters: any) => {
    return await searchService.fullTextSearch(query, filters)
  })

  handle('search:semantic', async (_, query: string, options: any) => {
    return await searchService.semanticSearch(query, options)
  })

  // 混合检索（RRF）：与保存检索的结果指纹同一口径，检索中心第三模式共用
  handle('search:hybrid', async (_, query: string, options: any) => {
    return await searchService.hybridSearch(query, options)
  })

  // 保存的检索（S2-07）：列表 / 保存（立即跑一次记指纹）/ 删除 / 手动重跑
  handle('search:savedList', async () => searchService.listSavedSearches())
  handle('search:savedCreate', async (_, input: any) => await searchService.saveSearch(input || {}))
  handle('search:savedRemove', async (_, id: number) => searchService.removeSavedSearch(Number(id)))
  handle('search:savedRerun', async (_, id: number) => await searchService.rerunSavedSearch(Number(id)))

  handle('graph:nodes', async (_, filters: any) => {
    return await graphBuilder.getNodes(filters)
  })

  handle('graph:edges', async (_, filters: any) => {
    return await graphBuilder.getEdges(filters)
  })

  // 分级图谱（ADR-002）：L0 全局折叠总览 + 跨域桥
  handle('graph:overview', async () => {
    return await graphBuilder.getOverview()
  })

  handle('graph:bridges', async (_, options: any) => {
    return await graphBuilder.getBridges(options || {})
  })

  handle('graph:entities', async (_, options: any) => {
    return await graphBuilder.getEntities(options || {})
  })

  handle('graph:entity', async (_, entityName: string) => {
    return await graphBuilder.getEntityGraph(entityName)
  })

  handle('graph:stats', async () => {
    return await graphBuilder.getStats()
  })

  handle('graph:addRelationship', async (_, sourceType: string, sourceId: number, targetType: string, targetId: number, relationType: string) => {
    return await graphBuilder.addRelationship(sourceType, sourceId, targetType, targetId, relationType)
  })

  handle('graph:deleteRelationship', async (_, id: number) => {
    return await graphBuilder.deleteRelationship(id)
  })

  handle('graph:mergeEntities', async (_, sourceId: number, targetId: number) => {
    return await graphBuilder.mergeEntities(sourceId, targetId)
  })

  handle('graph:mergeEntitiesBatch', async (_, sourceIds: number[], targetId: number) => {
    return await graphBuilder.mergeEntitiesBatch(sourceIds, targetId)
  })

  handle('graph:renameEntity', async (_, id: number, name: string, type?: string) => {
    return await graphBuilder.renameEntity(id, name, type)
  })

  handle('graph:batchRenameEntities', async (_, items: Array<{ id: number; name: string; type?: string }>) => {
    return await graphBuilder.batchRenameEntities(items)
  })

  handle('graph:searchNodes', async (_, query: string, limit?: number) => {
    return await graphBuilder.searchNodes(query, limit)
  })

  handle('graph:searchEntities', async (_, query: string, limit?: number) => {
    return await graphBuilder.searchEntities(query, limit)
  })

  handle('graph:suggestEntityMerges', async (_, options?: { limit?: number; minScore?: number; type?: string }) => {
    return await graphBuilder.suggestEntityMerges(options)
  })

  // ADR-007：主题社区（纯本地算法，不需要模型）
  handle('graph:communities', async (_, options?: { limit?: number }) => {
    return await graphBuilder.getCommunities(options)
  })

  handle('graph:detectCommunities', async (_, options?: { minSize?: number; maxRounds?: number }) => {
    return await graphBuilder.detectCommunities(options)
  })

  handle('graph:entityCommunity', async (_, entityId: number, limit?: number) => {
    return await graphBuilder.getEntityCommunity(entityId, limit)
  })

  handle('graph:listAliases', async (_, entityId?: number) => {
    return await graphBuilder.listAliases(entityId)
  })

  handle('graph:addAlias', async (_, entityId: number, alias: string) => {
    return await graphBuilder.addAlias(entityId, alias)
  })

  handle('graph:removeAlias', async (_, id: number) => {
    return await graphBuilder.removeAlias(id)
  })

  handle('graph:listMergeHistory', async (_, limit?: number) => {
    return await graphBuilder.listMergeHistory(limit)
  })

  handle('graph:ignoreMergeSuggestion', async (_, nameA: string, nameB: string) => {
    return await graphBuilder.ignoreMergeSuggestion(nameA, nameB)
  })

  handle('graph:listIgnoredMergePairs', async () => {
    return await graphBuilder.listIgnoredMergePairs()
  })

  handle('dashboard:stats', async () => {
    return { ...await db.getDashboardStats(), api_running: apiServer?.isRunning(), api_port: (await db.getSettings()).api_port, api_error: apiError }
  })

  handle('dashboard:recent', async () => {
    return await db.getRecentFiles(10)
  })

  handle('settings:get', async () => {
    return await db.getSettings()
  })

  handle('settings:update', async (_, settings: any) => {
    const numericRules: Record<string, { min: number; max: number; label: string }> = {
      api_port: { min: 1024, max: 65535, label: 'API 端口' },
      max_file_size: { min: 1, max: 10240, label: '文件大小上限(MB)' },
      backup_interval: { min: 1, max: 10080, label: '备份间隔(小时)' },
      backup_count: { min: 1, max: 100, label: '备份保留数' },
      max_versions: { min: 1, max: 100, label: '版本保留数' },
      rate_limit: { min: 1, max: 10000, label: '速率限制(次/分钟)' },
      queue_concurrency: { min: 1, max: 32, label: '解析并发度' }
    }
    for (const [key, rule] of Object.entries(numericRules)) {
      if (key in settings && settings[key] !== '' && settings[key] != null) {
        const num = Number(settings[key])
        if (!Number.isInteger(num) || num < rule.min || num > rule.max) {
          throw new Error(`${rule.label}必须为 ${rule.min}–${rule.max} 的整数`)
        }
      }
    }
    const result = await db.updateSettings(settings)
    const current = await db.getSettings()
    minimizeToTray = current.minimize_to_tray === 'true'
    app.setLoginItemSettings({ openAtLogin: current.auto_start === 'true' })
    if ('api_port' in settings || 'api_enabled' in settings) {
      await apiServer?.stop(); apiError = ''
      if (current.api_enabled === 'true') await apiServer?.start(Number(current.api_port)).catch(e => { apiError = e.message; throw e })
    }
    if ('backup_interval' in settings) backupService?.restart()
    // 并发度立即生效：调大立即补位，调小不打断进行中的任务
    if ('queue_concurrency' in settings) queue.setConcurrency(Number(current.queue_concurrency))
    return result
  })

  handle('security:status', async () => {
    return await securityService.getStatus()
  })

  handle('security:setup', async (_, password: string) => {
    return await securityService.setup(password)
  })

  handle('security:verify', async (_, password: string) => {
    return await securityService.verify(password)
  })

  handle('security:apikey:list', async () => {
    return await securityService.listApiKeys()
  })

  handle('security:apikey:create', async (_, name: string, role: string) => {
    return await securityService.createApiKey(name, role)
  })

  handle('security:apikey:revoke', async (_, id: number) => {
    return await securityService.revokeApiKey(id)
  })

  handle('audit:list', async (_, filters: any) => {
    return await securityService.getAuditLogs(filters)
  })

  // S2-10：审计保留天数与清理（清理前自动快照到 backups/audit/）
  handle('audit:retentionGet', async () => {
    return await securityService.getAuditRetentionDays()
  })

  handle('audit:retentionSet', async (_, days: number) => {
    return await securityService.setAuditRetentionDays(days)
  })

  handle('audit:prune', async () => {
    return await securityService.pruneAuditLogs()
  })

  // S2-02：分析页聚合（知识库规模 + 入库/命中趋势）
  handle('analytics:overview', async (_, options?: { days?: number }) => {
    return await db.getAnalyticsOverview(options?.days)
  })

  // S2-05：共享快照导出（自包含 JSON，剥离密钥/明文敏感字段，落 Data/exports/）
  handle('share:exportSnapshot', async () => {
    return backupService.exportSnapshot(dataManager)
  })

  // 工作台域：与 Web 入口共用同一份方法表（services/workbench/rpcHandlers.ts），
  // 所有方法走一个通道，避免每加一个接口就改三处（方法表 / preload / 前端门面）
  const workbenchRpc = createWorkbenchRpc({
    workbench: workbenchService,
    tasks: taskService,
    auth: authService,
    reminders: reminderService,
    dataManager,
    search: searchService,
    llm: llmGateway, llmService, answer: answerService, camera: cameraService,
    resources: resourceService,
    clientId: DESKTOP_CLIENT_ID,
  })
  handle('workbench:rpc', async (_, method: string, args: any[] = []) => {
    const fn = workbenchRpc[method]
    if (!fn) throw new Error(`不支持的操作: ${method}`)
    return await fn(...(Array.isArray(args) ? args : []))
  })

  /**
   * 问答流式（S1-05，桌面通道）。
   *
   * 与 Web 的 `/local/ask/stream`（SSE）**共用同一个 `answerService.ask({stream:true, onChunk})`**，
   * 差别只在出口形态：这里把每块增量用 `webContents.send('chat:stream:chunk')` 推给渲染进程，
   * 最终结果仍由这次 invoke 的返回值带回（不伪造逐字动画，块到达节奏由 provider 决定）。
   * 取消：渲染进程换题/离开页面时调 `chat:askStreamCancel`，对应 AbortController 立刻中止 provider 请求。
   */
  const askControllers = new Map<string, AbortController>()
  handle('chat:askStream', async (event: any, requestId: string, payload: any) => {
    const request = String(requestId || '')
    if (!request) throw new Error('缺少请求标识')
    const controller = new AbortController()
    askControllers.set(request, controller)
    try {
      return await answerService.ask({
        ...(payload || {}),
        actor: 'user',
        signal: controller.signal,
        stream: true,
        onChunk: chunk => { if (!event.sender.isDestroyed()) event.sender.send('chat:stream:chunk', { requestId: request, chunk }) },
      })
    } finally {
      askControllers.delete(request)
    }
  })
  handle('chat:askStreamCancel', async (_event: any, requestId: string) => {
    askControllers.get(String(requestId || ''))?.abort()
    return true
  })

  handle('shell:openPath', async (_, filePath: string) => {
    shell.openPath(filePath)
  })

  handle('shell:showItemInFolder', async (_, filePath: string) => {
    shell.showItemInFolder(filePath)
  })
}

if (process.argv.includes('--mcp')) {
  require('./mcpEntry')
} else app.whenReady().then(async () => {
  const dataDir = getDataDir()
  logDir = getLogDir(dataDir)
  // 分阶段耗时埋点并入主日志（受设置项 perf_log_enabled 控制）
  setPerfSink(line => logToFile('info', line))
  logToFile('info', `应用启动 (v${app.getVersion()}, electron ${process.versions.electron})`)

  db = new DatabaseService(path.join(dataDir, 'sd.db'))
  await db.init()

  securityService = new SecurityService(db, path.join(dataDir, 'backups', 'audit'))
  fileService = new FileService(db, dataDir)
  searchService = new SearchService(db)
  graphBuilder = new GraphBuilder(db)
  processingEngine = new ProcessingEngine(db, dataDir)
  fileWatcher = new FileWatcher(db)
  backupService = new BackupService(db, dataDir)

  workbenchService = new WorkbenchService(db)
  taskService = new TaskService(new TaskRepository(db))
  authService = new AuthService(db)
  reminderService = new ReminderService(db)
  dataManager = new DataManager(db, path.join(dataDir, 'backups', 'workbench'))

  // 对外接缝（ADR-003 决策 5）：只实例化注册表，厂商实现后续 register() 即可
  llmGateway = new LlmGateway()
  // S1-01：从 llm_providers 装配默认 provider，并挂出域闸门（S1-02）
  llmService = new LlmService(db, dataDir, llmGateway)
  // S1-03：RAG 问答链路（S2-09：查询日志落 agent_query_logs）
  answerService = new AnswerService(searchService, llmService, row => db.logAgentQuery(row))
  // 开源资源汇：卡片式展示收集的开源模型/技能/工具
  resourceService = new ResourceService(db)
  cameraService = new CameraService()

  searchService.setProcessingEngine(processingEngine)

  // S2-07：文档状态落定后比对保存的检索；批量导入用 5s 防抖合并，避免混合检索被打满
  let savedCheckTimer: ReturnType<typeof setTimeout> | null = null
  const scheduleSavedSearchCheck = () => {
    if (savedCheckTimer) clearTimeout(savedCheckTimer)
    savedCheckTimer = setTimeout(() => {
      savedCheckTimer = null
      void searchService.checkSavedSearches().catch(() => { /* 失败不影响解析主流程 */ })
    }, 5000)
    savedCheckTimer.unref?.()
  }
  // 解析队列：并发 N + 优先级出队。长文档推理期间，其它文档可并行完成解析与写库，不再严格 FIFO 干等。
  queue = new ProcessingQueue({
    concurrency: Number((await db.getSettings()).queue_concurrency),
    run: async id => {
      await processingEngine.processDocument(id)
      scheduleSavedSearchCheck()
    },
    onEnqueue: task => db.markQueued(task.documentId, task.priority),
    onDequeue: id => db.unmarkQueued(id),
    onError: (id, error: any) => {
      console.error(error)
      logToFile('error', `解析文档 #${id} 失败: ${error?.message || error}`)
    },
  })

  // 目录映射属于后台批量任务，用低优先级入队，让位给导入 / 手动重新解析
  folderSourceService = new FolderSourceService(db, dataDir, fileService, (id: number) => enqueue(id, QUEUE_PRIORITY.batch))

  apiServer = new APIServer(db, fileService, searchService, graphBuilder, securityService, processingEngine, {
    workbench: workbenchService, tasks: taskService, auth: authService, reminders: reminderService, dataManager, search: searchService,
    llm: llmGateway, llmService, answer: answerService, camera: cameraService,
  })
  const settings = await db.getSettings()
  minimizeToTray = settings.minimize_to_tray === 'true'
  if (settings.api_enabled === 'true') await apiServer.start(Number(settings.api_port)).catch(e => { apiError = e.message })

  registerIPC()
  createWindow()
  createTray()

  fileWatcher.start()
  backupService.start()

  // 提醒轮询：到点落一条通知，前端通知中心直接读 notifications
  reminderTimer = setInterval(() => {
    try {
      reminderService.claimDue().forEach(item => {
        db.prepare("INSERT INTO notifications (type, title, message) VALUES ('reminder', ?, ?)").run(item.title, item.taskCode || '')
      })
      workbenchService.refreshDeadlineNotifications()
    } catch (err: any) {
      logToFile('error', `提醒轮询失败: ${err?.message || err}`)
    }
  }, 60_000)

  recoverInterruptedProcessing()

  // 映射目录增量同步：延后执行，避免与首屏渲染、队列续传抢占资源
  if (settings.folder_sync_on_start === 'true') {
    setTimeout(() => {
      folderSourceService.syncAllSources()
        .then(res => {
          const added = res.results.reduce((sum, r) => sum + r.added, 0)
          const updated = res.results.reduce((sum, r) => sum + r.updated, 0)
          if (res.synced) logToFile('info', `映射目录同步完成：${res.synced} 个来源，新增 ${added}，更新 ${updated}`)
          res.errors.forEach(e => logToFile('warn', `映射目录同步失败 #${e.sourceId}: ${e.error}`))
        })
        .catch(e => logToFile('error', `映射目录同步异常: ${e?.message || e}`))
    }, 3000)
  }
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    if (tray) {
      return
    }
    app.quit()
  }
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow()
  }
})

app.on('before-quit', () => {
  (app as any).isQuitting = true
  if (reminderTimer) clearInterval(reminderTimer)
  processingEngine?.flushIndexes()
  apiServer?.stop()
  fileWatcher?.stop()
  backupService?.stop()
})
