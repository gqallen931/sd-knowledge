import * as fs from 'fs'
import * as path from 'path'

/**
 * 分阶段耗时埋点（性能诊断）
 *
 * - 由设置项 `perf_log_enabled` 控制，关闭时所有埋点退化为直接调用，无额外开销（仅一次字符串比较）
 * - 桌面版通过 setPerfSink 把结果并入 main-YYYY-MM-DD.log，与普通日志同一目录、同一 7 天保留策略
 * - 浏览器版 / MCP 版没有主日志，自动落盘到 logs/perf-YYYY-MM-DD.log 并自行清理过期文件
 */

export const PERF_LOG_RETAIN_DAYS = 7
const PERF_LOG_NAME_RE = /^perf-\d{4}-\d{2}-\d{2}\.log$/
const MAX_FIELD_LEN = 60

let perfLogDir = ''
let lastCleanupDate = ''
let sink: ((line: string) => void) | null = null

/** 指定 perf 日志目录（无 sink 时使用），目录不存在会自动创建 */
export function initPerfLog(dir: string) {
  if (dir) perfLogDir = dir
}

/** 注册日志出口。桌面版传入 logToFile，使埋点与主日志合并；传 null 恢复为独立文件 */
export function setPerfSink(fn: ((line: string) => void) | null) {
  sink = fn
}

export function isPerfEnabled(settings?: Record<string, string> | null): boolean {
  return !!settings && settings.perf_log_enabled === 'true'
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

function localDate(d = new Date()): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function cleanupOldPerfLogs(dir: string) {
  try {
    const cutoff = Date.now() - PERF_LOG_RETAIN_DAYS * 24 * 60 * 60 * 1000
    for (const name of fs.readdirSync(dir)) {
      if (!PERF_LOG_NAME_RE.test(name)) continue
      const full = path.join(dir, name)
      try {
        if (fs.statSync(full).mtimeMs < cutoff) fs.unlinkSync(full)
      } catch { /* 单个文件删除失败忽略 */ }
    }
  } catch { /* 目录不可读忽略 */ }
}

function appendToFile(line: string) {
  if (!perfLogDir) return
  try {
    fs.mkdirSync(perfLogDir, { recursive: true })
    const today = localDate()
    fs.appendFileSync(path.join(perfLogDir, `perf-${today}.log`), `[${new Date().toISOString()}] ${line}\n`)
    if (lastCleanupDate !== today) {
      lastCleanupDate = today
      cleanupOldPerfLogs(perfLogDir)
    }
  } catch { /* 写日志失败不能影响主流程 */ }
}

function emit(line: string) {
  if (sink) {
    try {
      sink(line)
      return
    } catch { /* sink 异常时退化为写文件 */ }
  }
  appendToFile(line)
}

interface StageStat {
  ms: number
  count: number
  skipped: boolean
}

export class PerfRecorder {
  private stages = new Map<string, StageStat>()
  private order: string[] = []
  private startedAt = Date.now()
  private finished = false

  constructor(private label: string, private fields: Record<string, string | number> = {}, startedAt?: number) {
    if (startedAt) this.startedAt = startedAt
  }

  setField(key: string, value: string | number) {
    this.fields[key] = value
  }

  private push(name: string, ms: number, skipped: boolean) {
    const cur = this.stages.get(name)
    if (!cur) {
      this.order.push(name)
      this.stages.set(name, { ms, count: 1, skipped })
      return
    }
    cur.ms += ms
    cur.count++
    if (!skipped) cur.skipped = false
  }

  /** 记录一段耗时（同步/异步函数均可） */
  async measure<T>(name: string, fn: () => T | Promise<T>): Promise<T> {
    const start = Date.now()
    try {
      return await fn()
    } finally {
      this.push(name, Date.now() - start, false)
    }
  }

  measureSync<T>(name: string, fn: () => T): T {
    const start = Date.now()
    try {
      return fn()
    } finally {
      this.push(name, Date.now() - start, false)
    }
  }

  /** 标记某阶段被跳过（如未启用 OCR / 向量化） */
  skip(name: string) {
    this.push(name, 0, true)
  }

  add(name: string, ms: number) {
    this.push(name, ms, false)
  }

  /** 输出一行汇总。同一阶段多次执行会累加并标 ×n，重复调用只生效一次 */
  finish(error?: string) {
    if (this.finished) return
    this.finished = true

    const clean = (v: string | number) =>
      typeof v === 'string' ? v.replace(/\s+/g, '_').slice(0, MAX_FIELD_LEN) : v

    const head = Object.entries(this.fields)
      .map(([k, v]) => `${k}=${clean(v)}`)
      .join(' ')

    const body = this.order
      .map(name => {
        const stat = this.stages.get(name)!
        const tag = stat.count > 1 ? `${name}×${stat.count}` : name
        return stat.skipped ? `${tag}=skipped` : `${tag}=${stat.ms}ms`
      })
      .join(' ')

    const total = Date.now() - this.startedAt
    const tail = error ? ` FAILED: ${String(error).replace(/\s+/g, ' ').slice(0, 200)}` : ''
    emit(`[perf] ${this.label}${head ? ' ' + head : ''} | ${body || 'no-stage'} | total=${total}ms${tail}`)
  }
}

/** 埋点关闭时返回 null，调用方的 measure(perf, ...) 会退化为直接执行 */
export function createPerfRecorder(
  dataDir: string,
  settings: Record<string, string> | null | undefined,
  label: string,
  fields?: Record<string, string | number>,
  startedAt?: number
): PerfRecorder | null {
  if (!isPerfEnabled(settings)) return null
  initPerfLog(path.join(dataDir, 'logs'))
  return new PerfRecorder(label, fields, startedAt)
}

export async function measure<T>(
  perf: PerfRecorder | null | undefined,
  name: string,
  fn: () => T | Promise<T>
): Promise<T> {
  if (!perf) return await fn()
  return perf.measure(name, fn)
}

export function measureSync<T>(
  perf: PerfRecorder | null | undefined,
  name: string,
  fn: () => T
): T {
  if (!perf) return fn()
  return perf.measureSync(name, fn)
}
