/**
 * 工作台域共享类型（移植自 deskforge，TS 化）。
 *
 * 数据库访问只依赖这个结构性接口，不直接依赖 DatabaseService 具体类：
 * 一是便于单测注入内存库，二是避免「内核域服务 ← 工作台域服务」的反向依赖。
 * DatabaseService 天然满足该接口（prepare / exec / transaction）。
 */
export interface WorkbenchDb {
  prepare(sql: string): any
  exec(sql: string): any
  transaction<T>(fn: () => T): T
}

export type TaskPriority = '高' | '中' | '低'
export type TaskStatus = 'todo' | 'doing' | 'done'
export type GroupColor = 'blue' | 'green' | 'violet'

export const TASK_PRIORITIES: readonly TaskPriority[] = ['高', '中', '低']
export const TASK_STATUSES: readonly TaskStatus[] = ['todo', 'doing', 'done']
export const GROUP_COLORS: readonly GroupColor[] = ['blue', 'green', 'violet']

/** 任务编号前缀：deskforge 原用 DF-，融合后统一为知序的 TK- */
export const DEFAULT_TASK_CODE_PREFIX = 'TK'

export interface TaskDto {
  id: string
  groupId: number
  name: string
  description: string
  priority: string
  status: string
  deadline: string | null
  owner: string
  participant: boolean
  position: number
  archived?: boolean
  projectId?: number | null
  /** 入库时间：项目时间线的任务条以「创建 → 截止」为一个真实区间 */
  createdAt: string
}

export interface TaskGroupDto {
  id: number
  name: string
  color: string
  position: number
}

export interface TaskGroupWithTasks extends TaskGroupDto {
  tasks: TaskDto[]
}

export interface WorkspaceDto {
  id: number
  name: string
  active: boolean
}

export interface WorkspaceStatsDto extends WorkspaceDto {
  projectCount: number
  fileCount: number
  taskCount: number
  doneCount: number
}

export interface ProjectDto {
  id: number
  workspaceId: number | null
  name: string
  description: string
  status: string
  deadline: string | null
  taskCount: number
  doneCount: number
  /** 关联文档数（documents.project_id → projects.id），跨域连接点 */
  docCount: number
  progress: number
}

export interface TagDto {
  id: number
  name: string
  color: string
}

export interface WorkspaceFileDto {
  id: number
  name: string
  path: string
  size: number
  extension: string
  createdAt: string
}

export interface NotificationDto {
  id: number
  type: string
  title: string
  message: string
  isRead: boolean
  createdAt: string
}

export interface SearchResultsDto {
  tasks: Array<{ id: string; name: string; type: 'task' }>
  projects: Array<{ id: number; name: string; type: 'project' }>
  files: Array<{ id: number; name: string; type: 'file'; path: string }>
}

/**
 * 跨域检索的统一返回值。任务/项目/工作台文件保留各自可直接打开的轻量形态；
 * 文档沿用内核检索的结果信封，因而不会丢掉作用域与截断信息。
 */
export interface UnifiedSearchResultsDto extends SearchResultsDto {
  documents: {
    items: any[]
    total: number
    limit: number
    truncated: boolean
    truncated_reason?: string
    scope?: any
    /** 本次实际参与融合的通道（D10）：语义未启用时 semantic=false，前端据此说明降级 */
    channels?: { fulltext: boolean; semantic: boolean }
    total_is_approx?: boolean
  }
  /** 文档侧检索方式：默认 RRF 混合检索；两路都不可用时如实退化为单通道 */
  documentSearchMode: 'hybrid' | 'fulltext' | 'semantic'
}

/** 跨域时间线事件：任务（截止）与文档（入库）共用一种形态，差别只在 kind */
export interface TimelineEventDto {
  kind: 'task' | 'document'
  /** 任务为编号（TK-…），文档为 doc:<id>，便于前端做各自跳转 */
  id: string
  title: string
  /** YYYY-MM-DD */
  at: string
  status: string
  projectName: string | null
  /** 相对今天：past = 已发生/已逾期，today = 今天，upcoming = 将来 */
  phase: 'past' | 'today' | 'upcoming'
}
