import { useState, useEffect } from 'react'
import { Routes, Route, useNavigate, useLocation } from 'react-router-dom'
import AppSidebar from './components/Layout/AppSidebar'
import CommandBar from './components/Layout/CommandBar'
import Dashboard from './pages/Dashboard'
import FileManager from './pages/FileManager'
import KnowledgeGraph from './pages/KnowledgeGraph'
import SearchCenter from './pages/SearchCenter'
import Projects from './pages/Projects'
import Settings from './pages/Settings'
import Ask from './pages/Ask'
import Resources from './pages/Resources'
import WorkbenchPage from './workbench/WorkbenchPage'
import { WorkbenchProvider } from './workbench/WorkbenchContext'
import './workbench/dashboard.css'

/**
 * 导航顺序与数字快捷键一致（见下方 numKeys）。
 * 问答 `/ask` 追加在末尾 → 数字键 7；**不改动既有 1–6 的映射**（S2-06 才会统一重排导航）。
 */
const ROUTES = ['/workbench', '/', '/files', '/graph', '/search', '/settings', '/ask'] as const

export default function App() {
  const navigate = useNavigate()
  const location = useLocation()
  const [theme, setTheme] = useState<'dark' | 'light'>('dark')
  const [cmdOpen, setCmdOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState(false)

  useEffect(() => {
    const saved = localStorage.getItem('sd-theme') as 'dark' | 'light' || 'dark'
    setTheme(saved)
    applyTheme(saved)

    const handleKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault()
        setCmdOpen(o => !o)
      }
      if (e.key === 'Escape') { setCmdOpen(false); setSidebarOpen(false) }
      const numKeys = ROUTES.map((_, i) => String(i + 1))
      if (numKeys.includes(e.key) && !e.metaKey && !e.ctrlKey && !(e.target as HTMLElement)?.tagName?.match(/INPUT|TEXTAREA/)) {
        navigate(ROUTES[parseInt(e.key) - 1])
      }
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [navigate])

  const applyTheme = (t: string) => {
    const root = document.documentElement
    if (t === 'light') root.classList.add('light')
    else root.classList.remove('light')
    root.classList.remove('dark')
    if (t === 'dark') root.classList.add('dark')
  }

  const toggleTheme = () => {
    const next = theme === 'dark' ? 'light' : 'dark'
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
            onToggleTheme={toggleTheme}
            onOpenSettings={() => setSettingsOpen(true)}
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
      </div>
    </WorkbenchProvider>
  )
}
