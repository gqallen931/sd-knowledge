/**
 * 解析队列调度器：并发 N + 优先级出队。
 *
 * 背景：原实现是 `promise = promise.then(...)` 的严格串行 FIFO，一篇长文档会独占
 * 推理通道，排在后面的小文件只能干等（实测 175KB 长文档约 8.7s）。
 *
 * 设计：
 * - 内存优先队列：priority 大者先出，同优先级按入队顺序（FIFO），同一文档去重；
 * - 并发上限 concurrency 可运行时调整，活跃数达到上限即停止出队（推理本身仍由
 *   processingEngine 内部逐次调用，避免 onnxruntime 会话被过度争抢）；
 * - 重复入队只提升优先级，不重复执行（用户手动「重新解析」可插队到正在排队的任务前）；
 * - 持久化交给外部回调（onEnqueue / onDequeue），断点续传时按 priority 还原出队顺序。
 */

export const QUEUE_PRIORITY = {
  /** 用户显式点「重新解析」：需要立即看到反馈 */
  manual: 100,
  /** 单文件导入 / 添加引用：用户刚操作，期待及时反馈 */
  import: 50,
  /** 断点续传恢复：介于导入与批量之间 */
  restore: 30,
  /** 目录映射批量入队：后台任务，让位给用户交互 */
  batch: 10,
} as const

export interface QueueTask {
  documentId: number
  priority: number
}

export interface ProcessingQueueOptions {
  /** 初始并发上限（≥1，默认 1 保持原有串行语义） */
  concurrency?: number
  /** 实际执行单个任务（通常是 processingEngine.processDocument） */
  run: (documentId: number) => Promise<unknown>
  /** 入队持久化（含优先级升级） */
  onEnqueue?: (task: QueueTask) => void
  /** 任务收尾（成功或失败）后清理持久化记录 */
  onDequeue?: (documentId: number) => void
  /** 任务异常（不向调用方抛出，避免中断其它任务） */
  onError?: (documentId: number, error: unknown) => void
}

interface QueueItem {
  documentId: number
  priority: number
  seq: number
}

/** 调度状态的只读快照，供界面展示 */
export interface QueueStatus {
  running: number
  waiting: number
  concurrency: number
}

export class ProcessingQueue {
  private items: QueueItem[] = []
  private pending = new Set<number>()
  private running = new Set<number>()
  private waiters: Array<() => void> = []
  private seq = 0
  private limit: number

  constructor(private options: ProcessingQueueOptions) {
    this.limit = normalizeConcurrency(options.concurrency)
  }

  get concurrency(): number {
    return this.limit
  }

  /** 运行时调整并发度：调大立即补位，调小不打断进行中的任务 */
  setConcurrency(value: number): void {
    this.limit = normalizeConcurrency(value)
    this.pump()
  }

  get waiting(): number {
    return this.items.length
  }

  get active(): number {
    return this.running.size
  }

  status(): QueueStatus {
    return { running: this.running.size, waiting: this.items.length, concurrency: this.limit }
  }

  isQueued(documentId: number): boolean {
    return this.pending.has(documentId) || this.running.has(documentId)
  }

  /**
   * 入队。已在等待中的同一文档不会重复执行，只会提升优先级。
   * @returns 是否真正插入队列（false 表示已在处理或优先级未变）
   */
  enqueue(documentId: number, priority: number = QUEUE_PRIORITY.import): boolean {
    const normalized = Number.isFinite(priority) ? Math.floor(priority) : QUEUE_PRIORITY.import
    const existing = this.items.find(item => item.documentId === documentId)
    if (existing) {
      if (normalized > existing.priority) {
        existing.priority = normalized
        this.options.onEnqueue?.({ documentId, priority: normalized })
      }
      return false
    }
    if (this.running.has(documentId)) return false
    this.items.push({ documentId, priority: normalized, seq: this.seq++ })
    this.pending.add(documentId)
    this.options.onEnqueue?.({ documentId, priority: normalized })
    this.pump()
    return true
  }

  /** 队列排空（含进行中的任务）后 resolve，供测试与退出前等待使用 */
  idle(): Promise<void> {
    if (this.running.size === 0 && this.items.length === 0) return Promise.resolve()
    return new Promise(resolve => { this.waiters.push(resolve) })
  }

  private take(): QueueItem | undefined {
    if (!this.items.length) return undefined
    let best = 0
    for (let i = 1; i < this.items.length; i++) {
      const candidate = this.items[i]
      const current = this.items[best]
      if (candidate.priority > current.priority || (candidate.priority === current.priority && candidate.seq < current.seq)) {
        best = i
      }
    }
    return this.items.splice(best, 1)[0]
  }

  private pump(): void {
    while (this.running.size < this.limit) {
      const item = this.take()
      if (!item) break
      this.pending.delete(item.documentId)
      this.running.add(item.documentId)
      Promise.resolve()
        .then(() => this.options.run(item.documentId))
        .catch(error => this.options.onError?.(item.documentId, error))
        .then(() => {
          this.running.delete(item.documentId)
          this.options.onDequeue?.(item.documentId)
          this.pump()
          this.settle()
        })
    }
    this.settle()
  }

  private settle(): void {
    if (this.running.size || this.items.length || !this.waiters.length) return
    const waiters = this.waiters
    this.waiters = []
    waiters.forEach(resolve => resolve())
  }
}

function normalizeConcurrency(value: number | undefined): number {
  const n = Math.floor(Number(value))
  return Number.isFinite(n) && n >= 1 ? Math.min(n, 32) : 1
}
