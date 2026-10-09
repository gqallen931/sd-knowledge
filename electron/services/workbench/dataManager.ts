import * as fs from 'fs'
import * as path from 'path'
import { WorkbenchDb } from './types'

/** 备份格式标识；同时接受 deskforge 的旧格式，便于一次性搬迁 */
const FORMAT = 'zhixu-workbench'
const LEGACY_FORMATS = ['deskforge-backup']
const FILE_PREFIX = 'workbench-'

/** 允许随备份往返的设置项（写入库时统一加 workbench. 前缀，避免与内核域设置撞键） */
const SETTING_PREFIX = 'workbench.'
const SETTING_KEYS = ['displayName', 'role', 'compactMode', 'reduceMotion', 'backupRetentionCount', 'backupRetentionDays']

/**
 * 工作台数据管理：JSON 备份的导出 / 导入 / 清理。
 *
 * 融合之后 `workspaces`、`projects`、`tags`、`settings` 四张表都和外键/内核域**共享**，
 * 因此与 deskforge 原始实现（导入前一律 `DELETE FROM`）相比，清空边界必须收紧：
 *
 * - `projects` / `workspaces`：**只并、不删**。`documents.project_id` 指向 projects、
 *   `projects.workspace_id` 指向 workspaces，删任何一方都会让文档侧连带违约
 *   （实测报 `FOREIGN KEY constraint failed`）。已存在的项目保留名称与描述，只回填工作台字段。
 * - `tags`：不删。标签与 `document_tags` 共用，删掉会让文档掉标签；
 *   改为按名称 upsert，再把备份里的 tag id 映射到本地 id 后重建 task_tags。
 * - `settings`：只写 `workbench.` 前缀的键，内核域的 api_port、api_enabled、LLM 配置一律不碰。
 *
 * 可以整表重建的只有没有任何外部引用的工作台自有表：task_groups / tasks / task_tags /
 * workspace_files / notifications / reminders。重建后按「本地已有 id 集合」过滤备份行，
 * 遇到对不上的引用宁可跳过单行，也不让整次恢复失败。
 */
export class DataManager {
  constructor(private db: WorkbenchDb, private backupDir: string) {}

  private ensureDir() {
    fs.mkdirSync(this.backupDir, { recursive: true })
  }

  readSettings(): Record<string, string> {
    const rows = this.db.prepare('SELECT key, value FROM settings WHERE key LIKE ?').all(`${SETTING_PREFIX}%`) as any[]
    const result: Record<string, string> = {}
    rows.forEach((row) => {
      result[String(row.key).slice(SETTING_PREFIX.length)] = row.value
    })
    return result
  }

  saveSettings(input: any): Record<string, string> {
    const stmt = this.db.prepare(`
      INSERT INTO settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
    `)
    this.db.transaction(() => {
      SETTING_KEYS.forEach((key) => {
        const value = input?.[key]
        if (typeof value === 'undefined') return
        stmt.run(`${SETTING_PREFIX}${key}`, typeof value === 'boolean' ? (value ? 'true' : 'false') : String(value))
      })
    })
    return this.readSettings()
  }

  exportData() {
    return {
      format: FORMAT,
      version: 1,
      exportedAt: new Date().toISOString(),
      workspaces: this.db.prepare('SELECT id, name, active FROM workspaces').all(),
      projects: this.db.prepare('SELECT * FROM projects WHERE workspace_id IS NOT NULL').all(),
      taskGroups: this.db.prepare('SELECT id, name, color, position FROM task_groups').all(),
      tasks: this.db.prepare('SELECT code, group_id AS groupId, name, description, priority, status, deadline, owner, participant, position, project_id AS projectId FROM tasks').all(),
      tags: this.db.prepare('SELECT id, name, color FROM tags').all(),
      taskTags: this.db.prepare('SELECT task_code AS taskCode, tag_id AS tagId FROM task_tags').all(),
      files: this.db.prepare('SELECT workspace_id AS workspaceId, name, file_path AS filePath, size, extension FROM workspace_files').all(),
      notifications: this.db.prepare('SELECT type, title, message, is_read AS isRead FROM notifications').all(),
      reminders: this.db.prepare('SELECT task_code AS taskCode, title, remind_at AS remindAt, repeat_rule AS repeatRule, status FROM reminders').all(),
      settings: this.readSettings(),
    }
  }

