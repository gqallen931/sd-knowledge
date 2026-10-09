import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  SDNotification,
  SDReminder,
  SDTask,
  SDTaskGroup,
  SDWorkbenchProject,
  SDWorkspace,
} from '../types/global'

export interface WorkbenchUser {
  id: number
  username: string
  displayName: string
  role: string
}

export interface WorkbenchAuth {
  needsSetup: boolean
  authenticated: boolean
  user: WorkbenchUser | null
}

export interface WorkbenchStats {
  total: number
  doing: number
  done: number
  overdue: number
}

export interface WorkbenchFile {
  id: number
  name: string
  path: string
  size: number
}

/** `workbench.dashboard()` 的返回快照 */
export interface WorkbenchSnapshot {
  workspace: SDWorkspace | null
  workspaces: SDWorkspace[]
  projects: SDWorkbenchProject[]
  tags: Array<{ id: number; name: string; color: string }>
  files: WorkbenchFile[]
  stats: WorkbenchStats
}

export const EMPTY_STATS: WorkbenchStats = { total: 0, doing: 0, done: 0, overdue: 0 }

/**
 * 未登录判定。
 *
 * Web 端入口把 AUTH_REQUIRED 转成 HTTP 401，前端会拿到 `code`；
 * 桌面端走 Electron IPC，只保留 message（`Error invoking remote method ...: AUTH_REQUIRED`），
 * 所以两种形态都要认，否则桌面版会卡在错误横幅而不是登录页。
 */
export function isAuthError(error: unknown): boolean {
  if (!error) return false
  const code = (error as { code?: string }).code
  if (code === 'AUTH_REQUIRED') return true
  return /AUTH_REQUIRED|请先登录|未登录/.test(String((error as { message?: string }).message || error))
}

/** 去掉 Electron IPC 拼上的「Error invoking remote method 'x': Error: 」前缀，只留业务信息 */
export function errorMessage(error: unknown): string {
  if (!error) return ''
  const raw = (error as { message?: string }).message || String(error)
  return raw.replace(/^Error invoking remote method '[^']*':\s*(Error:\s*)?/, '')
}

/**
 * 工作台域的统一数据入口。
 *
 * 未登录时 `auth.authenticated === false`，页面切到登录态；
 * 其余错误落到 `error`，不吞掉，方便排查迁移/权限问题。
 */
export function useWorkbench() {
  const [auth, setAuth] = useState<WorkbenchAuth | null>(null)
  const [snapshot, setSnapshot] = useState<WorkbenchSnapshot | null>(null)
  const [groups, setGroups] = useState<SDTaskGroup[]>([])
  const [tasks, setTasks] = useState<SDTask[]>([])
  const [notifications, setNotifications] = useState<SDNotification[]>([])
  const [reminders, setReminders] = useState<SDReminder[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const status = await window.sd.auth.status()
      if (!alive.current) return
      setAuth(status)
      if (!status.authenticated) {
        setSnapshot(null)
        setGroups([])
        setTasks([])
        setNotifications([])
        setReminders([])
        setError('')
        return
      }
      const [board, flat, dashboard, notes, rems] = await Promise.all([
        window.sd.task.groups(),
        window.sd.task.list(),
        window.sd.workbench.dashboard(),
        window.sd.notification.list(),
        window.sd.reminder.list(),
      ])
      if (!alive.current) return
      setGroups(board)
      setTasks(flat)
      setSnapshot(dashboard as unknown as WorkbenchSnapshot)
      setNotifications(notes)
      setReminders(rems)
      setError('')
    } catch (e) {
      if (!alive.current) return
      if (isAuthError(e)) {
        setAuth({ needsSetup: false, authenticated: false, user: null })
        setError('')
      } else {
        setError(errorMessage(e))
      }
    } finally {
      if (alive.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  /** 任何写操作后调用：重取看板 + 通知 + 提醒，保证三栏一致 */
  const refresh = useCallback(async () => {
    try {
      const [board, flat, dashboard, notes, rems] = await Promise.all([
        window.sd.task.groups(),
        window.sd.task.list(),
        window.sd.workbench.dashboard(),
        window.sd.notification.list(),
        window.sd.reminder.list(),
      ])
      if (!alive.current) return
      setGroups(board)
      setTasks(flat)
      setSnapshot(dashboard as unknown as WorkbenchSnapshot)
      setNotifications(notes)
      setReminders(rems)
      setError('')
    } catch (e) {
      if (!alive.current) return
      if (isAuthError(e)) setAuth({ needsSetup: false, authenticated: false, user: null })
      else setError(errorMessage(e))
    }
  }, [])

  const login = useCallback(
    async (username: string, password: string) => {
      await window.sd.auth.login({ username, password })
      await load()
    },
    [load],
  )

  const register = useCallback(
    async (username: string, password: string, displayName?: string) => {
      await window.sd.auth.register({ username, password, displayName })
      await load()
    },
    [load],
  )

  const logout = useCallback(async () => {
    await window.sd.auth.logout()
    await load()
  }, [load])

  const stats = snapshot?.stats ?? EMPTY_STATS
  const unread = notifications.filter((item) => !item.isRead).length

  return {
    auth,
    ready: auth?.authenticated === true,
    loading,
    error,
    setError,
    snapshot,
    groups,
    tasks,
    notifications,
    reminders,
    stats,
    unread,
    reload: load,
    refresh,
    login,
    register,
    logout,
  }
}

export type WorkbenchModel = ReturnType<typeof useWorkbench>
