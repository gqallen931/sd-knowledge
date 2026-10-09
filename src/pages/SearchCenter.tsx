import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'

/** 命中方式：优先看结果自带的 search_mode，缺省时回落本次调用的检索路径 */
function matchModeLabel(mode?: string | null): string {
  if (mode === 'hybrid') return '混合匹配'
  if (mode === 'semantic') return '语义匹配'
  if (mode === 'fulltext') return '全文匹配'
  return ''
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
  const [searchMode, setSearchMode] = useState<'fulltext' | 'semantic'>('fulltext')
  const [resultMode, setResultMode] = useState<'fulltext' | 'semantic'>('fulltext')
  const [searching, setSearching] = useState(false)
  const [hasSearched, setHasSearched] = useState(false)

  const handleSearch = async () => {
    if (!query.trim()) return
    setError('')
    setSearching(true)
    setHasSearched(true)
    try {
      const result = searchMode === 'semantic'
        ? await window.sd.search.semantic(query, { limit: 20 })
        : await window.sd.search.fulltext(query, { limit: 20 })
      const items = Array.isArray(result) ? result : (result?.items ?? [])
      setResults(items)
      setResultMode(searchMode)
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
          <button
            onClick={() => setSearchMode('fulltext')}
            className="px-4 py-1.5 rounded-md text-sm transition-all"
            style={{
              background: searchMode === 'fulltext' ? 'var(--primary)' : 'transparent',
              color: searchMode === 'fulltext' ? 'white' : 'var(--text-secondary)'
            }}>
            全文搜索
          </button>
          <button
            onClick={() => setSearchMode('semantic')}
            className="px-4 py-1.5 rounded-md text-sm transition-all"
            style={{
              background: searchMode === 'semantic' ? 'var(--primary)' : 'transparent',
              color: searchMode === 'semantic' ? 'white' : 'var(--text-secondary)'
            }}>
            语义搜索
          </button>
        </div>

        {/* Search Bar */}
        <div className="flex gap-2">
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
            placeholder={searchMode === 'fulltext' ? '输入关键词搜索文档内容...' : '输入自然语言描述，语义匹配相关文档...'}
            className="flex-1 rounded-lg px-4 py-3 text-sm outline-none"
            style={{ background: 'var(--card-bg)', border: '1px solid var(--card-border)', color: 'var(--text)' }}
            onFocus={(e) => e.target.style.borderColor = 'var(--primary)'}
            onBlur={(e) => e.target.style.borderColor = 'var(--card-border)'}
          />
          <button
            onClick={handleSearch}
            disabled={searching}
            className="px-6 py-3 rounded-lg text-sm text-white transition-all"
            style={{ background: 'var(--primary)', opacity: searching ? 0.6 : 1 }}>
            {searching ? '搜索中...' : '搜索'}
          </button>
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
