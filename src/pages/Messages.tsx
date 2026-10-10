import { useMemo, useState } from 'react'
import type { SDNotification, SDRepeatRule, SDReminder } from '../types/global'
import { errorMessage } from '../workbench/useWorkbench'
import { useWorkbenchContext } from '../workbench/WorkbenchContext'

/**
 * 消息中心（S2-03）：站内通知 + 提醒管理的整页视图。
 *
 * 与工作台右上角的浮层（Notifications.tsx）共用同一份数据源（WorkbenchContext 单写多读）：
 * 已读 / 完成 / 删除统一走 act()，成功后 provider 刷新并推进 revision，
 * 浮层与页面同源刷新，不存在「页面标已读、浮层角标还亮着」的双写不同步问题。
 */

const REPEAT_LABEL: Record<string, string> = { none: '不重复', daily: '每天', weekly: '每周' }

/** 通知类型符号：与浮层 Notifications 的约定一致，未知类型不编造 */
function notifSymbol(type: string): string {
  if (type === 'deadline') return '!'
  if (type === 'reminder') return '⏰'
  if (type === 'saved_search') return '⟳'
  return 'N'
}

function fmtTime(value: string | undefined): string {
  return String(value || '').slice(0, 16).replace('T', ' ')
}

function NotificationRow({ item }: { item: SDNotification }) {
  return (
    <div className="flex items-center gap-2" style={{
      padding: '8px 10px',
      borderRadius: 'var(--radius-m)',
      border: `1px solid ${item.isRead ? 'var(--card-border)' : 'var(--primary-light)'}`,
      background: item.isRead ? 'var(--card-bg)' : 'var(--primary-light)',
    }}>
      <span style={{
        width: 22, height: 22, borderRadius: 7, flexShrink: 0, display: 'grid', placeItems: 'center',
        fontSize: 11, background: 'var(--inset-bg)', color: 'var(--text-secondary)',
      }}>{notifSymbol(item.type)}</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 12.5, fontWeight: item.isRead ? 400 : 600, color: 'var(--text)' }}>{item.title}</div>
        {item.message && (
          <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {item.message}
          </div>
        )}
        <div style={{ fontSize: 10.5, color: 'var(--text-note)', marginTop: 2 }}>{fmtTime(item.createdAt)}</div>
      </div>
      {!item.isRead && (
        <span className="pill" style={{ fontSize: 10, color: 'var(--primary)', borderColor: 'var(--primary)', flexShrink: 0 }}>未读</span>
      )}
    </div>
  )
}

