import { pbkdf2Sync, randomBytes, randomInt, timingSafeEqual } from 'crypto'
import { WorkbenchDb } from './types'

export type ContactType = 'email' | 'phone'
export type CodePurpose = 'register' | 'reset'

export interface LocalUser {
  id: number
  username: string
  displayName: string
  role: string
  contactType: ContactType | null
  maskedContact: string | null
}

export interface CodeReceipt {
  accepted: true
  cooldownSeconds: number
  expiresInSeconds: number
}

export interface AuthPolicy {
  codeTtlMs: number
  sendCooldownMs: number
  dailySendLimit: number
  maxCodeAttempts: number
  /** 同一联系方式近 1 小时内累计输错次数达到该值即暂停校验，防止穷举 */
  hourlyFailureLimit: number
  loginMaxFailures: number
  loginLockMs: number
}

/** 防刷阈值；测试可通过 options.policy 覆盖 */
export const AUTH_POLICY: AuthPolicy = {
  codeTtlMs: 10 * 60 * 1000,
  sendCooldownMs: 60 * 1000,
  dailySendLimit: 10,
  maxCodeAttempts: 5,
  hourlyFailureLimit: 15,
  loginMaxFailures: 5,
  loginLockMs: 5 * 60 * 1000,
}

/** 验证码投递内容：不含任何会话或密钥信息 */
export interface CodeDelivery {
  purpose: CodePurpose
  contactType: ContactType
  contact: string
  code: string
  expiresInMinutes: number
}

export interface ContactSender {
  send(delivery: CodeDelivery): Promise<void>
}

/** 未配置发送通道：明确失败，绝不静默吞掉验证码 */
class UnconfiguredSender implements ContactSender {
  constructor(private reason: string) {}
  async send(): Promise<void> {
    throw new Error(this.reason)
  }
}

/** 开发调试用：验证码打印到控制台。必须显式设置 SD_CODE_SENDER=console，生产环境不得使用 */
class ConsoleSender implements ContactSender {
  async send(delivery: CodeDelivery): Promise<void> {
    console.log(`[verify] ${delivery.purpose} ${delivery.contact} code=${delivery.code} ttl=${delivery.expiresInMinutes}min`)
  }
}

