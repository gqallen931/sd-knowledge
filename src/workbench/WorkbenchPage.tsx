import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import type { SDChunkAnchor, SDFolder } from '../types/global'
import AuthScreen from './AuthScreen'
import Notifications from './Notifications'
import ProjectFan from './ProjectFan'
import ProjectGantt from './ProjectGantt'
import SmartDetail from './SmartDetail'
import TaskGroups from './TaskGroups'
import {
  IconActivity,
  IconAlertCircle,
  IconArrowDown,
  IconArrowUp,
  IconCheckCircle,
  IconChevronDown,
  IconClipboard,
  IconClose,
  IconFilter,
  IconList,
  IconMail,
  IconMenu,
  IconPlus,
  IconSearch,
  IconSort,
  IconSpark,
} from './icons'
import { errorMessage } from './useWorkbench'
import { useWorkbenchContext } from './WorkbenchContext'
import { GROUP_COLOR_CYCLE, useCountUp } from './motion'

interface Props {
  onOpenFile: (fileId: number) => void
  onOpenKnowledge: () => void
  onToggleSidebar: () => void
}

type Tab = 'all' | 'mine' | 'joined'
type SortKey = 'deadline' | 'priority' | 'name'
type SearchScope = { sourceId: string; folderPath: string; projectId: string }

const PRIORITY_RANK: Record<string, number> = { '高': 0, '中': 1, '低': 2 }

/**
 * 命中方式：以后端返回的 `channels` 为准（实测混合检索两条通道都为 true）。
 * 缺 `channels` 时回落到 `documentSearchMode`；两者都给不出就不显示（不编造）。
 */
function matchModeLabel(mode?: string | null, channels?: { fulltext?: boolean; semantic?: boolean } | null): string {
  if (channels?.fulltext && channels?.semantic) return '混合匹配'
  if (channels?.semantic) return '语义匹配'
  if (channels?.fulltext) return '全文匹配'
  if (mode === 'hybrid') return '混合匹配'
  if (mode === 'semantic') return '语义匹配'
  if (mode === 'fulltext') return '全文匹配'
  return ''
}

/**
 * 位置锚点翻成人话：page→第 N 页 / slide→第 N 张幻灯片 / chapter→第 N 章 /
 * sheet→第 N 个工作表 / time→mm:ss。
 * 给不出锚点（`anchor_kind` 为 null）或序号非法时返回空串——不编造「第 1 页」。
 */
function anchorLabel(anchor?: SDChunkAnchor | null): string {
  const kind = anchor?.anchor_kind
  if (!kind) return ''
  if (kind === 'time') {
    const ms = anchor?.time_start_ms
    if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return ''
    const seconds = Math.floor(ms / 1000)
    return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
  }
  const index = anchor?.anchor_index
  if (typeof index !== 'number' || !Number.isFinite(index) || index < 1) return ''
  if (kind === 'page') return `第 ${index} 页`
  if (kind === 'slide') return `第 ${index} 张幻灯片`
  if (kind === 'chapter') return `第 ${index} 章`
  if (kind === 'sheet') return `第 ${index} 个工作表`
  return ''
}

/** 匹配片段优先级：命中块正文 → 摘录 → 摘要；压掉换行便于单行截断 */
function hitSnippet(row: any): string {
  const raw = row?.matched_chunk?.content ?? row?.excerpt ?? row?.summary ?? ''
  return String(raw).replace(/\s+/g, ' ').trim()
}

