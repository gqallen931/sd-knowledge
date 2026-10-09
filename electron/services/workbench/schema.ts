import type { Migration } from '../migrations'

/**
 * 工作台域表结构（移植自 deskforge），版本号 100..199。
 *
 * 与 deskforge 原始 DDL 的**有意差异**（三处，均为融合必需）：
 *
 * 1. `projects` 不新建表，而是给内核域已有的 `projects` 扩列。
 *    deskforge 原定义里 `workspace_id INTEGER NOT NULL`，但内核域的 projects 是「文档项目集」，
 *    存量行没有工作区归属，加 NOT NULL 无法迁移 → 放宽为可空，由应用层保证新建时必填。
 *    这一步让「一个项目既装文档又装任务」成为同一行记录，是知识域与工作台域的核心连接点。
 *
 * 2. `app_state` 不建表，合并进内核域的 `settings`（KV → KV）。
 *    deskforge 用 app_state 只存了一份 dashboard 的 JSON blob，与 settings 的语义完全重叠。
 *
 * 3. `tasks` 直接带 `project_id` 建表，吸收 deskforge 的 migration v2（原为 ALTER 补列）。
 *    本库中 tasks 是新表，没有存量行需要补列。
 *
 * 另需注意：内核域连接开启了 `PRAGMA foreign_keys = ON`，而 deskforge 原本没有开启。
 * 因此 `task_tags` 的 ON DELETE CASCADE、`tasks.group_id` 的非空约束从「声明」变为「强制」，
 * 删除仍有任务的组会直接报错而非留下孤儿行——这是预期的收紧，移植服务层时需按此处理。
 */

/** 工作台域迁移版本段下界 */
export const WORKBENCH_MIGRATION_BASE = 100

/** 默认工作区名：首个工作区必须存在，否则所有任务/项目都无处归属 */
export const DEFAULT_WORKSPACE_NAME = '个人工作台'