  createBackup(kind = 'manual') {
    this.ensureDir()
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const target = path.join(this.backupDir, `${FILE_PREFIX}${kind}-${stamp}.json`)
    fs.writeFileSync(target, JSON.stringify(this.exportData(), null, 2), 'utf8')
    this.db
      .prepare(`
        INSERT INTO backup_history (file_path, filename, size, format_version, kind) VALUES (?, ?, ?, 1, ?)
        ON CONFLICT(file_path) DO UPDATE SET size = excluded.size
      `)
      .run(target, path.basename(target), fs.statSync(target).size, kind)
    this.prune()
    return { path: target, name: path.basename(target), createdAt: new Date().toISOString() }
  }

  /** 备份台账（backup_history），比扫描目录更可靠：目录里的文件可能被手工挪走 */
  history() {
    return this.db
      .prepare('SELECT id, filename, file_path AS filePath, size, kind, created_at AS createdAt FROM backup_history ORDER BY id DESC LIMIT 100')
      .all()
  }

  listBackups() {
    if (!fs.existsSync(this.backupDir)) return []
    return fs
      .readdirSync(this.backupDir)
      .filter((name) => name.endsWith('.json'))
      .map((name) => {
        const stat = fs.statSync(path.join(this.backupDir, name))
        return { name, size: stat.size, createdAt: stat.mtime.toISOString() }
      })
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
  }

  /** 只保留最近 N 份（N 取设置项 backupRetentionCount，默认 10） */
  prune(retention?: number) {
    const limit = Number(retention ?? this.readSettings().backupRetentionCount ?? 10)
    if (!Number.isFinite(limit) || limit <= 0) return 0
    const files = this.listBackups()
    let removed = 0
    files.slice(limit).forEach((file) => {
      fs.rmSync(path.join(this.backupDir, file.name), { force: true })
      removed += 1
    })
    return removed
  }

  readBackup(name: unknown) {
    const safe = path.basename(String(name || ''))
    const target = path.join(this.backupDir, safe)
    if (!safe.endsWith('.json') || !fs.existsSync(target)) throw new Error('备份文件不存在')
    return { name: safe, data: JSON.parse(fs.readFileSync(target, 'utf8')) }
  }

  deleteBackup(name: unknown) {
    const safe = path.basename(String(name || ''))
    const target = path.join(this.backupDir, safe)
    if (!safe.endsWith('.json') || !fs.existsSync(target)) throw new Error('备份文件不存在')
    fs.rmSync(target, { force: true })
    this.db.prepare('DELETE FROM backup_history WHERE filename = ?').run(safe)
    return true
  }

  restoreFromFile(name: unknown) {
    return this.importData(this.readBackup(name).data)
  }