/** 参照稿的 4 张统计卡：标签 / 单位 / 图标 都照搬，只有数值换成库里的真实值 */
function StatCard({
  label, value, unit, note, delta, tone, icon, delay,
}: {
  label: string
  value: number
  unit: string
  note: string
  delta?: number | null
  tone: 'danger' | 'normal'
  icon: ReactNode
  delay: number
}) {
  const shown = useCountUp(value)
  return (
    <div className={`wb-stat${tone === 'danger' ? ' wb-stat--danger' : ''}`} style={{ animation: `slide-up .32s ${delay}ms backwards` }}>
      <div className="wb-stat__icon">{icon}</div>
      <div className="wb-stat__label">{label}</div>
      <div className="wb-stat__value">
        <span className="wb-stat__num">{shown}</span>
        <span className="wb-stat__unit">{unit}</span>
      </div>
      <div className="wb-stat__trend">
        {note}
        {delta != null && (
          <span className={`wb-stat__delta wb-stat__delta--${delta >= 0 ? 'up' : 'down'}`}>
            {delta >= 0 ? <IconArrowUp /> : <IconArrowDown />}
            {Math.abs(Math.round(delta))}%
          </span>
        )}
      </div>
    </div>
  )
}

/**
 * 任务管理界面：参照稿 `A-UI/task-dashboard.html` 的 1:1 复刻。
 *
 * 页头 / 统计 / 看板 / 分组列表 / 卡片扇 / 时间线 / 右侧智能详情 / 移动端抽屉
 * 都是参照稿的元素；只有数据换成 SD 的真实来源，缺数据的项按约定置灰或标注。
 */