export const workbenchMigrations: Migration[] = [
  {
    version: 100,
    name: 'workbench-workspaces',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS workspaces (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          active INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
      `)
      const existing = db.prepare('SELECT id FROM workspaces LIMIT 1').get()
      if (!existing) {
        db.prepare('INSERT INTO workspaces (name, active) VALUES (?, 1)').run(DEFAULT_WORKSPACE_NAME)
      }
    },
  },
  {
    version: 101,
    name: 'workbench-project-columns',
    up(db) {
      const columns = db.prepare('PRAGMA table_info(projects)').all()
      const has = (name: string) => columns.some((column: any) => column.name === name)

      if (!has('workspace_id')) db.exec('ALTER TABLE projects ADD COLUMN workspace_id INTEGER REFERENCES workspaces(id)')
      if (!has('status')) db.exec("ALTER TABLE projects ADD COLUMN status TEXT NOT NULL DEFAULT 'active'")
      if (!has('deadline')) db.exec('ALTER TABLE projects ADD COLUMN deadline TEXT')
      if (!has('archived')) db.exec('ALTER TABLE projects ADD COLUMN archived INTEGER NOT NULL DEFAULT 0')
      if (!has('updated_at')) {
        // 注意：ADD COLUMN 不接受 CURRENT_TIMESTAMP 这类非常量默认值，非空表上会直接报
        // "Cannot add a column with non-constant default"（空表侥幸能过，属隐蔽陷阱）。
        // 因此这里先建无默认值的空列再回填，代价是新增行需由服务层显式写入 updated_at。
        db.exec('ALTER TABLE projects ADD COLUMN updated_at DATETIME')
        db.exec('UPDATE projects SET updated_at = CURRENT_TIMESTAMP WHERE updated_at IS NULL')
      }

      db.exec('CREATE INDEX IF NOT EXISTS idx_projects_workspace ON projects(workspace_id, archived)')
    },
  },
  {
    version: 102,
    name: 'workbench-settings-timestamp',
    up(db) {
      // app_state 合并进 settings：这里只补 deskforge 依赖的 updated_at
      const columns = db.prepare('PRAGMA table_info(settings)').all()
      if (!columns.some((column: any) => column.name === 'updated_at')) {
        db.exec('ALTER TABLE settings ADD COLUMN updated_at DATETIME')
        db.exec('UPDATE settings SET updated_at = CURRENT_TIMESTAMP WHERE updated_at IS NULL')
      }
    },
  },
  {
    version: 103,
    name: 'workbench-task-groups-and-tasks',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS task_groups (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          color TEXT NOT NULL DEFAULT 'blue',
          position INTEGER NOT NULL DEFAULT 0,
          archived INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS tasks (
          row_id INTEGER PRIMARY KEY AUTOINCREMENT,
          code TEXT UNIQUE,
          group_id INTEGER NOT NULL REFERENCES task_groups(id),
          name TEXT NOT NULL,
          description TEXT NOT NULL DEFAULT '',
          priority TEXT NOT NULL DEFAULT '中',
          status TEXT NOT NULL DEFAULT 'todo',
          deadline TEXT,
          owner TEXT NOT NULL DEFAULT '',
          participant INTEGER NOT NULL DEFAULT 1,
          position INTEGER NOT NULL DEFAULT 0,
          archived INTEGER NOT NULL DEFAULT 0,
          project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        CREATE INDEX IF NOT EXISTS idx_tasks_group_position ON tasks(group_id, position);
        CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status, archived);
        CREATE INDEX IF NOT EXISTS idx_tasks_project_id ON tasks(project_id);
      `)
    },
  },
  {
    version: 104,
    name: 'workbench-task-tags-and-files-and-notifications',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS task_tags (
          task_code TEXT NOT NULL REFERENCES tasks(code) ON DELETE CASCADE,
          tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
          PRIMARY KEY (task_code, tag_id)
        );

        CREATE TABLE IF NOT EXISTS workspace_files (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          workspace_id INTEGER NOT NULL REFERENCES workspaces(id),
          name TEXT NOT NULL,
          file_path TEXT NOT NULL UNIQUE,
          size INTEGER NOT NULL DEFAULT 0,
          extension TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS notifications (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          type TEXT NOT NULL DEFAULT 'info',
          title TEXT NOT NULL,
          message TEXT NOT NULL DEFAULT '',
          is_read INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        CREATE INDEX IF NOT EXISTS idx_notifications_unread ON notifications(is_read, created_at);
        CREATE INDEX IF NOT EXISTS idx_workspace_files_workspace ON workspace_files(workspace_id);
      `)
    },
  },
  {
    version: 105,
    name: 'workbench-reminders-and-backup-history',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS reminders (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          task_code TEXT REFERENCES tasks(code) ON DELETE SET NULL,
          title TEXT NOT NULL,
          remind_at TEXT NOT NULL,
          repeat_rule TEXT NOT NULL DEFAULT 'none',
          status TEXT NOT NULL DEFAULT 'pending',
          notified_at TEXT,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS backup_history (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          file_path TEXT NOT NULL UNIQUE,
          filename TEXT NOT NULL,
          size INTEGER NOT NULL DEFAULT 0,
          format_version INTEGER NOT NULL,
          kind TEXT NOT NULL DEFAULT 'manual',
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        CREATE INDEX IF NOT EXISTS idx_reminders_due ON reminders(status, remind_at);
      `)
    },
  },
  {
    version: 106,
    name: 'workbench-local-users',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS users (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          username TEXT NOT NULL UNIQUE COLLATE NOCASE,
          display_name TEXT NOT NULL,
          password_hash TEXT NOT NULL,
          salt TEXT NOT NULL,
          role TEXT NOT NULL DEFAULT 'owner',
          failed_attempts INTEGER NOT NULL DEFAULT 0,
          locked_until TEXT,
          last_login_at TEXT,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
      `)
    },
  },
]
