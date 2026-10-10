import { useState } from 'react'
import type { ReactNode } from 'react'
import { useWorkbenchContext } from '../../workbench/WorkbenchContext'
import {
  IconArchive,
  IconBook,
  IconCalendar,
  IconChart,
  IconChevronDown,
  IconChevronRight,
  IconChevronsUpDown,
  IconGear,
  IconGrid,
  IconLayers,
  IconLogout,
  IconMoon,
  IconPlus,
  IconSearch,
  IconShare,
  IconSpark,
  IconSun,
  IconUsers,
} from '../../workbench/icons'

interface Props {
  currentPath: string
  onNavigate: (path: string) => void
  theme: 'dark' | 'light'
  onToggleTheme: () => void
  onOpenSettings: () => void
  /** 点击 sd 头像或「未登录」时打开登录注册弹窗 */
  onOpenAuth: () => void
  /** ≤860px 时侧栏转为抽屉，由移动端悬浮按钮控制 */
  open?: boolean
}

interface NavItem {
  label: string
  path?: string
  icon: ReactNode
  /** 参照稿中的激活项右侧带一个 chevron */
  chevron?: boolean
  /** SD 尚无对应页面：照参照稿保留该项，置灰并标注 */
  pending?: boolean
}

const ROLE_LABEL: Record<string, string> = { owner: '本机所有者', member: '成员' }

/** 顺序与文案完全照参照稿的 8 项；末尾两项是 SD 自有页面，避免失去入口 */
const NAV: NavItem[] = [
  // 问答（S1-05）：S1 主线页面，置顶放置；数字键 7（见 App.tsx 的 ROUTES，避免改动既有 1–6）
  { label: '问答', path: '/ask', icon: <IconSpark /> },
  { label: '任务管理', path: '/workbench', icon: <IconGrid />, chevron: true },
  { label: '项目总览', path: '/projects', icon: <IconLayers /> },
  { label: '文件归档', path: '/files', icon: <IconArchive /> },
  { label: '日程管理', path: '/calendar', icon: <IconCalendar /> },
  { label: '团队协作', icon: <IconUsers />, pending: true },
  { label: '智能分析', path: '/analytics', icon: <IconChart /> },
  { label: '知识库', path: '/', icon: <IconBook /> },
  { label: '资源汇', path: '/resources', icon: <IconLayers /> },
  { label: '共享与导出', path: '/share', icon: <IconShare /> },
  { label: '设置中心', path: '/settings', icon: <IconGear /> },
  { label: '知识图谱', path: '/graph', icon: <IconChart /> },
  { label: '搜索中心', path: '/search', icon: <IconSearch /> },
]

/**
 * 左侧导航（参照稿 `.wb-sidebar` 的 1:1 复刻）。
 *
 * 工作区与项目挂在这里，而不是在工作台页内再开一条左栏 —— 参照稿的侧栏
 * 本身就是域感知的；数据来自 WorkbenchProvider，与工作台页共享同一份状态。
 */
