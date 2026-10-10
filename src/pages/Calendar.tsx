import { useEffect, useMemo, useState } from 'react'
import type { SDCalendarData, SDCalendarReminder, SDCalendarTask } from '../types/global'

/**
 * 日程管理（S2-01）：日 / 周 / 月三档视图 + 今日待办 + 逾期 + 提醒聚合。
 *
 * 日期口径的唯一真相源在服务端（workbench.calendar 返回的 today / date 字段），
 * 前端只从 today 出发做视图推算（加减天数 / 月网格），不再各自 new Date() 判定「今天」。
 */

type ViewMode = 'day' | 'week' | 'month'

/** YYYY-MM-DD → 本地 Date（组件内部仅用于加减天数与取星期，不再用于判定「今天」） */
function parseDay(day: string): Date {
  const [y, m, d] = day.split('-').map(Number)
  return new Date(y, (m || 1) - 1, d || 1)
}

function fmtDay(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function addDays(day: string, offset: number): string {
  const date = parseDay(day)
  date.setDate(date.getDate() + offset)
  return fmtDay(date)
}

/** 周一为一周起点（与月网格一致） */
function weekStart(day: string): string {
  const date = parseDay(day)
  const offset = (date.getDay() + 6) % 7
  return addDays(day, -offset)
}

function addMonths(day: string, offset: number): string {
  const date = parseDay(day)
  date.setDate(1)
  date.setMonth(date.getMonth() + offset)
  return fmtDay(date)
}

/** 月视图：从所在月份的周一起的 6 周网格（42 格） */
function monthGrid(day: string): string[] {
  const first = `${day.slice(0, 7)}-01`
  const start = weekStart(first)
  return Array.from({ length: 42 }, (_, i) => addDays(start, i))
}

const WEEK_LABELS = ['一', '二', '三', '四', '五', '六', '日']

const PRIORITY_COLORS: Record<string, string> = {
  高: 'var(--danger)',
  中: 'var(--warning)',
  低: 'var(--success)',
}

const STATUS_LABEL: Record<string, string> = {
  todo: '待办',
  doing: '进行中',
  done: '已完成',
}

function TaskRow({ task, today, busy, onToggle }: { task: SDCalendarTask; today: string; busy: string; onToggle: (task: SDCalendarTask) => void }) {
  const overdue = task.date < today && task.status !== 'done'
  return (
    <div
      className="flex items-center gap-2"
      style={{
        padding: '8px 10px',
        borderRadius: 'var(--radius-m)',
        border: `1px solid ${overdue ? 'var(--danger-light)' : 'var(--card-border)'}`,
        background: overdue ? 'var(--danger-light)' : 'var(--card-bg)',
      }}
    >
      <button
        onClick={() => onToggle(task)}
        disabled={busy === task.id}
        title={task.status === 'done' ? '标记为待办' : '标记完成'}
        aria-label={task.status === 'done' ? `将「${task.name}」标记为待办` : `完成「${task.name}」`}
        style={{
          width: 18, height: 18, borderRadius: 6, flexShrink: 0, cursor: busy === task.id ? 'wait' : 'pointer',
          border: `1.5px solid ${task.status === 'done' ? 'var(--success)' : 'var(--card-border-hover)'}`,
          background: task.status === 'done' ? 'var(--success)' : 'transparent',
          color: 'var(--on-primary)', fontSize: 11, lineHeight: 1, display: 'grid', placeItems: 'center',
        }}
      >
        {task.status === 'done' ? '✓' : ''}
      </button>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{
          fontSize: 12.5, fontWeight: 500, color: 'var(--text)',
          textDecoration: task.status === 'done' ? 'line-through' : 'none',
          opacity: task.status === 'done' ? 0.55 : 1,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>{task.name}</div>
        <div style={{ fontSize: 11, color: 'var(--text-note)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {task.projectName ? `${task.projectName} · ` : ''}{task.owner || '未指派'} · {task.date}
          {overdue ? ' · 已逾期' : ''}
        </div>
      </div>
      <span className="pill" style={{ fontSize: 10, color: PRIORITY_COLORS[task.priority] || 'var(--text-note)', flexShrink: 0 }}>
        {task.priority}
      </span>
    </div>
  )
}

function ReminderRow({ reminder, today, busy, onDismiss }: { reminder: SDCalendarReminder; today: string; busy: number | null; onDismiss: (reminder: SDCalendarReminder) => void }) {
  const fired = reminder.status === 'notified'
  return (
    <div className="flex items-center gap-2" style={{ padding: '8px 10px', borderRadius: 'var(--radius-m)', border: '1px solid var(--card-border)', background: 'var(--card-bg)' }}>
      <span style={{ fontSize: 12, color: 'var(--text-secondary)', fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}>{reminder.time}</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 12.5, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{reminder.title}</div>
        <div style={{ fontSize: 11, color: 'var(--text-note)', marginTop: 2 }}>
          {reminder.date === today ? '今天' : reminder.date}{reminder.repeatRule !== 'none' ? ` · 重复${reminder.repeatRule === 'daily' ? '每日' : '每周'}` : ''}
          {fired ? ' · 已触发' : ''}
        </div>
      </div>
      <button className="button secondary" style={{ padding: '3px 10px', fontSize: 11, flexShrink: 0 }} disabled={busy === reminder.id} onClick={() => onDismiss(reminder)}>
        {busy === reminder.id ? '…' : '忽略'}
      </button>
    </div>
  )
}

export default function Calendar() {
  const [data, setData] = useState<SDCalendarData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [view, setView] = useState<ViewMode>('month')
  const [anchor, setAnchor] = useState('') // 视图锚点日；首载后取服务端 today
  const [busyTask, setBusyTask] = useState('')
  const [busyReminder, setBusyReminder] = useState<number | null>(null)
  const [notice, setNotice] = useState('')

  const load = async () => {
    try {
      const result = await window.sd.workbench.calendar({ days: 42 })
      setData(result)
      setAnchor((prev) => prev || result.today)
      setError('')
    } catch (e: any) { setError(e?.message || String(e)) }
    finally { setLoading(false) }
  }

  useEffect(() => { void load() }, [])

  const today = data?.today || ''

  const toggleTask = async (task: SDCalendarTask) => {
    setBusyTask(task.id)
    setNotice('')
    try {
      await window.sd.task.update(task.id, { status: task.status === 'done' ? 'todo' : 'done' })
      await load()
    } catch (e: any) { setError(e?.message || String(e)) }
    finally { setBusyTask('') }
  }

  const scheduleToToday = async (task: { id: string; name: string }) => {
    setBusyTask(task.id)
    setNotice('')
    try {
      await window.sd.task.update(task.id, { deadline: today })
      setNotice(`「${task.name}」已排到今天`)
      await load()
    } catch (e: any) { setError(e?.message || String(e)) }
    finally { setBusyTask('') }
  }

  const dismissReminder = async (reminder: SDCalendarReminder) => {
    setBusyReminder(reminder.id)
    setNotice('')
    try {
      await window.sd.reminder.dismiss(reminder.id)
      await load()
    } catch (e: any) { setError(e?.message || String(e)) }
    finally { setBusyReminder(null) }
  }

  const step = (dir: number) => {
    if (!anchor) return
    setAnchor(view === 'day' ? addDays(anchor, dir) : view === 'week' ? addDays(anchor, dir * 7) : addMonths(anchor, dir))
  }

  const cells = useMemo(() => {
    if (!anchor) return []
    if (view === 'day') return [anchor]
    if (view === 'week') return Array.from({ length: 7 }, (_, i) => addDays(weekStart(anchor), i))
    return monthGrid(anchor)
  }, [anchor, view])

  const byDate = useMemo(() => {
    const map = new Map<string, SDCalendarTask[]>()
    data?.tasks.forEach((task) => {
      const list = map.get(task.date) || []
      list.push(task)
      map.set(task.date, list)
    })
    return map
  }, [data])

  const remindersByDate = useMemo(() => {
    const map = new Map<string, SDCalendarReminder[]>()
    data?.reminders.forEach((reminder) => {
      const list = map.get(reminder.date) || []
      list.push(reminder)
      map.set(reminder.date, list)
    })
    return map
  }, [data])

  const anchorLabel = anchor
    ? view === 'month'
      ? anchor.slice(0, 7).replace('-', ' 年 ') + ' 月'
      : view === 'week'
        ? `${cells[0]?.slice(5).replace('-', '/')} – ${cells[6]?.slice(5).replace('-', '/')}`
        : anchor
    : ''

  const viewMeta: Record<ViewMode, { label: string; hint: string }> = {
    day: { label: '日', hint: '单日议程' },
    week: { label: '周', hint: '一周概览' },
    month: { label: '月', hint: '月历总览' },
  }

  const cellTasks = (day: string) => byDate.get(day) || []
  const cellReminders = (day: string) => remindersByDate.get(day) || []

  return (
    <div className="page-scroll" style={{ padding: '22px 26px 26px' }}>
      <div className="page-heading">
        <div>
          <div className="eyebrow">SCHEDULE</div>
          <h1>日程管理<span className="heading-dot">.</span></h1>
          <p>任务截止与提醒按日聚合 · 今天 {today || '…'}</p>
        </div>
        <div className="heading-actions" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <div style={{ display: 'flex', gap: 4 }}>
            {(Object.keys(viewMeta) as ViewMode[]).map((mode) => (
              <button
                key={mode}
                className="pill"
                title={viewMeta[mode].hint}
                onClick={() => setView(mode)}
                style={view === mode ? { background: 'var(--primary)', color: 'var(--on-primary)', borderColor: 'var(--primary)' } : undefined}
              >{viewMeta[mode].label}</button>
            ))}
          </div>
          <button className="button secondary" onClick={() => anchor && setAnchor(today)} disabled={!anchor || anchor === today}>回到今天</button>
        </div>
      </div>

      {error && <div className="notice" role="alert" style={{ borderColor: 'var(--danger)' }}>加载失败：{error}</div>}
      {notice && <div className="notice" role="status">{notice}</div>}

      {loading ? (
        <div className="empty-state" style={{ minHeight: 200 }}>
          <span className="empty-symbol">◔</span>
          <p>正在加载日程…</p>
        </div>
      ) : !data ? (
        <div className="empty-state" style={{ minHeight: 200 }}>
          <span className="empty-symbol">✧</span>
          <p>暂无日程数据，请确认已登录并已创建任务</p>
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 320px', gap: 16, alignItems: 'start' }}>
          {/* 日历视图 */}
          <div className="panel">
            <div className="panel-heading">
              <div>
                <h2>{viewMeta[view].hint}</h2>
                <p>{anchorLabel}</p>
              </div>
              <div style={{ display: 'flex', gap: 6 }}>
                <button className="button secondary" style={{ padding: '4px 12px' }} onClick={() => step(-1)} aria-label="上一页">‹</button>
                <button className="button secondary" style={{ padding: '4px 12px' }} onClick={() => step(1)} aria-label="下一页">›</button>
              </div>
            </div>

            {view !== 'day' && (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 4, marginBottom: 4 }}>
                {WEEK_LABELS.map((label) => (
                  <div key={label} style={{ textAlign: 'center', fontSize: 11, color: 'var(--text-note)', padding: '2px 0' }}>{label}</div>
                ))}
              </div>
            )}

            <div
              style={{
                display: 'grid',
                gridTemplateColumns: view === 'day' ? '1fr' : 'repeat(7, 1fr)',
                gap: 4,
                gridAutoRows: view === 'month' ? 'minmax(72px, auto)' : 'auto',
              }}
            >
              {cells.map((day) => {
                const tasks = cellTasks(day)
                const reminders = cellReminders(day)
                const isToday = day === today
                const isAnchor = day === anchor
                const inMonth = view !== 'month' || day.slice(0, 7) === anchor.slice(0, 7)
                const open = view === 'day' ? tasks : tasks.slice(0, 3)
                return (
                  <button
                    key={day}
                    onClick={() => { if (view !== 'day') { setAnchor(day); setView('day') } }}
                    title={`${day}${tasks.length ? ` · ${tasks.length} 项任务` : ''}${reminders.length ? ` · ${reminders.length} 条提醒` : ''}`}
                    style={{
                      textAlign: 'left', padding: '6px 8px', borderRadius: 'var(--radius-m)',
                      border: `1px solid ${isAnchor ? 'var(--primary)' : isToday ? 'var(--primary-light)' : 'var(--card-border)'}`,
                      background: isToday ? 'var(--primary-light)' : inMonth ? 'var(--card-bg)' : 'var(--inset-bg)',
                      opacity: inMonth ? 1 : 0.55,
                      cursor: view === 'day' ? 'default' : 'pointer',
                      display: 'flex', flexDirection: 'column', gap: 4, minHeight: 0,
                      overflow: 'hidden', transition: 'border-color 0.18s var(--ease)',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
                      <span style={{ fontSize: 12, fontWeight: isToday || isAnchor ? 700 : 500, color: isToday ? 'var(--primary)' : 'var(--text)' }}>
                        {view === 'month' ? Number(day.slice(8)) : day.slice(5).replace('-', '/')}
                      </span>
                      {tasks.some((t) => t.date < today && t.status !== 'done') && (
                        <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--danger)' }} title="有逾期任务" />
                      )}
                    </div>
                    {open.map((task) => (
                      <div key={task.id} style={{
                        fontSize: 10.5, lineHeight: 1.4, borderRadius: 4, padding: '1px 5px',
                        background: task.status === 'done' ? 'var(--inset-bg)' : 'var(--card-bg-hover)',
                        color: task.date < today && task.status !== 'done' ? 'var(--danger)' : 'var(--text-secondary)',
                        textDecoration: task.status === 'done' ? 'line-through' : 'none',
                        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                      }}>
                        {task.name}
                      </div>
                    ))}
                    {tasks.length > 3 && (
                      <span style={{ fontSize: 10, color: 'var(--text-note)', flexShrink: 0 }}>还有 {tasks.length - 3} 项…</span>
                    )}
                    {reminders.length > 0 && (
                      <span style={{ fontSize: 10, color: 'var(--text-note)', flexShrink: 0 }}>⏰ {reminders.length} 条提醒</span>
                    )}
                  </button>
                )
              })}
            </div>
          </div>

          {/* 右侧聚合栏 */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div className="panel">
              <div className="panel-heading">
                <div><h2>今日待办</h2><p>{today}</p></div>
                <span className="pill">{data.todayTasks.filter((t) => t.status !== 'done').length} 项未完成</span>
              </div>
              {data.todayTasks.length ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {data.todayTasks.map((task) => (
                    <TaskRow key={task.id} task={task} today={today} busy={busyTask} onToggle={toggleTask} />
                  ))}
                </div>
              ) : (
                <div className="empty-state" style={{ minHeight: 80 }}>
                  <span className="empty-symbol">✧</span>
                  <p>今天没有已排期的任务</p>
                </div>
              )}
            </div>

            <div className="panel">
              <div className="panel-heading">
                <div><h2>逾期任务</h2><p>截止日已过仍未完成</p></div>
                <span className="pill" style={data.overdue.length ? { color: 'var(--danger)', borderColor: 'var(--danger)' } : undefined}>{data.overdue.length}</span>
              </div>
              {data.overdue.length ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 260, overflowY: 'auto' }}>
                  {data.overdue.map((task) => (
                    <TaskRow key={task.id} task={task} today={today} busy={busyTask} onToggle={toggleTask} />
                  ))}
                </div>
              ) : (
                <div className="empty-state" style={{ minHeight: 80 }}>
                  <span className="empty-symbol">✧</span>
                  <p>没有逾期任务，节奏很好</p>
                </div>
              )}
            </div>

            <div className="panel">
              <div className="panel-heading">
                <div><h2>提醒</h2><p>未忽略的提醒按时间排列</p></div>
                <span className="pill">{data.reminders.length}</span>
              </div>
              {data.reminders.length ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 240, overflowY: 'auto' }}>
                  {data.reminders.slice(0, 20).map((reminder) => (
                    <ReminderRow key={reminder.id} reminder={reminder} today={today} busy={busyReminder} onDismiss={dismissReminder} />
                  ))}
                </div>
              ) : (
                <div className="empty-state" style={{ minHeight: 80 }}>
                  <span className="empty-symbol">✧</span>
                  <p>暂无提醒</p>
                </div>
              )}
            </div>

            <div className="panel">
              <div className="panel-heading">
                <div><h2>待安排</h2><p>还没有截止日期的任务</p></div>
                <span className="pill">{data.unscheduled.length}</span>
              </div>
              {data.unscheduled.length ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 240, overflowY: 'auto' }}>
                  {data.unscheduled.map((task) => (
                    <div key={task.id} className="flex items-center gap-2" style={{ padding: '8px 10px', borderRadius: 'var(--radius-m)', border: '1px solid var(--card-border)', background: 'var(--card-bg)' }}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 12.5, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{task.name}</div>
                        <div style={{ fontSize: 11, color: 'var(--text-note)', marginTop: 2 }}>{task.projectName || '未归属项目'} · {STATUS_LABEL[task.status] || task.status}</div>
                      </div>
                      <button className="button secondary" style={{ padding: '3px 10px', fontSize: 11, flexShrink: 0 }} disabled={!today || busyTask === task.id} onClick={() => scheduleToToday(task)} title={`把截止日设为今天（${today}）`}>
                        排到今天
                      </button>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="empty-state" style={{ minHeight: 80 }}>
                  <span className="empty-symbol">✧</span>
                  <p>所有任务都已排期</p>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
