import * as fs from 'fs'
import * as path from 'path'

/**
 * 迁移执行器：把「隐式补列」升级为「带版本号的显式迁移」。
 *
 * 背景：原有迁移是 init() 里一串 `PRAGMA table_info` 判断 + ALTER，单域时够用，
 * 但并入工作台域后会出现两个问题：
 *   1. 无法区分「这条 ALTER 属于哪个业务域」，排查时只能通读 init()；
 *   2. 无法记录「迁移已执行」，每次启动都要重新探测一遍列。
 * 因此引入与 deskforge 同形的 `schema_migrations` 表，版本号按域分段：
 *   内核域 1..99 / 工作台域 100..199，一眼能看出某条迁移归谁。
 *
 * 与 deskforge 原实现的差异：快照改为「仅存量库执行」。新库没有数据可丢，
 * 每次都做一次整库 VACUUM INTO 只是白付启动成本。
 */

export interface MigrationDb {
  exec: (sql: string) => unknown
  prepare: (sql: string) => {
    all: (...args: any[]) => any[]
    get: (...args: any[]) => any
    run: (...args: any[]) => unknown
  }
}

export interface Migration {
  version: number
  name: string
  up: (db: MigrationDb) => void
}

export interface MigrationRunResult {
  applied: Array<{ version: number; name: string }>
  snapshot: string | null
}

/** 内核域迁移版本段下界（工作台域从 100 起，两段互不重叠） */
export const CORE_MIGRATION_LIMIT = 100

export function runMigrations(
  db: MigrationDb,
  migrations: Migration[],
  options: { dbPath?: string; snapshotDir?: string; snapshot?: boolean } = {},
): MigrationRunResult {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `)

  const done = new Set<number>(
    (db.prepare('SELECT version FROM schema_migrations').all() as any[]).map(row => row.version),
  )
  const pending = migrations
    .filter(migration => !done.has(migration.version))
    .sort((a, b) => a.version - b.version)
  if (!pending.length) return { applied: [], snapshot: null }

  let snapshot: string | null = null
  if (options.snapshot && options.dbPath && options.dbPath !== ':memory:') {
    try {
      const snapshotDir = options.snapshotDir || path.join(path.dirname(options.dbPath), 'migration-backups')
      fs.mkdirSync(snapshotDir, { recursive: true })
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
      snapshot = path.join(snapshotDir, `sd-pre-migration-${stamp}.db`)
      db.exec(`VACUUM INTO '${snapshot.split("'").join("''")}'`)
    } catch (error) {
      // 快照是保险而非前置条件：失败只降级记录，不阻断启动（迁移本身仍是单事务）
      console.error('[migrations] 迁移前快照失败，继续执行迁移：', error)
      snapshot = null
    }
  }

  const record = db.prepare('INSERT INTO schema_migrations (version, name) VALUES (?, ?)')
  for (const migration of pending) {
    db.exec('BEGIN IMMEDIATE')
    try {
      migration.up(db)
      record.run(migration.version, migration.name)
      db.exec('COMMIT')
    } catch (error: any) {
      try { db.exec('ROLLBACK') } catch {}
      throw new Error(`数据库迁移 ${migration.version} (${migration.name}) 失败: ${error?.message || error}`)
    }
  }

  return { applied: pending.map(({ version, name }) => ({ version, name })), snapshot }
}
