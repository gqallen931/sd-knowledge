import { useEffect, useRef, useState } from 'react'
import templateHtml from '../bigscreen/ops/ops.template.html?raw'
import { mountOps } from '../bigscreen/ops/opsScreen'
import { emptySnapshot, loadOpsSnapshot, type OpsSnapshot } from '../bigscreen/ops/opsData'

/** 数据刷新间隔。大屏是只读看板，3s 足够，也不至于压着后端查询 */
const POLL_MS = 3000

/** 大屏在 Shadow DOM 内按 `data-theme` 决策深浅，与 SD 在 `html` 上切 `.light` / `.dark` 是两套机制，需要桥接 */
function syncTheme(host: HTMLElement) {
  host.dataset.theme = document.documentElement.classList.contains('light') ? 'light' : 'dark'
}

/**
 * 调度大屏（OPS 主题）。
 *
 * 主题来自 agent-display，原文件是「一次挂载、永不卸载」的单页，因此这里做三件事：
 * 1. 用 Shadow DOM 隔离——它的 `:host` 变量、`canvas` 布局、11px 基础字号都不外泄，也不受 SD 全局样式影响；
 * 2. 挂载前把 `data-theme` 对齐 SD 当前主题，否则浅色界面里会跟着系统跑出深色；
 * 3. 卸载时调用 `mountOps` 登记的 `__sdDispose`，停掉 7 个定时器、rAF、3 个观察者与 2 个全局监听。
 *    少了这一步，每次进出页面都会多留一套 60fps 的动画循环。
 */
export default function BigScreen() {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const shadow = host.shadowRoot ?? host.attachShadow({ mode: 'open' })
    shadow.innerHTML = templateHtml
    syncTheme(host)

    let mounted = false
    try {
      mountOps(host, shadow)
      mounted = true
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }

    // SD 主题只能在设置里切换，这里跟随；大屏内部的切换按钮只改 host 属性，不触发回环
    const themeObserver = new MutationObserver(() => syncTheme(host))
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })

    /* 数据轮询：挂载成功后立刻推一帧，之后每 3s 一帧。
       窗口不可见时跳过（Electron 最小化后没必要继续查库），回到前台靠下一拍自动恢复。
       取数失败不抛到 UI——opsData 内部已降级为空快照，大屏保持上一帧即可。 */
    let alive = true
    const feedOps = (snap: OpsSnapshot) => {
      const api = host as unknown as { __sdOpsFeed?: (s: OpsSnapshot) => void }
      api.__sdOpsFeed?.(snap)
    }
    const push = async () => {
      if (!alive || document.hidden) return
      const snap = await loadOpsSnapshot()
      if (alive && snap) feedOps(snap)
    }
    let poll = 0
    if (mounted) {
      // 首帧先推空态，避免真实数据到达前露出主题自带的模拟数字
      feedOps(emptySnapshot('正在连接…'))
      void push()
      poll = window.setInterval(push, POLL_MS)
    }

    return () => {
      alive = false
      if (poll) window.clearInterval(poll)
      themeObserver.disconnect()
      const dispose = (host as unknown as { __sdDispose?: () => void }).__sdDispose
      if (typeof dispose === 'function') dispose()
      ;(host as unknown as { __sdDispose?: () => void }).__sdDispose = undefined
      if (host.shadowRoot) host.shadowRoot.innerHTML = ''
    }
  }, [])

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', position: 'relative' }}>
      <div ref={hostRef} style={{ flex: 1, minHeight: 0 }} />
      {error && (
        <div
          style={{
            position: 'absolute',
            inset: 'auto 16px 16px 16px',
            padding: '10px 12px',
            border: '1px solid var(--border, #333)',
            borderRadius: 8,
            background: 'var(--panel, #111)',
            color: 'var(--text, #eee)',
            fontSize: 12,
          }}
        >
          大屏渲染失败：{error}
        </div>
      )}
    </div>
  )
}
