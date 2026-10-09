import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import type { SDWorkbenchProject } from '../types/global'
import { IconArrowUpRight, IconFolder } from './icons'

interface Props {
  projects: SDWorkbenchProject[]
  /** 当前筛选的项目 id（'' = 全部任务） */
  activeId: number | string
  onPick: (projectId: number) => void
}

interface FanPos {
  x: number
  z: number
  ry: number
  rz: number
  zi: number
}

/** 扇形位置表：整数卡位的 x / z / rotateY / rotateZ / z-index（照抄参照稿 FAN_POS） */
const FAN_POS: Record<string, FanPos> = {
  '-3': { x: -196, z: -90, ry: 38, rz: -4, zi: 1 },
  '-2': { x: -138, z: -55, ry: 30, rz: -2.5, zi: 2 },
  '-1': { x: -74, z: -25, ry: 20, rz: -1, zi: 3 },
  '0': { x: 0, z: 40, ry: 0, rz: 0, zi: 6 },
  '1': { x: 74, z: -25, ry: -20, rz: 1, zi: 3 },
  '2': { x: 138, z: -55, ry: -30, rz: 2.5, zi: 2 },
  '3': { x: 196, z: -90, ry: -38, rz: 4, zi: 1 },
}

/** 相邻卡位间距（px），拖拽位移换算成卡位数的基准 */
const FAN_STEP_PX = 74
/** 最多 7 张卡（位置表的正负区间与参照稿一致） */
const MAX_CARDS = 7
/** 自动轮播间隔（ms） */
const AUTO_DELAY = 3000
/** 悬浮统计卡切换时的淡出时长（ms） */
const FLOAT_SWAP_MS = 160
/** 浮卡默认落点（相对卡片扇左上角，与 dashboard.css 里的 top/left 一致） */
const FLOAT_DEFAULT = { x: 18, y: 16 }
/** 浮卡位置是纯本机界面偏好，与主题同样存 localStorage，不进数据库 */
const FLOAT_POS_KEY = 'sd-fan-float-pos'
/** 贴边留白：浮卡带 -5° 旋转 + translateZ 透视放大，视觉外框比布局框大一圈，
 *  不留够余量会被 .wb-fan 的 overflow:hidden 切掉边角 */
const FLOAT_EDGE = 20

/** 读取记忆的浮卡落点；存储不可用或内容损坏时退回默认值 */
function readFloatPos(): { x: number; y: number } {
  try {
    const raw = localStorage.getItem(FLOAT_POS_KEY)
    if (!raw) return FLOAT_DEFAULT
    const parsed = JSON.parse(raw)
    if (typeof parsed?.x === 'number' && typeof parsed?.y === 'number' && Number.isFinite(parsed.x) && Number.isFinite(parsed.y)) {
      return { x: parsed.x, y: parsed.y }
    }
  } catch {
    /* 隐私模式或内容损坏：按默认落点渲染，不影响其它功能 */
  }
  return FLOAT_DEFAULT
}

/** 任意小数卡位下的扇形参数（线性插值，保证跟手时位置连续） */
function fanPosAt(pf: number): FanPos {
  if (pf <= -3) return FAN_POS['-3']
  if (pf >= 3) return FAN_POS['3']
  const lo = Math.floor(pf)
  const t = pf - lo
  const a = FAN_POS[String(lo)] ?? FAN_POS['0']
  const b = FAN_POS[String(lo + 1)] ?? FAN_POS['0']
  return {
    x: a.x + (b.x - a.x) * t,
    z: a.z + (b.z - a.z) * t,
    ry: a.ry + (b.ry - a.ry) * t,
    rz: a.rz + (b.rz - a.rz) * t,
    zi: t < 0.5 ? a.zi : b.zi,
  }
}

/**
 * 3D 卡片扇：参照稿 `.wb-fan` 的 1:1 复刻（结构来自 task-dashboard.html，
 * 滚轮 / 拖拽惯性 / 点击 / 键盘 / 居中高亮 / 悬浮统计卡联动来自 task-dashboard.js）。
 *
 * 与参照稿的差异：参照稿固定 7 张演示卡，这里按项目数渲染（最多 7 张），
 * 因此没有「永久主卡」——绿色的始终是居中那张，与参照稿运行后的实际表现一致。
 *
 * 位姿只能逐帧命令式写 inline `!important`（React 的 style 传不了 !important，
 * 而 `:hover` 提升规则必须被盖住），所以卡片上不挂任何 `style`/`className` 条件属性，
 * 否则 React 重渲染会把命令式写入的样式清掉。
 */
