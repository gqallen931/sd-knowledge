import * as path from 'path'
import type { SearchOptions, SearchService } from '../searchService'
import {
  NotificationDto,
  ProjectDto,
  SearchResultsDto,
  UnifiedSearchResultsDto,
  TagDto,
  TaskDto,
  TimelineEventDto,
  WorkbenchDb,
  WorkspaceDto,
  WorkspaceFileDto,
  WorkspaceStatsDto,
} from './types'

/**
 * 工作台服务：工作区 / 项目 / 标签 / 文件 / 通知 / 检索。
 *
 * 融合后的关键差异（与 deskforge 原始实现相比）：
 *
 * 1. `listProjects` 的口径为「当前工作区 + 未归属工作区」。
 *    内核域的 projects 是文档项目集，存量行没有 workspace_id；若只查 active 工作区，
 *    知识库里的项目会在工作台凭空消失。放开到 IS NULL 之后，同一个项目既能挂文档又能挂任务。
 *
 * 2. `createProject` 显式写入 updated_at。
 *    该列由迁移 101 补出（ALTER TABLE 不允许非常量默认值），库里没有 DEFAULT。
 *
 * 3. 逾期通知做去重，避免每次查询都重复插入同一条提醒。
 */
export class WorkbenchService {
  constructor(private db: WorkbenchDb) {}

  private required(value: unknown, label: string, max = 100): string {
    const text = typeof value === 'string' ? value.trim() : ''
    if (!text) throw new Error(`${label}不能为空`)
    if (text.length > max) throw new Error(`${label}不能超过${max}个字符`)
    return text
  }

  activeWorkspace(): { id: number; name: string } {
    return (
      (this.db.prepare('SELECT id, name FROM workspaces WHERE active = 1 ORDER BY id LIMIT 1').get() as any) ||
      (this.db.prepare('SELECT id, name FROM workspaces ORDER BY id LIMIT 1').get() as any)
    )
  }

  listWorkspaces(): WorkspaceDto[] {
    return (this.db.prepare('SELECT id, name, active FROM workspaces ORDER BY id').all() as any[]).map((row) => ({
      ...row,
      active: Boolean(row.active),
    }))
  }

  createWorkspace(input: any): WorkspaceDto {
    const name = this.required(input?.name, '工作区名称', 60)
    const result = this.db.prepare('INSERT INTO workspaces (name) VALUES (?)').run(name)
    return { id: Number(result.lastInsertRowid), name, active: false }
  }

