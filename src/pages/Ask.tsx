import { useEffect, useMemo, useRef, useState, type MutableRefObject, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { askStream, type AskStreamPayload } from '../api'

/**
 * 问答页（S1-05）——S1 问答闭环的主线页面。
 *
 * 一条链路：**提问 → 混合检索 → 上下文组装 → 模型流式 → 答案 + 可验证引用 → 点回原文位置**。
 *
 * 三条硬约束（ADR-004 / D2 / D5）：
 *   1. **真流式**：增量由 `askStream`（Web SSE / 桌面 IPC）逐块推来，按到达顺序追加，**不伪造打字机动画**；
 *   2. **降级不等于报错**：未配置模型时本页是一个完整的检索页（展示本地检索结果 + 配置引导），
 *      **不显示假输入框、不显示假流式**；
 *   3. **引用如实**：答案里的 `[i]` 与引用面板一一对应；未核实 / 越界编号 / 截断 / 出域被拒全部如实标注。
 */

/** 一次问答（本页内保留当前会话的列表；不落库——长期历史属 S2） */
interface AskEntry {
  id: number
  query: string
  /** 流式累积的答案文本 */
  answer: string
  /** 完成后的完整结果（引用 / 降级 / 被拒信息都在这里） */
  result: any | null
  streaming: boolean
  /** 用户点了「停止」 */
  stopped: boolean
  error: string
  /** 出域范围档位（用于文案） */
  scope: ScopeMode
}

type ScopeMode = 'document' | 'scope' | 'library'

const SCOPE_LABELS: Record<ScopeMode, string> = {
  document: '当前文档',
  scope: '当前作用域',
  library: '整库',
}

const EGRESS_BY_SCOPE: Record<ScopeMode, AskStreamPayload['egress_scope']> = {
  document: 'current_document',
  scope: 'selected_scope',
  library: 'whole_library',
}

/**
 * 位置锚点翻成人话：page→第 N 页 / slide→第 N 张幻灯片 / chapter→第 N 章 /
 * sheet→第 N 个工作表 / time→mm:ss。**给不出锚点时返回空串**（只显示文件名 + 片段，绝不编造位置）。
 */
function anchorLabel(anchor: any): string {
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

/** 截断原因四态（与搜索中心同一套口径） */
function truncationNotice(reason?: string | null): string {
  if (reason === 'candidate_window') return '候选集已截断，可缩小范围再问'
  if (reason === 'scope_filter') return '受范围限制，本次可能没有覆盖全部资料'
  if (reason === 'token_budget') return '上下文超出长度预算，部分片段未送入模型'
  if (reason === 'limit') return '命中较多，仅选取了靠前的若干片段'
  return '结果可能不完整，建议收窄范围'
}

/** 载入范围内的候选（文件 / 知识空间 / 项目），失败不阻塞页面 */
function useScopedOptions() {
  const [documents, setDocuments] = useState<any[]>([])
  const [sources, setSources] = useState<any[]>([])
  const [projects, setProjects] = useState<any[]>([])
  useEffect(() => {
    window.sd.file.list({ limit: 200 }).then((rows: any[]) => setDocuments(Array.isArray(rows) ? rows : [])).catch(() => {})
    window.sd.folder.list().then((rows: any) => setSources(Array.isArray(rows) ? rows : [])).catch(() => {})
    window.sd.project.list().then((rows: any) => setProjects(Array.isArray(rows) ? rows : [])).catch(() => {})
  }, [])
  return { documents, sources, projects }
}

export default function Ask() {
  const navigate = useNavigate()
  const { documents, sources, projects } = useScopedOptions()

  const [query, setQuery] = useState('')
  const [scopeMode, setScopeMode] = useState<ScopeMode>('library')
  const [documentId, setDocumentId] = useState<string>('')
  const [sourceId, setSourceId] = useState<string>('')
  const [projectId, setProjectId] = useState<string>('')
  const [entries, setEntries] = useState<AskEntry[]>([])
  const [busy, setBusy] = useState(false)
  /** 模型可用性：未配置时本页整体呈现为检索页 */
  const [gateway, setGateway] = useState<{ configured: boolean; label: string; reason: string } | null>(null)
  /** 高亮的引用卡：{entryId, index} —— 点答案里的 [i] 时联动 */
  const [activeCite, setActiveCite] = useState<{ entryId: number; index: number } | null>(null)

  const controller = useRef<AbortController | null>(null)
  const entrySeq = useRef(0)
  const cardRefs = useRef(new Map<string, HTMLDivElement>())
  const bottomRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    window.sd.gateway.status().then(setGateway).catch(() => setGateway(null))
    // 离开页面：取消在途请求（避免后台继续生成）
    return () => { controller.current?.abort() }
  }, [])

  const configured = gateway?.configured ?? null
  const scopeReady = scopeMode === 'document' ? Boolean(documentId)
    : scopeMode === 'scope' ? Boolean(sourceId || projectId)
    : true
  const canSubmit = Boolean(query.trim()) && scopeReady && !busy

  const submit = async () => {
    const text = query.trim()
    if (!text || !scopeReady) return
    // 再次提问：前一个请求先取消
    controller.current?.abort()
    const abort = new AbortController()
    controller.current = abort

    const entry: AskEntry = {
      id: ++entrySeq.current, query: text, answer: '', result: null,
      streaming: configured !== false, // 未配置模型时不会走流式
      stopped: false, error: '', scope: scopeMode,
    }
    setEntries(prev => [...prev, entry])
    setBusy(true)
    setQuery('')

    const payload: AskStreamPayload = { query: text }
    if (scopeMode === 'document') payload.document_id = Number(documentId)
    else if (scopeMode === 'scope') payload.scope = {
      source_id: sourceId ? Number(sourceId) : null,
      project_id: projectId ? Number(projectId) : null,
    }
    payload.egress_scope = EGRESS_BY_SCOPE[scopeMode]

    const patch = (updater: (e: AskEntry) => AskEntry) =>
      setEntries(prev => prev.map(e => (e.id === entry.id ? updater(e) : e)))

    try {
      const result = await askStream(payload, {
        signal: abort.signal,
        onChunk: chunk => patch(e => ({ ...e, answer: e.answer + chunk })),
      })
      if (!result) { patch(e => ({ ...e, streaming: false, error: '请求已中断' })); return }
      patch(e => ({ ...e, streaming: false, result, answer: result.answer ?? e.answer }))
      // 未配置模型：刷新一次可用性（用户可能刚在设置里配好）
      if (result.mode === 'retrieval_only') window.sd.gateway.status().then(setGateway).catch(() => {})
    } catch (e: any) {
      if (e?.name === 'AbortError') patch(cur => ({ ...cur, streaming: false, stopped: true }))
      else patch(cur => ({ ...cur, streaming: false, error: e?.message || String(e) }))
    } finally {
      setBusy(false)
      setTimeout(() => bottomRef.current?.scrollIntoView({ block: 'end', behavior: 'smooth' }), 0)
    }
  }

  const stop = () => { controller.current?.abort(); setBusy(false) }

  /** 点答案里的 [i]：高亮并滚动到对应引用卡 */
  const focusCite = (entryId: number, index: number) => {
    setActiveCite({ entryId, index })
    const node = cardRefs.current.get(`${entryId}:${index}`)
    node?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }

  /** 点引用卡 → 跳到文件页并定位（位置信息随 state 带过去，避免重复查询） */
  const openCitation = (cite: any) => {
    const position = anchorLabel(cite.anchor)
    navigate(`/files?id=${cite.document_id}`, {
      state: {
        citation: {
          document_id: cite.document_id,
          chunk_id: cite.chunk_id,
          file_name: cite.file_name || cite.title,
          quote: cite.quote,
          positionLabel: position,
          anchor_kind: cite.anchor?.anchor_kind ?? null,
        },
      },
    })
  }

  const openRetrievalHit = (hit: any) => {
    navigate(`/files?id=${hit.document_id ?? hit.id}`, {
      state: {
        citation: {
          document_id: hit.document_id ?? hit.id,
          chunk_id: hit.chunk_id ?? null,
          file_name: hit.file_name || hit.title,
          quote: hit.matched_chunk?.content ?? hit.excerpt ?? '',
          positionLabel: anchorLabel(hit.anchor),
          anchor_kind: hit.anchor?.anchor_kind ?? null,
        },
      },
    })
  }

  const empty = entries.length === 0

  return (
    <div className="ask-workspace page-scroll">
      <div className="page-heading">
        <div>
          <div className="eyebrow">ASK YOUR KNOWLEDGE</div>
          <h1>问答<span className="heading-dot">.</span></h1>
          <p>问一句话，得到有出处的答案，点引用回到原文位置。</p>
        </div>
        <div className="heading-actions">
          <span className={`ask-model-chip${configured ? '' : ' ask-model-chip--off'}`} title={gateway?.reason || ''}>
            模型：{configured ? (gateway?.label || '已配置') : '未配置'}
          </span>
        </div>
      </div>

      {/* 未配置模型：常驻提示 + 配置引导入口（不是报错） */}
      {configured === false && (
        <div className="ask-degrade-banner" role="status">
          <strong>当前未配置模型。</strong>
          下面是本机的检索结果（带出处），不会出域。配置一个模型端点即可获得带引用的答案。
          <button className="text-button" onClick={() => navigate('/settings?tab=ai')}>如何配置模型 ›</button>
        </div>
      )}

      {/* 提问区（吸顶） */}
      <section className="ask-compose panel">
        <div className="ask-compose__row">
          <textarea
            className="ask-input"
            value={query}
            rows={2}
            placeholder={configured === false ? '输入关键词，做本地检索…' : '问一句话，比如「竞品分析里我记过哪些定价说法？」'}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void submit() }
              if (e.key === 'Escape') setQuery('')
            }}
          />
          <button className="button primary ask-submit" disabled={!canSubmit} onClick={() => void submit()}>
            {busy ? '停止' : configured === false ? '检索' : '提问'}
          </button>
        </div>
        {busy && <button className="text-button" onClick={stop}>■ 停止生成</button>}

        <div className="ask-scope">
          <span className="ask-scope__label">范围</span>
          <div className="segmented">
            {(['document', 'scope', 'library'] as ScopeMode[]).map(mode => (
              <button key={mode} className={scopeMode === mode ? 'active' : ''} onClick={() => setScopeMode(mode)}>
                {SCOPE_LABELS[mode]}
              </button>
            ))}
          </div>
          {scopeMode === 'document' && (
            <select aria-label="选择文件" value={documentId} onChange={e => setDocumentId(e.target.value)}>
              <option value="">选择一份文件…</option>
              {documents.map(d => <option key={d.id} value={d.id}>{d.title || d.file_name}</option>)}
            </select>
          )}
          {scopeMode === 'scope' && (
            <>
              <select aria-label="知识空间" value={sourceId} onChange={e => setSourceId(e.target.value)}>
                <option value="">知识空间：不限</option>
                {sources.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
              <select aria-label="项目" value={projectId} onChange={e => setProjectId(e.target.value)}>
                <option value="">项目：不限</option>
                {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </>
          )}
        </div>
        {scopeMode === 'library' && (
          <p className="ask-scope__risk" role="note">⚠ 整库范围：若已配置远端模型，本次检索到的片段可能被送出本机；本地端点不受影响。</p>
        )}
        {scopeMode === 'scope' && !scopeReady && (
          <p className="ask-scope__risk" role="note">请先选择一个知识空间或项目，再提问。</p>
        )}
      </section>

      {empty && (
        <div className="empty-state">
          <span className="empty-symbol">✧</span>
          <p>还没有提问。输入一句话开始，答案会标明出处，点引用能回到原文位置。</p>
        </div>
      )}

      {/* 会话列表（当前页内，不落库） */}
      {entries.map(entry => (
        <AskEntryView
          key={entry.id}
          entry={entry}
          activeCite={activeCite}
          cardRefs={cardRefs}
          onCite={focusCite}
          onOpenCitation={openCitation}
          onOpenRetrievalHit={openRetrievalHit}
          onRetry={() => { setQuery(entry.query); void submit() }}
          onOpenSettings={() => navigate('/settings?tab=ai')}
        />
      ))}
      <div ref={bottomRef} />
    </div>
  )
}