function ReminderRow({ item, busy, onDismiss, onRemove }: {
  item: SDReminder
  busy: string
  onDismiss: (item: SDReminder) => void
  onRemove: (item: SDReminder) => void
}) {
  return (
    <div className="flex items-center gap-2" style={{ padding: '8px 10px', borderRadius: 'var(--radius-m)', border: '1px solid var(--card-border)', background: 'var(--card-bg)' }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 12.5, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.title}</div>
        <div style={{ fontSize: 11, color: 'var(--text-note)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {fmtTime(item.remindAt)}
          {item.taskCode ? ` · ${item.taskCode}` : ''}
          {item.repeatRule && item.repeatRule !== 'none' ? ` · ${REPEAT_LABEL[item.repeatRule] || item.repeatRule}` : ''}
        </div>
      </div>
      <button className="button secondary" style={{ padding: '3px 10px', fontSize: 11, flexShrink: 0 }} disabled={busy === `d${item.id}`} onClick={() => onDismiss(item)} title="标记为已完成">
        {busy === `d${item.id}` ? '…' : '完成'}
      </button>
      <button className="button secondary" style={{ padding: '3px 10px', fontSize: 11, color: 'var(--danger)', flexShrink: 0 }} disabled={busy === `x${item.id}`} onClick={() => onRemove(item)} title="删除提醒">
        {busy === `x${item.id}` ? '…' : '删除'}
      </button>
    </div>
  )
}

const INPUT_STYLE = {
  padding: '7px 10px',
  borderRadius: 'var(--radius-m)',
  border: '1px solid var(--card-border)',
  background: 'var(--inset-bg)',
  color: 'var(--text)',
  fontSize: 12.5,
} as const

const ACTIVE_PILL = { background: 'var(--primary)', color: 'var(--on-primary)', borderColor: 'var(--primary)' } as const

export default function Messages() {
  const { model, act } = useWorkbenchContext()
  const { ready, loading, error, notifications, reminders, unread } = model

  const [tab, setTab] = useState<'all' | 'unread'>('all')
  const [busy, setBusy] = useState('')
  const [notice, setNotice] = useState('')
  const [localError, setLocalError] = useState('')
  // 新建提醒表单
  const [title, setTitle] = useState('')
  const [remindAt, setRemindAt] = useState('')
  const [repeatRule, setRepeatRule] = useState<SDRepeatRule>('none')

  const pending = reminders.filter((item) => item.status !== 'done')
  const shown = useMemo(
    () => (tab === 'unread' ? notifications.filter((item) => !item.isRead) : notifications),
    [notifications, tab],
  )

  /** 写操作的统一出口：成功后 provider 刷新（浮层/侧栏同源更新），失败落到页面错误条 */
  const run = async (key: string, task: () => Promise<unknown>, successMessage?: string): Promise<boolean> => {
    setBusy(key)
    setNotice('')
    setLocalError('')
    try {
      await act(task)
      if (successMessage) setNotice(successMessage)
      return true
    } catch (e) {
      setLocalError(errorMessage(e))
      return false
    } finally {
      setBusy('')
    }
  }

  const createReminder = async () => {
    if (!title.trim() || !remindAt) return
    const ok = await run('create', () => window.sd.reminder.create({
      title: title.trim(),
      remindAt: `${remindAt.replace('T', ' ')}:00`,
      repeatRule,
    }), '提醒已创建')
    if (ok) {
      setTitle('')
      setRemindAt('')
      setRepeatRule('none')
    }
  }

  return (
    <div className="page-scroll" style={{ padding: '22px 26px 26px' }}>
      <div className="page-heading">
        <div>
          <div className="eyebrow">MESSAGES</div>
          <h1>消息中心<span className="heading-dot">.</span></h1>
          <p>站内通知与提醒集中管理 · {unread > 0 ? `${unread} 条未读` : '暂无未读'}</p>
        </div>
        <div className="heading-actions" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <div style={{ display: 'flex', gap: 4 }}>
            <button className="pill" onClick={() => setTab('all')} style={tab === 'all' ? ACTIVE_PILL : undefined}>全部</button>
            <button
              className="pill"
              onClick={() => setTab('unread')}
              disabled={unread === 0}
              title={unread === 0 ? '没有未读消息' : '只看未读'}
              style={tab === 'unread' ? ACTIVE_PILL : undefined}
            >未读{unread > 0 ? ` ${unread}` : ''}</button>
          </div>
          <button
            className="button secondary"
            disabled={unread === 0 || busy === 'read'}
            title={unread === 0 ? '没有未读消息' : '把全部通知标为已读'}
            onClick={() => void run('read', () => window.sd.notification.read(), '已全部标为已读')}
          >{busy === 'read' ? '处理中…' : '全部已读'}</button>
        </div>
      </div>

      {(localError || error) && <div className="notice" role="alert" style={{ borderColor: 'var(--danger)' }}>{localError || error}</div>}
      {notice && <div className="notice" role="status">{notice}</div>}

      {loading ? (
        <div className="empty-state" style={{ minHeight: 200 }}>
          <span className="empty-symbol">◔</span>
          <p>正在加载消息…</p>
        </div>
      ) : !ready ? (
        <div className="empty-state" style={{ minHeight: 200 }}>
          <span className="empty-symbol">✧</span>
          <p>消息中心需登录后使用：请在左侧栏底部登录，或进入任务管理完成登录</p>
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 360px', gap: 16, alignItems: 'start' }}>
          {/* 通知列表 */}
          <div className="panel">
            <div className="panel-heading">
              <div>
                <h2>站内通知</h2>
                <p>提醒触发与保存检索的变化都会推到这里</p>
              </div>
              <span className="pill">{shown.length} 条</span>
            </div>
            {shown.length ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 560, overflowY: 'auto' }}>
                {shown.map((item) => <NotificationRow key={item.id} item={item} />)}
              </div>
            ) : (
              <div className="empty-state" style={{ minHeight: 120 }}>
                <span className="empty-symbol">✧</span>
                <p>{tab === 'unread' ? '没有未读消息' : '还没有通知'}</p>
              </div>
            )}
          </div>

          {/* 提醒管理 */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div className="panel">
              <div className="panel-heading">
                <div>
                  <h2>提醒管理</h2>
                  <p>未完成的提醒可完成或删除</p>
                </div>
                <span className="pill">{pending.length}</span>
              </div>
              {pending.length ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 320, overflowY: 'auto' }}>
                  {pending.map((item) => (
                    <ReminderRow
                      key={item.id}
                      item={item}
                      busy={busy}
                      onDismiss={(reminder) => void run(`d${reminder.id}`, () => window.sd.reminder.dismiss(reminder.id), '提醒已完成')}
                      onRemove={(reminder) => void run(`x${reminder.id}`, () => window.sd.reminder.remove(reminder.id), '提醒已删除')}
                    />
                  ))}
                </div>
              ) : (
                <div className="empty-state" style={{ minHeight: 100 }}>
                  <span className="empty-symbol">✧</span>
                  <p>没有进行中的提醒</p>
                </div>
              )}
            </div>

            <div className="panel">
              <div className="panel-heading">
                <div>
                  <h2>新建提醒</h2>
                  <p>到点后推送一条站内通知</p>
                </div>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <input
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                  placeholder="提醒内容，如「提交周报」"
                  style={INPUT_STYLE}
                />
                <div style={{ display: 'flex', gap: 8 }}>
                  <input
                    type="datetime-local"
                    value={remindAt}
                    onChange={(event) => setRemindAt(event.target.value)}
                    style={{ ...INPUT_STYLE, flex: 1, minWidth: 0 }}
                    aria-label="提醒时间"
                  />
                  <select
                    value={repeatRule}
                    onChange={(event) => setRepeatRule(event.target.value as SDRepeatRule)}
                    style={INPUT_STYLE}
                    aria-label="重复规则"
                  >
                    <option value="none">不重复</option>
                    <option value="daily">每天</option>
                    <option value="weekly">每周</option>
                  </select>
                </div>
                <button
                  className="button"
                  disabled={!title.trim() || !remindAt || busy === 'create'}
                  title={!title.trim() || !remindAt ? '请填写提醒内容和时间' : '创建提醒'}
                  onClick={() => void createReminder()}
                >{busy === 'create' ? '创建中…' : '添加提醒'}</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
