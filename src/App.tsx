import { useState, useEffect } from 'react'
import { Routes, Route, useNavigate, useLocation } from 'react-router-dom'
import AppSidebar from './components/Layout/AppSidebar'
import AuthDialog from './workbench/AuthDialog'
import CommandBar from './components/Layout/CommandBar'
import Dashboard from './pages/Dashboard'
import FileManager from './pages/FileManager'
import KnowledgeGraph from './pages/KnowledgeGraph'
import SearchCenter from './pages/SearchCenter'
import Projects from './pages/Projects'
import Settings from './pages/Settings'
import Ask from './pages/Ask'
import Resources from './pages/Resources'
import Calendar from './pages/Calendar'
import Analytics from './pages/Analytics'
import Messages from './pages/Messages'
import Share from './pages/Share'
import WorkbenchPage from './workbench/WorkbenchPage'
import { WorkbenchProvider } from './workbench/WorkbenchContext'
import { SHORTCUTS, readThemeChoice, type ThemeChoice } from './shortcuts'
import './workbench/dashboard.css'

export default function App() {
  const navigate = useNavigate()
  const location = useLocation()
  const [theme, setTheme] = useState<ThemeChoice>('dark')
  const [cmdOpen, setCmdOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [authOpen, setAuthOpen] = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState(false)

  useEffect(() => {
    setTheme(readThemeChoice())
    applyTheme(readThemeChoice())
  }, [])

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setCmdOpen(o => !o)
        return
      }
      if (e.key === 'Escape') { setCmdOpen(false); setSidebarOpen(false); return }
      // 命令面板打开时数字键不再切换页面，避免面板遮挡下页面在背后跳转
      if (cmdOpen) return
      const target = e.target as HTMLElement | null
      const tag = target?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || target?.isContentEditable) return
      const hit = SHORTCUTS.find((s) => s.key === e.key)
      if (hit && !e.metaKey && !e.ctrlKey && !e.altKey) navigate(hit.path)
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [navigate, cmdOpen])

  /** S2-13：跟随系统时以 matchMedia 求解析，落出的类名与手动选择完全一致 */
  const applyTheme = (choice: ThemeChoice) => {
    const resolved = choice === 'system'
      ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
      : choice
    const root = document.documentElement
    root.classList.toggle('light', resolved === 'light')
    root.classList.toggle('dark', resolved === 'dark')
  }

  // 仅「跟随系统」时挂监听：系统深浅切换即时生效；手动选择永久覆盖系统
  useEffect(() => {
    if (theme !== 'system') return
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = () => applyTheme('system')
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [theme])

  const setThemeChoice = (next: ThemeChoice) => {
    setTheme(next)
    localStorage.setItem('sd-theme', next)
    applyTheme(next)
  }

  /** 工作台是「侧栏 + 主区 + 右侧详情」三栏（参照稿的 wb-app 栅格） */
  const isWorkbench = location.pathname === '/workbench'

  return (
    <WorkbenchProvider>
      <div className={`wb-app${isWorkbench ? ' wb-app--workbench' : ''}`}>
          <AppSidebar
          currentPath={location.pathname}
          onNavigate={(p) => { setSidebarOpen(false); navigate(p) }}
            theme={theme}
            onSetTheme={setThemeChoice}
            onOpenSettings={() => setSettingsOpen(true)}
          onOpenAuth={() => setAuthOpen(true)}
          open={sidebarOpen}
        />

        {isWorkbench ? (
          <WorkbenchPage
            onOpenFile={(fileId) => navigate(`/files?id=${fileId}`)}
            onOpenKnowledge={() => navigate('/')}
            onToggleSidebar={() => setSidebarOpen((value) => !value)}
          />
        ) : (
          <div className="wb-app__content">
            <Routes>
              <Route path="/" element={<Dashboard />} />
              <Route path="/ask" element={<Ask />} />
              <Route path="/files" element={<FileManager />} />
              <Route path="/graph" element={<KnowledgeGraph />} />
              <Route path="/search" element={<SearchCenter />} />
              <Route path="/projects" element={<Projects />} />
              <Route path="/settings" element={<Settings />} />
              <Route path="/resources" element={<Resources />} />
              <Route path="/calendar" element={<Calendar />} />
              <Route path="/analytics" element={<Analytics />} />
              <Route path="/messages" element={<Messages />} />
              <Route path="/share" element={<Share />} />
            </Routes>
          </div>
        )}

        <div
          className={`wb-scrim${sidebarOpen ? ' wb-scrim--show' : ''}`}
          onClick={() => setSidebarOpen(false)}
        />

            <CommandBar
          open={cmdOpen}
          onClose={() => setCmdOpen(false)}
          onOpen={() => setCmdOpen(true)}
          onNavigate={(p) => { navigate(p); setCmdOpen(false) }}
            />
            {settingsOpen && <Settings modal onClose={() => setSettingsOpen(false)} />}
            {authOpen && <AuthDialog onClose={() => setAuthOpen(false)} />}
      </div>
    </WorkbenchProvider>
  )
}
