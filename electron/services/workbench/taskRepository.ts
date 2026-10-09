import { DEFAULT_TASK_CODE_PREFIX, TaskDto, TaskGroupDto, WorkbenchDb } from './types'

/**
 * 任务仓储：只做 SQL，不做业务校验（校验在 TaskService）。
 *
 * 与 deskforge 原始实现的差异：
 * 1. 不再建表——DDL 已在迁移 103 中执行（schema.ts），仓储层只查询/写入。
 * 2. `listTasks` 额外带出 `project_id`，任务↔项目↔文档的关联据此打通。
 * 3. 任务编号前缀可注入（默认 TK-），deskforge 硬编码的 DF- 不再沿用。
 */
export class TaskRepository {
  private codePrefix: string

  constructor(private db: WorkbenchDb, codePrefix: string = DEFAULT_TASK_CODE_PREFIX) {
    this.codePrefix = codePrefix.replace(/-+$/, '')
  }

  private get listGroupsStmt() {
    return this.db.prepare(`
      SELECT id, name, color, position
      FROM task_groups
      WHERE archived = 0
      ORDER BY position, id
    `)
  }

  private get listTasksStmt() {
    return this.db.prepare(`
      SELECT code AS id, group_id AS groupId, name, description, priority, status,
             deadline, owner, participant, position, project_id AS projectId,
             created_at AS createdAt
      FROM tasks
      WHERE archived = 0
      ORDER BY group_id, position, row_id
    `)
  }

  private get getTaskStmt() {
    return this.db.prepare(`
      SELECT code AS id, group_id AS groupId, name, description, priority, status,
             deadline, owner, participant, position, archived, project_id AS projectId,
             created_at AS createdAt
      FROM tasks
      WHERE code = ?
    `)
  }

  private mapTask(row: any): TaskDto | null {
    if (!row) return null
    return {
      ...row,
      participant: Boolean(row.participant),
      archived: Boolean(row.archived),
    } as TaskDto
  }

  hasTasks(): boolean {
    const row = this.db.prepare('SELECT COUNT(*) AS count FROM tasks').get() as any
    return Number(row?.count || 0) > 0
  }

  listGroups(): TaskGroupDto[] {
    return this.listGroupsStmt.all() as TaskGroupDto[]
  }

  listTasks(): TaskDto[] {
    return (this.listTasksStmt.all() as any[]).map((row) => this.mapTask(row) as TaskDto)
  }

  getTask(id: string): TaskDto | null {
    return this.mapTask(this.getTaskStmt.get(id))
  }

  groupExists(id: number): boolean {
    return Boolean(this.db.prepare('SELECT id FROM task_groups WHERE id = ? AND archived = 0').get(id))
  }

  createGroup(group: { name: string; color: string; position: number }): TaskGroupDto {
    const result = this.db
      .prepare('INSERT INTO task_groups (name, color, position) VALUES (?, ?, ?)')
      .run(group.name, group.color, group.position)
    return { id: Number(result.lastInsertRowid), ...group }
  }

  createTask(task: Omit<TaskDto, 'id'> & { id?: string | null }): TaskDto | null {
    const result = this.db
      .prepare(`
        INSERT INTO tasks (code, group_id, name, description, priority, status, deadline, owner, participant, position)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        task.id || null,
        task.groupId,
        task.name,
        task.description,
        task.priority,
        task.status,
        task.deadline || null,
        task.owner,
        task.participant ? 1 : 0,
        task.position,
      )
    const rowId = Number(result.lastInsertRowid)
    const id = task.id || `${this.codePrefix}-${new Date().getFullYear()}-${String(rowId).padStart(4, '0')}`
    // 编号在插入后才确定（依赖 row_id 自增），故插入时先留空再回填
    if (!task.id) this.db.prepare('UPDATE tasks SET code = ? WHERE row_id = ?').run(id, rowId)
    return this.mapTask(this.getTaskStmt.get(id))
  }

  updateTask(task: TaskDto): TaskDto | null {
    const result = this.db
      .prepare(`
        UPDATE tasks
        SET group_id = ?, name = ?, description = ?, priority = ?, status = ?, deadline = ?,
            owner = ?, participant = ?, position = ?, updated_at = CURRENT_TIMESTAMP
        WHERE code = ? AND archived = 0
      `)
      .run(
        task.groupId,
        task.name,
        task.description,
        task.priority,
        task.status,
        task.deadline || null,
        task.owner,
        task.participant ? 1 : 0,
        task.position,
        task.id,
      )
    return result.changes ? this.mapTask(this.getTaskStmt.get(task.id)) : null
  }

  completeTask(id: string): TaskDto | null {
    const result = this.db
      .prepare("UPDATE tasks SET status = 'done', updated_at = CURRENT_TIMESTAMP WHERE code = ? AND archived = 0")
      .run(id)
    return result.changes ? this.mapTask(this.getTaskStmt.get(id)) : null
  }

  archiveTask(id: string): boolean {
    const result = this.db
      .prepare("UPDATE tasks SET archived = 1, status = 'archived', updated_at = CURRENT_TIMESTAMP WHERE code = ?")
      .run(id)
    return Boolean(result.changes)
  }

  removeTask(id: string): boolean {
    const result = this.db.prepare('DELETE FROM tasks WHERE code = ?').run(id)
    return Boolean(result.changes)
  }

  /** 首次初始化演示数据：仅在库中没有任何任务时生效 */
  seed(groups: Array<{ name: string; color: string; tasks: Array<Omit<TaskDto, 'id' | 'groupId' | 'position'>> }>): boolean {
    if (this.hasTasks()) return false
    this.db.transaction(() => {
      groups.forEach((group, groupIndex) => {
        const created = this.createGroup({ name: group.name, color: group.color, position: groupIndex })
        group.tasks.forEach((task, taskIndex) => {
          this.createTask({ ...task, groupId: created.id, position: taskIndex })
        })
      })
    })
    return true
  }
}
