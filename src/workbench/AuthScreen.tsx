import { useState } from 'react'
import type { FormEvent } from 'react'
import { errorMessage } from './useWorkbench'

/**
 * 校验规则与主进程 `electron/services/workbench/authService.ts` 的
 * `normalizeUsername` / `validatePassword` 逐字一致（渲染进程拿不到主进程模块，
 * 只能保持两份同源文本）：用户名 3-40 位 `[a-zA-Z0-9_.-]`，
 * 密码 8-128 位且同时含字母与数字。服务端始终是权威校验，这里只是提前拦住明显不合规的输入。
 */
const USERNAME_RULE = /^[a-zA-Z0-9_.-]{3,40}$/
const PASSWORD_RULE = (value: string) =>
  value.length >= 8 && value.length <= 128 && /[A-Za-z]/.test(value) && /\d/.test(value)

interface Props {
  needsSetup: boolean
  onLogin: (username: string, password: string) => Promise<void>
  onRegister: (username: string, password: string, displayName: string) => Promise<void>
  onSkip?: () => void
}

/**
 * 首次初始化 / 登录。
 *
 * 身份源是融合后的 `users` 表（ADR-003）：register 只在库里一个用户都没有时可用，
 * 建成之后这里只做登录，避免变成公开注册入口。
 */
export default function AuthScreen({ needsSetup, onLogin, onRegister, onSkip }: Props) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setError('')
    if (!username.trim()) return setError('请输入用户名（3-40 位字母、数字、点、横线或下划线）')
    if (!USERNAME_RULE.test(username.trim())) return setError('用户名需为 3-40 位字母、数字、点、横线或下划线')
    if (needsSetup) {
      if (!PASSWORD_RULE(password)) return setError('密码需为 8-128 位，且同时包含字母和数字')
      if (password !== confirm) return setError('两次输入的密码不一致，请重新输入一遍')
    } else if (!password) {
      return setError('请输入密码')
    }

    setBusy(true)
    try {
      if (needsSetup) await onRegister(username.trim(), password, displayName.trim() || username.trim())
      else await onLogin(username.trim(), password)
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="wb-auth">
      <div className="wb-auth-card" style={{ animation: 'slide-up .32s ease-out' }}>
        <div className="wb-auth-head">
          <span className="brand-mark">
            sd<span>·</span>
          </span>
          <div>
            <p className="eyebrow">{needsSetup ? 'INITIALIZE' : 'SIGN IN'}</p>
            <h1>{needsSetup ? '初始化工作台' : '进入知序工作台'}</h1>
            <p>{needsSetup ? '创建第一个本地账户，身份将同时用于工作台与知识库审计。' : '工作台数据仅保存在本机 SQLite，凭据不出设备。'}</p>
          </div>
        </div>

        <form className="wb-auth-form" onSubmit={submit}>
          <label>
            <span>用户名</span>
            <input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoFocus
              autoComplete="username"
              placeholder="本机账户名"
            />
          </label>

          {needsSetup && (
            <label>
              <span>显示名称</span>
              <input
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="选填，默认同用户名"
              />
            </label>
          )}

          <label>
            <span>密码</span>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete={needsSetup ? 'new-password' : 'current-password'}
              placeholder={needsSetup ? '8-128 位，含字母和数字' : '本机账户密码'}
            />
          </label>

          {needsSetup && (
            <label>
              <span>确认密码</span>
              <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" />
            </label>
          )}

          {error && <p className="wb-error">{error}</p>}

          <button className="button primary" type="submit" disabled={busy}>
            {busy ? '处理中…' : needsSetup ? '创建并进入' : '登录'}
          </button>

          {onSkip && (
            <button className="wb-auth-skip" type="button" onClick={onSkip}>
              先浏览知识库（工作台需登录）
            </button>
          )}
        </form>
      </div>
    </div>
  )
}
