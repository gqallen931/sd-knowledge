import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { errorMessage } from './useWorkbench'

export type AuthMode = 'login' | 'register' | 'reset'

/**
 * 校验规则与主进程 `electron/services/workbench/authService.ts` 的
 * `normalizeContact` / `validatePassword` 同源（渲染进程拿不到主进程模块，只能保持两份文本一致）。
 * 服务端始终是权威校验，这里只是提前拦住明显不合规的输入。
 */
const EMAIL_RULE = /^[a-z0-9](?:[a-z0-9._%+-]{0,62}[a-z0-9])?@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.[a-z]{2,24}$/
const PHONE_RULE = /^1[3-9]\d{9}$/
const CODE_RULE = /^\d{6}$/

/** 联系方式格式；返回空串表示通过 */
export function contactError(raw: string): string {
  const text = raw.trim()
  if (!text) return '请输入邮箱或手机号'
  if (text.includes('@')) {
    return text.length <= 254 && EMAIL_RULE.test(text.toLowerCase()) ? '' : '邮箱格式不正确，请检查后重新输入'
  }
  let phone = text.replace(/[\s-]/g, '')
  if (phone.startsWith('+86')) phone = phone.slice(3)
  else if (/^86\d{11}$/.test(phone)) phone = phone.slice(2)
  return PHONE_RULE.test(phone) ? '' : '请输入正确的邮箱或 11 位中国大陆手机号'
}

/** 密码强度；返回空串表示通过 */
export function passwordError(value: string, contact: string): string {
  if (value.length < 8 || value.length > 128 || !/[A-Za-z]/.test(value) || !/\d/.test(value)) {
    return '密码需为 8-128 位，且同时包含字母和数字'
  }
  if (/\s/.test(value)) return '密码不能包含空格或制表符'
  if (contact.trim() && value.toLowerCase() === contact.trim().toLowerCase()) return '密码不能与邮箱或手机号相同'
  return ''
}

const COPY: Record<AuthMode, { eyebrow: string; title: string; hint: string; submit: string }> = {
  login: {
    eyebrow: 'SIGN IN',
    title: '登录知序工作台',
    hint: '使用注册时绑定的邮箱或手机号登录。工作台数据仅保存在本机，凭据不出设备。',
    submit: '登录',
  },
  register: {
    eyebrow: 'SIGN UP',
    title: '注册本机账户',
    hint: '邮箱或手机号任选其一，通过验证码完成注册。该联系方式同时用于登录与找回密码。',
    submit: '注册并进入',
  },
  reset: {
    eyebrow: 'RESET',
    title: '找回密码',
    hint: '验证码将发送到注册时绑定的邮箱或手机号，验证通过后设置新密码。',
    submit: '重置密码',
  },
}

const TABS: Array<{ mode: AuthMode; label: string }> = [
  { mode: 'login', label: '登录' },
  { mode: 'register', label: '注册' },
  { mode: 'reset', label: '找回密码' },
]

interface Props {
  initialMode?: AuthMode
  /** 登录 / 注册成功后的回调，宿主负责重新加载工作台状态 */
  onAuthenticated: () => Promise<void> | void
  /** 工作台页面门控才提供：允许不登录浏览知识库 */
  onSkip?: () => void
}

/**
 * 登录 / 注册 / 找回密码（同一张卡片，三个页签）。
 *
 * 既用于工作台页面的门控，也用于侧栏弹窗（见 AuthDialog）。
 * 账户入口不再限于「首次初始化」：任何人都可以用邮箱或手机号 + 验证码注册。
 */
