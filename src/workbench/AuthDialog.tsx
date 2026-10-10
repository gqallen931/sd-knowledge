import { useEffect } from 'react'
import AuthScreen from './AuthScreen'
import { useWorkbenchContext } from './WorkbenchContext'

interface Props {
  onClose: () => void
}

/**
 * 侧栏「sd 图标 / 未登录」触发的登录注册弹窗。
 *
 * 必须渲染在 WorkbenchProvider 之内：登录成功后要 reload 共享状态，侧栏与工作台页才会同步切到已登录态。
 * 点遮罩、按 Esc 或点右上角关闭。
 */
export default function AuthDialog({ onClose }: Props) {
  const { model } = useWorkbenchContext()

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="settings-modal__backdrop" role="presentation" onMouseDown={onClose}>
      <div
        className="wb-auth-modal"
        role="dialog"
        aria-modal="true"
        aria-label="登录与注册"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <button type="button" className="wb-auth-modal__close" onClick={onClose} aria-label="关闭">×</button>
        <AuthScreen
          onAuthenticated={async () => {
            await model.reload()
            onClose()
          }}
        />
      </div>
    </div>
  )
}