export default function AppSidebar({ currentPath, onNavigate, theme, onToggleTheme, onOpenSettings, onOpenAuth, open = false }: Props) {
  const { model, filter, setFilter, act } = useWorkbenchContext()
  const { auth, snapshot, logout } = model

  const [accountOpen, setAccountOpen] = useState(false)
  const [wsClosed, setWsClosed] = useState(false)

  const authed = auth?.authenticated === true
  const workspace = snapshot?.workspace ?? null
  const projects = snapshot?.projects ?? []

  /** 侧栏写操作：失败消息由 provider 记进全局 error，这里不重复提示 */
  const run = (task: () => Promise<unknown>) => void act(task).catch(() => {})

  const createWorkspace = () => {
    const name = prompt('新工作区名称')
    if (!name?.trim()) return
    run(() => window.sd.workbench.workspace.create({ name: name.trim() }))
  }

  return (
    <aside className={`wb-sidebar${open ? ' wb-sidebar--open' : ''}`}>
      <div className="wb-logo">
        <span className="wb-logo__mark">SD</span>
        <span className="wb-logo__name">知序</span>
      </div>

      <nav className="wb-nav" aria-label="主导航">
        {NAV.map((item) => {
          const active = item.path != null && currentPath === item.path
          if (item.pending) {
            return (
              <button key={item.label} className="wb-nav__item" disabled title="还没有对应页面，待接入">
                {item.icon}
                {item.label}
                <span className="wb-nav__badge">待接入</span>
              </button>
            )
          }
          return (
            <button
              key={item.label}
              className={`wb-nav__item${active ? ' wb-nav__item--active' : ''}`}
              aria-current={active ? 'page' : undefined}
              onClick={() => item.path === '/settings' ? onOpenSettings() : onNavigate(item.path!)}
            >
              {item.icon}
              {item.label}
              {item.chevron && <span className="wb-nav__chevron"><IconChevronRight /></span>}
            </button>
          )
        })}
      </nav>

      {authed && (
        <div className="wb-ws">
          <div className="wb-ws__head">
            <span className="wb-ws__label">我的工作区</span>
            <button className="wb-ws__add" title="新建工作区" onClick={createWorkspace}>
              <IconPlus />
            </button>
          </div>

          <button
            className={`wb-ws__item${wsClosed ? ' wb-ws__item--closed' : ''}`}
            aria-expanded={!wsClosed}
            title={wsClosed ? '展开项目' : '收起项目'}
            onClick={() => setWsClosed((value) => !value)}
          >
            <span className="wb-ws__dot" />
            <span className="wb-ws__name">{workspace?.name || '未命名工作区'}</span>
            <span className="wb-ws__chevron"><IconChevronDown /></span>
          </button>

          {!wsClosed && (
            <div className="wb-ws__projects">
              <button
                className={`wb-ws__project${filter.projectId === '' ? ' wb-ws__project--on' : ''}`}
                onClick={() => setFilter({ ...filter, projectId: '' })}
              >
                <span className="wb-ws__project-name">全部任务</span>
              </button>
              {projects.map((project) => (
                <button
                  key={project.id}
                  className={`wb-ws__project${String(filter.projectId) === String(project.id) ? ' wb-ws__project--on' : ''}`}
                  onClick={() => setFilter({ ...filter, projectId: String(filter.projectId) === String(project.id) ? '' : project.id })}
                >
                  <span className="wb-ws__project-name" title={project.name}>{project.name}</span>
                  <span className="wb-ws__project-bar"><i style={{ width: `${project.progress}%` }} /></span>
                  <span className="wb-ws__project-count">{project.doneCount}/{project.taskCount}</span>
                </button>
              ))}
              {projects.length === 0 && <p className="wb-ws__empty">还没有项目。</p>}
            </div>
          )}
        </div>
      )}

      <div className="wb-user">
        {authed ? (
          <div className="wb-user__avatar">{(auth?.user?.displayName || 'SD').slice(0, 2).toUpperCase()}</div>
        ) : (
          <button type="button" className="wb-user__avatar wb-user__avatar--button" title="登录 / 注册" aria-label="登录或注册" onClick={onOpenAuth}>
            SD
          </button>
        )}
        <div className="wb-user__meta">
          {authed ? (
            <div className="wb-user__name">{auth?.user?.displayName}</div>
          ) : (
            <button type="button" className="wb-user__name wb-user__trigger" title="登录 / 注册" onClick={onOpenAuth}>
              未登录
            </button>
          )}
          <div className="wb-user__role">{authed ? ROLE_LABEL[auth?.user?.role || ''] || auth?.user?.role : '点击登录或注册'}</div>
        </div>
        <div className="wb-account">
          <button
            className="wb-user__expand"
            title="账户选项"
            aria-expanded={accountOpen}
            onClick={() => setAccountOpen((value) => !value)}
          >
            <IconChevronsUpDown />
          </button>
          {accountOpen && (
            <div className="wb-account__menu">
              <button
                className="wb-account__item"
                onClick={() => {
                  onToggleTheme()
                  setAccountOpen(false)
                }}
              >
                {theme === 'dark' ? <IconSun /> : <IconMoon />}
                {theme === 'dark' ? '切换到浅色' : '切换到深色'}
              </button>
              <button
                className="wb-account__item"
                onClick={() => {
                  setAccountOpen(false)
                  onOpenSettings()
                }}
              >
                <IconGear />
                系统设置
              </button>
              {authed ? (
                <button
                  className="wb-account__item"
                  onClick={() => {
                    setAccountOpen(false)
                    void logout()
                  }}
                >
                  <IconLogout />
                  退出登录
                </button>
              ) : (
                <button
                  className="wb-account__item"
                  onClick={() => {
                    setAccountOpen(false)
                    onOpenAuth()
                  }}
                >
                  <IconUsers />
                  登录 / 注册
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </aside>
  )
}
