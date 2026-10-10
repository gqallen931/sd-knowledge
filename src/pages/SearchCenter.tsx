import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'

/** 命中方式：优先看结果自带的 search_mode，缺省时回落本次调用的检索路径 */
function matchModeLabel(mode?: string | null): string {
  if (mode === 'hybrid') return '混合匹配'
  if (mode === 'semantic') return '语义匹配'
  if (mode === 'fulltext') return '全文匹配'
  return ''
}

type SearchMode = 'fulltext' | 'semantic' | 'hybrid'

/** 三种检索模式：混合（RRF）与保存检索的结果指纹同一口径 */
const MODES: Array<{ key: SearchMode; label: string; placeholder: string }> = [
  { key: 'fulltext', label: '全文搜索', placeholder: '输入关键词搜索文档内容...' },
  { key: 'semantic', label: '语义搜索', placeholder: '输入自然语言描述，语义匹配相关文档...' },
  { key: 'hybrid', label: '混合检索', placeholder: '关键词 + 语义混合召回，RRF 融合排序...' },
]

/** 库里的 CURRENT_TIMESTAMP 是 UTC 无时区标记，补 Z 再转本地时间显示 */
function fmtRunAt(value?: string | null): string {
  if (!value) return '尚未运行'
  const normalized = value.includes('T') ? value : value.replace(' ', 'T')
  const date = new Date(normalized.endsWith('Z') ? normalized : `${normalized}Z`)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { hour12: false })
}

/**
 * 位置锚点翻成人话：page→第 N 页 / slide→第 N 张幻灯片 / chapter→第 N 章 /
 * sheet→第 N 个工作表 / time→mm:ss；给不出锚点时不显示（不编造「第 1 页」）。
 */