export default function ProjectFan({ projects, activeId, onPick }: Props) {
  const cards = useMemo(() => projects.slice(0, MAX_CARDS), [projects])
  const n = cards.length

  const wrapRef = useRef<HTMLDivElement | null>(null)
  const stageRef = useRef<HTMLDivElement | null>(null)

  const [active, setActive] = useState(0)
  /** 悬浮统计卡正在展示的索引（淡出 160ms 后才换内容） */
  const [shown, setShown] = useState(0)
  const [switching, setSwitching] = useState(false)

  /** 动画的唯一真源：拖拽期间只改它、不触发重渲染 */
  const activeRef = useRef(0)
  const cardsRef = useRef(cards)
  const onPickRef = useRef(onPick)
  cardsRef.current = cards
  onPickRef.current = onPick

  const dragRef = useRef<{ x: number; downIdx: number } | null>(null)
  const slotsRef = useRef(0)
  const movedRef = useRef(false)
  const samplesRef = useRef<Array<{ t: number; s: number }>>([])
  const wheelRef = useRef({ acc: 0, lock: 0 })
  const hoveredRef = useRef(false)

  /** 浮卡（左上角那张统计卡）可拖拽，落点记忆在本机 */
  const floatRef = useRef<HTMLDivElement | null>(null)
  const [floatPos, setFloatPos] = useState(readFloatPos)
  const [floatDragging, setFloatDragging] = useState(false)
  const floatPosRef = useRef(floatPos)
  floatPosRef.current = floatPos
  const floatDragRef = useRef<{ px: number; py: number; x: number; y: number } | null>(null)
  const floatLiveRef = useRef<{ x: number; y: number } | null>(null)

  /** 居中索引落定：同步 ref（供命令式布局读）与 state（供悬浮卡渲染） */
  const goActive = useCallback((idx: number) => {
    if (cardsRef.current.length === 0) return
    const count = cardsRef.current.length
    const next = ((idx % count) + count) % count
    if (next === activeRef.current) return
    activeRef.current = next
    setActive(next)
  }, [])

  /** 按当前居中索引重排所有卡片；delta 为拖拽产生的小数卡位偏移 */
  const applyLayout = useCallback((delta: number) => {
    const stage = stageRef.current
    if (!stage) return
    const els = Array.from(stage.children) as HTMLElement[]
    const count = els.length
    if (!count) return
    // 卡位差写成「整数参考卡 + 小数余量」，跨格时位置才连续、不跳变
    const rd = Math.round(delta)
    const remain = delta - rd
    const ref = (((activeRef.current + rd) % count) + count) % count

    els.forEach((card, i) => {
      let p = (i - ref) % count
      if (p > count / 2) p -= count
      if (p < -count / 2) p += count
      p -= remain

      const cfg = fanPosAt(p)
      const a = Math.abs(p)
      const transform =
        `translateX(${cfg.x.toFixed(2)}px) translateZ(${cfg.z.toFixed(2)}px) ` +
        `rotateY(${cfg.ry.toFixed(2)}deg) rotateZ(${cfg.rz.toFixed(2)}deg) ` +
        `scale(${(1.05 - 0.05 * Math.min(a, 1)).toFixed(3)})`
      card.style.setProperty('transform', transform, 'important')
      card.style.setProperty('z-index', String(cfg.zi), 'important')
      card.style.setProperty('opacity', a >= 3 ? '0.5' : '1', 'important')
      card.classList.toggle('is-center', a < 0.5)
    })
  }, [])

  /** 拖拽期间关掉过渡改由脚本逐帧渲染，松手再交回 CSS 做吸附动画 */
  const setTransition = useCallback((on: boolean) => {
    const stage = stageRef.current
    if (!stage) return
    Array.from(stage.children).forEach((card) => {
      const el = card as HTMLElement
      if (on) el.style.removeProperty('transition')
      else el.style.setProperty('transition', 'none', 'important')
    })
  }, [])

  /** 把浮卡落点夹在扇面内：浮卡相对扇的 padding box 定位，所以用 clientWidth/Height 算边界 */
  const clampFloatPos = useCallback((x: number, y: number) => {
    const wrap = wrapRef.current
    const el = floatRef.current
    if (!wrap || !el) return { x, y }
    const maxX = Math.max(FLOAT_EDGE, wrap.clientWidth - el.offsetWidth - FLOAT_EDGE)
    const maxY = Math.max(FLOAT_EDGE, wrap.clientHeight - el.offsetHeight - FLOAT_EDGE)
    return { x: Math.min(Math.max(x, FLOAT_EDGE), maxX), y: Math.min(Math.max(y, FLOAT_EDGE), maxY) }
  }, [])

  // 扇面尺寸变化（窗口缩放、任务增删带动高度变化）后重新夹一次；夹完不写回存储，
  // 这样窗口恢复大小时浮卡还能回到用户当初拖到的位置
  useEffect(() => {
    const wrap = wrapRef.current
    if (!wrap) return
    const reclamp = () => {
      setFloatPos((prev) => {
        const next = clampFloatPos(prev.x, prev.y)
        return next.x === prev.x && next.y === prev.y ? prev : next
      })
    }
    reclamp()
    const observer = new ResizeObserver(reclamp)
    observer.observe(wrap)
    return () => observer.disconnect()
  }, [clampFloatPos, n])

  const onFloatDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button) return
    const el = floatRef.current
    if (!el) return
    const start = floatPosRef.current
    floatDragRef.current = { px: e.clientX, py: e.clientY, x: start.x, y: start.y }
    floatLiveRef.current = start
    try {
      el.setPointerCapture(e.pointerId)
    } catch {
      /* 不支持指针捕获时退化为普通拖拽 */
    }
    setFloatDragging(true)
  }

  const onFloatMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const drag = floatDragRef.current
    if (!drag) return
    // 用位移增量而不是绝对坐标换算，省掉边框与内边距带来的坐标系误差
    const next = clampFloatPos(drag.x + (e.clientX - drag.px), drag.y + (e.clientY - drag.py))
    floatLiveRef.current = next
    const el = floatRef.current
    if (el) {
      el.style.left = `${next.x}px`
      el.style.top = `${next.y}px`
    }
  }

  const onFloatUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!floatDragRef.current) return
    floatDragRef.current = null
    setFloatDragging(false)
    try {
      floatRef.current?.releasePointerCapture(e.pointerId)
    } catch {
      /* 已经释放 */
    }
    const next = floatLiveRef.current
    if (next) {
      setFloatPos(next)
      try {
        localStorage.setItem(FLOAT_POS_KEY, JSON.stringify(next))
      } catch {
        /* 存储不可用时仅本次会话生效 */
      }
    }
  }

  // 首次挂载 / 项目数变化：定位到当前选中项目并铺一次位姿（不播动画）
  useLayoutEffect(() => {
    const idx = cards.findIndex((p) => String(p.id) === String(activeId))
    if (idx >= 0) {
      activeRef.current = idx
      setActive(idx)
      setShown(idx)
    }
    applyLayout(0)
    // 依赖 n 而非 cards：项目内容变化不该重排，数量变了才需要
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [n, activeId, applyLayout])

  // 居中索引变化后重排（带吸附动画）
  useLayoutEffect(() => {
    applyLayout(0)
  }, [active, applyLayout])

  // 悬浮统计卡：先淡出，160ms 后换内容再淡入
  const firstFloatRef = useRef(true)
  useEffect(() => {
    if (firstFloatRef.current) {
      firstFloatRef.current = false
      setShown(active)
      return
    }
    setSwitching(true)
    const timer = setTimeout(() => {
      setShown(active)
      setSwitching(false)
    }, FLOAT_SWAP_MS)
    return () => clearTimeout(timer)
  }, [active])

  // 滚轮 / 拖拽 / 惯性 / 键盘
  useEffect(() => {
    const wrap = wrapRef.current
    if (!wrap || n === 0) return

    const onWheel = (e: WheelEvent) => {
      if (dragRef.current) return
      const raw = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY
      e.preventDefault()
      const now = Date.now()
      wheelRef.current.acc += raw
      if (now - wheelRef.current.lock < 140) return
      if (Math.abs(wheelRef.current.acc) < 10) return
      goActive(activeRef.current + (wheelRef.current.acc > 0 ? 1 : -1))
      wheelRef.current.acc = 0
      wheelRef.current.lock = now
    }

    const onPointerDown = (e: PointerEvent) => {
      if (e.button) return // 仅左键 / 触摸
      // 浮卡自己可拖拽（移动落点）：别把它当成轮播拖拽的起点。
      // 这里必须用原生 target 判断——本监听挂在容器上，比 React 的合成事件先跑，
      // 靠浮卡那侧 stopPropagation 是拦不住的。
      if ((e.target as HTMLElement | null)?.closest?.('.wb-fan__float')) return
      const card = (e.target as HTMLElement | null)?.closest?.('.wb-fan__card') as HTMLElement | null
      const downIdx = card ? Array.from(stageRef.current?.children ?? []).indexOf(card) : -1
      dragRef.current = { x: e.clientX, downIdx }
      slotsRef.current = 0
      movedRef.current = false
      samplesRef.current = []
      wrap.classList.add('is-dragging')
      try {
        wrap.setPointerCapture(e.pointerId)
      } catch {
        /* 某些环境不支持捕获，退化为普通拖拽 */
      }
      setTransition(false)
    }

    const onPointerMove = (e: PointerEvent) => {
      const drag = dragRef.current
      if (!drag) return
      const dx = e.clientX - drag.x
      if (!movedRef.current && Math.abs(dx) < 5) return
      movedRef.current = true
      e.preventDefault()
      slotsRef.current = dx / FAN_STEP_PX // 位移 → 卡位数
      applyLayout(slotsRef.current) // 实时跟手，不吸附
      samplesRef.current.push({ t: Date.now(), s: slotsRef.current })
      if (samplesRef.current.length > 8) samplesRef.current.shift()
    }

    const endDrag = (e: PointerEvent, cancelled: boolean) => {
      const drag = dragRef.current
      if (!drag) return
      let slots = slotsRef.current || 0
      const moved = movedRef.current
      dragRef.current = null
      slotsRef.current = 0
      movedRef.current = false
      wrap.classList.remove('is-dragging')
      setTransition(true)

      if (moved && !cancelled) {
        // 惯性：最近 120ms 的速度折算成额外卡位，再吸附到整数卡位
        const now = Date.now()
        let first: { t: number; s: number } | null = null
        let last: { t: number; s: number } | null = null
        for (const sample of samplesRef.current) {
          if (now - sample.t > 120) continue
          if (!first) first = sample
          last = sample
        }
        if (first && last && last.t > first.t) {
          const v = (last.s - first.s) / (last.t - first.t) // 卡位 / ms
          slots += Math.max(-1.2, Math.min(1.2, v * 140))
        }
        samplesRef.current = []
        const target = Math.round(slots) // 轻拖不足半格 → 回弹原位
        if (target !== 0) goActive(activeRef.current + target)
        // 无条件吸附回整数卡位：goActive 在「目标卡位等于当前卡位」时会提前返回，
        // 只靠 state 变化驱动重排会让卡片永远停在拖动中的小数位移上
        applyLayout(0)
        return
      }

      samplesRef.current = []
      if (moved || cancelled) {
        applyLayout(0)
        return
      }
      // 点选：用 pointerdown 记下的卡（指针捕获会把 pointerup 的 target 重定向到容器）
      const idx = drag.downIdx
      if (idx > -1 && idx < cardsRef.current.length) {
        goActive(idx)
        onPickRef.current(cardsRef.current[idx].id)
      }
    }

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft') {
        goActive(activeRef.current - 1)
        e.preventDefault()
      }
      if (e.key === 'ArrowRight') {
        goActive(activeRef.current + 1)
        e.preventDefault()
      }
    }

    const onPointerUp = (e: PointerEvent) => endDrag(e, false)
    const onPointerCancel = (e: PointerEvent) => endDrag(e, true)

    wrap.addEventListener('wheel', onWheel, { passive: false })
    wrap.addEventListener('pointerdown', onPointerDown)
    wrap.addEventListener('pointermove', onPointerMove)
    wrap.addEventListener('pointerup', onPointerUp)
    wrap.addEventListener('pointercancel', onPointerCancel)
    wrap.addEventListener('lostpointercapture', onPointerUp)
    wrap.addEventListener('keydown', onKeyDown)
    return () => {
      wrap.removeEventListener('wheel', onWheel)
      wrap.removeEventListener('pointerdown', onPointerDown)
      wrap.removeEventListener('pointermove', onPointerMove)
      wrap.removeEventListener('pointerup', onPointerUp)
      wrap.removeEventListener('pointercancel', onPointerCancel)
      wrap.removeEventListener('lostpointercapture', onPointerUp)
      wrap.removeEventListener('keydown', onKeyDown)
    }
  }, [n, applyLayout, goActive, setTransition])

  // 自动轮播：让卡片缓慢滑动；悬停 / 拖拽 / 切后台时暂停
  useEffect(() => {
    if (n <= 1) return
    const wrap = wrapRef.current
    let timer: number | undefined
    const stop = () => {
      if (timer !== undefined) {
        clearInterval(timer)
        timer = undefined
      }
    }
    const start = () => {
      stop()
      timer = window.setInterval(() => {
        if (dragRef.current || hoveredRef.current || document.hidden) return
        goActive(activeRef.current + 1)
      }, AUTO_DELAY)
    }
    const onEnter = () => {
      hoveredRef.current = true
    }
    const onLeave = () => {
      hoveredRef.current = false
    }
    const onVisible = () => {
      if (document.hidden) stop()
      else start()
    }
    wrap?.addEventListener('pointerenter', onEnter)
    wrap?.addEventListener('pointerleave', onLeave)
    document.addEventListener('visibilitychange', onVisible)
    start()
    return () => {
      stop()
      wrap?.removeEventListener('pointerenter', onEnter)
      wrap?.removeEventListener('pointerleave', onLeave)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [n, goActive])

  /** 没有项目时不铺卡片，只留空态 —— 否则整层覆盖会压在绿色主卡上 */
  if (projects.length === 0) {
    return (
      <div className="wb-fan" aria-label="项目文档概览">
        <div className="wb-fan__empty">
          <p>还没有项目。建项目后，它的完成度与关联文档会在这里聚成一张卡。</p>
        </div>
      </div>
    )
  }

  const floating = cards[shown] ?? null

  return (
    <div
      ref={wrapRef}
      className="wb-fan"
      aria-label="项目文档概览：滚轮或拖动切换，左右方向键也可切换"
      tabIndex={0}
    >
      <div className="wb-fan__stage" ref={stageRef}>
        {cards.map((project) => (
          <div
            key={project.id}
            className="wb-fan__card"
            title={`${project.name}：${project.taskCount} 个任务、${project.docCount} 份关联文档`}
          >
            <span className="wbi-fan-tag">{project.name}</span>
            <div className="wbi-fan-center">
              <span className="wbi-fan-center__icon"><IconFolder /></span>
              <span className="wbi-fan-center__title">{project.name}</span>
              <span className="wbi-fan-center__sub">▤ {project.docCount} 份文档</span>
            </div>
          </div>
        ))}
      </div>

      <div
        ref={floatRef}
        className={`wb-fan__float${switching ? ' is-switching' : ''}${floatDragging ? ' is-dragging' : ''}`}
        style={{ left: floatPos.x, top: floatPos.y }}
        title={floating?.name ? `${floating.name}（可拖动，位置会记住）` : '可拖动'}
        onPointerDown={onFloatDown}
        onPointerMove={onFloatMove}
        onPointerUp={onFloatUp}
        onPointerCancel={onFloatUp}
        onLostPointerCapture={onFloatUp}
      >
        <div className="wb-fan__float-head">
          <div>
            <div className="wb-fan__float-title">项目文档</div>
            <div className="wb-fan__float-sub">{floating?.name}</div>
          </div>
          <span className="wb-fan__float-arrow"><IconArrowUpRight /></span>
        </div>
        <div className="wb-fan__float-num">{floating?.progress ?? 0}<small>%</small></div>
        <div className="wb-fan__float-label">
          完成度 · {floating?.doneCount ?? 0}/{floating?.taskCount ?? 0} 任务
        </div>
        <div className="wb-fan__float-bar"><i style={{ width: `${floating?.progress ?? 0}%` }} /></div>
      </div>

      {n > 1 && <span className="wb-fan__hint">自动滑动中 · 悬停暂停 · 可拖动</span>}
    </div>
  )
}