  switchWorkspace(id: unknown) {
    const target = this.db.prepare('SELECT id, name FROM workspaces WHERE id = ?').get(Number(id)) as any
    if (!target) throw new Error('工作区不存在')
    this.db.transaction(() => {
      this.db.prepare('UPDATE workspaces SET active = 0').run()
      this.db.prepare('UPDATE workspaces SET active = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(target.id)
    })
    return target
  }

  workspaceStats(): WorkspaceStatsDto[] {
    return (this.db
      .prepare(`
        SELECT ws.id, ws.name, ws.active,
          (SELECT COUNT(*) FROM projects p WHERE p.workspace_id = ws.id AND p.archived = 0) AS projectCount,
          (SELECT COUNT(*) FROM workspace_files f WHERE f.workspace_id = ws.id) AS fileCount,
          (SELECT COUNT(*) FROM tasks t JOIN projects p ON t.project_id = p.id
             WHERE p.workspace_id = ws.id AND t.archived = 0) AS taskCount,
          (SELECT COUNT(*) FROM tasks t JOIN projects p ON t.project_id = p.id
             WHERE p.workspace_id = ws.id AND t.archived = 0 AND t.status = 'done') AS doneCount
        FROM workspaces ws ORDER BY ws.id
      `)
      .all() as any[])
      .map((row) => ({
        id: row.id,
        name: row.name,
        active: Boolean(row.active),
        projectCount: Number(row.projectCount),
        fileCount: Number(row.fileCount),
        taskCount: Number(row.taskCount),
        doneCount: Number(row.doneCount),
      }))
  }

  /**
   * 项目列表：任务侧用 tasks 聚合，文档侧用 documents 关联子查询。
   *
   * 两域靠 `documents.project_id` / `tasks.project_id` 指向同一 `projects.id` 连起来，
   * 所以一次性取回比前端按项目 N+1 去问文档数更省往返，也让「同一项目挂多少文档」
   * 与「任务完成度」在同一行快照里保持一致。
   */
  listProjects(): ProjectDto[] {
    const workspace = this.activeWorkspace()
    return (this.db
      .prepare(`
        SELECT p.id, p.workspace_id AS workspaceId, p.name, p.description, p.status, p.deadline,
          COUNT(t.code) AS taskCount, COALESCE(SUM(t.status = 'done'), 0) AS doneCount,
          (SELECT COUNT(*) FROM documents d
             WHERE d.project_id = p.id AND d.is_available = 1) AS docCount
        FROM projects p
        LEFT JOIN tasks t ON t.project_id = p.id AND t.archived = 0
        WHERE COALESCE(p.archived, 0) = 0 AND (p.workspace_id = ? OR p.workspace_id IS NULL)
        GROUP BY p.id ORDER BY p.id DESC
      `)
      .all(workspace?.id ?? null) as any[])
      .map((project) => {
        const taskCount = Number(project.taskCount)
        const doneCount = Number(project.doneCount)
        return {
          ...project,
          taskCount,
          doneCount,
          docCount: Number(project.docCount),
          progress: taskCount ? Math.round((doneCount * 100) / taskCount) : 0,
        } as ProjectDto
      })
  }

  createProject(input: any): ProjectDto {
    const name = this.required(input?.name, '项目名称', 100)
    const description = String(input?.description || '').trim().slice(0, 1000)
    const deadline = String(input?.deadline || '').trim().slice(0, 40) || null
    const color = String(input?.color || '').trim().slice(0, 40) || null
    const workspaceId = this.activeWorkspace()?.id ?? null
    const result = this.db
      .prepare(`
        INSERT INTO projects (name, description, color, workspace_id, deadline, updated_at)
        VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      `)
      .run(name, description, color, workspaceId, deadline)
    return {
      id: Number(result.lastInsertRowid),
      workspaceId,
      name,
      description,
      status: 'active',
      deadline,
      taskCount: 0,
      doneCount: 0,
      docCount: 0,
      progress: 0,
    }
  }

  updateProject(id: unknown, input: any): ProjectDto | undefined {
    const project = this.db.prepare('SELECT id FROM projects WHERE id = ? AND COALESCE(archived,0) = 0').get(Number(id)) as any
    if (!project) throw new Error('项目不存在')
    const name = this.required(input?.name, '项目名称', 100)
    const description = String(input?.description || '').trim().slice(0, 1000)
    const deadline = String(input?.deadline || '').trim().slice(0, 40) || null
    this.db
      .prepare(`
        UPDATE projects SET name = ?, description = ?, deadline = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
      `)
      .run(name, description, deadline, project.id)
    return this.listProjects().find((item) => item.id === Number(project.id))
  }

  archiveProject(id: unknown): boolean {
    return Boolean(
      this.db
        .prepare("UPDATE projects SET archived = 1, status = 'archived', updated_at = CURRENT_TIMESTAMP WHERE id = ?")
        .run(Number(id)).changes,
    )
  }

  deleteProject(id: unknown): boolean {
    const projectId = Number(id)
    let changed = false
    this.db.transaction(() => {
      this.db.prepare('UPDATE tasks SET project_id = NULL WHERE project_id = ?').run(projectId)
      changed = Boolean(this.db.prepare('DELETE FROM projects WHERE id = ?').run(projectId).changes)
    })
    return changed
  }

  /** 项目下的任务：任务↔项目↔文档三者的中间跳板 */
  projectTasks(id: unknown): TaskDto[] {
    return this.db
      .prepare(`
        SELECT code AS id, name, status, priority, deadline, owner, project_id AS projectId
        FROM tasks WHERE project_id = ? AND archived = 0 ORDER BY position, row_id
      `)
      .all(Number(id)) as TaskDto[]
  }

  assignTask(projectId: unknown, taskCode: unknown): boolean {
    if (!this.db.prepare('SELECT id FROM projects WHERE id = ? AND COALESCE(archived,0) = 0').get(Number(projectId))) {
      throw new Error('项目不存在')
    }
    const code = this.required(taskCode, '任务编号', 40)
    if (!this.db.prepare('SELECT code FROM tasks WHERE code = ? AND archived = 0').get(code)) {
      throw new Error('任务不存在')
    }
    this.db.prepare('UPDATE tasks SET project_id = ?, updated_at = CURRENT_TIMESTAMP WHERE code = ?').run(Number(projectId), code)
    return true
  }

  unassignTask(taskCode: unknown): boolean {
    return Boolean(
      this.db
        .prepare('UPDATE tasks SET project_id = NULL, updated_at = CURRENT_TIMESTAMP WHERE code = ?')
        .run(this.required(taskCode, '任务编号', 40)).changes,
    )
  }

  addTag(taskCode: string, input: any): TagDto {
    if (!this.db.prepare('SELECT code FROM tasks WHERE code = ? AND archived = 0').get(this.required(taskCode, '任务编号', 40))) {
      throw new Error('任务不存在')
    }
    const name = this.required(input?.name, '标签名称', 20)
    this.db.prepare('INSERT INTO tags (name, color) VALUES (?, ?) ON CONFLICT(name) DO NOTHING').run(name, input?.color || 'green')
    const tag = this.db.prepare('SELECT id, name, color FROM tags WHERE name = ?').get(name) as TagDto
    this.db.prepare('INSERT INTO task_tags (task_code, tag_id) VALUES (?, ?) ON CONFLICT DO NOTHING').run(taskCode, tag.id)
    return tag
  }

  listTags(taskCode?: string): TagDto[] {
    if (taskCode) {
      return this.db
        .prepare(`
          SELECT t.id, t.name, t.color FROM tags t
          JOIN task_tags tt ON tt.tag_id = t.id WHERE tt.task_code = ? ORDER BY t.name
        `)
        .all(taskCode) as TagDto[]
    }
    return this.db.prepare('SELECT id, name, color FROM tags ORDER BY name').all() as TagDto[]
  }

  removeTag(taskCode: string, tagId: unknown): boolean {
    return Boolean(
      this.db.prepare('DELETE FROM task_tags WHERE task_code = ? AND tag_id = ?').run(taskCode, Number(tagId)).changes,
    )
  }

  listFiles(): WorkspaceFileDto[] {
    return this.db
      .prepare(`
        SELECT id, name, file_path AS path, size, extension, created_at AS createdAt
        FROM workspace_files WHERE workspace_id = ? ORDER BY id DESC
      `)
      .all(this.activeWorkspace()?.id) as WorkspaceFileDto[]
  }

  addFiles(files: Array<{ name: string; path: string; size?: number }>): WorkspaceFileDto[] {
    const stmt = this.db.prepare(`
      INSERT INTO workspace_files (workspace_id, name, file_path, size, extension)
      VALUES (?, ?, ?, ?, ?) ON CONFLICT(file_path) DO NOTHING
    `)
    // workspace_files.workspace_id 是 NOT NULL，没有工作区就不该写文件
    const workspaceId = this.activeWorkspace()?.id
    if (!workspaceId) throw new Error('没有可用工作区，无法导入文件')
    ;(files || []).forEach((file) => {
      stmt.run(
        workspaceId,
        this.required(file?.name, '文件名', 255),
        this.required(file?.path, '文件路径', 2000),
        Number(file?.size || 0),
        path.extname(String(file?.name || '')).slice(0, 20).toLowerCase(),
      )
    })
    return this.listFiles()
  }

  removeFile(id: unknown): boolean {
    return Boolean(this.db.prepare('DELETE FROM workspace_files WHERE id = ?').run(Number(id)).changes)
  }

  /** 逾期任务转通知：标题+内容去重，避免每次刷新都重复插入 */
  refreshDeadlineNotifications(): number {
    const overdue = this.db
      .prepare(`
        SELECT code, name, deadline FROM tasks
        WHERE archived = 0 AND status != 'done' AND deadline IS NOT NULL AND deadline != ''
          AND date(deadline) < date('now','localtime')
      `)
      .all() as any[]
    const exists = this.db.prepare('SELECT id FROM notifications WHERE title = ? AND message = ? LIMIT 1')
    const insert = this.db.prepare("INSERT INTO notifications (type, title, message) VALUES ('warning', ?, ?)")
    let created = 0
    overdue.forEach((task) => {
      const title = '任务已逾期'
      const message = `${task.code} · ${task.name}`
      if (!exists.get(title, message)) {
        insert.run(title, message)
        created += 1
      }
    })
    return created
  }

  notifications(): NotificationDto[] {
    this.refreshDeadlineNotifications()
    return (this.db
      .prepare(`
        SELECT id, type, title, message, is_read AS isRead, created_at AS createdAt
        FROM notifications ORDER BY id DESC LIMIT 50
      `)
      .all() as any[]).map((row) => ({ ...row, isRead: Boolean(row.isRead) }))
  }

  unreadCount(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS count FROM notifications WHERE is_read = 0').get() as any
    return Number(row?.count || 0)
  }

  markNotificationsRead(): boolean {
    this.db.prepare('UPDATE notifications SET is_read = 1').run()
    return true
  }

  /** 工作台内检索（任务 / 项目 / 工作台文件），全局检索仍由内核域的检索服务负责 */
  search(query: unknown): SearchResultsDto {
    const q = `%${this.required(query, '搜索内容', 100)}%`
    return {
      tasks: this.db
        .prepare(`
          SELECT code AS id, name, 'task' AS type FROM tasks
          WHERE archived = 0 AND (name LIKE ? OR description LIKE ? OR code LIKE ?) LIMIT 20
        `)
        .all(q, q, q) as any[],
      projects: this.db
        .prepare(`SELECT id, name, 'project' AS type FROM projects WHERE COALESCE(archived,0) = 0 AND (name LIKE ? OR description LIKE ?) LIMIT 20`)
        .all(q, q) as any[],
      files: this.db
        .prepare(`SELECT id, name, 'file' AS type, file_path AS path FROM workspace_files WHERE name LIKE ? LIMIT 20`)
        .all(q) as any[],
    }
  }

  /**
   * 统一检索：工作台元数据与知识文档由同一个入口返回。
   *
   * 文档检索仍完全委托内核 SearchService，避免在工作台域复制 FTS5、作用域和
   * ResultSet 的规则；调用者也可直接据 documents.truncated 决定是否继续收窄范围。
   *
   * S0（D10）起文档侧走**混合检索（RRF 融合全文与向量）**，不再「全文零命中才试语义」：
   * 串行回退会让任意一条全文命中把语义结果整段挡掉，而 RRF 是两路各自排名后融合。
   */
  async searchAll(query: unknown, searchService: SearchService, options: SearchOptions = {}): Promise<UnifiedSearchResultsDto> {
    const local = this.search(query)
    let documents = await searchService.hybridSearch(String(query || ''), options)
    let documentSearchMode: UnifiedSearchResultsDto['documentSearchMode'] = 'hybrid'
    // 语义模型未启用/尚未就绪时混合检索会自行降级为全文通道（channels.semantic=false），
    // 不发生异常；这里只在极端情况下兜底一次纯全文，保证搜索框不会变成错误提示。
    if (!documents.items.length && documents.channels?.semantic === false) {
      try {
        documents = await searchService.fullTextSearch(String(query || ''), options)
        documentSearchMode = 'fulltext'
      } catch { /* 全文结果与原异常都保留为正常的空结果 */ }
    }
    return { ...local, documents, documentSearchMode }
  }

  /** 本地日期字符串（YYYY-MM-DD），与库里 date('now','localtime') 同一口径 */
  private localDate(offsetDays = 0): string {
    const date = new Date(Date.now() + offsetDays * 86400000)
    const pad = (value: number) => String(value).padStart(2, '0')
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
  }

  /**
   * 日程页聚合（S2-01）：任务按截止日分桶（本地日口径）+ 今日待办 + 逾期 + 提醒聚合。
   *
   * 日期口径统一在服务端算好再下发（`today` / 每行的 `date`），前端只做视图渲染，
   * 不允许各自 new Date() 再算一遍——跨天边界的判定只有一个真相源。
   * 提醒的 remind_at 是 UTC ISO 串，SQL 里用 date(…,'localtime') 转本地日口径。
   */
  calendar(options: { days?: unknown } = {}) {
    const days = Math.min(124, Math.max(7, Number(options?.days) || 42))
    const today = this.localDate()
    const until = this.localDate(days - 1)

    // 有截止日的任务：date(deadline) 归一后落在窗口内；无效日期（date() 为 NULL）自然被过滤
    const tasks = this.db
      .prepare(`
        SELECT t.code AS id, t.name, t.status, t.priority, t.deadline,
          date(t.deadline) AS date, t.owner, p.name AS projectName
        FROM tasks t LEFT JOIN projects p ON p.id = t.project_id
        WHERE t.archived = 0 AND t.deadline IS NOT NULL AND t.deadline != ''
          AND date(t.deadline) IS NOT NULL AND date(t.deadline) <= ?
        ORDER BY date(t.deadline), t.position
      `)
      .all(until) as any[]

    const todayTasks = tasks.filter((row) => row.date === today)
    const overdue = tasks.filter((row) => row.date < today && row.status !== 'done')

    // 无截止日的未完成任务 → 日程页「待安排」区
    const unscheduled = this.db
      .prepare(`
        SELECT t.code AS id, t.name, t.status, t.priority, p.name AS projectName
        FROM tasks t LEFT JOIN projects p ON p.id = t.project_id
        WHERE t.archived = 0 AND (t.deadline IS NULL OR t.deadline = '') AND t.status != 'done'
        ORDER BY t.position LIMIT 50
      `)
      .all() as any[]

    // 提醒聚合：含已触发（notified）未 dismissed 的，前端按状态标注；上限 200 条防极端数据拖垮
    const reminders = (this.db
      .prepare(`
        SELECT id, task_code AS taskCode, title,
          remind_at AS remindAt, repeat_rule AS repeatRule, status,
          date(remind_at, 'localtime') AS date,
          substr(time(remind_at, 'localtime'), 1, 5) AS time
        FROM reminders
        WHERE status != 'dismissed' AND date(remind_at, 'localtime') <= ?
        ORDER BY datetime(remind_at, 'localtime'), id LIMIT 200
      `)
      .all(until) as any[]).map((row) => ({ ...row, id: Number(row.id) }))

    return { today, days, tasks, todayTasks, overdue, unscheduled, reminders }
  }

  /**
   * 跨域时间线：把「任务截止」与「文档入库」放进同一条事件流。
   *
   * 这是融合最直接的兑现——两个域本就写在同一个库里，于是「这周要交什么」
   * 和「这周收进了哪些资料」能对上，不必在两套系统之间来回切。
   * 两侧共用 kind/id/title/at/status 一套形态，前端只需一种渲染分支。
   */
  timeline(options: { days?: unknown; limit?: unknown } = {}): TimelineEventDto[] {
    const days = Math.min(365, Math.max(1, Number(options?.days) || 30))
    const limit = Math.min(200, Math.max(1, Number(options?.limit) || 60))
    const since = this.localDate(-days)
    const today = this.localDate()

    const rows = this.db
      .prepare(`
        SELECT 'task' AS kind, t.code AS id, t.name AS title, date(t.deadline) AS at,
          t.status AS status, p.name AS projectName
        FROM tasks t LEFT JOIN projects p ON p.id = t.project_id
        WHERE t.archived = 0 AND t.deadline IS NOT NULL AND t.deadline != '' AND date(t.deadline) >= ?
        UNION ALL
        SELECT 'document' AS kind, 'doc:' || d.id AS id, d.title AS title, date(d.created_at) AS at,
          COALESCE(d.processing_status, 'ready') AS status, p.name AS projectName
        FROM documents d LEFT JOIN projects p ON p.id = d.project_id
        WHERE d.is_available = 1 AND date(d.created_at) >= ?
        ORDER BY at DESC, kind DESC
        LIMIT ?
      `)
      .all(since, since, limit) as any[]

    return rows.map((row) => ({
      kind: row.kind,
      id: row.id,
      title: row.title,
      at: row.at,
      status: row.status,
      projectName: row.projectName ?? null,
      phase: row.at < today ? 'past' : row.at === today ? 'today' : 'upcoming',
    })) as TimelineEventDto[]
  }

  dashboard() {
    const stats = this.db
      .prepare(`
        SELECT COUNT(*) AS total, SUM(status = 'doing') AS doing, SUM(status = 'done') AS done,
          SUM(status != 'done' AND deadline IS NOT NULL AND date(deadline) < date('now','localtime')) AS overdue
        FROM tasks WHERE archived = 0
      `)
      .get() as any
    return {
      workspace: this.activeWorkspace(),
      workspaces: this.listWorkspaces(),
      projects: this.listProjects(),
      tags: this.listTags(),
      files: this.listFiles(),
      stats: {
        total: Number(stats?.total || 0),
        doing: Number(stats?.doing || 0),
        done: Number(stats?.done || 0),
        overdue: Number(stats?.overdue || 0),
      },
    }
  }
}