function anchorLabel(anchor?: any): string {
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

/** 匹配片段优先级：命中块正文 → 摘录 → 摘要 */
function hitSnippet(row: any): string {
  const raw = row?.matched_chunk?.content ?? row?.excerpt ?? row?.summary ?? ''
  return String(raw).replace(/\s+/g, ' ').trim()
}

/** 截断原因翻成人话（架构文档 §5.3.5 截断四态） */
function truncationNotice(reason?: string): string {
  if (reason === 'candidate_window') return '候选集已截断，可缩小范围再搜'
  if (reason === 'scope_filter') return '受范围限制，结果可能不全'
  if (reason === 'token_budget') return '受长度限制已截断'
  if (reason === 'limit') return '结果较多，仅显示前若干条'
  return '结果可能不完整，建议收窄检索条件'
}

export default function SearchCenter() {
  const navigate = useNavigate()
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<any[]>([])
  const [meta, setMeta] = useState<{ total: number; truncated: boolean; reason?: string; approx: boolean } | null>(null)
  const [searchMode, setSearchMode] = useState<SearchMode>('fulltext')
  const [resultMode, setResultMode] = useState<SearchMode>('fulltext')
  const [searching, setSearching] = useState(false)
  const [hasSearched, setHasSearched] = useState(false)
  // 保存的检索（S2-07）
  const [savedList, setSavedList] = useState<any[]>([])
  const [savedOpen, setSavedOpen] = useState(false)
  const [savedError, setSavedError] = useState('')
  const [saveName, setSaveName] = useState('')
  const [saveBusy, setSaveBusy] = useState(false)
  const [saveMsg, setSaveMsg] = useState('')

  const loadSaved = async () => {
    setSavedError('')
    try { setSavedList(await window.sd.search.savedList()) }
    catch (e: any) { setSavedError(e?.message || '保存的检索列表加载失败') }
  }

  useEffect(() => { void loadSaved() }, [])

  const performSearch = async (q: string, mode: SearchMode) => {
    if (!q.trim()) return
    setError('')
    setSearching(true)
    setHasSearched(true)
    try {
      const call = mode === 'semantic'
        ? window.sd.search.semantic
        : mode === 'hybrid'
          ? window.sd.search.hybrid
          : window.sd.search.fulltext
      const result = await call(q, { limit: 20 })
      const items = Array.isArray(result) ? result : (result?.items ?? [])
      setResults(items)
      setResultMode(mode)
      setMeta(Array.isArray(result)
        ? { total: items.length, truncated: false, approx: false }
        : {
          total: result?.total ?? items.length,
          truncated: Boolean(result?.truncated),
          reason: result?.truncated_reason,
          approx: Boolean(result?.total_is_approx),
        })
    } catch (e: any) {
      setError(e.message)
      console.error('Search error:', e)
      setResults([])
      setMeta(null)
    } finally {
      setSearching(false)
    }
  }

  const handleSearch = () => void performSearch(query, searchMode)

  /** 把当前检索保存下来：名称必填由按钮禁用态拦，后端还有一道兜底 */
  const saveCurrent = async () => {
    const name = saveName.trim()
    if (!name || !query.trim() || saveBusy) return
    setSaveBusy(true)
    setSaveMsg('')
    setSavedError('')
    try {
      await window.sd.search.savedCreate({ name, query: query.trim(), notify_on_change: true })
      setSaveName('')
      setSaveMsg(`已保存为「${name}」，结果集变化时会提醒你`)
      await loadSaved()
    } catch (e: any) {
      setSaveMsg('')
      setSavedError(e?.message || '保存失败，请重试')
    } finally {
      setSaveBusy(false)
    }
  }

  /** 运行保存的检索：按混合口径展示结果，同时重跑一次刷新指纹 */
  const runSaved = async (row: any) => {
    if (searching) return
    setQuery(String(row.query || ''))
    setSearchMode('hybrid')
    setSaveMsg('')
    await performSearch(String(row.query || ''), 'hybrid')
    try {
      const fresh = await window.sd.search.savedRerun(row.id)
      if (fresh) setSavedList((prev) => prev.map((x) => (x.id === row.id ? fresh : x)))
    } catch { /* 指纹刷新失败不影响结果展示 */ }
  }

  const removeSaved = async (row: any) => {
    if (!window.confirm(`删除保存的检索「${row.name}」？删除后将不再跟踪其结果变化。`)) return
    try {
      await window.sd.search.savedRemove(row.id)
      setSavedList((prev) => prev.filter((x) => x.id !== row.id))
      setSaveMsg('')
    } catch (e: any) {
      setSavedError(e?.message || '删除失败，请重试')
    }
  }

  const getFileIcon = (type: string) => {
    const map: Record<string, { bg: string; color: string; label: string }> = {
      pdf: { bg: 'var(--danger-light)', color: 'var(--danger)', label: 'PDF' },
      docx: { bg: 'var(--info-light)', color: 'var(--info)', label: 'DOC' },
      xlsx: { bg: 'var(--success-light)', color: 'var(--success)', label: 'XLS' },
      md: { bg: 'var(--accent-light)', color: 'var(--accent)', label: 'MD' },
    }
    return map[type] || { bg: 'rgba(100,116,139,0.1)', color: 'var(--text-secondary)', label: type.substring(0, 3).toUpperCase() }
  }

  const formatSize = (bytes: number) => {
    if (!bytes) return '-'
    if (bytes < 1024) return `${bytes}B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
    return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
  }

  return (
    <div className="h-full overflow-y-auto p-8" style={{ maxWidth: '900px', margin: '0 auto', width: '100%' }}>
      {/* Search Header */}
      <div className="mb-6">
        <h2 className="text-xl font-bold mb-4" style={{ color: 'var(--text)' }}>搜索中心</h2>

        {/* Mode Toggle */}
        <div className="inline-flex rounded-lg p-1 mb-4" style={{ background: 'var(--card-bg)', border: '1px solid var(--card-border)' }}>
          {MODES.map((mode) => (
            <button
              key={mode.key}
              onClick={() => setSearchMode(mode.key)}
              className="px-4 py-1.5 rounded-md text-sm transition-all"
              style={{
                background: searchMode === mode.key ? 'var(--primary)' : 'transparent',
                color: searchMode === mode.key ? 'white' : 'var(--text-secondary)',
              }}>
              {mode.label}
            </button>
          ))}
        </div>

        {/* Search Bar */}
        <div className="flex gap-2">
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
            placeholder={MODES.find((m) => m.key === searchMode)?.placeholder}
            className="flex-1 rounded-lg px-4 py-3 text-sm outline-none"
            style={{ background: 'var(--card-bg)', border: '1px solid var(--card-border)', color: 'var(--text)' }}
            onFocus={(e) => e.target.style.borderColor = 'var(--primary)'}
            onBlur={(e) => e.target.style.borderColor = 'var(--card-border)'}
          />
          <button
            onClick={handleSearch}
            disabled={searching || !query.trim()}
            className="px-6 py-3 rounded-lg text-sm text-white transition-all"
            style={{ background: 'var(--primary)', opacity: searching || !query.trim() ? 0.6 : 1, cursor: searching || !query.trim() ? 'not-allowed' : 'pointer' }}>
            {searching ? '搜索中...' : '搜索'}
          </button>
        </div>

        {/* 保存的检索（S2-07）：保存当前检索 + 列表 + 变更提醒 */}
        <div className="rounded-xl p-4 mt-4" style={{ background: 'var(--card-bg)', border: '1px solid var(--card-border)' }}>
          <div className="flex items-center justify-between mb-2">
            <div style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text)' }}>保存的检索</div>
            <button
              onClick={() => setSavedOpen((o) => !o)}
              className="text-xs px-3 py-1 rounded-md"
              style={{ background: 'var(--bg)', border: '1px solid var(--card-border)', color: 'var(--text-secondary)', cursor: 'pointer' }}>
              {savedOpen ? '收起' : `展开（${savedList.length}）`}
            </button>
          </div>

          {savedOpen && (
            <>
              {hasSearched && query.trim() ? (
                <div className="flex gap-2 mb-2">
                  <input
                    value={saveName}
                    onChange={(e) => { setSaveName(e.target.value); setSaveMsg('') }}
                    onKeyDown={(e) => e.key === 'Enter' && saveCurrent()}
                    maxLength={50}
                    placeholder="给这条检索起个名字，方便下次直接运行..."
                    className="flex-1 rounded-md px-3 py-2 text-xs outline-none"
                    style={{ background: 'var(--bg)', border: '1px solid var(--card-border)', color: 'var(--text)' }}
                  />
                  <button
                    onClick={saveCurrent}
                    disabled={saveBusy || !saveName.trim()}
                    className="px-4 py-2 rounded-md text-xs text-white"
                    style={{ background: 'var(--primary)', opacity: saveBusy || !saveName.trim() ? 0.6 : 1, cursor: saveBusy || !saveName.trim() ? 'not-allowed' : 'pointer' }}>
                    {saveBusy ? '保存中...' : '保存当前检索'}
                  </button>
                </div>
              ) : (
                <div className="text-xs mb-2" style={{ color: 'var(--text-note)' }}>
                  执行一次检索后可保存下来；库里文档变化导致结果集变化时会收到提醒。
                </div>
              )}

              {saveMsg && <div className="text-xs mb-2" style={{ color: 'var(--primary)' }}>{saveMsg}</div>}
              {savedError && <div className="text-xs mb-2" style={{ color: 'var(--danger)' }} role="alert">{savedError}</div>}

              {savedList.length === 0 ? (
                <div className="text-xs" style={{ color: 'var(--text-note)' }}>还没有保存的检索。</div>
              ) : (
                savedList.map((row) => (
                  <div key={row.id} className="flex items-center gap-3 py-2" style={{ borderTop: '1px solid var(--card-border)' }}>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm truncate" style={{ color: 'var(--text)' }}>
                        {row.name}
                        {row.notify_on_change ? (
                          <span className="ml-2 text-xs" style={{ fontSize: '10px', color: 'var(--primary)' }} title="结果集变化时会收到提醒">变更提醒</span>
                        ) : null}
                      </div>
                      <div className="text-xs truncate" style={{ color: 'var(--text-note)' }} title={row.query}>
                        {row.query} · 约 {row.last_result_count ?? '—'} 条 · {fmtRunAt(row.last_run_at)}
                      </div>
                    </div>
                    <button
                      onClick={() => void runSaved(row)}
                      disabled={searching}
                      className="text-xs px-3 py-1 rounded-md"
                      style={{ background: 'var(--bg)', border: '1px solid var(--card-border)', color: 'var(--primary)', cursor: searching ? 'not-allowed' : 'pointer', opacity: searching ? 0.5 : 1 }}>
                      运行
                    </button>
                    <button
                      onClick={() => void removeSaved(row)}
                      disabled={searching}
                      className="text-xs px-3 py-1 rounded-md"
                      style={{ background: 'var(--bg)', border: '1px solid var(--card-border)', color: 'var(--text-secondary)', cursor: searching ? 'not-allowed' : 'pointer' }}>
                      删除
                    </button>
                  </div>
                ))
              )}
            </>
          )}
        </div>
      </div>

      {error && <div className="error-banner" role="alert">{error}</div>}
      {/* Results */}
      {hasSearched && (
        <div>
          <div className="text-sm mb-4" style={{ color: 'var(--text-note)' }}>
            {searching ? '搜索中...' : `找到 ${meta?.approx ? '约 ' : ''}${meta?.total ?? results.length} 条结果`}
          </div>

          {!searching && meta?.truncated && (
            <div className="search-notice" role="status">{truncationNotice(meta.reason)}</div>
          )}

          {results.length === 0 && !searching ? (
            <div className="text-center py-16">
              <div className="text-sm" style={{ color: 'var(--text-note)' }}>未找到匹配结果</div>
            </div>
          ) : (
            <div className="space-y-3">
              {results.map((result, i) => {
                const icon = getFileIcon(result.file_type)
                const mode = matchModeLabel(result.search_mode ?? resultMode)
                const position = anchorLabel(result.anchor)
                const snippet = hitSnippet(result)
                return (
                  <div key={i} onClick={() => navigate(`/files?id=${result.id}`, {
                    // 复用文件页的「引用定位」块：把位置与片段原文随 state 带过去
                    state: { citation: { document_id: result.document_id ?? result.id, chunk_id: result.chunk_id ?? null, file_name: result.file_name || result.title, quote: snippet, positionLabel: position, anchor_kind: result.anchor?.anchor_kind ?? null } },
                  })}
                    className="rounded-xl p-4 border cursor-pointer transition-all"
                    style={{ background: 'var(--card-bg)', borderColor: 'var(--card-border)' }}
                    onMouseEnter={(e) => { e.currentTarget.style.borderColor = 'var(--primary)' }}
                    onMouseLeave={(e) => { e.currentTarget.style.borderColor = 'var(--card-border)' }}>
                    <div className="flex items-center gap-3 mb-2">
                      <div className="flex items-center justify-center rounded-md font-bold text-xs"
                        style={{ width: '32px', height: '32px', background: icon.bg, color: icon.color }}>
                        {icon.label}
                      </div>
                      <div className="flex-1">
                        <div className="text-sm font-medium" style={{ color: 'var(--text)' }}>
                          {result.title || result.file_name}
                        </div>
                        <div className="flex items-center gap-2 text-xs" style={{ color: 'var(--text-note)' }}>
                          <span>{formatSize(result.file_size)} / {result.storage_type === 'local' ? '本地' : '引用'}</span>
                          {mode && <span className="search-chip">{mode}</span>}
                          {position && <span className="search-chip">{position}</span>}
                        </div>
                      </div>
                    </div>
                    {snippet && (
                      <div className="text-xs pl-11 search-snippet">{snippet}</div>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}

      {!hasSearched && (
        <div className="text-center py-16">
          <div className="text-sm mb-2" style={{ color: 'var(--text-note)' }}>
            开始搜索您的知识库
          </div>
          <div className="text-xs" style={{ color: 'var(--text-note)' }}>
            支持全文搜索和语义搜索两种模式
          </div>
        </div>
      )}
    </div>
  )
}
