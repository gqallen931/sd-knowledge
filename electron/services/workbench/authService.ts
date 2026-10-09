import { pbkdf2Sync, randomBytes, timingSafeEqual } from 'crypto'
import { WorkbenchDb } from './types'

export interface LocalUser {
  id: number
  username: string
  displayName: string
  role: string
}

/**
 * 本地账户服务：`users` 表是全系统唯一身份源。
 *
 * 与 SD 原有安全体系的分工（ADR-003 决策）：
 * - `users`（本服务）：**人**的身份，登录后签发内存会话。
 * - `api_keys`（SecurityService）：**机器**凭证，MCP/外部调用凭 key 换 role，不参与登录。
 * - `audit_logs`（SecurityService 表）：两边共用，本服务写入的审计带真实用户名。
 *
 * 有意偏离 deskforge 两处：
 * 1. KDF 由 scrypt 改为 PBKDF2-SHA512。SD 原有的密码存储已是 PBKDF2，
 *    同一套系统里不该并存两种口令派生算法，统一以既有实现为准。
 * 2. 会话以 `clientId` 显式传入（Web 端送本地会话 token，桌面端送 'desktop'），
 *    不再由渲染进程自造 id。
 */
export class AuthService {
  private sessions = new Map<string, LocalUser>()

  constructor(private db: WorkbenchDb) {}

  private static hash(password: string, salt: string): string {
    return pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex')
  }

  /** 定长比较，避免 timingSafeEqual 在长度不等时抛错 */
  private static safeEqual(a: string, b: string): boolean {
    const left = Buffer.from(a, 'hex')
    const right = Buffer.from(b, 'hex')
    if (left.length !== right.length || left.length === 0) return false
    return timingSafeEqual(left, right)
  }

  private normalizeUsername(value: unknown): string {
    const username = String(value || '').trim()
    if (!/^[a-zA-Z0-9_.-]{3,40}$/.test(username)) throw new Error('用户名需为 3-40 位字母、数字、点、横线或下划线')
    return username
  }

  private validatePassword(value: unknown): string {
    const password = String(value || '')
    if (password.length < 8 || password.length > 128 || !/[A-Za-z]/.test(password) || !/\d/.test(password)) {
      throw new Error('密码需为 8-128 位，且同时包含字母和数字')
    }
    return password
  }

  private toSafeUser(user: any): LocalUser {
    return { id: Number(user.id), username: user.username, displayName: user.display_name, role: user.role }
  }

  private audit(action: string, details: string, actor = 'user') {
    this.db
      .prepare(`
        INSERT INTO audit_logs (actor_type, actor_name, action, resource_type, details, status)
        VALUES ('user', ?, ?, 'account', ?, 'success')
      `)
      .run(actor, action, details)
  }

  /** 是否已完成初始化（users 为空则需要首次创建账户） */
  needsSetup(): boolean {
    const row = this.db.prepare('SELECT COUNT(*) AS count FROM users').get() as any
    return Number(row?.count || 0) === 0
  }

  status(clientId: string) {
    return { needsSetup: this.needsSetup(), authenticated: this.sessions.has(clientId), user: this.sessions.get(clientId) || null }
  }

  register(clientId: string, input: any): LocalUser {
    if (!this.needsSetup()) throw new Error('本机账户已经初始化')
    const username = this.normalizeUsername(input?.username)
    const password = this.validatePassword(input?.password)
    const displayName = String(input?.displayName || username).trim().slice(0, 40) || username
    const salt = randomBytes(16).toString('hex')
    const result = this.db
      .prepare('INSERT INTO users (username, display_name, password_hash, salt, updated_at) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)')
      .run(username, displayName, AuthService.hash(password, salt), salt)
    const user: LocalUser = { id: Number(result.lastInsertRowid), username, displayName, role: 'owner' }
    this.sessions.set(clientId, user)
    this.audit('register', `注册本机账户 ${username}`, username)
    return user
  }

  login(clientId: string, input: any): LocalUser {
    const username = this.normalizeUsername(input?.username)
    const password = String(input?.password || '')
    const user = this.db.prepare('SELECT * FROM users WHERE username = ?').get(username) as any
    const now = Date.now()

    if (user?.locked_until && new Date(user.locked_until).getTime() > now) throw new Error('登录尝试过多，请稍后再试')

    const valid = Boolean(user) && password.length <= 128 && AuthService.safeEqual(AuthService.hash(password, user.salt), user.password_hash)
    if (!valid) {
      if (user) {
        const attempts = Number(user.failed_attempts || 0) + 1
        const lockedUntil = attempts >= 5 ? new Date(now + 5 * 60 * 1000).toISOString() : null
        this.db
          .prepare('UPDATE users SET failed_attempts = ?, locked_until = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
          .run(lockedUntil ? 0 : attempts, lockedUntil, user.id)
        if (lockedUntil) this.audit('login_locked', `连续失败锁定账户 ${username}`, username)
      }
      throw new Error('用户名或密码错误')
    }

    this.db
      .prepare('UPDATE users SET failed_attempts = 0, locked_until = NULL, last_login_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(user.id)
    const clean = this.toSafeUser(user)
    this.sessions.set(clientId, clean)
    return clean
  }

  logout(clientId: string): boolean {
    const user = this.sessions.get(clientId)
    if (user) this.audit('logout', `退出登录 ${user.username}`, user.username)
    this.sessions.delete(clientId)
    return true
  }

  /** 会话失效时抛 AUTH_REQUIRED，供中间件识别并返回 401 */
  requireSession(clientId: string): LocalUser {
    const user = this.sessions.get(clientId)
    if (!user) throw new Error('AUTH_REQUIRED')
    return user
  }

  changePassword(clientId: string, input: any): boolean {
    const session = this.requireSession(clientId)
    const newPassword = this.validatePassword(input?.newPassword)
    const user = this.db.prepare('SELECT * FROM users WHERE id = ?').get(session.id) as any
    if (!user || !AuthService.safeEqual(AuthService.hash(String(input?.currentPassword || ''), user.salt), user.password_hash)) {
      throw new Error('当前密码错误')
    }
    const salt = randomBytes(16).toString('hex')
    this.db
      .prepare('UPDATE users SET password_hash = ?, salt = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(AuthService.hash(newPassword, salt), salt, user.id)
    this.audit('change_password', `修改密码 ${user.username}`, user.username)
    return true
  }

  clear(clientId: string): void {
    this.sessions.delete(clientId)
  }
}