/** 单条问答：问题 + 答案（按 mode 分支）+ 引用面板 + 检索兜底 */
function AskEntryView({ entry, activeCite, cardRefs, onCite, onOpenCitation, onOpenRetrievalHit, onRetry, onOpenSettings }: {
  entry: AskEntry
  activeCite: { entryId: number; index: number } | null
  cardRefs: MutableRefObject<Map<string, HTMLDivElement>>
  onCite: (entryId: number, index: number) => void
  onOpenCitation: (cite: any) => void
  onOpenRetrievalHit: (hit: any) => void
  onRetry: () => void
  onOpenSettings: () => void
}) {
  const result = entry.result
  const mode: string = result?.mode ?? (entry.streaming ? 'streaming' : entry.error ? 'error' : '')
  const citations: any[] = Array.isArray(result?.citations) ? result.citations : []
  const contextBlocks: any[] = Array.isArray(result?.context_blocks) ? result.context_blocks : []
  const retrievalItems: any[] = Array.isArray(result?.retrieval?.items) ? result.retrieval.items : []
  const validIndexes = useMemo(() => new Set<number>(Object.keys(result?.citation_map || {}).map(Number)), [result])
  const truncReason = result?.context_meta?.truncated_reason

  return (
    <div className="ask-entry panel">
      <div className="ask-question">
        <span className="ask-question__scope">{SCOPE_LABELS[(entry.scope as ScopeMode)] || ''}</span>
        {entry.query}
      </div>

      {/* 答案区：流式或完整文本；[i] 可点击联动引用面板 */}
      {(mode === 'streaming' || mode === 'answer' || (entry.stopped && entry.answer)) && (
        <div className="ask-answer" aria-live="polite" aria-busy={entry.streaming}>
          <div className="ask-answer__head">
            <span className="ask-answer__title">答案</span>
            {entry.streaming && <span className="ask-answer__hint">生成中…</span>}
            {entry.stopped && <span className="ask-answer__hint">（已停止）</span>}
            {mode === 'answer' && citations.length > 0 && <span className="ask-answer__hint">{citations.length} 处出处</span>}
          </div>
          <p className="ask-answer__text">
            {renderAnswer(entry.answer, entry.id, validIndexes, onCite)}
            {entry.streaming && <span className="ask-caret" aria-hidden="true" />}
          </p>

          {/* 如实标注：未核实 / 越界编号 / 截断 */}
          {result?.citations_unverified && (
            <div className="ask-note ask-note--warn" role="status">
              {result.message && result.message.includes('编号')
                ? '本答案存在无法核实的引用，请以引用面板与原文为准。'
                : '本答案未能核实引用（没有标注来源编号），请以引用面板的片段为准，不要当作已有依据。'}
              {Array.isArray(result.invalid_indexes) && result.invalid_indexes.length > 0 && (
                <>　模型引用了不存在的编号 [{result.invalid_indexes.join('][')}]。</>
              )}
            </div>
          )}
          {truncReason && <div className="ask-note" role="status">{truncationNotice(truncReason)}</div>}
        </div>
      )}

      {/* 引用面板：只列**实际被引用**的块 */}
      {citations.length > 0 && (
        <div className="ask-citations">
          <div className="ask-citations__head">
            出处 · {citations.length} 处
            <span className="ask-citations__meta">提供 {contextBlocks.length} 个片段，引用 {citations.length} 个</span>
          </div>
          {citations.map(cite => {
            const position = anchorLabel(cite.anchor)
            const active = activeCite?.entryId === entry.id && activeCite?.index === cite.index
            return (
              <div
                key={cite.index}
                className={`ask-cite${active ? ' ask-cite--active' : ''}`}
                ref={node => { if (node) cardRefs.current.set(`${entry.id}:${cite.index}`, node) }}
              >
                <div className="ask-cite__head">
                  <button className="ask-cite__index" onClick={() => onCite(entry.id, cite.index)}>[{cite.index}]</button>
                  <span className="ask-cite__file" title={cite.file_name || cite.title}>{cite.file_name || cite.title}</span>
                  {position
                    ? <span className="search-chip">{position}</span>
                    : <span className="search-chip" title="该片段没有可定位的位置锚点">全文</span>}
                  <button className="text-button ask-cite__jump" onClick={() => onOpenCitation(cite)}>跳转原文 ›</button>
                </div>
                <div className="ask-cite__quote search-snippet">{String(cite.quote || '').replace(/\s+/g, ' ').trim()}</div>
                {cite.anchor?.anchor_kind === 'time' && (
                  <div className="ask-cite__note">音视频无内嵌播放器，按时间戳做文本定位。</div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {/* 降级：未配置模型 → 直接展示本地检索结果（不是假问答） */}
      {mode === 'retrieval_only' && (
        <div className="ask-degrade">
          <div className="ask-note" role="status">{result.message}</div>
          <div className="ask-degrade__head">本机检索结果 · {retrievalItems.length} 条</div>
          {retrievalItems.length === 0
            ? <div className="ask-note">这个范围下没有检索到相关内容。</div>
            : retrievalItems.map((hit, i) => (
              <button key={`${hit.id}-${i}`} className="ask-hit" onClick={() => onOpenRetrievalHit(hit)}>
                <div className="ask-hit__head">
                  <span className="ask-hit__file">{hit.title || hit.file_name}</span>
                  {anchorLabel(hit.anchor) && <span className="search-chip">{anchorLabel(hit.anchor)}</span>}
                </div>
                <div className="search-snippet">{String(hit.matched_chunk?.content ?? hit.excerpt ?? '').replace(/\s+/g, ' ').trim()}</div>
              </button>
            ))}
          <button className="button secondary" onClick={onOpenSettings}>配置模型 ›</button>
        </div>
      )}

      {/* 出域被拒：原样展示可读原因 + 跳到设置·数据出域 */}
      {mode === 'refused' && (
        <div className="ask-note ask-note--danger" role="alert">
          <strong>本次提问未发送到模型。</strong>{result.message}
          <button className="text-button" onClick={onOpenSettings}>打开「设置 → AI 引擎 → 数据出域」›</button>
        </div>
      )}

      {/* 生成失败：错误卡（不自动消失）+ 重试 + 纯检索兜底；服务端带原因时如实展示 */}
      {mode === 'error' && (entry.error || result?.message) && (
        <div className="ask-note ask-note--danger" role="alert">
          <strong>生成失败。</strong>{entry.error || result?.message}
          <button className="text-button" onClick={onRetry}>重试</button>
        </div>
      )}

      {/* 被拒 / 失败时仍有纯检索结果：如实给出，不停在半空 */}
      {(mode === 'refused' || mode === 'error') && retrievalItems.length > 0 && (
        <div className="ask-degrade">
          <div className="ask-degrade__head">本机检索结果 · {retrievalItems.length} 条</div>
          {retrievalItems.map((hit, i) => (
            <button key={`${hit.id}-${i}`} className="ask-hit" onClick={() => onOpenRetrievalHit(hit)}>
              <div className="ask-hit__head">
                <span className="ask-hit__file">{hit.title || hit.file_name}</span>
                {anchorLabel(hit.anchor) && <span className="search-chip">{anchorLabel(hit.anchor)}</span>}
              </div>
              <div className="search-snippet">{String(hit.matched_chunk?.content ?? hit.excerpt ?? '').replace(/\s+/g, ' ').trim()}</div>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/**
 * 把答案文本里的 `[i]` 渲染成可点 chip；引用范围内（`validIndexes`）的可点并联动引用面板，
 * 越界编号（模型编的）用 `--invalid` 样式标出且禁点——不假装它是有效引用。
 * 流式过程中结果未到，`validIndexes` 为空，此时所有编号都可点（结果到达后再判定）。
 */
function renderAnswer(text: string, entryId: number, validIndexes: Set<number>, onCite: (entryId: number, index: number) => void) {
  const nodes: ReactNode[] = []
  const re = /\[(\d{1,3})\]/g
  let last = 0
  let match: RegExpExecArray | null
  const resolved = validIndexes.size > 0
  while ((match = re.exec(text)) !== null) {
    if (match.index > last) nodes.push(<span key={`t${last}`}>{text.slice(last, match.index)}</span>)
    const index = Number(match[1])
    const invalid = resolved && !validIndexes.has(index)
    nodes.push(
      invalid
        ? <span key={`i${match.index}`} className="ask-cite-chip ask-cite-chip--invalid" title="模型引用了不存在的编号">[{index}]</span>
        : <button key={`c${match.index}`} className="ask-cite-chip" onClick={() => onCite(entryId, index)}>[{index}]</button>,
    )
    last = match.index + match[0].length
  }
  if (last < text.length) nodes.push(<span key="tend">{text.slice(last)}</span>)
  return nodes.length ? nodes : text
}
