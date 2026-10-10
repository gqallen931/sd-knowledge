import * as fs from 'fs'
import * as path from 'path'
import DatabaseService from './database'
import type { DataManager } from './workbench/dataManager'

/**
 * 备份服务：
 * - 定时将数据库快照备份到 Data/backups/sd-YYYYMMDD-HHmmss.db
 * - 按设置 backup_count 轮换（超出保留数量时删除最旧备份）
 * - 启动时若距上次备份已超过间隔，立即补一次
 * file_versions 的写入逻辑见 FileService.recordVersion（版本控制）。
 */
/** S2-05：settings 中不允许随快照外发的键（密钥类一律不出本机） */
const SENSITIVE_SETTING_RE = /key|secret|password|passwd|token|salt|hash/i
/** 纯运维状态键：外发没有意义，一并剔除 */
const RUNTIME_SETTING_KEYS = ['last_backup_at']

export class BackupService {
  private db: DatabaseService
  private backupDir: string
  private timer: ReturnType<typeof setInterval> | null = null
  private running = false

  constructor(db: DatabaseService, dataDir: string) {
    this.db = db
    this.backupDir = path.join(dataDir, 'backups')
    fs.mkdirSync(this.backupDir, { recursive: true })
  }

  start() {
    this.stop()
    const intervalHours = Number(this.getSetting('backup_interval')) || 24
    if (intervalHours <= 0) return // 0 表示关闭自动备份
    const intervalMs = intervalHours * 3600_000
    const last = Number(this.getSetting('last_backup_at')) || 0
    if (Date.now() - last >= intervalMs) {
      this.runBackup('startup').catch(e => console.error('Startup backup failed:', e.message))
    }
    this.timer = setInterval(() => {
      this.runBackup('scheduled').catch(e => console.error('Scheduled backup failed:', e.message))
    }, intervalMs)
    // 不阻止进程退出（测试 / MCP 模式下随进程自然结束）
    ;(this.timer as any)?.unref?.()
  }

