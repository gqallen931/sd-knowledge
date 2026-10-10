import { createHash, randomBytes, pbkdf2Sync } from 'crypto'
import * as fs from 'fs'
import * as path from 'path'
import DatabaseService from './database'

export class SecurityService {
  private initialized = false

  constructor(
    private db: DatabaseService,
    /** S2-10：审计清理前快照的落盘目录；未提供时清理前不落盘（仅测试场景） */
    private auditBackupDir?: string,
  ) {}

  async getStatus(): Promise<any> {
    const setting = this.db.prepare("SELECT value FROM settings WHERE key = 'security_enabled'").get() as any
    const hasPassword = this.db.prepare("SELECT value FROM settings WHERE key = 'password_hash'").get() as any
    const keyCount = this.db.prepare('SELECT COUNT(*) as count FROM api_keys WHERE is_active = 1').get() as any
    const sessionCount = this.db.prepare("SELECT COUNT(*) as count FROM agent_sessions WHERE status = 'active'").get() as any

    return {
      enabled: setting?.value === 'true',
      hasPassword: !!hasPassword?.value,
      apiKeys: keyCount.count,
      activeSessions: sessionCount.count
    }
  }

  async setup(password: string): Promise<any> {
    if (password.length < 6) {
      return { success: false, error: 'Password too short (min 6 characters)' }
    }

    const salt = randomBytes(16).toString('hex')
    const hash = this.hashPassword(password, salt)
    const masterKey = this.deriveKey(password, salt)

    this.db.prepare(`
      INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES
      ('security_enabled', 'true', CURRENT_TIMESTAMP),
      ('password_hash', ?, CURRENT_TIMESTAMP),
      ('password_salt', ?, CURRENT_TIMESTAMP),
      ('master_key_hint', ?, CURRENT_TIMESTAMP)
    `).run(hash, salt, masterKey.substring(0, 8))

    this.initialized = true
    this.logAudit('user', 'setup', 'security', 'Security initialized')
    return { success: true }
  }

  async verify(password: string): Promise<any> {
    const stored = this.db.prepare(`
      SELECT value FROM settings WHERE key = 'password_hash'
    `).get() as any
    const saltRow = this.db.prepare(`
      SELECT value FROM settings WHERE key = 'password_salt'
    `).get() as any

    if (!stored || !saltRow) return { success: false, error: 'Security not initialized' }

    const hash = this.hashPassword(password, saltRow.value)
    if (hash === stored.value) {
      this.initialized = true
      return { success: true }
    }
    return { success: false, error: 'Invalid password' }
  }

  async createApiKey(name: string, role: string = 'reader'): Promise<any> {
    const rawKey = `sd_${randomBytes(24).toString('hex')}`
    const keyHash = createHash('sha256').update(rawKey).digest('hex')
    const keyPrefix = rawKey.substring(0, 11)

    const info = this.db.prepare(`
      INSERT INTO api_keys (key_hash, key_prefix, name, role)
      VALUES (?, ?, ?, ?)
    `).run(keyHash, keyPrefix, name, role)

    this.logAudit('user', 'create', 'api_key', `Created key: ${name} (role: ${role})`)
    return { id: info.lastInsertRowid, key: rawKey, name, role }
  }

  async validateApiKey(token: string): Promise<boolean> {
    const keyHash = createHash('sha256').update(token).digest('hex')
    const key = this.db.prepare(`
      SELECT id, name, role FROM api_keys WHERE key_hash = ? AND is_active = 1
    `).get(keyHash) as any

    if (!key) return false

    this.db.prepare('UPDATE api_keys SET last_used_at = CURRENT_TIMESTAMP WHERE id = ?').run(key.id)
    return true
  }

  async getApiKeyRole(token: string): Promise<string> {
    const hash = createHash('sha256').update(token).digest('hex')
    return (this.db.prepare('SELECT role FROM api_keys WHERE key_hash=? AND is_active=1').get(hash) as any)?.role || 'reader'
  }

  async listApiKeys(): Promise<any[]> {
    return this.db.prepare(`
      SELECT id, key_prefix, name, role, created_at, last_used_at, is_active
      FROM api_keys ORDER BY created_at DESC
    `).all()
  }

