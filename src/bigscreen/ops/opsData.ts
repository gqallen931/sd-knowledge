/* SD 真实数据 → OPS 大屏快照。
 *
 * 这个文件是大屏与业务层之间唯一的翻译层：所有数字都直取后端返回，
 * 不做估算、不做平滑、缺字段就是 0——宁可显示 0，也不补一个假数。
 * 四个数据源全部失败时返回 null，由调用方保持上一帧（抖动时不会把 0 刷上屏）。
 */

export interface OpsFeedItem {
  n: string
  verb: string
  text: string
}

export interface OpsSlot {
  code: string
  name: string
  busy: boolean
  state: string
}

export interface OpsSnapshot {
  stats: {
    docs: number
    running: number
    concurrency: number
    communities: number
    entities: number
    relations: number
    waiting: number
  }
  note: string
  agMeta: string
  feed: OpsFeedItem[]
  slots: OpsSlot[]
  hud: { value: string; state: string; bad: boolean }
}

/** 解析流水阶段名，用于填充空闲槽位（槽位数取队列真实并发） */
const STAGES = ['解析', '切块', '向量', '抽取', '归一', '建图', '社区', '索引', '检索', '重排', '摘要', '归档']

type Row = Record<string, unknown>

const num = (v: unknown): number => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

const str = (v: unknown, fallback = ''): string =>
  v === null || v === undefined || v === '' ? fallback : String(v)

/** 四位数以上折成 k，保持大屏数字列宽一致 */
const fmt = (n: number): string => (n >= 10000 ? `${(n / 1000).toFixed(1)}k` : String(n))

async function safe<T>(fn: (() => Promise<T>) | undefined, fallback: T, onFail: () => void): Promise<T> {
  if (typeof fn !== 'function') {
    onFail()
    return fallback
  }
  try {
    return await fn()
  } catch {
    onFail()
    return fallback
  }
}

export function emptySnapshot(message = '等待数据…'): OpsSnapshot {
  return {
    stats: { docs: 0, running: 0, concurrency: 0, communities: 0, entities: 0, relations: 0, waiting: 0 },
    note: message,
    agMeta: '0 idle',
    feed: [{ n: '000', verb: 'IDLE', text: message }],
    slots: [{ code: '01', name: '解析', busy: false, state: 'idle' }],
    hud: { value: '0', state: '—', bad: false },
  }
}

/**
 * 拉取一次快照。
 * - graph.stats    → 文档 / 实体 / 关系 / 社区
 * - queue.status   → 并发槽位（running / waiting / concurrency）
 * - dashboard.recent → 入库流（最近 10 份）
 * - analytics.overview → 近 7 天检索次数与平均延迟
 */
export async function loadOpsSnapshot(days = 7): Promise<OpsSnapshot | null> {
  const sd = (window as unknown as { sd?: Record<string, any> }).sd
  if (!sd) return emptySnapshot('未连接本地服务')

  let failed = 0
  const fail = () => { failed += 1 }

  const [graph, queue, recent, analytics] = await Promise.all([
    safe<Row>(sd.graph?.stats && (() => sd.graph.stats()), {}, fail),
    safe<Row>(sd.queue?.status && (() => sd.queue.status()), {}, fail),
    safe<Row[]>(sd.dashboard?.recent && (() => sd.dashboard.recent()), [], fail),
    safe<Row | null>(sd.analytics?.overview && (() => sd.analytics.overview({ days })), null, fail),
  ])

  // 四个源全部失败 = 后端掉线。返回 null 让大屏保持上一帧，好过把 0 刷上去
  if (failed === 4) return null

  const docs = num(graph.documents)
  const entities = num(graph.entities)
  const relations = num(graph.relationships)
  const communities = num(graph.communities)

  const running = num(queue.running)
  const waiting = num(queue.waiting)
  const concurrency = num(queue.concurrency)

  const totals = (analytics?.totals ?? {}) as Row
  const queries = (analytics?.queries ?? {}) as Row
  const indexed = num(totals.indexedFiles)
  const queryTotal = num(queries.total)
  const latency = num(queries.avgLatencyMs)

  const list = Array.isArray(recent) ? recent : []
  const feed: OpsFeedItem[] = list
    .slice(0, 10)
    .reverse() // 后端按导入时间倒序，反转后最新一条落在底部
    .map((f, i) => ({
      n: String(i + 1).padStart(3, '0'),
      verb: str(f.file_type, 'DOC').toUpperCase().slice(0, 4),
      text: str(f.file_name, str(f.title, '未命名文档')),
    }))
  if (!feed.length) feed.push({ n: '000', verb: 'IDLE', text: '暂无入库记录' })

  const slotCount = Math.min(Math.max(concurrency, 0), 12)
  const slots: OpsSlot[] = Array.from({ length: slotCount }, (_, i) => ({
    code: String(i + 1).padStart(2, '0'),
    name: STAGES[i % STAGES.length],
    busy: i < running,
    state: i < running ? 'running' : 'idle',
  }))
  if (!slots.length) slots.push({ code: '01', name: '解析', busy: false, state: 'idle' })

  const note = docs ? `索引 ${fmt(indexed)} / ${fmt(docs)} · 待解析 ${waiting}` : '尚未入库任何文档'

  return {
    stats: {
      docs,
      running,
      concurrency,
      communities,
      entities,
      relations,
      waiting,
    },
    note,
    agMeta: `${Math.max(0, concurrency - running)} idle`,
    feed,
    slots,
    hud: {
      value: fmt(queryTotal),
      state: latency ? `${Math.round(latency)}ms` : '—',
      bad: latency > 1500,
    },
  }
}