  restart() {
    this.start()
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  async runBackup(trigger: 'scheduled' | 'startup' | 'manual' = 'scheduled'): Promise<{ success: boolean; path?: string; reason?: string }> {
    if (this.running) return { success: false, reason: 'already_running' }
    this.running = true
    try {
      const now = new Date()
      const pad = (n: number) => String(n).padStart(2, '0')
      const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
      const dest = path.join(this.backupDir, `sd-${stamp}.db`)
      await this.db.backupTo(dest)
      await this.db.updateSettings({ last_backup_at: String(Date.now()) })
      this.pruneBackups()
      this.db.prepare(`INSERT INTO audit_logs (actor_type, actor_name, action, resource_type, details, status) VALUES ('system', 'backup', 'backup', 'database', ?, 'success')`)
        .run(`${trigger}: ${path.basename(dest)}`)
      return { success: true, path: dest }
    } catch (e: any) {
      this.db.prepare(`INSERT INTO audit_logs (actor_type, actor_name, action, resource_type, details, status) VALUES ('system', 'backup', 'backup', 'database', ?, 'error')`)
        .run(`${trigger} 失败: ${e.message}`)
      throw e
    } finally {
      this.running = false
    }
  }

  /**
   * 共享快照导出（S2-05）：把「可共享」的库内容落成一份自包含 JSON（Data/exports/snapshot-*.json）。
   *
   * 与 runBackup 的 .db 全量快照不同，这份是**面向外发/归档**的精选集：
   * - 包含：documents（不含正文与本地原始路径）、chunks（含锚点字段，保留溯源能力）、
   *   目录树与目录映射（不含绝对根路径，不暴露盘符结构）、实体/别名/关系、保存的检索、
   *   settings（剥离密钥类键）、工作台域全量（dataManager.exportData()）；
   * - 不含：向量、llm_providers（密文也不外发）、api_keys、users、审计与出域日志——这些属于本机安全边界。
   */
  exportSnapshot(dataManager?: DataManager): { path: string; fileName: string; size: number; counts: Record<string, number>; exportedAt: string } {
    const exportsDir = path.join(path.dirname(this.backupDir), 'exports')
    fs.mkdirSync(exportsDir, { recursive: true })
    const now = new Date()
    const pad = (n: number) => String(n).padStart(2, '0')
    const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
    const target = path.join(exportsDir, `snapshot-${stamp}.json`)

    const settings = Object.fromEntries(
      Object.entries(this.db.getSettingsSync())
        .filter(([key]) => !SENSITIVE_SETTING_RE.test(key) && !RUNTIME_SETTING_KEYS.includes(key)),
    )

    const documents = this.db.prepare(`
      SELECT id, title, file_name, file_type, file_size, storage_type, summary, project_id,
             source_id, relative_path, created_at, updated_at, imported_at, processing_status
      FROM documents ORDER BY id
    `).all()
    const chunks = this.db.prepare(`
      SELECT document_id, chunk_index, content, char_start, char_end, anchor_kind, anchor_index,
             time_start_ms, time_end_ms, token_count, chunk_size, chunk_overlap
      FROM chunks ORDER BY document_id, chunk_index
    `).all()
    const folders = this.db.prepare(`
      SELECT id, source_id, path, name, parent_id, depth, doc_count, summary FROM folders ORDER BY id
    `).all()
    const folderSources = this.db.prepare(`
      SELECT id, name, storage_mode, recursive, include_ext, exclude_globs, project_id, auto_sync, enabled
      FROM folder_sources ORDER BY id
    `).all()
    const entities = this.db.prepare('SELECT id, name, type, description FROM entities ORDER BY id').all()
    const entityAliases = this.db.prepare('SELECT entity_id, alias, source FROM entity_aliases ORDER BY id').all()
    const relationships = this.db.prepare(`
      SELECT id, source_type, source_id, target_type, target_id, relation_type, weight
      FROM relationships ORDER BY id
    `).all()
    const savedSearches = this.db.prepare(`
      SELECT id, name, query, filters_json, owner, notify_on_change, created_at
      FROM saved_searches ORDER BY id
    `).all()
    const workbench = dataManager ? dataManager.exportData() : null

    const counts: Record<string, number> = {
      documents: documents.length, chunks: chunks.length, folders: folders.length,
      folderSources: folderSources.length, entities: entities.length, entityAliases: entityAliases.length,
      relationships: relationships.length, savedSearches: savedSearches.length,
    }
    if (workbench && typeof workbench === 'object') {
      const section = workbench as Record<string, unknown>
      counts.tasks = Array.isArray(section.tasks) ? section.tasks.length : 0
      counts.projects = Array.isArray(section.projects) ? section.projects.length : 0
    }

    const payload = {
      format: 'zhixu-snapshot',
      version: 1,
      exportedAt: now.toISOString(),
      counts,
      settings, documents, chunks, folders, folderSources, entities, entityAliases, relationships, savedSearches, workbench,
    }
    fs.writeFileSync(target, JSON.stringify(payload, null, 2), 'utf8')
    return { path: target, fileName: path.basename(target), size: fs.statSync(target).size, counts, exportedAt: now.toISOString() }
  }

  private pruneBackups() {
    const keep = Math.max(1, Number(this.getSetting('backup_count')) || 7)
    const files = fs.readdirSync(this.backupDir)
      .filter(f => /^sd-\d{8}-\d{6}\.db$/.test(f))
      .sort() // 文件名含时间戳，字典序即时间序
    const excess = files.slice(0, Math.max(0, files.length - keep))
    for (const f of excess) {
      try { fs.unlinkSync(path.join(this.backupDir, f)) } catch { /* 忽略删除失败 */ }
    }
  }

  private getSetting(key: string): string | undefined {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as any
    return row?.value
  }
}
