import { useMemo, useState } from 'react'
import type { SDTask, SDTaskGroup } from '../types/global'
import { IconChevronDown, IconChevronLeft, IconChevronRight, IconGanttGrid } from './icons'
import { groupColor } from './motion'

interface Props {
  groups: SDTaskGroup[]
  tasks: SDTask[]
  selectedId: string | null
  onSelect: (id: string) => void
}

type Mode = 'week' | 'month'

const pad = (n: number) => String(n).padStart(2, '0')
const DAY = 86400000

/** 取日期部分（本地零点），忽略时分秒；无法解析返回 null */
function toDay(value?: string | null): Date | null {
  if (!value) return null
  const date = new Date(`${value.replace(' ', 'T').slice(0, 10)}T00:00:00`)
  return Number.isNaN(date.getTime()) ? null : date
}

function startOfDay(date: Date): Date {
  const next = new Date(date)
  next.setHours(0, 0, 0, 0)
  return next
}

/**
 * 项目时间线：参照稿 `.wb-gantt` 的 1:1 复刻。
 *
 * 与参照稿一致的部分：84px 行标签列 + 日期表头 + 竖向网格线 + 今日标记 + 任务条。
 * 数据落到 SD 的真实字段：行 = 任务分组，条 = 任务「创建 → 截止」的真实区间
 * （`createdAt` / `deadline`），已完成的任务用参照稿的绿色高亮条。
 */
export default function ProjectGantt({ groups, tasks, selectedId, onSelect }: Props) {
  const [mode, setMode] = useState<Mode>('month')
  const [offset, setOffset] = useState(0)

  const today = startOfDay(new Date())

  const days = useMemo(() => {
    if (mode === 'week') {
      const base = startOfDay(new Date(today.getTime() + (offset * 7 - today.getDay() + 1) * DAY))
      return Array.from({ length: 7 }, (_, index) => new Date(base.getTime() + index * DAY))
    }
    const base = new Date(today.getFullYear(), today.getMonth() + offset, 1)
    const total = new Date(base.getFullYear(), base.getMonth() + 1, 0).getDate()
    return Array.from({ length: total }, (_, index) => new Date(base.getFullYear(), base.getMonth(), index + 1))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, offset, today.getTime()])

  const windowStart = days[0]
  const windowEnd = days[days.length - 1]
  const indexOf = (date: Date) => Math.round((startOfDay(date).getTime() - windowStart.getTime()) / DAY)

  /** 有排期的任务按分组铺到行上；条的范围是「创建 → 截止」的真实区间 */
  const rows = useMemo(() => {
    return groups
      .map((group) => {
        const bars = tasks
          .filter((task) => task.groupId === group.id && task.deadline)
          .map((task) => {
            const end = toDay(task.deadline)
            const start = toDay(task.createdAt) ?? end
            if (!end || !start) return null
            const from = start.getTime() <= end.getTime() ? start : end
            const to = start.getTime() <= end.getTime() ? end : start
            if (to < windowStart || from > windowEnd) return null
            const fromIndex = Math.max(0, indexOf(from))
            const toIndex = Math.min(days.length - 1, indexOf(to))
            return { task, fromIndex, toIndex }
          })
          .filter(Boolean) as Array<{ task: SDTask; fromIndex: number; toIndex: number }>
        return { group, bars }
      })
      .filter((row) => row.bars.length > 0)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groups, tasks, days])

  const todayIndex = indexOf(today)
  const todayVisible = todayIndex >= 0 && todayIndex < days.length

  const monthLabel = mode === 'week'
    ? `${days[0].getMonth() + 1}月${days[0].getDate()}日 - ${days[days.length - 1].getMonth() + 1}月${days[days.length - 1].getDate()}日`
    : `${days[0].getFullYear()}年${days[0].getMonth() + 1}月`

  const columns = `84px repeat(${days.length}, minmax(${mode === 'week' ? 64 : 30}px, 1fr))`
  const gridRows = `26px repeat(${Math.max(rows.length, 1)}, 34px)`

  return (
    <section className="wb-gantt" aria-label="项目时间线">
      <div className="wb-gantt__head">
        <span className="wb-gantt__title">
          <IconGanttGrid />
          项目时间线
        </span>
        <span className="wb-gantt__month">{monthLabel}</span>
        <div className="wb-gantt__tools">
          <button className="wb-toolbtn" onClick={() => setMode(mode === 'week' ? 'month' : 'week')}>
            {mode === 'week' ? '周' : '月'}
            <IconChevronDown />
          </button>
          <button className="wb-toolbtn" onClick={() => setOffset(0)}>今天</button>
          <button className="wb-toolbtn wb-toolbtn--icon" title="上一周期" onClick={() => setOffset((value) => value - 1)}>
            <IconChevronLeft />
          </button>
          <button className="wb-toolbtn wb-toolbtn--icon" title="下一周期" onClick={() => setOffset((value) => value + 1)}>
            <IconChevronRight />
          </button>
        </div>
      </div>

      <div className="wb-gantt__scroll">
        <div className="wb-gantt__grid" style={{ gridTemplateColumns: columns, gridTemplateRows: gridRows }}>
          <div
            className="wb-gantt__lines"
            style={{
              backgroundImage: `repeating-linear-gradient(90deg, transparent 0, transparent calc(100% / ${days.length} - 1px), var(--card-border) calc(100% / ${days.length} - 1px), var(--card-border) calc(100% / ${days.length}))`,
            }}
          />

          <div className="wb-gantt__corner" />

          {days.map((day, index) => {
            const isToday = day.getTime() === today.getTime()
            return (
              <div
                key={`d${index}`}
                className={`wb-gantt__day${isToday ? ' wb-gantt__day--today' : ''}`}
                style={{ gridColumn: index + 2, gridRow: 1 }}
              >
                <span>{mode === 'week' ? `${day.getMonth() + 1}/${day.getDate()}` : day.getDate()}</span>
              </div>
            )
          })}

          {rows.length === 0 && (
            <div className="wb-gantt__rowlabel" style={{ gridColumn: '1 / -1', gridRow: 2 }}>
              没有排期中的任务（任务需要「截止时间」才会出现在时间线上）。
            </div>
          )}

          {rows.map((row, rowIndex) => (
            <div
              key={`l${row.group.id}`}
              className="wb-gantt__rowlabel"
              style={{ gridColumn: 1, gridRow: rowIndex + 2 }}
              title={row.group.name}
            >
              <i style={{ background: groupColor(row.group.color) }} />
              {row.group.name}
            </div>
          ))}

          {rows.map((row, rowIndex) =>
            row.bars.map((bar) => (
              <div
                key={`b${bar.task.id}`}
                className={`wb-gantt__bar wb-gantt__bar--clickable${bar.task.status === 'done' ? ' wb-gantt__bar--green' : ''}${selectedId === bar.task.id ? ' wb-gantt__bar--green' : ''}`}
                style={{ gridColumn: `${bar.fromIndex + 2} / ${bar.toIndex + 3}`, gridRow: rowIndex + 2 }}
                title={`${bar.task.id} ${bar.task.name}`}
                onClick={() => onSelect(bar.task.id)}
              >
                <b>{bar.task.name}</b>
                <span>{bar.toIndex - bar.fromIndex + 1} 天</span>
              </div>
            )),
          )}

          {todayVisible && (
            <div className="wb-gantt__today" style={{ gridColumn: todayIndex + 2 }} />
          )}
        </div>
      </div>
    </section>
  )
}