/** 交给外部邮件 / 短信网关：POST JSON，网关非 2xx 视为发送失败 */
class WebhookSender implements ContactSender {
  constructor(private url: string, private token?: string) {}
  async send(delivery: CodeDelivery): Promise<void> {
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (this.token) headers.authorization = `Bearer ${this.token}`
    const response = await fetch(this.url, {
      method: 'POST',
      headers,
      body: JSON.stringify(delivery),
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) throw new Error(`验证码发送失败（网关返回 HTTP ${response.status}），请稍后重试`)
  }
}

/**
 * 按环境变量选择验证码发送通道：
 * - `SD_CODE_SENDER=webhook` + `SD_CODE_WEBHOOK_URL`（https，或本机 http://127.0.0.1）+ 可选 `SD_CODE_WEBHOOK_TOKEN`
 * - `SD_CODE_SENDER=console`：仅开发调试
 * - 未设置：注册与找回密码会返回「发送通道未配置」，不会假装已发送
 */
export function createContactSenderFromEnv(env: NodeJS.ProcessEnv = process.env): ContactSender {
  const kind = env.SD_CODE_SENDER
  if (kind === 'console') return new ConsoleSender()
  if (kind === 'webhook') {
    const raw = env.SD_CODE_WEBHOOK_URL || ''
    let url: URL | null = null
    try {
      url = new URL(raw)
    } catch {
      url = null
    }
    const local = url && (url.hostname === '127.0.0.1' || url.hostname === 'localhost')
    if (!url || (url.protocol !== 'https:' && !(url.protocol === 'http:' && local))) {
      return new UnconfiguredSender('SD_CODE_WEBHOOK_URL 必须是 https 地址（本机调试可用 http://127.0.0.1）')
    }
    return new WebhookSender(url.toString(), env.SD_CODE_WEBHOOK_TOKEN)
  }
  return new UnconfiguredSender('验证码发送通道未配置：请设置 SD_CODE_SENDER（webhook / console）后重启应用')
}

const EMAIL_RULE = /^[a-z0-9](?:[a-z0-9._%+-]{0,62}[a-z0-9])?@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.[a-z]{2,24}$/
const PHONE_RULE = /^1[3-9]\d{9}$/
const ALREADY_REGISTERED = '该邮箱或手机号已注册，请直接登录，或使用找回密码'
const DAY_MS = 24 * 60 * 60 * 1000
const HOUR_MS = 60 * 60 * 1000

/**
 * 校验并归一化联系方式：含 @ 视为邮箱（小写），否则按中国大陆手机号处理（去空格、去 +86 / 86 前缀）。
 * 注册、登录、找回密码共用这一个入口，保证同一个邮箱/手机号只有一种写法。
 */
export function normalizeContact(raw: unknown): { type: ContactType; value: string } {
  const text = String(raw ?? '').trim()
  if (text.includes('@')) {
    const email = text.toLowerCase()
    if (email.length > 254 || !EMAIL_RULE.test(email)) throw new Error('邮箱格式不正确，请检查后重新输入')
    return { type: 'email', value: email }
  }
  let phone = text.replace(/[\s-]/g, '')
  if (phone.startsWith('+86')) phone = phone.slice(3)
  else if (/^86\d{11}$/.test(phone)) phone = phone.slice(2)
  if (!PHONE_RULE.test(phone)) throw new Error('请输入正确的邮箱或 11 位中国大陆手机号')
  return { type: 'phone', value: phone }
}

/** 展示用掩码：ab***@example.com / 138****0000 */
export function maskContact(type: ContactType | null, value: string | null): string | null {
  if (!value) return null
  if (type === 'phone') return `${value.slice(0, 3)}****${value.slice(-4)}`
  const [local, domain] = value.split('@')
  return `${local.slice(0, 2)}***@${domain}`
}

/** 本机账户服务：`users` 表是全系统唯一身份源，联系方式（邮箱 / 手机号）是登录标识与找回渠道。 */
export class AuthService {
  private sessions = new Map<string, LocalUser>()
  private readonly sender: ContactSender
  private readonly now: () => number
  private readonly policy: AuthPolicy

  constructor(
    private db: WorkbenchDb,
    options: { sender?: ContactSender; now?: () => number; policy?: Partial<AuthPolicy> } = {},
  ) {
    this.sender = options.sender ?? createContactSenderFromEnv()
    this.now = options.now ?? (() => Date.now())
    this.policy = { ...AUTH_POLICY, ...options.policy }
  }

  private static hash(password: string, salt: string): string {
    return pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex')
  }

  /** 验证码用 SHA-256 系 PBKDF2，与口令哈希分开，避免两者互相影响 */
  private static hashCode(code: string, salt: string): string {
    return pbkdf2Sync(code, salt, 100000, 32, 'sha256').toString('hex')
  }

  /** 账户不存在时也跑一次哈希，让耗时与「密码错误」一致，避免靠响应时间枚举账户 */
  private static verifyPassword(password: string, user: any): boolean {
    if (!user) {
      AuthService.hash(password, 'sd-dummy-salt-for-timing')
      return false
    }
    return password.length <= 128 && AuthService.safeEqual(AuthService.hash(password, user.salt), user.password_hash)
  }

  /** 定长比较，避免 timingSafeEqual 在长度不等时抛错 */
  private static safeEqual(a: string, b: string): boolean {
    const left = Buffer.from(a, 'hex')
    const right = Buffer.from(b, 'hex')
    if (left.length !== right.length || left.length === 0) return false
    return timingSafeEqual(left, right)
  }

  private nowIso(): string {
    return new Date(this.now()).toISOString()
  }

  private validatePassword(value: unknown, contactValue?: string): string {
    const password = String(value || '')
    if (password.length < 8 || password.length > 128 || !/[A-Za-z]/.test(password) || !/\d/.test(password)) {
      throw new Error('密码需为 8-128 位，且同时包含字母和数字')
    }
    if (/\s/.test(password)) throw new Error('密码不能包含空格或制表符')
    if (contactValue && password.toLowerCase() === contactValue.toLowerCase()) throw new Error('密码不能与邮箱或手机号相同')
    return password
  }

