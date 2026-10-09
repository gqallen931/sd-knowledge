import { WorkbenchDb } from './types'

const REPEAT_MS: Record<string, number> = { daily: 86400000, weekly: 604800000 }
const REPEAT_RULES = ['none', 'daily', 'weekly']

export interface ReminderDto {
  id: number
  taskCode: string | null
  title: string
  remindAt: string
  repeatRule: string
  status: string
  notifiedAt: string | null
  createdAt: string
}

/**
 * 提醒服务：到点领取（claimDue）→ 触发通知 → 按重复规则顺延。
 *
 * 与 deskforge 的差异：手写的 BEGIN IMMEDIATE/COMMIT 改为 `db.transaction()`，
 * 由驱动负责嵌套与回滚，避免与上层事务嵌套时出现"事务内不能开启事务"。
 */
export class ReminderService {
  private readonly select = `
    SELECT id, task_code AS taskCode, title, remind_at AS remindAt, repeat_rule AS repeatRule,
           status, notified_at AS notifiedAt, created_at AS createdAt
    FROM reminders
  `

  constructor(private db: WorkbenchDb) {}

  private required(value: unknown, label: string, max = 120): string {
    const text = String(value || '').trim()
    if (!text) throw new Error(`${label}不能为空`)
    if (text.length > max) throw new Error(`${label}不能超过${max}个字符`)
    return text
  }

  private row(item: any): ReminderDto | null {
    return item ? ({ ...item, id: Number(item.id) } as ReminderDto) : null
  }

  list(): ReminderDto[] {
    return (this.db.prepare(`${this.select} ORDER BY datetime(remind_at), id`).all() as any[]).map((item) => this.row(item) as ReminderDto)
  }

  create(input: any): ReminderDto {
    const title = this.required(input?.title, '提醒标题')
    const date = new Date(input?.remindAt)
    if (Number.isNaN(date.getTime())) throw new Error('提醒时间无效')
    const repeatRule = REPEAT_RULES.includes(input?.repeatRule) ? input.repeatRule : 'none'
    const taskCode = input?.taskCode ? this.required(input.taskCode, '任务编号', 40) : null
    if (taskCode && !this.db.prepare('SELECT code FROM tasks WHERE code = ?').get(taskCode)) throw new Error('任务不存在')

    const result = this.db
      .prepare('INSERT INTO reminders (task_code, title, remind_at, repeat_rule) VALUES (?, ?, ?, ?)')
      .run(taskCode, title, date.toISOString(), repeatRule)
    return this.row(this.db.prepare(`${this.select} WHERE id = ?`).get(Number(result.lastInsertRowid))) as ReminderDto
  }

  dismiss(id: unknown): boolean {
    return Boolean(
      this.db.prepare("UPDATE reminders SET status = 'dismissed', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(Number(id)).changes,
    )
  }

  remove(id: unknown): boolean {
    return Boolean(this.db.prepare('DELETE FROM reminders WHERE id = ?').run(Number(id)).changes)
  }

  /** 领取所有到期提醒，返回本次应触发的条目（重复规则会自动顺延下一次） */
  claimDue(now: Date = new Date()): ReminderDto[] {
    const nowIso = now.toISOString()
    const due = this.db
      .prepare(`${this.select} WHERE status = 'pending' AND datetime(remind_at) <= datetime(?) ORDER BY datetime(remind_at), id`)
      .all(nowIso) as any[]
    if (!due.length) return []

    const finish = this.db.prepare("UPDATE reminders SET status = 'notified', notified_at = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
    const repeat = this.db.prepare("UPDATE reminders SET remind_at = ?, notified_at = ?, status = 'pending', updated_at = CURRENT_TIMESTAMP WHERE id = ?")

    this.db.transaction(() => {
      due.forEach((item) => {
        const interval = REPEAT_MS[item.repeatRule]
        if (interval) repeat.run(new Date(now.getTime() + interval).toISOString(), nowIso, item.id)
        else finish.run(nowIso, item.id)
      })
    })

    return due.map((item) => this.row(item) as ReminderDto)
  }
}
