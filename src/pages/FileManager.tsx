import { useState, useEffect, useRef } from 'react'
import { useSearchParams, useLocation } from 'react-router-dom'
import { isDesktop, uploadFiles } from '../api'
const statusLabels: Record<string, string> = { pending: '等待解析', processing: '解析中', ready: '已解析', failed: '解析失败' }
const size = (n: number) => n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${(n / 1024).toFixed(1)} KB`
export default function FileManager() {
  const [params] = useSearchParams()
  const location = useLocation()
  /** 引用跳转落点（S1-04）：问答/搜索点引用时随 state 带来的定位信息（文件 + 位置 + 片段原文） */
  const citation = (location.state as any)?.citation as { document_id: number; chunk_id: number | null; file_name: string; quote: string; positionLabel: string; anchor_kind: string | null } | undefined
  const [files, setFiles] = useState<any[]>([])
  const [selectedId, setSelectedId] = useState<number | null>(Number(params.get('id')) || null)
  const [detail, setDetail] = useState<any>(null)
  const [query, setQuery] = useState('')
  const [type, setType] = useState('')
  const [storage, setStorage] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [projects, setProjects] = useState<any[]>([])
  const [sources, setSources] = useState<any[]>([])
  const [sourceId, setSourceId] = useState<number | null>(null)
  const [availability, setAvailability] = useState('')
  const [mapForm, setMapForm] = useState<any>(null)
  const [preview, setPreview] = useState<any>(null)
  const [syncing, setSyncing] = useState<number | null>(null)
  /** 当前启用的支持格式：扩展名给 accept 用，file_type 给筛选用（两者不同：png→image、js→code） */
  const [formatExtensions, setFormatExtensions] = useState<string[]>([])
  const [formatTypes, setFormatTypes] = useState<string[]>([])
  const input = useRef<HTMLInputElement>(null)
  const loadSources = async () => { try { setSources(await window.sd.folder.list()) } catch { /* 映射列表获取失败不影响文件浏览 */ } }
  /**
   * 支持格式随插件注册表变化：停用某解析器后，它覆盖的扩展名立即从筛选下拉与导入 accept 中消失。
   * 接口不可用时退化为「所有格式」，不影响文件浏览。
   */
  const loadFormats = async () => {
    try {
      const plugins = await window.sd.plugin.list()
      const exts = new Set<string>()
      const types = new Set<string>()
      for (const plugin of plugins || []) {
        if (plugin.kind !== 'parser' || !plugin.enabled || !plugin.loaded) continue
        const declared = plugin.fileTypes || {}
        for (const ext of plugin.capabilities?.extensions || []) {
          const value = String(ext).toLowerCase().replace(/^\./, '')
          if (!value) continue
          exts.add(value)
          // 筛选值必须是库里的 file_type（image / code / config 这类），未声明时退化为扩展名
          types.add(declared[value] || value)
        }
      }
      setFormatExtensions([...exts].sort())
      setFormatTypes([...types].sort())
    } catch { /* 插件接口不可用时保持空列表（不退回硬编码） */ }
  }
  useEffect(() => {
    void loadFormats()
    // 设置页是模态：插件启停不会重挂载本页，靠事件通知刷新支持格式
    const onPluginsChanged = () => { void loadFormats() }
    window.addEventListener('sd:plugins-changed', onPluginsChanged)
    return () => window.removeEventListener('sd:plugins-changed', onPluginsChanged)
  }, [])
  useEffect(() => { window.sd.project.list().then(setProjects).catch(() => {}); loadSources() }, [])
  const load = async () => {
    try {
      const result = await window.sd.file.list({ search: query, file_type: type, storage_type: storage, availability: availability || undefined, source_id: sourceId || undefined })
      setFiles(result)
      if (selectedId && !result.some((f: any) => f.id === selectedId)) { setSelectedId(null); setDetail(null) }
      if (selectedId && result.some((f: any) => f.id === selectedId)) setDetail(await window.sd.file.detail(selectedId))
    } catch (e: any) { setError(e.message) }
  }
  // 轮询：页面不可见时暂停，恢复可见立即刷新一次
  useEffect(() => {
    load()
    const timer = setInterval(() => { if (!document.hidden) load() }, 3000)
    const onVisible = () => { if (!document.hidden) load() }
    document.addEventListener('visibilitychange', onVisible)
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', onVisible) }
  }, [query, type, storage, availability, sourceId, selectedId])
  useEffect(() => { const timer = setInterval(() => { if (!document.hidden) loadSources() }, 10000); return () => clearInterval(timer) }, [])
  const importAction = async (browserFiles?: File[], reference = false) => {
    setError(''); setMessage(''); setBusy(true)
    try {
      let results
      if (isDesktop) { const paths = browserFiles ? browserFiles.map(f => (f as any).path) : await window.sd.file.select(); if (!paths.length) return; results = await (reference ? window.sd.file.reference(paths) : window.sd.file.import(paths)) }
      else { if (!browserFiles?.length) { input.current?.click(); return } results = await uploadFiles(browserFiles) }
      const success = results.filter((r: any) => r.success).length
      const rejected = results.filter((r: any) => !r.success)
      setMessage(`已导入 ${success} 份文件，正在自动解析。${rejected.length ? ' 跳过：' + rejected.map((r: any) => `${r.file}（${r.reason === 'duplicate' ? '重复文件' : r.reason}）`).join('、') : ''}`)
      if (success) setSelectedId(results.find((r: any) => r.success).documentId)
      await load()
    } catch (e: any) { setError(e.message) } finally { setBusy(false); if (input.current) input.current.value = '' }
  }
  const remove = async () => {
    if (!detail || !confirm(`删除“${detail.file_name}”？本地导入副本及索引会被删除，外部源文件不受影响。`)) return
    try { await window.sd.file.delete(detail.id); setSelectedId(null); setDetail(null); await load() } catch (e: any) { setError(e.message) }
  }
  const retry = async () => { try { await window.sd.file.process(detail.id); setMessage('已加入解析队列'); await load() } catch(e: any) { setError(e.message) } }
  const runPreview = async (form?: any) => {
    const target = form || mapForm
    if (!target?.rootPath) return
    try { setPreview(await window.sd.folder.preview(target.rootPath, target)) } catch (e: any) { setPreview(null); setError(e.message) }
  }
  const openMapForm = async () => {
    setError(''); setMessage(''); setPreview(null)
    const form = { rootPath: '', name: '', storageMode: 'reference', includeExt: '', excludeGlobs: '' }
    if (isDesktop) {
      const paths = await window.sd.folder.select().catch(() => [] as string[])
      if (!paths.length) return
      form.rootPath = paths[0]
      form.name = paths[0].split(/[\\/]/).filter(Boolean).pop() || ''
    }
    setMapForm(form)
    if (form.rootPath) await runPreview(form)
  }
  const submitMap = async () => {
    if (!mapForm?.rootPath) return
    setBusy(true); setError(''); setMessage('')
    try {
      if (preview?.alreadyMapped) {
        const res = await window.sd.folder.sync(preview.sourceId)
        setMessage(`同步完成：新增 ${res.added}（复用解析 ${res.reused}），更新 ${res.updated}，失效 ${res.removed}${res.deferred ? `，另有 ${res.deferred} 份待下轮同步` : ''}`)
      } else {
        const res = await window.sd.folder.create(mapForm)
        const s = res.sync
        setMessage(`已映射「${res.source.name}」：入库 ${s.added} 份（复用解析 ${s.reused}），排队解析 ${s.enqueued} 份${s.deferred ? `，其余 ${s.deferred} 份将在下次同步继续` : ''}`)
      }
      setMapForm(null); setPreview(null); await loadSources(); await load()
    } catch (e: any) { setError(e.message) } finally { setBusy(false) }
  }
  const syncAllSources = async () => {
    setError(''); setMessage(''); setSyncing(-1)
    try {
      const res = await window.sd.folder.syncAll()
      const added = res.results.reduce((sum: number, r: any) => sum + r.added, 0)
      const updated = res.results.reduce((sum: number, r: any) => sum + r.updated, 0)
      setMessage(`全部同步完成：${res.synced} 个来源，新增 ${added}，更新 ${updated}${res.errors.length ? `，${res.errors.length} 个来源失败` : ''}`)
      await loadSources(); await load()
    } catch (e: any) { setError(e.message) } finally { setSyncing(null) }
  }
  const syncOne = async (id: number) => {
    setSyncing(id); setError(''); setMessage('')
    try {
      const res = await window.sd.folder.sync(id)
      setMessage(`同步完成：新增 ${res.added}，更新 ${res.updated}，恢复 ${res.restored}，失效 ${res.removed}${res.deferred ? `，${res.deferred} 份待下轮` : ''}`)
      await loadSources(); await load()
    } catch (e: any) { setError(e.message) } finally { setSyncing(null) }
  }
  const cleanupSource = async (id: number) => {
    if (!confirm('清理该目录下已失效文件（源文件已删除/移走）的解析结果？此操作不可恢复。')) return
    try { const res = await window.sd.folder.cleanup(id); setMessage(`已清理 ${res.removed} 份失效文件`); await loadSources(); await load() } catch (e: any) { setError(e.message) }
  }
  const removeSource = async (s: any) => {
    if (!confirm(`移除映射「${s.name}」？已解析的 ${s.doc_count} 份内容将保留为普通引用。`)) return
    const deleteDocuments = confirm('是否同时删除这些文件已入库的解析结果（摘要、向量、实体、标签）？\n\n「确定」删除，「取消」仅解除映射。')
    try {
      await window.sd.folder.remove(s.id, deleteDocuments)
      setMessage(deleteDocuments ? '映射与解析结果已移除' : '映射已移除，已解析内容保留')
      if (sourceId === s.id) setSourceId(null)
      await loadSources(); await load()
    } catch (e: any) { setError(e.message) }
  }
  return <div className="file-workspace page-scroll" onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); if (!busy) importAction(Array.from(e.dataTransfer.files)) }}>
    <div className="page-heading"><div><div className="eyebrow">YOUR DOCUMENT LIBRARY</div><h1>文件空间<span className="heading-dot">.</span></h1><p>导入、解析、连接。每一份资料都可以被找到。</p></div><div className="heading-actions"><button className="button secondary" disabled={busy} onClick={openMapForm}>🗂 映射文件夹</button>{isDesktop && <button className="button secondary" disabled={busy} onClick={() => importAction(undefined, true)}>添加引用</button>}<button className="button primary" disabled={busy} onClick={() => importAction()}>{busy ? '导入中…' : '＋ 导入文件'}</button></div></div>
    <input ref={input} type="file" multiple hidden accept={formatExtensions.length ? formatExtensions.map(f => `.${f}`).join(',') : undefined} onChange={e => importAction(Array.from(e.target.files || []))} />
    {(sources.length > 0 || mapForm) && <section className="source-panel panel"><div className="panel-heading"><h2>映射的文件夹<span className="heading-dot">.</span></h2><div className="heading-actions"><button className="text-button" onClick={syncAllSources}>⟳ 全部同步</button></div></div><p className="source-hint">映射后整个目录会长期跟随：软件启动时自动比对增量，只解析新增与真正变更的文件。</p>{sources.map(s => <div className={'source-row' + (sourceId === s.id ? ' active' : '')} key={s.id}><div className="source-meta"><strong>🗂 {s.name}</strong><small title={s.root_path}>{s.root_path}</small><small>{s.doc_count} 份已入库 · {s.storage_mode === 'copy' ? '副本模式' : '引用模式'}{s.missing_count ? ` · ${s.missing_count} 份失效` : ''}{s.pending_count ? ` · ${s.pending_count} 份待解析` : ''} · {s.last_sync_at ? `上次同步 ${new Date(s.last_sync_at.replace(' ', 'T') + (s.last_sync_at.includes('Z') ? '' : 'Z')).toLocaleString('zh-CN')}` : '尚未同步'}{s.last_scan_status === 'error' ? ' · 同步失败' : ''}</small></div><div className="source-actions"><button className="text-button" disabled={syncing === s.id} onClick={() => syncOne(s.id)}>{syncing === s.id ? '同步中…' : '立即同步'}</button><button className="text-button" onClick={() => setSourceId(sourceId === s.id ? null : s.id)}>{sourceId === s.id ? '取消筛选' : '查看文件'}</button>{s.missing_count > 0 && <button className="text-button" onClick={() => cleanupSource(s.id)}>清理失效</button>}<button className="text-button error-text" onClick={() => removeSource(s)}>移除</button></div></div>)}</section>}
    {mapForm && <section className="source-form panel"><div className="panel-heading"><h2>{preview?.alreadyMapped ? '同步已有映射' : '建立目录映射'}</h2><button className="text-button" onClick={() => { setMapForm(null); setPreview(null) }}>取消 ×</button></div><div className="source-form-grid"><label>目录路径<input value={mapForm.rootPath} placeholder="例如 D:/资料/技术文档" onChange={e => setMapForm({ ...mapForm, rootPath: e.target.value })} /></label><label>显示名称<input value={mapForm.name} placeholder="默认使用目录名" onChange={e => setMapForm({ ...mapForm, name: e.target.value })} /></label><label>文件处理<select value={mapForm.storageMode} onChange={e => setMapForm({ ...mapForm, storageMode: e.target.value })}><option value="reference">仅引用，不复制原文件</option><option value="copy">复制副本到软件数据目录</option></select></label><label>限定格式<input value={mapForm.includeExt} placeholder={formatExtensions.length ? `留空=全部支持格式，如 ${formatExtensions.slice(0, 3).join(',')}` : '留空=全部支持格式'} onChange={e => setMapForm({ ...mapForm, includeExt: e.target.value })} /></label><label>忽略规则<input value={mapForm.excludeGlobs} placeholder="如 node_modules,*.log,草稿" onChange={e => setMapForm({ ...mapForm, excludeGlobs: e.target.value })} /></label></div>{preview && <div className="source-preview">扫描到 <strong>{preview.stats.matched}</strong> 份可解析文件 · 新增 {preview.newFiles} · 内容变更 {preview.changed} · 已入库 {preview.unchanged}{preview.missing ? ` · 已消失 ${preview.missing}` : ''}{preview.stats.unsupported ? ` · 跳过不支持格式 ${preview.stats.unsupported}` : ''}{preview.stats.tooLarge ? ` · 超出大小上限 ${preview.stats.tooLarge}` : ''}{preview.stats.ignored ? ` · 按规则忽略 ${preview.stats.ignored}` : ''}{preview.stats.truncated ? ' · 目录过大已截断' : ''}{preview.alreadyMapped ? '　该目录已建立映射，将执行差集同步' : ''}</div>}<div className="detail-actions">{isDesktop && <button className="button secondary" onClick={openMapForm}>重新选择目录…</button>}<button className="button secondary" disabled={!mapForm.rootPath} onClick={() => runPreview()}>预览扫描</button><button className="button primary" disabled={busy || !mapForm.rootPath} onClick={submitMap}>{busy ? '处理中…' : preview?.alreadyMapped ? '执行同步' : '建立映射并入库'}</button></div></section>}
    {error && <div className="error-banner" role="alert">{error}</div>}{message && <div className="notice" role="status">{message}</div>}
    <div className="file-toolbar"><input aria-label="搜索文件名" placeholder="⌕  搜索文件名…" value={query} onChange={e => setQuery(e.target.value)} /><select aria-label="文件类型" value={type} onChange={e => setType(e.target.value)}><option value="">所有格式</option>{formatTypes.map(t => <option key={t} value={t}>{t.toUpperCase()}</option>)}</select><select aria-label="存储方式" value={storage} onChange={e => setStorage(e.target.value)}><option value="">所有来源</option><option value="local">本地导入</option><option value="reference">外部引用</option></select><select aria-label="有效状态" value={availability} onChange={e => setAvailability(e.target.value)}><option value="">全部状态</option><option value="unavailable">仅已失效</option></select><span>{files.length} 份文件{sourceId ? `（已按「${sources.find(s => s.id === sourceId)?.name || ''}」筛选）` : ''}</span><button className="text-button" onClick={load}>↻ 刷新</button></div>
    <div className={'file-columns' + (detail ? ' with-detail' : '')}><section className="file-table"><div className="file-table-head"><span>文件名称</span><span>大小</span><span>处理状态</span><span>导入时间</span></div>{files.length ? files.map(f => <button className={'file-table-row' + (selectedId === f.id ? ' selected' : '')} key={f.id} onClick={() => setSelectedId(f.id)}><span className="file-name-cell"><span className="file-badge">{f.file_type.toUpperCase().slice(0, 4)}</span><span><strong>{f.file_name}</strong><small>{f.storage_type === 'local' ? '本地导入' : '外部引用'}{f.source_name ? ` · 映射：${f.source_name}${f.relative_path && f.relative_path.includes('/') ? ' / ' + f.relative_path.slice(0, f.relative_path.lastIndexOf('/')) : ''}` : ''}{f.is_available === 0 ? ' · 已失效' : ''}</small></span></span><span>{size(f.file_size || 0)}</span><span className={f.processing_status === 'failed' ? 'error-text' : f.processing_status === 'ready' ? 'success-text' : ''}>{statusLabels[f.processing_status] || '等待解析'}</span><span>{new Date(f.imported_at.replace(' ', 'T') + (f.imported_at.includes('Z') ? '' : 'Z')).toLocaleDateString('zh-CN')}</span></button>) : <div className="file-empty"><span>▤</span><h2>{query || type || storage || availability || sourceId ? '没有符合条件的文件' : '为你的知识留一个位置'}</h2><p>拖入文件，或点击导入。当前支持 {formatExtensions.length} 种格式{formatExtensions.length ? `：${formatExtensions.slice(0, 8).join(' / ')}${formatExtensions.length > 8 ? ' 等' : ''}` : ''}。</p><button className="button primary" onClick={() => importAction()}>导入第一份文件</button></div>}</section>
    {detail && <aside className="file-detail panel"><div className="panel-heading"><h2>文件详情</h2><button className="text-button" onClick={() => { setSelectedId(null); setDetail(null) }}>关闭 ×</button></div><span className="file-badge">{detail.file_type.toUpperCase()}</span><h3>{detail.file_name}</h3><p>{size(detail.file_size || 0)} · {statusLabels[detail.processing_status]}</p>
    {/* 引用定位（S1-04）：从问答/搜索点引用跳来时，显示该引用的位置与片段原文；无锚点只显示片段，不编造位置 */}
    {citation && Number(citation.document_id) === detail.id && <div className="citation-locate" role="note"><h4>引用定位</h4><p>{citation.positionLabel ? `位置：${citation.positionLabel}` : '该片段没有可定位的位置锚点（未给出页码/时间戳）'}{citation.anchor_kind === 'time' ? '　音视频无内嵌播放器，按时间戳做文本定位。' : ''}</p><div className="search-snippet">{String(citation.quote || '').replace(/\s+/g, ' ').trim() || '（无片段原文）'}</div></div>}{detail.source_id && <><h4>来源目录</h4><p>{detail.source_name || '映射文件夹'}{detail.relative_path ? ` / ${detail.relative_path}` : ''}{detail.is_available === 0 ? ' · 源文件已失效' : ''}</p></>}<div><h4>所属项目</h4><select className="project-select" aria-label="所属项目" value={detail.project_id ?? ''} onChange={async e => { const v = e.target.value ? Number(e.target.value) : null; try { await window.sd.project.assign(detail.id, v); setDetail(await window.sd.file.detail(detail.id)); setMessage('项目指派已更新') } catch (err: any) { setError(err.message) } }}><option value="">未分组</option>{projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></div>{detail.processing_error && <div className="error-banner">{detail.processing_error}</div>}<h4>内容摘要</h4><p>{detail.summary || '解析完成后会自动生成摘要。'}</p><h4>知识实体 · {detail.entities?.length || 0}</h4><div className="entity-chips">{detail.entities?.map((e: any) => <span key={e.id}>{e.name}</span>)}</div>{detail.versions?.length > 0 && <><h4>版本历史 · {detail.versions.length}</h4><div className="version-list">{detail.versions.map((v: any) => <div key={v.id} className="version-row"><span className="version-no">v{v.version_number}</span><span>{v.change_type === 'initial' ? '初始导入' : v.change_type === 'modified' ? '内容变更' : v.change_type}{v.change_summary ? ` · ${v.change_summary}` : ''}</span><small>{size(v.file_size || 0)}</small></div>)}</div></>}<h4>文本预览</h4><pre>{detail.content_text || '暂无提取文本'}</pre><div className="detail-actions"><button className="button secondary" onClick={retry} disabled={detail.processing_status === 'processing'}>重新解析</button>{isDesktop && <button className="button secondary" onClick={() => window.sd.shell.showInFolder(detail.original_path || detail.file_path)}>打开文件夹</button>}<button className="button secondary error-text" disabled={detail.processing_status === 'processing'} onClick={remove}>删除文件</button></div></aside>}</div>
  </div>
}