  private normalizeDisplayName(raw: unknown, contact: { type: ContactType; value: string }): string {
    const name = String(raw ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 40)
    return name || maskContact(contact.type, contact.value) || contact.value
  }

  private toSafeUser(row: any): LocalUser {
    return {
      id: Number(row.id),
      username: row.username,
      displayName: row.display_name,
      role: row.role,
      contactType: (row.contact_type as ContactType) ?? null,
      maskedContact: maskContact(row.contact_type, row.contact),
    }
  }

  private audit(action: string, details: string, actor = 'user') {
    this.db
      .prepare(`
        INSERT INTO audit_logs (actor_type, actor_name, action, resource_type, details, status)
        VALUES ('user', ?, ?, 'account', ?, 'success')
      `)
      .run(actor, action, details)
  }

  private findUserByContact(contactValue: string): any {
    return this.db.prepare('SELECT * FROM users WHERE contact = ?').get(contactValue)
  }

  private revokeUserSessions(userId: number, except?: string) {
    for (const [clientId, user] of this.sessions) {
      if (user.id === userId && clientId !== except) this.sessions.delete(clientId)
    }
  }

  /** 是否已完成初始化（users 为空）。仅用于标注「首个账户即所有者」，不再限制注册入口。 */
  needsSetup(): boolean {
    const row = this.db.prepare('SELECT COUNT(*) AS count FROM users').get() as any
    return Number(row?.count || 0) === 0
  }

  status(clientId: string) {
    return { needsSetup: this.needsSetup(), authenticated: this.sessions.has(clientId), user: this.sessions.get(clientId) || null }
  }

  /** 发送前的频率限制：冷却 + 每日上限 */
  private assertSendAllowed(contactValue: string, purpose: CodePurpose) {
    const now = this.now()
    const last = this.db
      .prepare('SELECT created_at FROM verification_codes WHERE contact = ? AND purpose = ? ORDER BY id DESC LIMIT 1')
      .get(contactValue, purpose) as any
    if (last) {
      const wait = this.policy.sendCooldownMs - (now - Date.parse(last.created_at))
      if (wait > 0) throw new Error(`验证码发送过于频繁，请 ${Math.ceil(wait / 1000)} 秒后再试`)
    }
    const daily = this.db
      .prepare('SELECT COUNT(*) AS n FROM verification_codes WHERE contact = ? AND purpose = ? AND created_at >= ?')
      .get(contactValue, purpose, new Date(now - DAY_MS).toISOString()) as any
    if (Number(daily?.n || 0) >= this.policy.dailySendLimit) throw new Error('今日该联系方式的验证码发送次数已达上限，请明天再试')
  }

  /** 校验前的失败次数熔断：近 1 小时累计输错过多则暂停，发送与校验都拒绝 */
  private assertNotLockedOut(contactValue: string) {
    const row = this.db
      .prepare('SELECT COALESCE(SUM(attempts), 0) AS failures FROM verification_codes WHERE contact = ? AND created_at >= ?')
      .get(contactValue, new Date(this.now() - HOUR_MS).toISOString()) as any
    if (Number(row?.failures || 0) >= this.policy.hourlyFailureLimit) throw new Error('验证码校验失败次数过多，请 1 小时后再试')
  }

