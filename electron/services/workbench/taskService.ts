import { TaskRepository } from './taskRepository'
import { GROUP_COLORS, GroupColor, TASK_PRIORITIES, TASK_STATUSES, TaskDto, TaskGroupWithTasks } from './types'

/**
 * 任务领域服务：校验 + 归一化，落库交给 TaskRepository。
 *
 * 与 deskforge 的差异：`owner` 默认值由硬编码的 'brandon' 改为空串（未指派），
 * 人员归属交给本地用户表决定，不再写死一个人名。
 */
export class TaskService {
  constructor(private repository: TaskRepository) {}

  private requiredText(value: unknown, field: string, maxLength: number): string {
    const text = typeof value === 'string' ? value.trim() : ''
    if (!text) throw new Error(`${field}不能为空`)
    if (text.length > maxLength) throw new Error(`${field}不能超过${maxLength}个字符`)
    return text
  }

  private optionalText(value: unknown, maxLength: number): string {
    const text = typeof value === 'string' ? value.trim() : ''
    return text.slice(0, maxLength)
  }

  private assertGroup(groupId: unknown): number {
    const id = Number(groupId)
    if (!Number.isInteger(id) || !this.repository.groupExists(id)) throw new Error('任务分组不存在')
    return id
  }

  private normalize(input: any, existing: Partial<TaskDto> = {}): TaskDto {
    const priority = input.priority ?? existing.priority ?? '中'
    const status = input.status ?? existing.status ?? 'todo'
    if (!TASK_PRIORITIES.includes(priority)) throw new Error('任务优先级无效')
    if (!TASK_STATUSES.includes(status as any)) throw new Error('任务状态无效')

    return {
      ...existing,
      id: (existing.id || '') as string,
      groupId: this.assertGroup(input.groupId ?? existing.groupId),
      name: this.requiredText(input.name ?? existing.name, '任务名称', 100),
      description: this.optionalText(input.description ?? existing.description, 5000),
      priority,
      status,
      deadline: this.optionalText(input.deadline ?? existing.deadline, 40) || null,
      owner: this.optionalText(input.owner ?? existing.owner, 80),
      participant: input.participant ?? existing.participant ?? true,
      position: Number.isInteger(input.position) ? input.position : existing.position ?? 0,
      // 只读字段：写库时不参与，仓储层写完会重新读一遍再返回（见 taskRepository.createTask/updateTask）
      createdAt: existing.createdAt ?? '',
    }
  }

  /** 分组树（看板视图数据源） */
  list(): TaskGroupWithTasks[] {
    const groups: TaskGroupWithTasks[] = this.repository.listGroups().map((group) => ({ ...group, tasks: [] }))
    const byId = new Map(groups.map((group) => [group.id, group]))
    this.repository.listTasks().forEach((task) => {
      const group = byId.get(task.groupId)
      if (group) group.tasks.push(task)
    })
    return groups
  }

  /** 扁平任务列表（甘特视图数据源） */
  flat(): TaskDto[] {
    return this.repository.listTasks()
  }

  get(id: string): TaskDto | null {
    return this.repository.getTask(this.requiredText(id, '任务编号', 40))
  }

  seed(groups: any[]): TaskGroupWithTasks[] {
    if (!Array.isArray(groups)) throw new Error('初始化数据格式无效')
    const normalized = groups.map((group, groupIndex) => ({
      name: this.requiredText(group?.name, '分组名称', 50),
      color: GROUP_COLORS.includes(group?.color) ? (group.color as GroupColor) : 'blue',
      position: groupIndex,
      tasks: Array.isArray(group?.tasks)
        ? group.tasks.map((task: any, taskIndex: number) => ({
            id: this.optionalText(task?.id, 40) || null,
            name: this.requiredText(task?.name, '任务名称', 100),
            description: this.optionalText(task?.description, 5000),
            priority: TASK_PRIORITIES.includes(task?.priority) ? task.priority : '中',
            status: TASK_STATUSES.includes(task?.status) ? task.status : 'todo',
            deadline: this.optionalText(task?.deadline, 40) || null,
            owner: this.optionalText(task?.owner, 80),
            participant: task?.participant !== false,
            position: taskIndex,
          }))
        : [],
    }))
    this.repository.seed(normalized)
    return this.list()
  }

  createGroup(input: any) {
    const groups = this.repository.listGroups()
    return this.repository.createGroup({
      name: this.requiredText(input?.name, '分组名称', 50),
      color: GROUP_COLORS.includes(input?.color) ? input.color : 'blue',
      position: groups.length,
    })
  }

  createTask(input: any): TaskDto | null {
    return this.repository.createTask(this.normalize(input))
  }

  updateTask(id: string, input: any): TaskDto | null {
    const existing = this.repository.getTask(this.requiredText(id, '任务编号', 40))
    if (!existing || existing.archived) throw new Error('任务不存在')
    return this.repository.updateTask(this.normalize(input, existing))
  }

  completeTask(id: string): TaskDto {
    const task = this.repository.completeTask(this.requiredText(id, '任务编号', 40))
    if (!task) throw new Error('任务不存在')
    return task
  }

  archiveTask(id: string): boolean {
    if (!this.repository.archiveTask(this.requiredText(id, '任务编号', 40))) throw new Error('任务不存在')
    return true
  }

  removeTask(id: string): boolean {
    if (!this.repository.removeTask(this.requiredText(id, '任务编号', 40))) throw new Error('任务不存在')
    return true
  }
}