export default function AuthScreen({ initialMode = 'login', onAuthenticated, onSkip }: Props) {
  const [mode, setMode] = useState<AuthMode>(initialMode)
  const [contact, setContact] = useState('')
  const [code, setCode] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [busy, setBusy] = useState(false)
  const [sending, setSending] = useState(false)
  const [cooldownUntil, setCooldownUntil] = useState(0)
  const [, setTick] = useState(0)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  // 验证码冷却倒计时：每秒重绘一次，结束后自动恢复「获取验证码」
  useEffect(() => {
    if (cooldownUntil <= Date.now()) return
    const timer = window.setInterval(() => setTick((value) => value + 1), 1000)
    return () => window.clearInterval(timer)
  }, [cooldownUntil])

  const cooldownLeft = Math.max(0, Math.ceil((cooldownUntil - Date.now()) / 1000))
  const copy = COPY[mode]

  const switchMode = (next: AuthMode) => {
    setMode(next)
    setError('')
    setNotice('')
    setCode('')
    setPassword('')
    setConfirm('')
    setCooldownUntil(0)
  }

  const sendCode = async () => {
    setError('')
    setNotice('')
    const problem = contactError(contact)
    if (problem) return setError(problem)
    setSending(true)
    try {
      const receipt = await window.sd.auth.requestCode({
        purpose: mode === 'reset' ? 'reset' : 'register',
        contact: contact.trim(),
      })
      setCooldownUntil(Date.now() + receipt.cooldownSeconds * 1000)
      const minutes = Math.round(receipt.expiresInSeconds / 60)
      // 找回密码对「账户是否存在」保持模糊，文案也不能暗示已确认注册
      setNotice(mode === 'reset'
        ? `若该账户已绑定此联系方式，验证码已发送，${minutes} 分钟内有效。`
        : `验证码已发送，${minutes} 分钟内有效。`)
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setSending(false)
    }
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setError('')
    setNotice('')
    const problem = contactError(contact)
    if (problem) return setError(problem)
    if (mode === 'login') {
      if (!password) return setError('请输入密码')
    } else {
      if (!CODE_RULE.test(code.trim())) return setError('请输入 6 位数字验证码')
      const passwordProblem = passwordError(password, contact)
      if (passwordProblem) return setError(passwordProblem)
      if (password !== confirm) return setError('两次输入的密码不一致，请重新输入一遍')
    }

    setBusy(true)
    try {
      if (mode === 'login') {
        await window.sd.auth.login({ account: contact.trim(), password })
        await onAuthenticated()
      } else if (mode === 'register') {
        await window.sd.auth.register({
          contact: contact.trim(),
          code: code.trim(),
          password,
          displayName: displayName.trim() || undefined,
        })
        await onAuthenticated()
      } else {
        await window.sd.auth.resetPassword({
          contact: contact.trim(),
          code: code.trim(),
          newPassword: password,
          confirmPassword: confirm,
        })
        // 重置成功后回到登录页，联系方式保留，方便直接用新密码登录
        setMode('login')
        setCode('')
        setPassword('')
        setConfirm('')
        setCooldownUntil(0)
        setNotice('密码已重置，请使用新密码登录。')
      }
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="wb-auth-card" style={{ animation: 'slide-up .32s ease-out' }}>
      <div className="wb-auth-head">
        <span className="brand-mark">
          sd<span>·</span>
        </span>
        <div>
          <p className="eyebrow">{copy.eyebrow}</p>
          <h1>{copy.title}</h1>
          <p>{copy.hint}</p>
        </div>
      </div>

      <div className="wb-auth-tabs" role="tablist" aria-label="账户操作">
        {TABS.map((tab) => (
          <button
            key={tab.mode}
            type="button"
            role="tab"
            aria-selected={mode === tab.mode}
            className={`wb-auth-tab${mode === tab.mode ? ' wb-auth-tab--on' : ''}`}
            onClick={() => switchMode(tab.mode)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <form className="wb-auth-form" onSubmit={submit} noValidate>
        <label>
          <span>{mode === 'login' ? '账号（邮箱或手机号）' : '邮箱或手机号'}</span>
          <input
            value={contact}
            onChange={(e) => setContact(e.target.value)}
            autoFocus
            autoComplete="username"
            maxLength={254}
            placeholder="name@example.com 或 138xxxx0000"
          />
        </label>

        {mode !== 'login' && (
          <div className="wb-auth-field">
            <span>验证码</span>
            <div className="wb-auth-row">
              <input
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                inputMode="numeric"
                autoComplete="one-time-code"
                aria-label="验证码"
                placeholder="6 位数字"
              />
              <button
                type="button"
                className="button"
                disabled={sending || cooldownLeft > 0 || !contact.trim()}
                onClick={() => void sendCode()}
              >
                {cooldownLeft > 0 ? `${cooldownLeft} 秒后重发` : sending ? '发送中…' : '获取验证码'}
              </button>
            </div>
          </div>
        )}

        {mode === 'register' && (
          <label>
            <span>显示名称</span>
            <input
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              maxLength={40}
              placeholder="选填，默认显示掩码后的联系方式"
            />
          </label>
        )}

        <label>
          <span>{mode === 'reset' ? '新密码' : '密码'}</span>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
            placeholder={mode === 'login' ? '账户密码' : '8-128 位，含字母和数字'}
          />
        </label>

        {mode !== 'login' && (
          <label>
            <span>{mode === 'reset' ? '确认新密码' : '确认密码'}</span>
            <input
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              autoComplete="new-password"
            />
          </label>
        )}

        {mode === 'login' && (
          <div className="wb-auth-aux">
            <button type="button" className="wb-auth-link" onClick={() => switchMode('reset')}>
              忘记密码？
            </button>
          </div>
        )}

        {error && <p className="wb-error" role="alert">{error}</p>}
        {notice && <p className="wb-auth-notice" role="status">{notice}</p>}

        <button className="button primary" type="submit" disabled={busy}>
          {busy ? '处理中…' : copy.submit}
        </button>

        <div className="wb-auth-foot">
          {mode === 'login' ? (
            <>
              还没有账户？
              <button type="button" className="wb-auth-link" onClick={() => switchMode('register')}>去注册</button>
            </>
          ) : (
            <>
              已有账户？
              <button type="button" className="wb-auth-link" onClick={() => switchMode('login')}>去登录</button>
            </>
          )}
        </div>

        {onSkip && (
          <button className="wb-auth-skip" type="button" onClick={onSkip}>
            先浏览知识库（工作台需登录）
          </button>
        )}
      </form>
    </div>
  )
}