  /**
   * 申请验证码。
   * - register：邮箱或手机号已注册则直接报错（注册场景必须明确告知）；
   * - reset：账户不存在时与成功路径返回相同结果（不发送、不落库），不泄露是否注册。
   * 发送失败会删除刚写入的验证码，不占用冷却与每日额度。
   */
  async requestCode(input: any): Promise<CodeReceipt> {
    const purpose = AuthService.parsePurpose(input?.purpose)
    const contact = normalizeContact(input?.contact)
    const receipt: CodeReceipt = {
      accepted: true,
      cooldownSeconds: this.policy.sendCooldownMs / 1000,
      expiresInSeconds: this.policy.codeTtlMs / 1000,
    }
    const user = this.findUserByContact(contact.value)
    if (purpose === 'register' && user) throw new Error(ALREADY_REGISTERED)
    if (purpose === 'reset' && !user) return receipt

    this.assertNotLockedOut(contact.value)
    this.assertSendAllowed(contact.value, purpose)

    const code = String(randomInt(0, 1_000_000)).padStart(6, '0')
    const salt = randomBytes(16).toString('hex')
    const createdAt = this.nowIso()
    const expiresAt = new Date(this.now() + this.policy.codeTtlMs).toISOString()
    // 旧码立即作废：任一时刻同一联系方式 + 用途只有最新一枚有效
    const codeId = this.db.transaction(() => {
      this.db
        .prepare('UPDATE verification_codes SET consumed_at = ? WHERE contact = ? AND purpose = ? AND consumed_at IS NULL')
        .run(createdAt, contact.value, purpose)
      const result = this.db
        .prepare(`
          INSERT INTO verification_codes (purpose, contact_type, contact, user_id, code_hash, salt, attempts, expires_at, created_at)
          VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)
        `)
        .run(purpose, contact.type, contact.value, user ? user.id : null, AuthService.hashCode(code, salt), salt, expiresAt, createdAt)
      return Number(result.lastInsertRowid)
    })

    try {
      await this.sender.send({
        purpose,
        contactType: contact.type,
        contact: contact.value,
        code,
        expiresInMinutes: Math.round(this.policy.codeTtlMs / 60000),
      })
    } catch (error) {
      this.db.prepare('DELETE FROM verification_codes WHERE id = ?').run(codeId)
      throw error
    }
    return receipt
  }

  private static parsePurpose(value: unknown): CodePurpose {
    if (value === 'register' || value === 'reset') return value
    throw new Error('不支持的验证用途')
  }

  /**
   * 校验验证码（不消费）。错误次数在这里持久化，失败路径不能包在事务里，否则计数会被回滚。
   * 成功后由调用方在同一事务里标记 consumed_at，保证「校验通过 → 写入账户」原子完成。
   */
  private checkCode(purpose: CodePurpose, contactValue: string, code: string): any {
    if (!/^\d{6}$/.test(code)) throw new Error('验证码为 6 位数字')
    this.assertNotLockedOut(contactValue)
    const row = this.db
      .prepare('SELECT * FROM verification_codes WHERE contact = ? AND purpose = ? AND consumed_at IS NULL ORDER BY id DESC LIMIT 1')
      .get(contactValue, purpose) as any
    if (!row || Date.parse(row.expires_at) <= this.now()) throw new Error('验证码已过期或不存在，请重新获取')
    if (Number(row.attempts) >= this.policy.maxCodeAttempts) throw new Error('验证码错误次数过多，请重新获取')
    if (!AuthService.safeEqual(AuthService.hashCode(code, row.salt), row.code_hash)) {
      const attempts = Number(row.attempts) + 1
      this.db.prepare('UPDATE verification_codes SET attempts = ? WHERE id = ?').run(attempts, row.id)
      const left = this.policy.maxCodeAttempts - attempts
      throw new Error(left > 0 ? `验证码错误，还可尝试 ${left} 次` : '验证码错误次数过多，请重新获取')
    }
    return row
  }