  importData(input: any) {
    const format = String(input?.format || '')
    if (format !== FORMAT && !LEGACY_FORMATS.includes(format)) throw new Error('备份文件格式不受支持')
    const payload = {
      workspaces: Array.isArray(input.workspaces) ? input.workspaces : [],
      projects: Array.isArray(input.projects) ? input.projects : [],
      taskGroups: Array.isArray(input.taskGroups) ? input.taskGroups : [],
      tasks: Array.isArray(input.tasks) ? input.tasks : [],
      tags: Array.isArray(input.tags) ? input.tags : [],
      taskTags: Array.isArray(input.taskTags) ? input.taskTags : [],
      files: Array.isArray(input.files) ? input.files : [],
      notifications: Array.isArray(input.notifications) ? input.notifications : [],
      reminders: Array.isArray(input.reminders) ? input.reminders : [],
      settings: input.settings && typeof input.settings === 'object' ? input.settings : {},
    }

    // 导入前先自备份，误导入可以回退
    const safety = this.createBackup('pre-restore')

    const tagIdMap = new Map<number, number>()

    const ids = (sql: string) => new Set((this.db.prepare(sql).all() as any[]).map((row) => Number(row.id)))
    const taskCodes = new Set<string>()

    this.db.transaction(() => {
      // 可以整表重建的：只有工作台自己产出的表，没有任何外部引用
      this.db.prepare('DELETE FROM task_tags').run()
      this.db.prepare('DELETE FROM reminders').run()
      this.db.prepare('DELETE FROM tasks').run()
      this.db.prepare('DELETE FROM notifications').run()
      this.db.prepare('DELETE FROM workspace_files').run()
      this.db.prepare('DELETE FROM task_groups').run()

      // workspaces 与 projects 只能并、不能删：
      // 融合后 documents.project_id 指向 projects，projects.workspace_id 指向 workspaces，
      // 删任何一方都会让文档侧连带违约（实测表现为 FOREIGN KEY constraint failed）。
      const upsertWorkspace = this.db.prepare(`
        INSERT INTO workspaces (id, name, active) VALUES (?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET name = excluded.name, active = excluded.active
      `)
      payload.workspaces.forEach((ws: any) => upsertWorkspace.run(Number(ws.id), String(ws.name || ''), ws.active ? 1 : 0))
      // 必须留下一个激活工作区，否则之后新建项目无处归属
      if (!this.db.prepare('SELECT id FROM workspaces WHERE active = 1').get()) {
        this.db.prepare('UPDATE workspaces SET active = 1 WHERE id = (SELECT id FROM workspaces ORDER BY id LIMIT 1)').run()
      }
      const workspaceIds = ids('SELECT id FROM workspaces')

      // 已存在的项目保留名称与描述（文档侧在维护这两个字段），只回填工作台负责的状态字段
      const upsertProject = this.db.prepare(`
        INSERT INTO projects (id, name, description, workspace_id, status, deadline, color, archived, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(id) DO UPDATE SET
          workspace_id = excluded.workspace_id, status = excluded.status,
          deadline = excluded.deadline, updated_at = CURRENT_TIMESTAMP
      `)
      payload.projects.forEach((project: any) => {
        const raw = project.workspace_id ?? project.workspaceId ?? null
        const workspaceId = raw !== null && workspaceIds.has(Number(raw)) ? Number(raw) : null
        upsertProject.run(
          Number(project.id),
          String(project.name || ''),
          String(project.description || ''),
          workspaceId,
          String(project.status || 'active'),
          project.deadline || null,
          project.color || null,
          project.archived ? 1 : 0,
        )
      })
      const projectIds = ids('SELECT id FROM projects')

      const insertGroup = this.db.prepare('INSERT INTO task_groups (id, name, color, position) VALUES (?, ?, ?, ?)')
      payload.taskGroups.forEach((group: any) =>
        insertGroup.run(Number(group.id), String(group.name || ''), String(group.color || 'blue'), Number(group.position || 0)),
      )
      const groupIds = ids('SELECT id FROM task_groups')

      const insertTask = this.db.prepare(`
        INSERT INTO tasks (code, group_id, name, description, priority, status, deadline, owner, participant, position, project_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      payload.tasks.forEach((task: any) => {
        // code 有 UNIQUE 约束，空值不能重复写入
        const code = String(task.code || task.id || '').trim()
        if (!code) return
        // 分组是 NOT NULL 外键：备份与本地对不上时宁可跳过，也不能整个恢复失败
        const groupId = Number(task.group_id ?? task.groupId ?? 0)
        if (!groupIds.has(groupId)) return
        const rawProject = task.project_id ?? task.projectId ?? null
        insertTask.run(
          code,
          groupId,
          String(task.name || ''),
          String(task.description || ''),
          String(task.priority || '中'),
          String(task.status || 'todo'),
          task.deadline || null,
          String(task.owner || ''),
          task.participant === false || task.participant === 0 ? 0 : 1,
          Number(task.position || 0),
          rawProject !== null && projectIds.has(Number(rawProject)) ? Number(rawProject) : null,
        )
        taskCodes.add(code)
      })

      // 标签按名称合并，不删除既有标签（与文档标签共用）
      const upsertTag = this.db.prepare(`
        INSERT INTO tags (name, color) VALUES (?, ?)
        ON CONFLICT(name) DO UPDATE SET color = excluded.color
      `)
      const findTag = this.db.prepare('SELECT id FROM tags WHERE name = ?')
      payload.tags.forEach((tag: any) => {
        const name = String(tag.name || '').trim()
        if (!name) return
        upsertTag.run(name, String(tag.color || 'green'))
        const local = findTag.get(name) as any
        if (local) tagIdMap.set(Number(tag.id), Number(local.id))
      })

      const insertTaskTag = this.db.prepare('INSERT INTO task_tags (task_code, tag_id) VALUES (?, ?) ON CONFLICT DO NOTHING')
      payload.taskTags.forEach((row: any) => {
        const tagId = tagIdMap.get(Number(row.tagId ?? row.tag_id))
        const code = String(row.taskCode ?? row.task_code ?? '')
        if (tagId && taskCodes.has(code)) insertTaskTag.run(code, tagId)
      })

      const insertFile = this.db.prepare(`
        INSERT INTO workspace_files (workspace_id, name, file_path, size, extension) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(file_path) DO NOTHING
      `)
      payload.files.forEach((file: any) => {
        const workspaceId = Number(file.workspaceId ?? file.workspace_id ?? 0)
        if (!workspaceIds.has(workspaceId)) return
        insertFile.run(workspaceId, String(file.name || ''), String(file.filePath || file.file_path || ''), Number(file.size || 0), String(file.extension || ''))
      })

      const insertNotification = this.db.prepare('INSERT INTO notifications (type, title, message, is_read) VALUES (?, ?, ?, ?)')
      payload.notifications.forEach((item: any) =>
        insertNotification.run(String(item.type || 'info'), String(item.title || ''), String(item.message || ''), item.isRead ? 1 : 0),
      )

      const insertReminder = this.db.prepare('INSERT INTO reminders (task_code, title, remind_at, repeat_rule, status) VALUES (?, ?, ?, ?, ?)')
      payload.reminders.forEach((item: any) => {
        const code = item.taskCode ?? item.task_code ?? null
        insertReminder.run(
          code && taskCodes.has(String(code)) ? String(code) : null,
          String(item.title || ''),
          String(item.remindAt || ''),
          String(item.repeatRule || 'none'),
          String(item.status || 'pending'),
        )
      })
    })

    // 设置项走白名单，兼容带前缀与不带前缀两种备份
    const settings: Record<string, any> = {}
    SETTING_KEYS.forEach((key) => {
      const value = payload.settings[key] ?? payload.settings[`${SETTING_PREFIX}${key}`]
      if (typeof value !== 'undefined') settings[key] = value
    })
    this.saveSettings(settings)

    return { ...this.statistics(), safetyBackup: safety.name }
  }

  statistics() {
    const count = (sql: string) => Number((this.db.prepare(sql).get() as any)?.count || 0)
    return {
      workspaces: count('SELECT COUNT(*) AS count FROM workspaces'),
      projects: count('SELECT COUNT(*) AS count FROM projects'),
      taskGroups: count('SELECT COUNT(*) AS count FROM task_groups'),
      tasks: count('SELECT COUNT(*) AS count FROM tasks'),
      tags: count('SELECT COUNT(*) AS count FROM tags'),
      files: count('SELECT COUNT(*) AS count FROM workspace_files'),
      notifications: count('SELECT COUNT(*) AS count FROM notifications'),
      reminders: count('SELECT COUNT(*) AS count FROM reminders'),
      users: count('SELECT COUNT(*) AS count FROM users'),
    }
  }
}
