import DatabaseService from './database'
import { FileService } from './fileService'
import { ProcessingEngine } from './processingEngine'
import { SearchService } from './searchService'
import { GraphBuilder } from './graphBuilder'
import { SecurityService } from './securityService'
import { BackupService } from './backupService'
import { initPerfLog } from './perfLogger'
import { FolderSourceService } from './folderSourceService'
import { ChunkBackfillService } from './chunkBackfill'
import { ProcessingQueue, QUEUE_PRIORITY } from './processingQueue'
import { TaskRepository } from './workbench/taskRepository'
import { TaskService } from './workbench/taskService'
import { WorkbenchService } from './workbench/workbenchService'
import { AuthService } from './workbench/authService'
import { ReminderService } from './workbench/reminderService'
import { DataManager } from './workbench/dataManager'
import { LlmGateway } from './gateway/llmGateway'
import { LlmService } from './gateway/llmService'
import { AnswerService } from './answerService'
import { CameraService } from './perception/cameraService'
import * as fs from 'fs'
import * as path from 'path'

export async function createRuntime(dataDir: string) {
  fs.mkdirSync(dataDir, { recursive: true })
  initPerfLog(path.join(dataDir, 'logs'))
  const db = new DatabaseService(path.join(dataDir, 'sd.db'))
  await db.init()
  const files = new FileService(db, dataDir)
  const processing = new ProcessingEngine(db, dataDir)
  const search = new SearchService(db)
  search.setProcessingEngine(processing)
  const graph = new GraphBuilder(db)
  const security = new SecurityService(db)
  const backup = new BackupService(db, dataDir)
  backup.start()
  // 解析队列：并发 N + 优先级出队（用户交互 > 导入 > 断点恢复 > 目录映射批量）
  const queue = new ProcessingQueue({
    concurrency: Number(db.getSettingsSync().queue_concurrency),
    run: (id: number) => processing.processDocument(id),
    onEnqueue: task => db.markQueued(task.documentId, task.priority),
    onDequeue: id => db.unmarkQueued(id),
    onError: (id, error) => console.error(`[runtime] 解析失败 #${id}:`, error),
  })
  const enqueue = (id: number, priority: number = QUEUE_PRIORITY.import) => queue.enqueue(id, priority)
  const importFiles = async (paths: string[], reference = false) => {
    const results = await (reference ? files.addReferences(paths) : files.importFiles(paths))
    results.filter(r => r.success).forEach(r => enqueue(r.documentId, QUEUE_PRIORITY.import))
    return results
  }

  // 目录映射：把整个文件夹作为长期知识来源，首轮全量入库，之后按差集增量同步
  const folderSources = new FolderSourceService(db, dataDir, files, (id: number) => enqueue(id, QUEUE_PRIORITY.batch))

  // 工作台域（ADR-003）：与内核域共用一个 SQLite 文件，故 projects 表可直接被双方使用
  const workbench = new WorkbenchService(db)
  const tasks = new TaskService(new TaskRepository(db))
  const auth = new AuthService(db)
  const reminders = new ReminderService(db)
  // 工作台备份单独放一个子目录，避免与内核域的 .db 快照混在一起
  const dataManager = new DataManager(db, path.join(dataDir, 'backups', 'workbench'))

  // 对外两个接缝（ADR-003 决策 5）：此处只实例化注册表，不含任何厂商实现/设备采集。
  // 之所以现在就装配，是为了让「模型」和「摄像头」在架构上先各就各位，后续只需 register()。
  const llm = new LlmGateway()
  // S1-01：把 llm_providers 的配置翻译成 provider 注册进网关，并装配出域闸门（S1-02）
  const llmService = new LlmService(db, dataDir, llm)
  // S1-03：RAG 问答链路（混合检索 → 上下文组装 → LLM → 答案 + 引用）
  const answer = new AnswerService(search, llmService)
  const camera = new CameraService()

  // 断点续传：恢复上次异常退出时中断或仍在排队的解析任务（按持久化的优先级还原出队顺序）
  const recoverQueue = () => {
    const interrupted = db.prepare("SELECT id FROM documents WHERE processing_status = 'processing'").all() as any[]
    if (interrupted.length) {
      db.prepare("UPDATE documents SET processing_status = 'pending', processing_error = NULL WHERE processing_status = 'processing'").run()
    }
    const tasks = new Map<number, number>()
    for (const row of interrupted) tasks.set(row.id, QUEUE_PRIORITY.restore)
    for (const task of db.getQueuedTasks()) {
      if (!tasks.has(task.documentId)) tasks.set(task.documentId, task.priority)
    }
    let restored = 0
    for (const [id, priority] of tasks) {
      const doc = db.prepare('SELECT processing_status FROM documents WHERE id = ?').get(id) as any
      if (!doc || doc.processing_status === 'ready') {
        db.unmarkQueued(id)
        continue
      }
      db.prepare("UPDATE documents SET processing_status = 'pending', processing_error = NULL WHERE id = ?").run(id)
      enqueue(id, priority)
      restored++
    }
    if (restored) console.log(`[runtime] 解析队列断点续传：恢复 ${restored} 个任务`)
  }
  recoverQueue()

  // 存量 chunks 回填（D8 / 架构文档 §3.3.3 的 P-a）：后台分批执行，不阻塞启动。
  // 已全部完成（settings.chunks_backfill_done='true'）时 run() 直接返回，不做全表扫描。
  const chunkBackfill = new ChunkBackfillService(db, processing, dataDir)
  const runChunkBackfill = () => chunkBackfill.run().catch(e => console.error('[runtime] chunks 回填失败:', e))
  const backfillTimer = setTimeout(() => {
    try { void runChunkBackfill() } catch (e) { console.error('[runtime] chunks 回填启动失败:', e) }
  }, 1500)
  backfillTimer.unref?.()

  // 提醒轮询：到点即落一条通知，前端通知中心直接读 notifications 表
  const reminderTimer = setInterval(() => {
    try {
      reminders.claimDue().forEach(item => {
        db.prepare("INSERT INTO notifications (type, title, message) VALUES ('reminder', ?, ?)").run(item.title, item.taskCode || '')
      })
      workbench.refreshDeadlineNotifications()
    } catch (error) {
      console.error('[runtime] 提醒轮询失败:', error)
    }
  }, 60_000)
  reminderTimer.unref?.()

  return {
    isQueued: (id: number) => queue.isQueued(id),
    db, files, processing, search, graph, security, backup,
    workbench, tasks, auth, reminders, dataManager,
    llm, llmService, answer, camera,
    chunkBackfill,
    runChunkBackfill,
    stopReminders: () => clearInterval(reminderTimer),
    enqueue, importFiles, folderSources,
    setQueueConcurrency: (value: number) => queue.setConcurrency(value),
    queueStatus: () => queue.status(),
    idle: () => queue.idle(),
  }
}