  register(clientId: string, input: any): LocalUser {
    const contact = normalizeContact(input?.contact)
    const password = this.validatePassword(input?.password, contact.value)
    const displayName = this.normalizeDisplayName(input?.displayName, contact)
    if (this.findUserByContact(contact.value)) throw new Error(ALREADY_REGISTERED)
    const row = this.checkCode('register', contact.value, String(input?.code ?? '').trim())

    const salt = randomBytes(16).toString('hex')
    const user = this.db.transaction(() => {
      const role = this.needsSetup() ? 'owner' : 'member'
      const now = this.nowIso()
      this.db.prepare('UPDATE verification_codes SET consumed_at = ? WHERE id = ?').run(now, row.id)
      this.db
        .prepare(`
          INSERT INTO users (username, display_name, password_hash, salt, role, contact_type, contact, contact_verified_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(contact.value, displayName, AuthService.hash(password, salt), salt, role, contact.type, contact.value, now, now)
      return this.toSafeUser(this.findUserByContact(contact.value))
    })
    this.sessions.set(clientId, user)
    this.audit('register', `注册账户 ${user.maskedContact}`, user.maskedContact || undefined)
    return user
  }

  login(clientId: string, input: any): LocalUser {
    const account = String(input?.account ?? input?.username ?? '').trim()
    if (!account) throw new Error('请输入注册时使用的邮箱或手机号')
    const contactValue = normalizeContact(account).value
    const password = String(input?.password || '')
    const user = this.findUserByContact(contactValue)
    const now = this.now()

    if (user?.locked_until && Date.parse(user.locked_until) > now) throw new Error('登录失败次数过多，请稍后再试')

    if (!AuthService.verifyPassword(password, user)) {
      if (user) {
        const attempts = Number(user.failed_attempts || 0) + 1
        const locked = attempts >= this.policy.loginMaxFailures
        const lockedUntil = locked ? new Date(now + this.policy.loginLockMs).toISOString() : null
        this.db
          .prepare('UPDATE users SET failed_attempts = ?, locked_until = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
          .run(locked ? 0 : attempts, lockedUntil, user.id)
        if (locked) this.audit('login_locked', `连续失败锁定账户 ${maskContact(user.contact_type, user.contact)}`, maskContact(user.contact_type, user.contact) || undefined)
      }
      throw new Error('账号或密码错误')
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
    if (user) this.audit('logout', `退出登录 ${user.maskedContact}`, user.maskedContact || undefined)
    this.sessions.delete(clientId)
    return true
  }

  /** 会话失效时抛 AUTH_REQUIRED，供中间件识别并返回 401 */
  requireSession(clientId: string): LocalUser {
    const user = this.sessions.get(clientId)
    if (!user) throw new Error('AUTH_REQUIRED')
    return user
  }

  /** 已登录状态下修改密码：需当前密码；成功后其它设备的会话全部失效 */
  changePassword(clientId: string, input: any): boolean {
    const session = this.requireSession(clientId)
    const user = this.db.prepare('SELECT * FROM users WHERE id = ?').get(session.id) as any
    if (!user || !AuthService.safeEqual(AuthService.hash(String(input?.currentPassword || ''), user.salt), user.password_hash)) {
      throw new Error('当前密码错误')
    }
    const newPassword = this.validatePassword(input?.newPassword, user.contact)
    if (newPassword === String(input?.currentPassword)) throw new Error('新密码不能与当前密码相同')
    const salt = randomBytes(16).toString('hex')
    this.db
      .prepare('UPDATE users SET password_hash = ?, salt = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(AuthService.hash(newPassword, salt), salt, user.id)
    this.revokeUserSessions(user.id, clientId)
    this.audit('change_password', `修改密码 ${maskContact(user.contact_type, user.contact)}`, maskContact(user.contact_type, user.contact) || undefined)
    return true
  }

  /**
   * 通过已绑定的邮箱或手机号 + 验证码重置密码。
   * 成功后：验证码全部作废、该账户所有会话吊销、失败计数清零。不自动登录，由用户用新密码重新登录。
   */
  resetPassword(input: any): boolean {
    const contact = normalizeContact(input?.contact)
    const newPassword = this.validatePassword(input?.newPassword, contact.value)
    if (String(input?.confirmPassword ?? '') !== newPassword) throw new Error('两次输入的新密码不一致，请重新输入')
    const row = this.checkCode('reset', contact.value, String(input?.code ?? '').trim())
    const user = row.user_id ? (this.db.prepare('SELECT * FROM users WHERE id = ?').get(row.user_id) as any) : null
    if (!user) throw new Error('验证码已过期或不存在，请重新获取')

    const salt = randomBytes(16).toString('hex')
    this.db.transaction(() => {
      this.db
        .prepare('UPDATE verification_codes SET consumed_at = ? WHERE contact = ? AND purpose = ? AND consumed_at IS NULL')
        .run(this.nowIso(), contact.value, 'reset')
      this.db
        .prepare(`
          UPDATE users SET password_hash = ?, salt = ?, failed_attempts = 0, locked_until = NULL, updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `)
        .run(AuthService.hash(newPassword, salt), salt, user.id)
    })
    this.revokeUserSessions(user.id)
    this.audit('reset_password', `通过验证码重置密码 ${maskContact(user.contact_type, user.contact)}`, maskContact(user.contact_type, user.contact) || undefined)
    return true
  }

  clear(clientId: string): void {
    this.sessions.delete(clientId)
  }
}
