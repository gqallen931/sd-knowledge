import { useState } from 'react'
import type { SDTask, SDTaskGroup } from '../types/global'
import { IconChevronDown } from './icons'
import { daysUntil, priorityMeta, statusMeta } from './motion'

interface Props {
  groups: SDTaskGroup[]
  tasks: SDTask[]
  selectedId: string | null
  onSelect: (id: string) => void
  /** 页头的「新增任务」按钮把新任务行插到第一个分组里 */
  creating?: boolean
  onCreate?: (name: string) => Promise<void>
}

/** 分组圆点只有三种配色，与参照稿的 blue / green / violet 变体一一对应 */
const dotClass = (color?: string) =>
  color === 'green' ? 'wb-group__dot--green' : color === 'violet' ? 'wb-group__dot--violet' : 'wb-group__dot--blue'

/** 优先级徽标：高 / 中 / 低 三档，同参照稿的 wb-badge--high|mid|low */
const badgeClass = (priority: string) =>
  priority === '高' ? 'wb-badge--high' : priority === '低' ? 'wb-badge--low' : 'wb-badge--mid'

/** 行尾：有截止时间就给「今天 10:00」这类时间，否则退回状态点（与参照稿同一取舍） */
function tail(task: SDTask) {
  if (task.deadline) {
    const days = daysUntil(task.deadline)
    const time = task.deadline.length > 10 ? task.deadline.slice(11, 16) : ''
    const day = days === 0 ? '今天'
      : days === 1 ? '明天'
      : days !== null && days < 0 ? `逾期 ${-days} 天`
      : task.deadline.slice(5, 10)
    return { kind: 'time' as const, text: time ? `${day} ${time}` : day }
  }
  return { kind: 'status' as const, text: statusMeta(task.status).label, status: task.status }
}

/**
 * 任务分组列表：参照稿 `.wb-groups` / `.wb-group` / `.wb-task` 的 1:1 复刻。
 * 分组可收起（`.wb-group--closed` 让 chevron 转 -90°），任务行是行列表而非卡片。
 */
export default function TaskGroups({ groups, tasks, selectedId, onSelect, creating = false, onCreate }: Props) {
  const [closed, setClosed] = useState<number[]>([])
  const [draft, setDraft] = useState('')
  const toggle = (groupId: number) =>
    setClosed((list) => (list.includes(groupId) ? list.filter((id) => id !== groupId) : [...list, groupId]))

  const submit = async () => {
    const name = draft.trim()
    if (!name || !onCreate) return
    await onCreate(name)
    setDraft('')
  }

  if (groups.length === 0) {
    return (
      <div className="wb-groups">
        <div className="wb-group">
          <p className="wb-group__empty">还没有任务分组。先建一个分组（如「需求评审」「开发实现」），再把任务放进去。</p>
        </div>
      </div>
    )
  }

  return (
    <div className="wb-groups">
      {groups.map((group, index) => {
        const list = tasks.filter((task) => task.groupId === group.id)
        const isClosed = closed.includes(group.id)
        return (
          <div key={group.id} className={`wb-group${isClosed ? ' wb-group--closed' : ''}`}>
            <button
              className="wb-group__head"
              aria-expanded={!isClosed}
              onClick={() => toggle(group.id)}
            >
              <span className={`wb-group__dot ${dotClass(group.color)}`} />
              <span className="wb-group__name">{group.name}</span>
              <span className="wb-group__count">{list.length}</span>
              <span className="wb-group__chevron"><IconChevronDown /></span>
            </button>

            <div className="wb-group__list">
              {creating && index === 0 && (
                <div className="wb-task">
                  <span className="wb-task__id">新任务</span>
                  <input
                    className="wb-task__input"
                    autoFocus
                    value={draft}
                    onChange={(event) => setDraft(event.target.value)}
                    onBlur={() => void submit()}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') void submit()
                      if (event.key === 'Escape') setDraft('')
                    }}
                    placeholder="任务名称，回车创建"
                  />
                </div>
              )}
              {list.map((task) => {
                const end = tail(task)
                return (
                  <div
                    key={task.id}
                    className={`wb-task${selectedId === task.id ? ' wb-task--selected' : ''}`}
                    onClick={() => onSelect(task.id)}
                    title={task.description || task.name}
                  >
                    <span className="wb-task__id">{task.id}</span>
                    <span className="wb-task__name">{task.name}</span>
                    <span className={`wb-badge ${badgeClass(task.priority)}`} title={`优先级 ${priorityMeta(task.priority).label}`}>
                      {task.priority}
                    </span>
                    {end.kind === 'time' ? (
                      <span className="wb-task__time">{end.text}</span>
                    ) : (
                      <span className={`wb-task__status${end.status === 'doing' ? '' : ` wb-task__status--${end.status}`}`}>
                        {end.text}
                      </span>
                    )}
                  </div>
                )
              })}
              {list.length === 0 && <p className="wb-group__empty">这个分组下还没有任务。</p>}
            </div>
          </div>
        )
      })}
    </div>
  )
}
