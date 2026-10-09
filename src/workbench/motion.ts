import { useEffect, useRef, useState } from 'react'
import type { SDGroupColor, SDTaskPriority, SDTaskStatus } from '../types/global'

/**
 * 数字滚动动画：让指标卡的值从 0 递增到目标。
 * 用 rAF 而不是 CSS，保证「数据到位后」才开始滚，视觉上跟 deskforge 一致。
 */
export function useCountUp(target: number, duration = 760): number {
  const [value, setValue] = useState(0)
  const from = useRef(0)

  useEffect(() => {
    const start = performance.now()
    const origin = from.current
    let frame = 0

    const step = (now: number) => {
      const t = Math.min(1, (now - start) / duration)
      // easeOutCubic：起步快、收尾稳
      const eased = 1 - Math.pow(1 - t, 3)
      const next = origin + (target - origin) * eased
      setValue(next)
      if (t < 1) frame = requestAnimationFrame(step)
      else from.current = target
    }

    frame = requestAnimationFrame(step)
    return () => cancelAnimationFrame(frame)
  }, [target, duration])

  return Math.round(value)
}

/** 状态 → 颜色令牌，分组列表/时间线/详情共用一套语义（取值同 TASK_STATUSES） */
export const STATUS_META: Record<SDTaskStatus, { label: string; color: string }> = {
  todo: { label: '待办', color: 'var(--text-dim)' },
  doing: { label: '进行中', color: 'var(--primary)' },
  done: { label: '已完成', color: 'var(--success)' },
}

export const STATUS_ORDER: readonly SDTaskStatus[] = ['todo', 'doing', 'done']

/** 优先级是中文枚举（同 TASK_PRIORITIES），不做二次翻译，直接落库 */
export const PRIORITY_META: Record<SDTaskPriority, { label: string; color: string }> = {
  '高': { label: '高', color: 'var(--danger)' },
  '中': { label: '中', color: 'var(--warning)' },
  '低': { label: '低', color: 'var(--text-dim)' },
}

/** 分组颜色是名称枚举（同 GROUP_COLORS），需要映射到设计令牌才能当 CSS 用 */
export const GROUP_COLOR_TOKEN: Record<SDGroupColor, string> = {
  blue: 'var(--primary)',
  green: 'var(--success)',
  violet: 'var(--accent)',
}

/** 新建分组时按顺序轮转配色 */
export const GROUP_COLOR_CYCLE: readonly SDGroupColor[] = ['blue', 'green', 'violet']

export const groupColor = (color?: string) =>
  GROUP_COLOR_TOKEN[(color as SDGroupColor) ?? 'blue'] ?? 'var(--primary)'

export function statusMeta(status: string) {
  return STATUS_META[status as SDTaskStatus] ?? { label: status || '未知', color: 'var(--text-dim)' }
}

export function priorityMeta(priority: string) {
  return PRIORITY_META[priority as SDTaskPriority] ?? PRIORITY_META['中']
}

/** 距今天数：负数 = 已逾期 */
export function daysUntil(deadline?: string | null): number | null {
  if (!deadline) return null
  const target = new Date(deadline.replace(' ', 'T'))
  if (Number.isNaN(target.getTime())) return null
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  target.setHours(0, 0, 0, 0)
  return Math.round((target.getTime() - today.getTime()) / 86400000)
}