  async revokeApiKey(id: number): Promise<any> {
    this.db.prepare('UPDATE api_keys SET is_active = 0 WHERE id = ?').run(id)
    this.logAudit('user', 'revoke', 'api_key', `Revoked key id: ${id}`)
    return { success: true }
  }

  async getAuditLogs(filters: any = {}): Promise<any[]> {
    let sql = 'SELECT * FROM audit_logs'
    const conditions: string[] = []
    const params: any[] = []

    if (filters.action) { conditions.push('action = ?'); params.push(filters.action) }
    if (filters.actor_name) { conditions.push('actor_name = ?'); params.push(filters.actor_name) }
    if (filters.from_date) { conditions.push('created_at >= ?'); params.push(filters.from_date) }
    if (filters.to_date) { conditions.push('created_at <= ?'); params.push(filters.to_date) }

    if (conditions.length > 0) sql += ' WHERE ' + conditions.join(' AND ')
    sql += ' ORDER BY created_at DESC LIMIT ?'
    params.push(filters.limit || 100)

    return this.db.prepare(sql).all(...params)
  }

  // ── 审计日志清理与轮转（S2-10）──────────────────────────────────────

  /** 审计保留天数：存 settings 表；缺省 90 天，允许 7–365 */
  async getAuditRetentionDays(): Promise<number> {
    const settings = await this.db.getSettings()
    const days = Number((settings as any).audit_retention_days)
    return Number.isFinite(days) && days >= 7 && days <= 365 ? Math.round(days) : 90
  }

  async setAuditRetentionDays(days: number): Promise<number> {
    const n = Math.round(Number(days))
    if (!Number.isFinite(n) || n < 7 || n > 365) throw new Error('保留天数需为 7–365 的整数')
    await this.db.updateSettings({ audit_retention_days: String(n) })
    this.logAudit('user', 'update', 'settings', `audit retention set to ${n} days`)
    return n
  }

  /**
   * 清理保留窗口之外的审计记录。清理前把将删记录快照成 JSON 落盘（审计是追责依据，
   * 误删不可逆）；快照失败则中止清理并抛错，绝不「没备份就删」。
   */
  async pruneAuditLogs(retentionDays?: number): Promise<{ removed: number; remaining: number; snapshot: string | null }> {
    const days = retentionDays != null ? Math.round(Number(retentionDays)) : await this.getAuditRetentionDays()
    if (!Number.isFinite(days) || days < 1) throw new Error('保留天数无效')

    const stale = this.db.prepare("SELECT * FROM audit_logs WHERE created_at < datetime('now', '-' || ? || ' days')").all(String(days)) as any[]
    if (stale.length === 0) {
      const row = this.db.prepare('SELECT COUNT(*) AS n FROM audit_logs').get() as any
      return { removed: 0, remaining: Number(row?.n || 0), snapshot: null }
    }

    let snapshotPath: string | null = null
    if (this.auditBackupDir) {
      fs.mkdirSync(this.auditBackupDir, { recursive: true })
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      snapshotPath = path.join(this.auditBackupDir, `audit-pruned-${stamp}.json`)
      fs.writeFileSync(snapshotPath, JSON.stringify({ pruned_at: new Date().toISOString(), retention_days: days, count: stale.length, rows: stale }, null, 2), 'utf8')
    }

    this.db.prepare("DELETE FROM audit_logs WHERE created_at < datetime('now', '-' || ? || ' days')").run(String(days))
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM audit_logs').get() as any
    this.logAudit('user', 'delete', 'audit_log', `pruned ${stale.length} entries older than ${days} days${snapshotPath ? `; snapshot: ${path.basename(snapshotPath)}` : ''}`)
    return { removed: stale.length, remaining: Number(row?.n || 0), snapshot: snapshotPath }
  }

  private hashPassword(password: string, salt: string): string {
    return pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex')
  }

  private deriveKey(password: string, salt: string): string {
    return pbkdf2Sync(password, salt, 100000, 32, 'sha256').toString('hex')
  }

  private logAudit(actorType: string, action: string, resourceType: string, details: string) {
    this.db.prepare(`
      INSERT INTO audit_logs (actor_type, actor_name, action, resource_type, details, status)
      VALUES (?, ?, ?, ?, ?, 'success')
    `).run(actorType, 'user', action, resourceType, details)
  }
}
