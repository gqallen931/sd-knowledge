import { useState, useEffect } from 'react'
import type { DragEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import Chevron from '../components/Chevron'

const COLORS = ['#00dc6e', '#4c8dff', '#a06cd5', '#e8b04b', '#f24949', '#2fe387', '#38bdf8', '#7c8593']
const size = (n: number) => n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${(n / 1024).toFixed(1)} KB`
/** 页面内拖拽的自定义 MIME；项目页的文档行只拖给自己，不污染系统拖拽 */
const DRAG_TYPE = 'application/x-sd-docs'

export default function Projects() {
  const [projects, setProjects] = useState<any[]>([])
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [color, setColor] = useState(COLORS[0])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [editingId, setEditingId] = useState<number | null>(null)
  const [expandedId, setExpandedId] = useState<number | null>(null)
  const [docs, setDocs] = useState<any[]>([])
  const [selected, setSelected] = useState<number[]>([])
  const [moveTo, setMoveTo] = useState('')
  const [dragging, setDragging] = useState<number[]>([])
  const [dropTarget, setDropTarget] = useState<number | 'none' | null>(null)
  const navigate = useNavigate()

  const load = async () => {
    try { setProjects(await window.sd.project.list()) }
    catch (e: any) { setError(e.message) }
  }
  useEffect(() => { load() }, [])

  const create = async () => {
    setError(''); setMessage('')
    if (!name.trim()) { setError('项目名称不能为空'); return }
    setBusy(true)
    try {
      await window.sd.project.create(name, description, color)
      setName(''); setDescription(''); setColor(COLORS[0])
      setMessage('项目已创建')
      await load()
    } catch (e: any) { setError(e.message) } finally { setBusy(false) }
  }

  const startEdit = (p: any) => {
    setEditingId(p.id); setName(p.name); setDescription(p.description || ''); setColor(p.color || COLORS[0])
    setMessage(''); setError('')
  }
  const cancelEdit = () => { setEditingId(null); setName(''); setDescription(''); setColor(COLORS[0]) }
  const saveEdit = async (id: number) => {
    setBusy(true)
    try {
      await window.sd.project.update(id, name, description, color)
      cancelEdit(); setMessage('项目已更新'); await load()
    } catch (e: any) { setError(e.message) } finally { setBusy(false) }
  }

  const remove = async (p: any) => {
    if (!confirm(`删除项目“${p.name}”？项目内文件不会被删除，仅解除关联。`)) return
    try {
      await window.sd.project.remove(p.id)
      if (expandedId === p.id) { setExpandedId(null); setDocs([]); setSelected([]) }
      setMessage('项目已删除'); await load()
    } catch (e: any) { setError(e.message) }
  }

  const refreshDocs = async (projectId: number) => {
    try { setDocs(await window.sd.file.list({ project_id: projectId })) }
    catch (e: any) { setError(e.message) }
  }

  const toggleExpand = async (p: any) => {
    if (expandedId === p.id) { setExpandedId(null); setDocs([]); setSelected([]); return }
    setExpandedId(p.id); setSelected([])
    await refreshDocs(p.id)
  }
  const unassign = async (docId: number) => {
    try {
      await window.sd.project.assign(docId, null)
      setDocs(docs.filter(d => d.id !== docId))
      setSelected(prev => prev.filter(x => x !== docId))
      await load()
    } catch (e: any) { setError(e.message) }
  }

  /** 批量迁移的唯一出口：updated 只统计真正改了归属的行，因此"拖回原处"会如实报 0 */
  const applyMove = async (ids: number[], targetId: number | null) => {
    const list = Array.from(new Set(ids.filter(n => Number.isInteger(n))))
    if (!list.length) return
    setError(''); setMessage('')
    try {
      const res = await window.sd.project.assignMany(list, targetId)
      const targetName = targetId == null ? null : (projects.find(p => p.id === targetId)?.name || `#${targetId}`)
      const verb = targetName ? `迁移到「${targetName}」` : '移出项目'
      setMessage(res.skipped > 0
        ? `${verb}：已更新 ${res.updated} 份，${res.skipped} 份原本就在目标位置`
        : `${verb}：已更新 ${res.updated} 份`)
      setSelected([])
      await load()
      if (expandedId != null) await refreshDocs(expandedId)
    } catch (e: any) { setError(e.message) }
  }

  const toggleSelect = (id: number) =>
    setSelected(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id])
  const allSelected = docs.length > 0 && selected.length === docs.length
  const toggleSelectAll = () => setSelected(allSelected ? [] : docs.map(d => d.id))

  const onDragStart = (e: DragEvent, docId: number) => {
    // 拖动选中的行 = 整组迁移；拖动未选中的行 = 只搬这一份
    const ids = selected.includes(docId) ? selected : [docId]
    setDragging(ids)
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData(DRAG_TYPE, JSON.stringify(ids))
    e.dataTransfer.setData('text/plain', ids.join(','))
  }
  const readPayload = (e: DragEvent): number[] => {
    const raw = e.dataTransfer.getData(DRAG_TYPE)
    if (raw) { try { return JSON.parse(raw) } catch { /* 落到内存态兜底 */ } }
    return dragging
  }
  const onDragEnd = () => { setDragging([]); setDropTarget(null) }
  const onDropTo = async (e: DragEvent, targetId: number | null) => {
    e.preventDefault()
    const ids = readPayload(e)
    setDropTarget(null); setDragging([])
    if (!ids.length) return
    await applyMove(ids, targetId)
  }

  const cardDnd = (p: any) => ({
    onDragOver: (e: DragEvent) => {
      if (!dragging.length) return
      e.preventDefault()
      e.dataTransfer.dropEffect = 'move'
      if (dropTarget !== p.id) setDropTarget(p.id)
    },
    onDragLeave: (e: DragEvent) => {
      if (e.currentTarget.contains(e.relatedTarget as Node)) return
      setDropTarget(t => (t === p.id ? null : t))
    },
    onDrop: (e: DragEvent) => onDropTo(e, p.id),
  })

  const colorRow = <div className="color-swatches">
    {COLORS.map(c => <button key={c} type="button" aria-label={`选择颜色 ${c}`}
      className={'swatch' + (color === c ? ' active' : '')} style={{ background: c }}
      onClick={() => setColor(c)} />)}
  </div>

  return <div className="page-scroll projects-workspace">
    <div className="page-heading"><div><div className="eyebrow">PROJECT WORKSPACES</div><h1>项目集<span className="heading-dot">.</span></h1><p>以课题为单位组织文档，跨来源聚合资料。</p></div></div>
    {error && <div className="error-banner" role="alert">{error}</div>}
    {message && <div className="notice" role="status">{message}</div>}

    {dragging.length > 0 && <div className={'drop-zone' + (dropTarget === 'none' ? ' active' : '')}
      onDragOver={e => { e.preventDefault(); setDropTarget('none') }}
      onDragLeave={() => setDropTarget(t => (t === 'none' ? null : t))}
      onDrop={e => onDropTo(e, null)}>
      正在拖动 {dragging.length} 份文档 · 放到任意项目卡片 = 迁移 · 放到这里 = 移出项目
    </div>}

    <div className="panel" style={{ padding: '20px', marginBottom: '24px' }}>
      <h3 style={{ marginBottom: '12px' }}>{editingId != null ? '编辑项目' : '新建项目'}</h3>
      <div className="project-form">
        <input aria-label="项目名称" placeholder="项目名称（如：毕业论文、竞品分析）" value={name}
          onChange={e => setName(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && editingId == null) create() }} />
        <input aria-label="项目描述" placeholder="描述（可选）" value={description} onChange={e => setDescription(e.target.value)} />
        {colorRow}
        {editingId != null
          ? <>
            <button className="button primary" disabled={busy} onClick={() => saveEdit(editingId)}>保存</button>
            <button className="button secondary" onClick={cancelEdit}>取消</button>
          </>
          : <button className="button primary" disabled={busy} onClick={create}>＋ 创建项目</button>}
      </div>
    </div>

    {projects.length === 0
      ? <div className="file-empty"><span>◈</span><h2>还没有项目</h2><p>创建第一个项目，把相关文档组织到一起。</p></div>
      : <div className="project-grid">
        {projects.map(p => <div key={p.id}
          className={'project-card panel' + (dropTarget === p.id ? ' drop-target' : '')} {...cardDnd(p)}>
          <div className="project-card-head">
            <span className="project-dot" style={{ background: p.color || COLORS[0] }} />
            <strong>{p.name}</strong>
            <span className="project-count">{p.doc_count} 份文档</span>
          </div>
          <p className="project-desc">{p.description || '暂无描述'}</p>
          <small className="project-date">创建于 {String(p.created_at || '').slice(0, 10)}</small>
          <div className="project-actions">
            <button className="text-button" onClick={() => toggleExpand(p)}>{expandedId === p.id ? '收起 ▴' : '查看文档 ▾'}</button>
            <button className="text-button" onClick={() => startEdit(p)}>编辑</button>
            <button className="text-button error-text" onClick={() => remove(p)}>删除</button>
          </div>
          {expandedId === p.id && <div className="project-docs">
            {docs.length === 0
              ? <p style={{ color: 'var(--text-dim)', fontSize: '13px' }}>项目内暂无文档。可在文件空间详情面板中把文档指派到本项目。</p>
              : <>
                <div className="bulk-bar">
                  <label className="bulk-check">
                    <input type="checkbox" checked={allSelected} onChange={toggleSelectAll} /> 全选
                  </label>
                  <span className="bulk-count">已选 {selected.length} / {docs.length}</span>
                  <select aria-label="迁移目标项目" value={moveTo} onChange={e => setMoveTo(e.target.value)}>
                    <option value="">移到项目…</option>
                    {projects.filter(x => x.id !== p.id).map(x =>
                      <option key={x.id} value={x.id}>{x.name}</option>)}
                  </select>
                  <button className="button secondary" disabled={!selected.length || !moveTo}
                    onClick={() => { const t = Number(moveTo); setMoveTo(''); applyMove(selected, t) }}>迁移</button>
                  <button className="text-button error-text" disabled={!selected.length}
                    onClick={() => applyMove(selected, null)}>移出项目</button>
                </div>
                {docs.map(d => <div key={d.id} draggable
                  className={'project-doc-row' + (selected.includes(d.id) ? ' selected' : '')}
                  onDragStart={e => onDragStart(e, d.id)} onDragEnd={onDragEnd}>
                  <input type="checkbox" className="doc-check" checked={selected.includes(d.id)}
                    aria-label={`选择 ${d.file_name}`} onChange={() => toggleSelect(d.id)} />
                  <button className="text-button" onClick={() => navigate(`/files?id=${d.id}`)}>{d.file_name}</button>
                  <span>{size(d.file_size || 0)}</span>
                  <button className="text-button error-text" onClick={() => unassign(d.id)}>移出</button>
                </div>)}
              </>}
          </div>}
        </div>)}
      </div>}
  </div>
}
