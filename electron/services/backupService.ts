import * as fs from 'fs'
import * as path from 'path'
import DatabaseService from './database'

/**
 * 备份服务：
 * - 定时将数据库快照备份到 Data/backups/sd-YYYYMMDD-HHmmss.db
 * - 按设置 backup_count 轮换（超出保留数量时删除最旧备份）
 * - 启动时若距上次备份已超过间隔，立即补一次
 * file_versions 的写入逻辑见 FileService.recordVersion（版本控制）。
 */
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
