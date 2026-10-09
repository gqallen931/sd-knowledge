import { useState } from 'react'
import type { SDNotification, SDReminder, SDRepeatRule } from '../types/global'
import { IconBell } from './icons'

interface Props {
  notifications: SDNotification[]
  reminders: SDReminder[]
  unread: number
  onMarkRead: () => Promise<void>
  onCreateReminder: (title: string, remindAt: string, repeatRule: SDRepeatRule) => Promise<void>
  onDismissReminder: (id: number) => Promise<void>
  onRemoveReminder: (id: number) => Promise<void>
  onSelectTask: (taskCode: string) => void
}

const REPEAT: Array<{ value: SDRepeatRule; label: string }> = [
  { value: 'none', label: '不重复' },
  { value: 'daily', label: '每天' },
  { value: 'weekly', label: '每周' },
]

/** 参照稿的通知铃铛按钮后面的浮层：通知与提醒都收在这里，不再占用右栏 */
export default function Notifications({
  notifications,
  reminders,
  unread,
  onMarkRead,
  onCreateReminder,
  onDismissReminder,
  onRemoveReminder,
  onSelectTask,
}: Props) {
  const [open, setOpen] = useState(false)
  const [title, setTitle] = useState('')
  const [remindAt, setRemindAt] = useState('')
  const [repeatRule, setRepeatRule] = useState<SDRepeatRule>('none')

  const pending = reminders.filter((item) => item.status !== 'done')

  const submit = async () => {
    if (!title.trim() || !remindAt) return
    await onCreateReminder(title.trim(), `${remindAt.replace('T', ' ')}:00`, repeatRule)
    setTitle('')
    setRemindAt('')
    setRepeatRule('none')
  }

  return (
    <div className="wb-notify">
      <button
        className="wb-iconbtn"
        title="通知与提醒"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <IconBell />
        {unread > 0 && <span className="wb-iconbtn__dot" />}
      </button>

      {open && (
        <div className="wb-notify__panel">
          <div className="wb-notify__head">
            <strong>通知与提醒{unread > 0 ? ` · ${unread} 条未读` : ''}</strong>
            <button className="wb-toolbtn" onClick={() => void onMarkRead()}>全部已读</button>
          </div>

          {notifications.length === 0 && pending.length === 0 && (
            <p className="wb-notify__empty">还没有通知或提醒。</p>
          )}

          {notifications.slice(0, 8).map((item) => (
            <div key={`n${item.id}`} className={`wb-notify__item${item.isRead ? '' : ' wb-notify__item--unread'}`}>
              <span className={`wb-notify__icon${item.type === 'deadline' ? ' wb-notify__icon--deadline' : ''}`}>
                {item.type === 'deadline' ? '!' : 'N'}
              </span>
              <div className="wb-notify__body">
                <strong>{item.title}</strong>
                {item.message && <p>{item.message}</p>}
                <small>{String(item.createdAt || '').slice(0, 16)}</small>
              </div>
            </div>
          ))}

          {pending.map((item) => (
            <div key={`r${item.id}`} className="wb-notify__item">
              <span className="wb-notify__icon">⏰</span>
              <div className="wb-notify__body">
                <strong>{item.title}</strong>
                <small>
                  {String(item.remindAt || '').slice(0, 16)}
                  {item.taskCode ? ` · ${item.taskCode}` : ''}
                  {item.repeatRule ? ` · ${REPEAT.find((r) => r.value === item.repeatRule)?.label ?? item.repeatRule}` : ''}
                </small>
              </div>
              <div className="wb-notify__actions">
                {item.taskCode && (
                  <button className="wb-toolbtn" onClick={() => { onSelectTask(item.taskCode!); setOpen(false) }}>定位</button>
                )}
                <button className="wb-toolbtn" onClick={() => void onDismissReminder(item.id)}>完成</button>
                <button className="wb-toolbtn wb-toolbtn--icon" title="删除" onClick={() => void onRemoveReminder(item.id)}>✕</button>
              </div>
            </div>
          ))}

          <div className="wb-notify__form">
            <div className="wb-notify__form-row">
              <input
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                placeholder="新建提醒，如「提交周报」"
              />
            </div>
            <div className="wb-notify__form-row">
              <input type="datetime-local" value={remindAt} onChange={(event) => setRemindAt(event.target.value)} />
              <select value={repeatRule} onChange={(event) => setRepeatRule(event.target.value as SDRepeatRule)}>
                {REPEAT.map((item) => (
                  <option key={item.value} value={item.value}>{item.label}</option>
                ))}
              </select>
              <button className="wb-toolbtn" disabled={!title.trim() || !remindAt} onClick={() => void submit()}>
                添加
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
