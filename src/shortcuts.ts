/**
 * 全站唯一的数字快捷键注册表（S2-12 收敛）。
 * App.tsx 的键盘监听与 CommandBar 命令面板都从这里取值，
 * 新增页面时只需在此登记一处，键位与面板提示自动保持一致。
 */
export interface PageShortcut {
  /** 触发键：'1'-'9' 与 '0'；无键位页面为空串 */
  key: string
  /** 页面名称，与侧栏导航文案保持一致 */
  label: string
  path: string
  /** 命令面板里展示的单字图标 */
  icon: string
}

export const SHORTCUTS: readonly PageShortcut[] = [
  { key: '1', label: '任务管理', path: '/workbench', icon: 'W' },
  { key: '2', label: '知识库', path: '/', icon: 'B' },
  { key: '3', label: '文件归档', path: '/files', icon: 'F' },
  { key: '4', label: '知识图谱', path: '/graph', icon: 'G' },
  { key: '5', label: '搜索中心', path: '/search', icon: 'S' },
  { key: '6', label: '设置中心', path: '/settings', icon: 'T' },
  { key: '7', label: '问答', path: '/ask', icon: 'A' },
  { key: '8', label: '日程管理', path: '/calendar', icon: 'C' },
  { key: '9', label: '智能分析', path: '/analytics', icon: 'N' },
  { key: '0', label: '共享与导出', path: '/share', icon: 'H' },
]

/** 无数字键位的页面：只进命令面板，不参与数字快捷键 */
export const EXTRA_PAGES: readonly PageShortcut[] = [
  { key: '', label: '项目总览', path: '/projects', icon: 'P' },
  { key: '', label: '资源汇', path: '/resources', icon: 'R' },
  { key: '', label: '消息中心', path: '/messages', icon: 'M' },
]

// 开发期断言：键位必须唯一，重复注册会让两条快捷键互相覆盖
if (import.meta.env.DEV) {
  const keys = SHORTCUTS.map((s) => s.key)
  const dup = keys.filter((k, i) => keys.indexOf(k) !== i)
  if (dup.length > 0) console.warn(`[shortcuts] 数字快捷键重复注册: ${dup.join(', ')}`)
}

/** 主题选择：跟随系统 / 深色 / 浅色（S2-13）。手动选择会写入 localStorage 永久覆盖。 */
export type ThemeChoice = 'system' | 'dark' | 'light'

export const THEME_STORAGE_KEY = 'sd-theme'

/** 读取持久化的主题选择；旧值迁移：非法值或缺省一律回 dark，保持既有观感 */
export function readThemeChoice(): ThemeChoice {
  try {
    const saved = localStorage.getItem(THEME_STORAGE_KEY)
    if (saved === 'system' || saved === 'dark' || saved === 'light') return saved
  } catch {
    /* 隐私模式等存储不可用场景 */
  }
  return 'dark'
}
