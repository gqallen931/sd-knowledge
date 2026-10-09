import { createContext, useCallback, useContext, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { errorMessage, useWorkbench } from './useWorkbench'
import type { WorkbenchModel } from './useWorkbench'

/** 任务筛选：项目来自侧栏，其余在任务看板的工具条里 */
export interface BoardFilter {
  query: string
  priority: string
  status: string
  projectId: number | string
}

export const EMPTY_FILTER: BoardFilter = { query: '', priority: '', status: '', projectId: '' }

interface WorkbenchContextValue {
  model: WorkbenchModel
  filter: BoardFilter
  setFilter: (next: BoardFilter) => void
  selectedId: string | null
  setSelectedId: (id: string | null) => void
  /** 写操作的统一出口：成功后 refresh 并推进 revision，失败把消息写进全局 error */
  act: (run: () => Promise<unknown>) => Promise<void>
  /** 写操作计数：时间线是自取数据的子视图，靠它触发重取 */
  revision: number
}

const WorkbenchContext = createContext<WorkbenchContextValue | null>(null)

/**
 * 工作台域的全局上下文。
 *
 * 之所以要提到 App 层：Deskforge 只有一条左侧栏，工作区切换与项目筛选就在这条栏里。
 * 若工作台自己再画一条左栏，就会出现「两条左栏」——宽度被吃掉、视觉也不成形。
 * 因此把数据入口与筛选状态一起上提，侧栏与工作台页共享同一份，写入点仍然只有一个。
 */
export function WorkbenchProvider({ children }: { children: ReactNode }) {
  const model = useWorkbench()
  const [filter, setFilter] = useState<BoardFilter>(EMPTY_FILTER)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [revision, setRevision] = useState(0)

  const act = useCallback(
    async (run: () => Promise<unknown>) => {
      try {
        await run()
        await model.refresh()
        setRevision((value) => value + 1)
      } catch (e) {
        const message = errorMessage(e)
        if (message) model.setError(message)
        throw e
      }
    },
    [model],
  )

  const value = useMemo(
    () => ({ model, filter, setFilter, selectedId, setSelectedId, act, revision }),
    [model, filter, selectedId, act, revision],
  )

  return <WorkbenchContext.Provider value={value}>{children}</WorkbenchContext.Provider>
}

export function useWorkbenchContext() {
  const value = useContext(WorkbenchContext)
  if (!value) throw new Error('useWorkbenchContext 必须在 WorkbenchProvider 内使用')
  return value
}