export default function WorkbenchPage({ onOpenFile, onOpenKnowledge, onToggleSidebar }: Props) {
  const navigate = useNavigate()
  const { model, filter, setFilter, selectedId, setSelectedId, act } = useWorkbenchContext()
  const {
    auth, ready, loading, error, setError, snapshot, groups, tasks,
    notifications, reminders, stats, unread,
  } = model

  const [tab, setTab] = useState<Tab>('all')
  const [statusFilter, setStatusFilter] = useState('')
  const [priorityFilter, setPriorityFilter] = useState('')
  const [sortKey, setSortKey] = useState<SortKey>('deadline')
  const [listOnly, setListOnly] = useState(false)
  const [creating, setCreating] = useState(false)
  /** ≤1200px 时右栏是抽屉，靠这个开关和悬浮按钮控制 */
  const [detailOpen, setDetailOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<{
    tasks: any[]; projects: any[]; docs: any[]; total: number; truncated: boolean;
    totalIsApprox: boolean; mode: string; channels: { fulltext?: boolean; semantic?: boolean } | null;
  } | null>(null)
  const [searchScope, setSearchScope] = useState<SearchScope>({ sourceId: '', folderPath: '', projectId: '' })
  const [scopeOpen, setScopeOpen] = useState(false)
  const [sources, setSources] = useState<any[]>([])
  const [folders, setFolders] = useState<SDFolder[]>([])
  const [menu, setMenu] = useState<'status' | 'filter' | 'sort' | 'more' | null>(null)

  const projects = snapshot?.projects ?? []
  const me = auth?.user?.displayName || auth?.user?.username || ''
  const scopeLabel = searchScope.folderPath || sources.find((source) => String(source.id) === searchScope.sourceId)?.name ||
    projects.find((project) => String(project.id) === searchScope.projectId)?.name || '全部资料'

  /** 写操作的统一出口：成功后 refresh，失败把消息写进全局 error */
  const run = useCallback(
    async (task: () => Promise<unknown>) => {
      try { await act(task) } catch { /* 错误已在 provider 里记下 */ }
    },
    [act],
  )

  /** 作用域列表只在登录后加载；目录随所选知识空间收窄。 */
  useEffect(() => {
    if (!ready) return
    void window.sd.folder.list().then(setSources).catch((e) => setError(errorMessage(e)))
  }, [ready, setError])

  useEffect(() => {
    if (!searchScope.sourceId) { setFolders([]); return }
    void window.sd.folder.listFolders(Number(searchScope.sourceId)).then(setFolders).catch((e) => setError(errorMessage(e)))
  }, [searchScope.sourceId, setError])

  /** 顶部搜索：工作台元数据 + 受作用域约束的内核文档；全文零命中时服务端自动回退语义检索。 */
  useEffect(() => {
    if (!query.trim()) { setResults(null); return }
    let alive = true
    const timer = window.setTimeout(async () => {
      try {
        const all = await window.sd.workbench.search(query.trim(), {
          source_id: searchScope.sourceId ? Number(searchScope.sourceId) : null,
          folder_path: searchScope.folderPath || null,
          project_id: searchScope.projectId ? Number(searchScope.projectId) : null,
        })
        if (alive) setResults({
          tasks: all?.tasks ?? [], projects: all?.projects ?? [], docs: all?.documents?.items ?? [],
          total: all?.documents?.total ?? 0, truncated: Boolean(all?.documents?.truncated),
          totalIsApprox: Boolean(all?.documents?.total_is_approx),
          mode: all?.documentSearchMode ?? 'fulltext',
          channels: all?.documents?.channels ?? null,
        })
      } catch (e) {
        if (alive) setError(errorMessage(e))
      }
    }, 220)
    return () => { alive = false; window.clearTimeout(timer) }
  }, [query, searchScope, setError])

  const visible = useMemo(() => {
    const list = tasks.filter((task) => {
      if (filter.projectId !== '' && String(task.projectId ?? '') !== String(filter.projectId)) return false
      if (tab === 'mine' && me && task.owner !== me) return false
      if (tab === 'joined' && !task.participant) return false
      if (statusFilter && task.status !== statusFilter) return false
      if (priorityFilter && task.priority !== priorityFilter) return false
      return true
    })
    return [...list].sort((a, b) => {
      if (sortKey === 'priority') return (PRIORITY_RANK[a.priority] ?? 9) - (PRIORITY_RANK[b.priority] ?? 9)
      if (sortKey === 'name') return a.name.localeCompare(b.name, 'zh-CN')
      return (a.deadline || '9999') < (b.deadline || '9999') ? -1 : 1
    })
  }, [tasks, filter.projectId, tab, me, statusFilter, priorityFilter, sortKey])

  const selected = tasks.find((task) => task.id === selectedId) ?? null

  /** 库里存的是本地时间，日期键必须按本地时区算，否则跨零点会错位一天 */
  const localKey = (date: Date) =>
    `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
  const todayKey = localKey(new Date())
  const yesterdayKey = localKey(new Date(Date.now() - 86400000))
  const dueToday = tasks.filter((task) => task.status !== 'done' && task.deadline?.slice(0, 10) === todayKey).length
  const createdToday = tasks.filter((task) => task.createdAt?.slice(0, 10) === todayKey).length
  const createdYesterday = tasks.filter((task) => task.createdAt?.slice(0, 10) === yesterdayKey).length
  /** 真实的「较昨日」：只在这里算得出来（新增任务数），其余三张卡给真实占比而不是编一个百分比 */
  const createdDelta = createdYesterday > 0 ? ((createdToday - createdYesterday) / createdYesterday) * 100 : null
  const total = stats.total || 0
  /** 命中方式：混合检索显示「混合匹配」，不再被误报成「全文匹配」 */
  const docModeLabel = results ? matchModeLabel(results.mode, results.channels) : ''

  if (loading && !auth) {
    return (
      <main className="wb-main">
        <div className="wb-detail__empty">
          <span className="wb-spinner" />
          <p>正在加载任务管理…</p>
        </div>
      </main>
    )
  }

  if (auth && !auth.authenticated) {
    return (
      <main className="wb-main">
        <div className="wb-auth">
          <AuthScreen onAuthenticated={model.reload} onSkip={onOpenKnowledge} />
        </div>
      </main>
    )
  }

  return (
    <>
      <main className="wb-main">
        <header className="wb-head">
          <div className="wb-head__titleblock">
            <h1 className="wb-head__title">任务管理</h1>
            <p className="wb-head__subtitle">高效规划 · 智能协同 · 结果驱动</p>
          </div>

          <div className="wb-search">
            <IconSearch />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索任务、项目或文件..."
              aria-label="搜索任务、项目或文件"
            />
            <button
              type="button"
              className="wb-search__scope"
              title="限定知识库文档的搜索范围"
              onClick={() => setScopeOpen((open) => !open)}
            >
              {scopeLabel}
              <IconChevronDown />
            </button>
            <kbd>Ctrl K</kbd>
            {scopeOpen && (
              <div className="wb-search__scope-menu">
                <label>
                  知识空间
                  <select value={searchScope.sourceId} onChange={(event) => setSearchScope({ sourceId: event.target.value, folderPath: '', projectId: searchScope.projectId })}>
                    <option value="">全部空间</option>
                    {sources.map((source) => <option key={source.id} value={source.id}>{source.name}</option>)}
                  </select>
                </label>
                <label>
                  文件夹
                  <select value={searchScope.folderPath} disabled={!searchScope.sourceId} onChange={(event) => setSearchScope({ ...searchScope, folderPath: event.target.value })}>
                    <option value="">空间根目录</option>
                    {folders.map((folder) => <option key={folder.id} value={folder.path}>{'　'.repeat(folder.depth)}{folder.path}</option>)}
                  </select>
                </label>
                <label>
                  项目
                  <select value={searchScope.projectId} onChange={(event) => setSearchScope({ ...searchScope, projectId: event.target.value })}>
                    <option value="">全部项目</option>
                    {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
                  </select>
                </label>
                <button type="button" className="wb-search__scope-reset" onClick={() => setSearchScope({ sourceId: '', folderPath: '', projectId: '' })}>清除范围</button>
              </div>
            )}
            {results && (
              <div className="wb-search__results">
                <p className="wb-search__meta">
                  文件：{results.totalIsApprox ? '约 ' : ''}{results.total} 条
                  {docModeLabel ? ` · ${docModeLabel}` : ''}
                  {results.truncated ? ' · 已显示部分结果' : ''}
                </p>
                {[
                  { key: '任务', rows: results.tasks, rich: false, open: (row: any) => setSelectedId(row.id) },
                  { key: '项目', rows: results.projects, rich: false, open: (row: any) => setFilter({ ...filter, projectId: row.id }) },
                  { key: '文件', rows: results.docs, rich: true, open: (row: any) => onOpenFile(Number(row.id ?? row.file_id)) },
                ]
                  .filter((group) => group.rows.length > 0)
                  .map((group) => (
                    <div className="wb-search__group" key={group.key}>
                      <h6>{group.key}</h6>
                      {group.rows.slice(0, 6).map((row: any, index: number) => {
                        const snippet = group.rich ? hitSnippet(row) : ''
                        const position = group.rich ? anchorLabel(row.anchor) : ''
                        return (
                          <button
                            key={`${group.key}-${row.id ?? index}`}
                            className={`wb-search__hit${group.rich ? ' wb-search__hit--rich' : ''}`}
                            onClick={() => { group.open(row); setQuery(''); setResults(null) }}
                          >
                            <span className="wb-search__hit-main">
                              <code>{row.id ?? row.code ?? ''}</code>
                              <span className="wb-search__hit-title">{row.name ?? row.title ?? row.file_name}</span>
                              {position && <span className="search-chip">{position}</span>}
                            </span>
                            {snippet && <span className="search-snippet">{snippet}</span>}
                          </button>
                        )
                      })}
                    </div>
                  ))}
                {!results.tasks.length && !results.projects.length && !results.docs.length && (
                  <p className="wb-search__empty">没有匹配结果。</p>
                )}
              </div>
            )}
          </div>

          <div className="wb-head__actions">
            <Notifications
              notifications={notifications}
              reminders={reminders}
              unread={unread}
              onMarkRead={() => act(() => window.sd.notification.read())}
              onCreateReminder={(title, remindAt, repeatRule) => act(() => window.sd.reminder.create({ title, remindAt, repeatRule }))}
              onDismissReminder={(id) => act(() => window.sd.reminder.dismiss(id))}
              onRemoveReminder={(id) => act(() => window.sd.reminder.remove(id))}
              onSelectTask={(taskCode) => setSelectedId(taskCode)}
            />
            <button className="wb-iconbtn" title="消息中心" onClick={() => navigate('/messages')}>
              <IconMail />
            </button>
            <button className="wb-btn-new" disabled={groups.length === 0} onClick={() => setCreating(true)}>
              <IconPlus sw={2.4} />
              新增任务
            </button>
            <div className="wb-account wb-account--down">
              <button className="wb-btn-split" title="更多操作" onClick={() => setMenu(menu === 'more' ? null : 'more')}>
                <IconChevronDown />
              </button>
              {menu === 'more' && (
                <div className="wb-account__menu">
                  <button
                    className="wb-account__item"
                    onClick={() => {
                      setMenu(null)
                      const name = prompt('新分组名称（如「需求评审」「开发实现」）')
                      if (name?.trim()) {
                        void run(() => window.sd.task.group.create({
                          name: name.trim(),
                          color: GROUP_COLOR_CYCLE[groups.length % GROUP_COLOR_CYCLE.length],
                        }))
                      }
                    }}
                  >
                    <IconPlus /> 新建分组
                  </button>
                  <button
                    className="wb-account__item"
                    onClick={() => {
                      setMenu(null)
                      const name = prompt('新项目名称')
                      if (name?.trim()) void run(() => window.sd.workbench.project.create({ name: name.trim() }))
                    }}
                  >
                    <IconPlus /> 新建项目
                  </button>
                  <button className="wb-account__item" onClick={() => { setMenu(null); void run(() => model.refresh()) }}>
                    <IconActivity /> 刷新数据
                  </button>
                </div>
              )}
            </div>
          </div>
        </header>

        {error && (
          <div className="wb-error-banner">
            <span>{error}</span>
            <button className="wb-iconbtn" onClick={() => setError('')}><IconClose /></button>
          </div>
        )}

        <section className="wb-stats" aria-label="任务统计">
          <StatCard label="今日待办" value={dueToday} unit="项任务" note="今日新增较昨日" delta={createdDelta} tone="normal" icon={<IconClipboard />} delay={0} />
          <StatCard label="进行中" value={stats.doing} unit="项任务" note={total ? `占全部 ${Math.round((stats.doing * 100) / total)}%` : '暂无任务'} tone="normal" icon={<IconActivity />} delay={50} />
          <StatCard label="已完成" value={stats.done} unit="项任务" note={`完成率 ${total ? Math.round((stats.done * 100) / total) : 0}%`} tone="normal" icon={<IconCheckCircle />} delay={100} />
          <StatCard label="逾期任务" value={stats.overdue} unit="项任务" note="需要重新排期" tone="danger" icon={<IconAlertCircle />} delay={150} />
        </section>

        <section className="wb-kanban" aria-label="任务看板">
          <div className="wb-kanban__head">
            <h2 className="wb-kanban__title">任务看板</h2>
            <div className="wb-tabs">
              {([
                ['all', '全部任务'],
                ['mine', '我负责的'],
                ['joined', '我参与的'],
              ] as Array<[Tab, string]>).map(([key, label]) => (
                <button
                  key={key}
                  className={`wb-tabs__tab${tab === key ? ' wb-tabs__tab--active' : ''}`}
                  onClick={() => setTab(key)}
                >
                  {label}
                </button>
              ))}
            </div>

            <div className="wb-account wb-account--down">
              <button className="wb-toolbtn" onClick={() => setMenu(menu === 'status' ? null : 'status')}>
                状态
                <IconChevronDown />
              </button>
              {menu === 'status' && (
                <div className="wb-account__menu">
                  {([['', '全部状态'], ['todo', '待办'], ['doing', '进行中'], ['done', '已完成']] as Array<[string, string]>).map(([value, label]) => (
                    <button key={value || 'all'} className="wb-account__item" onClick={() => { setStatusFilter(value); setMenu(null) }}>
                      {label}
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div className="wb-head-tools">
              <div className="wb-account wb-account--down">
                <button className={`wb-toolbtn${priorityFilter ? ' wb-toolbtn--on' : ''}`} onClick={() => setMenu(menu === 'filter' ? null : 'filter')}>
                  <IconFilter />
                  筛选{priorityFilter ? ` · ${priorityFilter}` : ''}
                </button>
                {menu === 'filter' && (
                  <div className="wb-account__menu">
                    {(['', '高', '中', '低'] as string[]).map((value) => (
                      <button key={value || 'all'} className="wb-account__item" onClick={() => { setPriorityFilter(value); setMenu(null) }}>
                        {value ? `${value}优先级` : '全部优先级'}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              <div className="wb-account wb-account--down">
                <button className="wb-toolbtn" onClick={() => setMenu(menu === 'sort' ? null : 'sort')}>
                  <IconSort />
                  排序
                </button>
                {menu === 'sort' && (
                  <div className="wb-account__menu">
                    {([['deadline', '按截止时间'], ['priority', '按优先级'], ['name', '按名称']] as Array<[SortKey, string]>).map(([value, label]) => (
                      <button key={value} className="wb-account__item" onClick={() => { setSortKey(value); setMenu(null) }}>
                        {label}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              <button
                className={`wb-toolbtn wb-toolbtn--icon${listOnly ? ' wb-toolbtn--on' : ''}`}
                title={listOnly ? '显示项目概览' : '只看列表'}
                onClick={() => setListOnly((value) => !value)}
              >
                <IconList />
              </button>
            </div>
          </div>

          {filter.projectId && (
            <div className="wb-filter-bar" role="status">
              <span className="wb-filter-chip">
                项目：{projects.find((p) => String(p.id) === String(filter.projectId))?.name || '未知项目'}
                <button
                  type="button"
                  className="wb-filter-chip__clear"
                  title="清除项目筛选"
                  aria-label="清除项目筛选"
                  onClick={() => setFilter({ ...filter, projectId: '' })}
                >
                  <IconClose />
                </button>
              </span>
              <span className="wb-filter-bar__hint">仅显示该项目的任务，点 × 恢复全部</span>
            </div>
          )}

          <div className={`wb-kanban__body${listOnly ? ' wb-kanban__body--full' : ''}`}>
            <TaskGroups
              groups={groups}
              tasks={visible}
              selectedId={selectedId}
              onSelect={(id) => { setSelectedId(id); setCreating(false); setDetailOpen(true) }}
              creating={creating}
              onCreate={async (name) => {
                const target = groups[0]
                if (!target) return
                await run(() => window.sd.task.create({ name, groupId: target.id, status: 'todo', priority: '中' }))
                setCreating(false)
              }}
            />
            {!listOnly && (
              <ProjectFan
                projects={projects}
                activeId={filter.projectId}
                onPick={(projectId) => setFilter({ ...filter, projectId: String(projectId) })}
              />
            )}
          </div>
        </section>

        <ProjectGantt
          groups={groups}
          tasks={visible}
          selectedId={selectedId}
          onSelect={(id) => { setSelectedId(id); setDetailOpen(true) }}
        />
      </main>

      <SmartDetail
        task={selected}
        tasks={tasks}
        groups={groups}
        projects={projects}
        open={detailOpen}
        onClose={() => { setSelectedId(null); setDetailOpen(false) }}
        onPatch={(id, patch) => run(() => window.sd.task.update(id, patch))}
        onAssignProject={(taskId, projectId) =>
          run(() => (projectId ? window.sd.workbench.project.assign(projectId, taskId) : window.sd.workbench.project.unassign(taskId)))
        }
        onComplete={(id) => run(() => window.sd.task.complete(id))}
        onArchive={(id) => { setSelectedId(null); return run(() => window.sd.task.archive(id)) }}
        onRemove={(id) => { setSelectedId(null); return run(() => window.sd.task.remove(id)) }}
        onRefresh={() => model.refresh()}
      />

      <button className="wb-fab-menu" title="打开导航" onClick={onToggleSidebar}>
        <IconMenu />
      </button>
      {/* 详情抽屉打开时藏起这颗 FAB：它在 ≤1200px 会正好盖住页脚最右侧的「更多」按钮 */}
      {!detailOpen && (
        <button className="wb-fab-detail" title="打开智能详情" onClick={() => setDetailOpen(true)}>
          <IconSpark />
        </button>
      )}
    </>
  )
}
