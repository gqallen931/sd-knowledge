import { useState, useEffect, useMemo, useRef } from 'react'
import type { EChartsOption } from 'echarts'
import * as echarts from 'echarts'
import Chart from '../components/Chart'

/**
 * ECharts 走 Canvas，读不到 CSS 变量：这里从 index.css 的令牌取实际值。
 * 主题切换是给 documentElement 加/去 .light，所以订阅它的 class 变化后重取，
 * 浅色主题下图谱的节点色、文字与边线才会跟着换成压深/反转的那一套。
 */
const GRAPH_TOKENS = {
  primary: '--chart-1',          // 文档节点：主色 / 完成度
  space: '--chart-2',            // 空间节点：信息色
  accent: '--chart-3',           // 实体节点：标签色
  success: '--success',          // 标签节点
  edge: '--card-border-hover',   // 连线（原本是写死的 #2a2d33）
  tooltipBg: '--panel-bg',
  tooltipText: '--text',
  legendText: '--text-secondary',
}
type GraphTokens = { [K in keyof typeof GRAPH_TOKENS]: string }
function readGraphTokens(): GraphTokens {
  const style = getComputedStyle(document.documentElement)
  const tokens = {} as GraphTokens
  for (const key of Object.keys(GRAPH_TOKENS) as (keyof GraphTokens)[]) {
    tokens[key] = style.getPropertyValue(GRAPH_TOKENS[key]).trim()
  }
  return tokens
}

/** 库时间（UTC 无时区标记）转本地展示；解析失败按原样展示 */
function fmtTimeSuffix(value?: string | null): string {
  if (!value) return ''
  const normalized = value.includes('T') ? value : value.replace(' ', 'T')
  const date = new Date(normalized.endsWith('Z') ? normalized : `${normalized}Z`)
  return Number.isNaN(date.getTime()) ? ` · ${value}` : ` · ${date.toLocaleString('zh-CN', { hour12: false })}`
}

export default function KnowledgeGraph() {
  const [nodes, setNodes] = useState<any[]>([])
  const [edges, setEdges] = useState<any[]>([])
  const [stats, setStats] = useState<any>(null)
  const [selectedNode, setSelectedNode] = useState<any>(null)
  // ===== 分级图谱（ADR-002）=====
  // L0：空间折叠总览；L1：单个空间内部的文档/实体/标签图。
  const [level, setLevel] = useState<'global' | 'space'>('global')
  const [spaceId, setSpaceId] = useState<number | null>(null)
  /** 图谱加载失败提示：失败与「真的没数据」是两回事，不能共用空态文案 */
  const [loadError, setLoadError] = useState('')
  /** L1 落在「未归入空间」节点上：此时没有 space_id，范围改由 `unassigned` 表达 */
  const [spaceUnassigned, setSpaceUnassigned] = useState(false)
  const [spaceLabel, setSpaceLabel] = useState('')
  const [folderPath, setFolderPath] = useState<string | null>(null)
  const [folders, setFolders] = useState<any[]>([])
  const [bridges, setBridges] = useState<any[]>([])
  /** ADR-007：主题社区（实体—实体边上的标签传播结果） */
  const [communities, setCommunities] = useState<any[]>([])
  const [communityBusy, setCommunityBusy] = useState(false)
  const [communityNote, setCommunityNote] = useState('')
  /** 截断/范围提示：把「你看到的不是全部」显式说出来，而不是静默丢弃 */
  const [scopeNote, setScopeNote] = useState('')
  /** L2：聚焦某个实体的邻域（客户端裁剪，不再查库） */
  const [focusEntity, setFocusEntity] = useState<any>(null)
  const [showFilters, setShowFilters] = useState(true)
  const [layout, setLayout] = useState<'force' | 'circular'>('force')
  const [filters, setFilters] = useState({
    documents: true, entities: true, tags: true,
    local: true, reference: true,
  })
  /** 图表色板令牌：主题切换时重取（.light 的 class 变化由这里订阅） */
  const [tokens, setTokens] = useState(readGraphTokens)
  useEffect(() => {
    const observer = new MutationObserver(() => setTokens(readGraphTokens()))
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
    return () => observer.disconnect()
  }, [])
  const chartRef = useRef<echarts.ECharts | null>(null)
  // 图谱编辑状态
  const [relQuery, setRelQuery] = useState('')
  const [relResults, setRelResults] = useState<any[]>([])
  const [relType, setRelType] = useState('RELATED')
  const [editError, setEditError] = useState('')
  const [editMsg, setEditMsg] = useState('')
  const [editBusy, setEditBusy] = useState(false)
  // 实体重命名
  const [renameValue, setRenameValue] = useState('')
  // 批量实体操作（多选合并）
  const [batchOpen, setBatchOpen] = useState(false)
  const [batchSelected, setBatchSelected] = useState<any[]>([])
  const [batchQuery, setBatchQuery] = useState('')
  const [batchResults, setBatchResults] = useState<any[]>([])
  const [batchTarget, setBatchTarget] = useState<any>(null)
  const [batchTargetQuery, setBatchTargetQuery] = useState('')
  const [batchTargetResults, setBatchTargetResults] = useState<any[]>([])
  // 实体消歧候选建议
  const [suggestOpen, setSuggestOpen] = useState(false)
  const [suggestLoading, setSuggestLoading] = useState(false)
  const [suggestResult, setSuggestResult] = useState<any>(null)
  const [suggestIgnored, setSuggestIgnored] = useState<string[]>([])
  // 实体别名（S2-08）：等义名共享给检索与消歧
  const [aliases, setAliases] = useState<any[]>([])
  const [aliasDraft, setAliasDraft] = useState('')
  const [aliasBusy, setAliasBusy] = useState(false)
  // 合并历史（S2-08）：可在消歧面板回看
  const [mergeHistory, setMergeHistory] = useState<any[]>([])
  const [showHistory, setShowHistory] = useState(false)

  /** 选中实体时拉取别名列表；非实体节点清空 */
  useEffect(() => {
    if (!selectedNode || selectedNode.node_type !== 'entity') { setAliases([]); setAliasDraft(''); return }
    let alive = true
    window.sd.graph.listAliases(selectedNode.id)
      .then((list: any[]) => { if (alive) setAliases(list ?? []) })
      .catch(() => { if (alive) setAliases([]) })
    return () => { alive = false }
  }, [selectedNode?.id, selectedNode?.node_type])

  useEffect(() => { loadGraph() }, [level, spaceId, spaceUnassigned, folderPath])

  /**
   * 分级加载：
   *   - L0 只拉 `overview()`——空间超级节点 + 跨域桥，量级 = 空间数，永远画得下；
   *   - L1 才拉该空间内部的节点/边，并把该空间参与的跨域桥一起带出来。
   * 旧版一次性拉全库（且静默截断到 500/200/100），图谱越大越像一张糊掉的网。
   */
  const loadGraph = async () => {
    setLoadError('')
    try {
      const s = await window.sd.graph.stats()
      setStats(s)
      // 社区是独立一层结构，加载失败不应挡住主图（旧库没有社区表时就是空数组）
      try {
        setCommunities(await window.sd.graph.communities({ limit: 8 }))
      } catch {
        setCommunities([])
      }
      if (level === 'global') {
        const ov: any = await window.sd.graph.overview()
        // 「未归入空间」节点没有 space_id，用自身 id（'unassigned'）入图，避免 id 为 null
        setNodes((ov?.nodes || []).map((n: any) => ({ ...n, id: n.space_id ?? n.id })))
        setEdges((ov?.edges || []).map((e: any) => ({
          id: e.id,
          source_type: 'space', source_id: Number(String(e.source).slice(1)),
          target_type: 'space', target_id: Number(String(e.target).slice(1)),
          relation_type: e.relation_type, weight: e.weight, mentions: e.mentions,
        })))
        setBridges([])
        setScopeNote(ov?.truncated ? `跨域桥仅显示前 ${ov.edges.length} / ${ov.total} 条` : '')
        return
      }

      const scope: any = spaceUnassigned
        ? { unassigned: true, folder_path: folderPath }
        : { source_id: spaceId, folder_path: folderPath }
      const [n, e, b, fs] = await Promise.all([
        window.sd.graph.nodes(scope),
        window.sd.graph.edges(scope),
        // 跨域桥只在空间之间成立，未归入空间的文档没有桥可谈
        spaceUnassigned || spaceId == null
          ? Promise.resolve<any>({ items: [], total: 0, truncated: false })
          : window.sd.graph.bridges({ source_id: spaceId, limit: 30 }),
        spaceUnassigned || spaceId == null
          ? Promise.resolve<any>([])
          : window.sd.folder.listFolders(spaceId),
      ])
      setNodes(Array.isArray(n) ? n : (n?.items ?? []))
      setEdges(Array.isArray(e) ? e : (e?.items ?? []))
      setBridges(b?.items ?? [])
      setFolders(Array.isArray(fs) ? fs : [])

      const notes: string[] = []
      if (n?.truncated) notes.push(`节点 ${n.items.length}/${n.total}`)
      if (e?.truncated) notes.push(`关系 ${e.items.length}/${e.total}`)
      if (b?.truncated) notes.push(`跨域桥 ${b.items.length}/${b.total}`)
      setScopeNote(notes.length ? `已截断：${notes.join(' · ')}` : '')
    } catch (e: any) {
      console.error('Graph load error:', e?.message || e)
      setLoadError('图谱数据加载失败，请稍后点击右下角「刷新」重试')
    }
  }

  /**
   * 重算主题社区（ADR-007）。
   *
   * 是一次显式的、用户触发的幂等重算：社区不随文档入库自动变，
   * 因为「重新解析」与「重新聚类」的代价和时机完全不同，混在一起会让人不敢改文档。
   */
  const handleDetectCommunities = async () => {
    setCommunityBusy(true)
    setCommunityNote('')
    try {
      const result = await window.sd.graph.detectCommunities()
      setCommunityNote(
        result.communities > 0
          ? `已重算：${result.communities} 个社区，覆盖 ${result.entities} 个实体`
          : '实体之间还没有足够的语义关系，暂时聚不出社区',
      )
      await loadGraph()
    } catch (error: any) {
      setCommunityNote(error?.message || '社区检测失败')
    } finally {
      setCommunityBusy(false)
    }
  }

  const getCategory = (nodeType: string) => {
    switch (nodeType) {
      case 'document': return 0
      case 'entity': return 1
      case 'tag': return 2
      case 'space': return 3
      default: return 1
    }
  }

  const getNodeSize = (nodeType: string, raw?: any) => {
    switch (nodeType) {
      case 'document': return 45
      case 'entity': return 32
      case 'tag': return 24
      // 空间节点按文档量放大，让「重仓空间」一眼可辨
      case 'space': return Math.min(90, 40 + Math.sqrt(Number(raw?.doc_count) || 0) * 4)
      default: return 30
    }
  }

  const baseNodes = useMemo(() => nodes.filter(n => {
    if (n.node_type === 'document' && !filters.documents) return false
    if (n.node_type === 'entity' && !filters.entities) return false
    if (n.node_type === 'tag' && !filters.tags) return false
    if (n.storage_type === 'local' && !filters.local) return false
    if (n.storage_type === 'reference' && !filters.reference) return false
    return true
  }), [nodes, filters])

  /**
   * L2 聚焦：只看某个实体及其直接邻居。
   * 纯客户端裁剪——邻域关系已经在 L1 的边集里，不必再查一次库。
   */
  const filteredNodes = useMemo(() => {
    if (!focusEntity) return baseNodes
    const key = `${focusEntity.node_type}:${focusEntity.id}`
    const keep = new Set<string>([key])
    edges.forEach(e => {
      const s = `${e.source_type}:${e.source_id}`
      const t = `${e.target_type}:${e.target_id}`
      if (s === key) keep.add(t)
      else if (t === key) keep.add(s)
    })
    return baseNodes.filter(n => keep.has(`${n.node_type}:${n.id}`))
  }, [baseNodes, focusEntity, edges])

  const filteredEdges = useMemo(() => {
    const nodeIds = new Set(filteredNodes.map(n => `${n.node_type}:${n.id}`))
    return edges.filter(e => {
      const sId = `${e.source_type}:${e.source_id}`
      const tId = `${e.target_type}:${e.target_id}`
      return nodeIds.has(sId) && nodeIds.has(tId)
    })
  }, [edges, filteredNodes])

  const graphOption = useMemo<EChartsOption>(() => {
    const echartsNodes = filteredNodes.map(n => {
      const isSpace = n.node_type === 'space'
      return {
        id: `${n.node_type}:${n.id}`,
        name: n.label || n.title || n.name || `节点${n.id}`,
        category: getCategory(n.node_type),
        symbolSize: getNodeSize(n.node_type, n),
        value: isSpace
          ? Number(n.doc_count) || 0
          : n.node_type === 'document' ? 10 : n.node_type === 'entity' ? 5 : 2,
        nodeType: n.node_type,
        raw: n,
        itemStyle: {
          borderColor: '#fff',
          borderWidth: isSpace ? 3 : 2,
          shadowBlur: 10,
          shadowColor: 'rgba(0,0,0,0.3)',
        },
        label: {
          show: isSpace ? true : n.node_type !== 'tag',
          position: 'bottom' as const,
          distance: isSpace ? 8 : 5,
          fontSize: isSpace ? 13 : 11,
          color: tokens.legendText,
        },
      }
    })

    const echartsLinks = filteredEdges.map(e => {
      // 跨域桥的粗细直接编码「共享实体数」——一眼看出哪两个空间最像
      const isBridge = e.source_type === 'space'
      return {
        source: `${e.source_type}:${e.source_id}`,
        target: `${e.target_type}:${e.target_id}`,
        value: isBridge ? `共享实体 ${e.weight ?? 0} 个` : (e.relation_type || '关联'),
        lineStyle: {
          width: isBridge ? Math.min(7, 1 + Math.log2((Number(e.weight) || 1) + 1)) : 1.5,
          curveness: 0.1,
          opacity: isBridge ? 0.6 : 0.6,
        },
      }
    })

    return {
      tooltip: {
        trigger: 'item',
        renderMode: 'richText',
        backgroundColor: tokens.tooltipBg,
        borderColor: tokens.edge,
        textStyle: { color: tokens.tooltipText, fontSize: 12 },
        formatter: (params: any) => {
          if (params.dataType === 'edge') {
            return String(params.data.value)
          }
          const n = params.data.raw
          if (n.node_type === 'space') {
            if (n.unassigned) {
              return `${params.name}\n${n.doc_count ?? 0} 篇本地导入文档 · 不属于任何映射空间\n双击查看这些文档的图谱`
            }
            return `${params.name}\n空间 · ${n.doc_count ?? 0} 篇文档 · ${n.folder_count ?? 0} 个目录\n双击进入`
          }
          return `${params.name}\n类型: ${n.node_type} / ${n.type || n.file_type || "-"}`
        },
      },
      legend: {
        data: level === 'global' ? ['空间'] : ['文档', '实体', '标签'],
        top: 12,
        right: 20,
        textStyle: { color: tokens.legendText, fontSize: 12 },
        itemWidth: 14,
        itemHeight: 14,
      },
      series: [{
        type: 'graph',
        layout: layout === 'force' ? 'force' : 'circular',
        roam: true,
        draggable: true,

        categories: [
          { name: '文档', itemStyle: { color: tokens.primary } },
          { name: '实体', itemStyle: { color: tokens.accent } },
          { name: '标签', itemStyle: { color: tokens.success } },
          { name: '空间', itemStyle: { color: tokens.space } },
        ],
        force: {
          repulsion: 250,
          gravity: 0.1,
          edgeLength: [80, 150],
          layoutAnimation: true,
        },
        circular: {
          rotateLabel: true,
        },
        lineStyle: {
          color: tokens.edge,
          curveness: 0.1,
          opacity: 0.5,
        },
        emphasis: {
          focus: 'adjacency',
          lineStyle: {
            width: 3,
            color: tokens.primary,
            opacity: 1,
          },
          itemStyle: {
            shadowBlur: 20,
            shadowColor: 'rgba(0,220,110,0.5)',
          },
        },
        data: echartsNodes,
        links: echartsLinks,
      }],
    }
  }, [filteredNodes, filteredEdges, layout, filters, level, tokens])

  /** L0 → L1：进入某个空间（可再叠加目录前缀）；「未归入空间」节点走 unassigned 范围 */
  const enterSpace = (node: any, path: string | null = null) => {
    const unassigned = node.unassigned === true || node.space_id == null
    setLevel('space')
    setSpaceUnassigned(unassigned)
    setSpaceId(unassigned ? null : Number(node.space_id ?? node.id))
    setSpaceLabel(
      node.label || node.name || (unassigned ? '未归入空间' : `空间 ${node.space_id ?? node.id}`)
    )
    setFolderPath(path)
    setFocusEntity(null)
    setSelectedNode(null)
  }

  /** 回到 L0（折叠回空间总览） */
  const backToGlobal = () => {
    setLevel('global')
    setSpaceId(null)
    setSpaceUnassigned(false)
    setSpaceLabel('')
    setFolderPath(null)
    setFolders([])
    setBridges([])
    setFocusEntity(null)
    setSelectedNode(null)
  }

  const handleChartReady = (chart: echarts.ECharts) => {
    chartRef.current = chart
    chart.off('click')
    chart.off('dblclick')
    chart.on('click', (params: any) => {
      if (params.dataType === 'node') {
        const raw = params.data.raw
        setSelectedNode(raw)
        setRelQuery(''); setRelResults([]); setEditError(''); setEditMsg('')
        // 重命名输入框跟随选中实体初始化（state setter 稳定，不依赖闭包中的旧值）
        setRenameValue(raw.node_type === 'entity' ? (raw.label || raw.name || '') : '')
      }
    })
    // 双击下钻：空间 → 空间内部；实体 → 只看它的邻域（纯前端裁剪）
    chart.on('dblclick', (params: any) => {
      if (params.dataType !== 'node') return
      const raw = params.data.raw
      if (!raw) return
      if (raw.node_type === 'space') enterSpace(raw)
      else if (raw.node_type === 'entity' && level === 'space') {
        setFocusEntity((prev: any) => (prev && prev.id === raw.id && prev.node_type === raw.node_type) ? null : raw)
      }
    })
  }

  // ===== 图谱编辑 =====
  const nodeKey = (n: any) => `${n.node_type}:${n.id}`
  const labelMap = useMemo(() => {
    const m = new Map<string, string>()
    nodes.forEach(n => m.set(`${n.node_type}:${n.id}`, n.label || n.name || n.title || `节点${n.id}`))
    return m
  }, [nodes])

  const nodeEdges = useMemo(() => {
    if (!selectedNode) return []
    const key = nodeKey(selectedNode)
    return edges.filter(e =>
      `${e.source_type}:${e.source_id}` === key || `${e.target_type}:${e.target_id}` === key
    )
  }, [edges, selectedNode])

  const otherEnd = (e: any) => {
    const self = nodeKey(selectedNode)
    const s = `${e.source_type}:${e.source_id}`
    const t = `${e.target_type}:${e.target_id}`
    return s === self ? labelMap.get(t) || '节点' : labelMap.get(s) || '节点'
  }

  const searchTargets = async (q: string) => {
    setRelQuery(q); setEditError('')
    if (!q.trim()) { setRelResults([]); return }
    try { setRelResults(await window.sd.graph.searchNodes(q) as any[]) }
    catch (e: any) { setEditError(e.message) }
  }

  const addRelation = async (target: any) => {
    if (!selectedNode || editBusy) return
    setEditBusy(true); setEditError('')
    try {
      await window.sd.graph.addRelationship(selectedNode.node_type, selectedNode.id, target.node_type, target.id, relType.trim() || 'RELATED')
      setRelQuery(''); setRelResults([])
      await loadGraph()
    } catch (e: any) { setEditError(e.message) } finally { setEditBusy(false) }
  }

  const mergeInto = async (target: any) => {
    if (!selectedNode || editBusy || target.node_type !== 'entity') return
    if (!confirm(`将实体"${selectedNode.label}"合并到"${target.label}"？\n前者的全部关系将转移，实体本身会被删除。`)) return
    setEditBusy(true); setEditError('')
    try {
      await window.sd.graph.mergeEntities(selectedNode.id, target.id)
      setSelectedNode(null); setRelQuery(''); setRelResults([])
      await loadGraph()
    } catch (e: any) { setEditError(e.message) } finally { setEditBusy(false) }
  }

  // ===== 实体重命名 =====
  const applyRename = async () => {
    if (!selectedNode || selectedNode.node_type !== 'entity' || editBusy) return
    const name = renameValue.replace(/\s+/g, ' ').trim()
    const current = selectedNode.label || selectedNode.name || ''
    if (!name) { setEditError('实体名称不能为空'); return }
    if (name === current) { setEditMsg('名称未变化'); return }
    setEditBusy(true); setEditError(''); setEditMsg('')
    try {
      await window.sd.graph.renameEntity(selectedNode.id, name)
      setSelectedNode({ ...selectedNode, label: name, name })
      setEditMsg(`已重命名为「${name}」`)
      await loadGraph()
    } catch (e: any) { setEditError(e.message) } finally { setEditBusy(false) }
  }

  // ===== 批量实体合并 =====
  const searchBatchEntities = async (q: string) => {
    setBatchQuery(q); setEditError('')
    if (!q.trim()) { setBatchResults([]); return }
    try { setBatchResults(await window.sd.graph.searchEntities(q, 20) as any[]) }
    catch (e: any) { setEditError(e.message) }
  }

  const searchBatchTarget = async (q: string) => {
    setBatchTargetQuery(q); setEditError('')
    if (!q.trim()) { setBatchTargetResults([]); return }
    try { setBatchTargetResults(await window.sd.graph.searchEntities(q, 20) as any[]) }
    catch (e: any) { setEditError(e.message) }
  }

  const toggleBatchEntity = (n: any) => {
    setEditMsg('')
    setBatchSelected(prev => prev.some(x => nodeKey(x) === nodeKey(n))
      ? prev.filter(x => nodeKey(x) !== nodeKey(n))
      : [...prev, n])
  }

  const closeBatch = () => {
    setBatchOpen(false)
    setBatchSelected([]); setBatchTarget(null)
    setBatchQuery(''); setBatchResults([])
    setBatchTargetQuery(''); setBatchTargetResults([])
    setEditMsg('')
  }

  const runBatchMerge = async () => {
    if (editBusy) return
    // 目标实体不参与合并，避免自己合自己
    const sources = batchTarget ? batchSelected.filter(n => nodeKey(n) !== nodeKey(batchTarget)) : []
    if (!batchTarget) { setEditError('请先指定目标实体'); return }
    if (sources.length === 0) { setEditError('请先选择要合并的实体'); return }
    if (!confirm(`将 ${sources.length} 个实体合并到「${batchTarget.label}」？\n这些实体的全部关系会转移到目标实体，实体本身会被删除，操作不可撤销。`)) return
    setEditBusy(true); setEditError(''); setEditMsg('')
    try {
      const res: any = await window.sd.graph.mergeEntitiesBatch(sources.map(n => n.id), batchTarget.id)
      setBatchSelected([]); setBatchTarget(null)
      setBatchQuery(''); setBatchResults([])
      setBatchTargetQuery(''); setBatchTargetResults([])
      setSelectedNode(null)
      setEditMsg(`已合并 ${res.merged} 个实体（转移 ${res.moved} 条关系，去重 ${res.deduped} 条）`)
      await loadGraph()
    } catch (e: any) { setEditError(e.message) } finally { setEditBusy(false) }
  }

  // ===== 实体消歧候选建议（只读扫描，合并不自动执行） =====
  // 用无序对做 key，方向反转后仍能定位同一条建议、稳定记住「忽略」状态
  const pairKey = (s: any) => [s.source.id, s.target.id].sort((a: number, b: number) => a - b).join('>')

  const refreshSuggest = async () => {
    setSuggestResult(await window.sd.graph.suggestEntityMerges({ limit: 50 }))
    setSuggestIgnored([])
  }

  const openSuggest = async () => {
    if (suggestOpen) { setSuggestOpen(false); return }
    setBatchOpen(false)
    setSuggestOpen(true)
    setSuggestLoading(true)
    setEditError('')
    setEditMsg('')
    try { await refreshSuggest() }
    catch (e: any) { setEditError(e.message) }
    finally { setSuggestLoading(false) }
  }

  const mergeSuggestion = async (s: any) => {
    const go = window.confirm(
      `将「${s.source.name}」合并到「${s.target.name}」？\n\n` +
      `前者的全部关系会转移到后者并自动去重，实体本身被删除。此操作不可撤销。`
    )
    if (!go) return
    setEditBusy(true)
    setEditError('')
    setEditMsg('')
    try {
      await window.sd.graph.mergeEntities(s.source.id, s.target.id)
      setEditMsg(`已合并「${s.source.name}」→「${s.target.name}」`)
      await loadGraph()
      await refreshSuggest()
    } catch (e: any) { setEditError(e.message) }
    finally { setEditBusy(false) }
  }

  const swapSuggestion = (s: any) => {
    setSuggestResult((prev: any) => prev ? {
      ...prev,
      suggestions: prev.suggestions.map((x: any) => pairKey(x) === pairKey(s)
        ? { ...x, source: x.target, target: x.source, detail: `${x.detail}（已反转方向）` }
        : x),
    } : prev)
  }

  /** 「不再提示」持久化：写入忽略记忆，后端扫描时跳过这组（本地同时隐藏） */
  const ignoreSuggestion = async (s: any) => {
    try {
      await window.sd.graph.ignoreMergeSuggestion(s.source.name, s.target.name)
      setSuggestIgnored((p) => [...p, pairKey(s)])
    } catch (e: any) { setEditError(e.message) }
  }

  const loadMergeHistory = async () => {
    try { setMergeHistory(await window.sd.graph.listMergeHistory(20)) }
    catch (e: any) { setEditError(e.message) }
  }

  // ===== 实体别名 =====
  const addAlias = async () => {
    if (!selectedNode || selectedNode.node_type !== 'entity' || aliasBusy) return
    const alias = aliasDraft.trim()
    if (!alias) return
    setAliasBusy(true)
    try {
      await window.sd.graph.addAlias(selectedNode.id, alias)
      setAliasDraft('')
      setAliases(await window.sd.graph.listAliases(selectedNode.id))
    } catch (e: any) { setEditError(e.message) } finally { setAliasBusy(false) }
  }

  const removeAlias = async (id: number) => {
    if (!selectedNode || aliasBusy) return
    setAliasBusy(true)
    try {
      await window.sd.graph.removeAlias(id)
      setAliases(await window.sd.graph.listAliases(selectedNode.id))
    } catch (e: any) { setEditError(e.message) } finally { setAliasBusy(false) }
  }

  const chipBtn = (color: string) => ({
    border: '1px solid var(--card-border)', background: 'transparent', color,
    cursor: 'pointer', borderRadius: '4px', fontSize: '11px', padding: '2px 8px',
  })

  const suggestPending = (suggestResult?.suggestions || [])
    .filter((s: any) => !suggestIgnored.includes(pairKey(s)))

  const deleteEdge = async (id: number) => {
    if (editBusy) return
    if (!confirm('删除这条关系？')) return
    setEditBusy(true); setEditError('')
    try { await window.sd.graph.deleteRelationship(id); await loadGraph() }
    catch (e: any) { setEditError(e.message) } finally { setEditBusy(false) }
  }

  const getNodeStyle = (type: string) => {
    const styles: Record<string, { bg: string; label: string }> = {
      document: { bg: '#00dc6e', label: 'D' },
      entity: { bg: '#a06cd5', label: 'E' },
      tag: { bg: '#2fe387', label: 'T' },
      space: { bg: '#4c8dff', label: 'S' },
    }
    return styles[type] || styles.document
  }

  return (
    <div className="relative h-full overflow-hidden" style={{ background: 'var(--bg)' }}>
      {/* Dot grid background */}
      <div className="absolute inset-0" style={{
        backgroundImage: 'radial-gradient(circle, var(--bg-grid) 1px, transparent 1px)',
        backgroundSize: '32px 32px',
      }} />

      {/* ECharts Graph Canvas */}
      <div className="absolute inset-0" style={{ zIndex: 1 }}>
        {filteredNodes.length === 0 ? (
          <div className="flex items-center justify-center h-full relative z-10">
            <div className="text-center">
              {loadError ? (
                <>
                  <div style={{ fontSize: '18px', color: 'var(--danger)', marginBottom: '8px' }}>图谱加载失败</div>
                  <div style={{ fontSize: '13px', color: 'var(--text-dim)' }}>{loadError}</div>
                  <button onClick={loadGraph}
                    style={{ marginTop: '12px', border: '1px solid var(--card-border)', background: 'transparent', color: 'var(--primary)', cursor: 'pointer', borderRadius: 6, fontSize: '12px', padding: '6px 16px' }}>
                    重试
                  </button>
                </>
              ) : (
                <>
                  <div style={{ fontSize: '18px', color: 'var(--text-secondary)', marginBottom: '8px' }}>暂无图谱数据</div>
                  <div style={{ fontSize: '13px', color: 'var(--text-dim)' }}>
                    {level === 'global'
                      ? '导入文件后，系统自动构建知识图谱'
                      : '当前范围下没有可展示的节点，试试返回上一层或放宽左侧筛选'}
                  </div>
                </>
              )}
            </div>
          </div>
        ) : (
          <Chart option={graphOption} height="100%" onChartReady={handleChartReady} />
        )}
      </div>

      {/* 分级面包屑：L0 全局总览 ⇄ L1 空间内部 ⇄ 目录 / 实体聚焦 */}
      <div className="absolute top-4 left-1/2 rounded-xl px-3 py-2 flex items-center gap-2"
        style={{
          transform: 'translateX(-50%)', background: 'var(--glass)', backdropFilter: 'blur(20px)',
          border: '1px solid var(--card-border)', zIndex: 10, boxShadow: 'var(--shadow-lg)',
          maxWidth: '76vw', overflow: 'hidden',
        }}>
        <span onClick={backToGlobal}
          style={{ cursor: 'pointer', fontSize: '12px', whiteSpace: 'nowrap', fontWeight: level === 'global' ? 600 : 500, color: level === 'global' ? 'var(--text)' : 'var(--primary)' }}>
          全局总览
        </span>
        {level === 'space' && (
          <>
            <span style={{ color: 'var(--text-dim)', fontSize: '12px' }}>›</span>
            <span style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text)', maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {spaceLabel}
            </span>
          </>
        )}
        {folderPath && (
          <>
            <span style={{ color: 'var(--text-dim)', fontSize: '12px' }}>›</span>
            <span onClick={() => setFolderPath(null)}
              style={{ cursor: 'pointer', fontSize: '12px', color: 'var(--primary)', maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              /{folderPath}（点击取消）
            </span>
          </>
        )}
        {focusEntity && (
          <>
            <span style={{ color: 'var(--text-dim)', fontSize: '12px' }}>›</span>
            <span onClick={() => setFocusEntity(null)} style={{ cursor: 'pointer', fontSize: '12px', color: 'var(--primary)', whiteSpace: 'nowrap' }}>
              聚焦「{focusEntity.label}」（点击取消）
            </span>
          </>
        )}
        <span style={{ fontSize: '11px', color: 'var(--text-dim)', whiteSpace: 'nowrap', paddingLeft: '6px', borderLeft: '1px solid var(--card-border)' }}>
          {level === 'global' ? '双击空间节点下钻' : '双击实体聚焦邻域'}
        </span>
      </div>

      {/* 截断提示：不静默丢数据，把「你看到的不是全部」讲清楚 */}
      {scopeNote && (
        <div className="absolute rounded-lg px-3 py-1"
          style={{
            top: '68px', left: '50%', transform: 'translateX(-50%)', zIndex: 10,
            background: 'var(--glass)', border: '1px solid var(--card-border)',
            fontSize: '11px', color: 'var(--text-secondary)',
          }}>
          {scopeNote}
        </div>
      )}

      {/* Left floating panel: Filters + Stats */}
      {showFilters && (
        <div className="absolute top-4 left-4 rounded-xl p-4 max-h-full overflow-y-auto"
          style={{
            width: '240px', background: 'var(--glass)', backdropFilter: 'blur(20px)',
            border: '1px solid var(--card-border)', zIndex: 10, boxShadow: 'var(--shadow-lg)',
          }}>
          <div style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '12px' }}>
            图谱筛选
          </div>

          <div style={{ fontSize: '11px', color: 'var(--text-dim)', margin: '0 0 4px' }}>节点类型</div>
          {[
            { key: 'documents', label: '文档', color: '#6366f1' },
            { key: 'entities', label: '实体', color: '#8b5cf6' },
            { key: 'tags', label: '标签', color: 'var(--primary)' },
          ].map(item => (
            <span key={item.key}
              onClick={() => setFilters({ ...filters, [item.key]: !filters[item.key as keyof typeof filters] })}
              className="inline-block rounded-full text-xs m-0.5 cursor-pointer"
              style={{
                padding: '3px 10px',
                background: filters[item.key as keyof typeof filters] ? item.color : 'var(--bg)',
                color: filters[item.key as keyof typeof filters] ? 'white' : 'var(--text-secondary)',
                border: `1px solid ${filters[item.key as keyof typeof filters] ? item.color : 'var(--card-border)'}`,
              }}>
              {item.label}
            </span>
          ))}

          <div style={{ fontSize: '11px', color: 'var(--text-dim)', margin: '12px 0 4px' }}>数据来源</div>
          {[
            { key: 'local', label: '本地导入' },
            { key: 'reference', label: '外部引用' },
          ].map(item => (
            <span key={item.key}
              onClick={() => setFilters({ ...filters, [item.key]: !filters[item.key as keyof typeof filters] })}
              className="inline-block rounded-full text-xs m-0.5 cursor-pointer"
              style={{
                padding: '3px 10px',
                background: filters[item.key as keyof typeof filters] ? 'var(--primary)' : 'var(--bg)',
                color: filters[item.key as keyof typeof filters] ? 'white' : 'var(--text-secondary)',
                border: '1px solid var(--card-border)',
              }}>
              {item.label}
            </span>
          ))}

          {stats && (
            <div style={{ marginTop: '16px', paddingTop: '16px', borderTop: '1px solid var(--card-border)' }}>
              <div style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: '8px', textTransform: 'uppercase' }}>图谱统计</div>
              <div style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', padding: '2px 0' }}><span>节点</span><span style={{ color: 'var(--text)' }}>{stats.total_nodes ?? filteredNodes.length}</span></div>
                <div style={{ display: 'flex', justifyContent: 'space-between', padding: '2px 0' }}><span>文档</span><span style={{ color: 'var(--text)' }}>{stats.documents ?? 0}</span></div>
                <div style={{ display: 'flex', justifyContent: 'space-between', padding: '2px 0' }}><span>实体</span><span style={{ color: 'var(--text)' }}>{stats.entities ?? 0}</span></div>
                <div style={{ display: 'flex', justifyContent: 'space-between', padding: '2px 0' }}><span>关系</span><span style={{ color: 'var(--text)' }}>{stats.relationships ?? filteredEdges.length}</span></div>
                {stats.spaces != null && (
                  <div style={{ display: 'flex', justifyContent: 'space-between', padding: '2px 0' }}><span>空间</span><span style={{ color: 'var(--text)' }}>{stats.spaces}</span></div>
                )}
                {stats.bridges != null && (
                  <div style={{ display: 'flex', justifyContent: 'space-between', padding: '2px 0' }}><span>跨域桥</span><span style={{ color: 'var(--text)' }}>{stats.bridges}</span></div>
                )}
                {stats.predicate_edges != null && (
                  <div style={{ display: 'flex', justifyContent: 'space-between', padding: '2px 0' }}><span>语义边</span><span style={{ color: 'var(--text)' }}>{stats.predicate_edges}</span></div>
                )}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '2px 0' }}>
                  <span>主题社区</span>
                  <span style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                    <span style={{ color: 'var(--text)' }}>{stats.communities ?? 0}</span>
                    <button
                      onClick={handleDetectCommunities}
                      disabled={communityBusy}
                      title="基于实体—实体关系重新聚类（纯本地算法，不调用模型）"
                      style={{
                        fontSize: '11px',
                        padding: '1px 6px',
                        borderRadius: '4px',
                        border: '1px solid var(--card-border)',
                        background: 'transparent',
                        color: 'var(--text-secondary)',
                        cursor: communityBusy ? 'wait' : 'pointer',
                      }}
                    >{communityBusy ? '…' : '重算'}</button>
                  </span>
                </div>
                {communityNote && (
                  <div style={{ fontSize: '11px', color: 'var(--text-dim)', marginTop: '2px' }}>{communityNote}</div>
                )}
              </div>
            </div>
          )}

          {/* ADR-007：主题社区——关系密集的实体簇，给「这个词属于哪条主线」一个答案 */}
          {communities.length > 0 && (
            <div style={{ marginTop: '16px', paddingTop: '16px', borderTop: '1px solid var(--card-border)' }}>
              <div style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: '4px', textTransform: 'uppercase' }}>
                主题社区 · {communities.length}
              </div>
              <div style={{ fontSize: '11px', color: 'var(--text-dim)', marginBottom: '8px' }}>
                关系密集的实体簇，内聚度越高说明社区越「纯粹」
              </div>
              {communities.map((community: any) => (
                <div key={community.id} style={{ marginBottom: '9px', fontSize: '12px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span style={{ color: 'var(--text)' }}>社区 #{community.id}</span>
                    <span style={{ color: 'var(--text-dim)', fontSize: '11px' }}>
                      {community.size} 实体 · 内聚 {Number(community.cohesion || 0).toFixed(2)}
                    </span>
                  </div>
                  <div style={{ color: 'var(--accent)', fontSize: '11px', marginTop: '2px' }}>
                    {(community.top_entities || []).join(' · ')}
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* L1：目录下钻——把空间切成目录粒度，避免大空间糊成一团 */}
          {level === 'space' && folders.length > 0 && (
            <div style={{ marginTop: '16px', paddingTop: '16px', borderTop: '1px solid var(--card-border)' }}>
              <div style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: '6px', textTransform: 'uppercase' }}>目录下钻</div>
              <div style={{ maxHeight: '150px', overflowY: 'auto' }}>
                {folders.map((f: any) => {
                  const active = folderPath === f.path
                  return (
                    <div key={f.id ?? f.path}
                      onClick={() => setFolderPath(active ? null : f.path)}
                      className="truncate"
                      title={f.path}
                      style={{
                        cursor: 'pointer', fontSize: '11px', padding: '3px 6px', borderRadius: '4px', marginBottom: '2px',
                        background: active ? 'var(--primary)' : 'var(--bg)',
                        color: active ? 'white' : 'var(--text-secondary)',
                      }}>
                      {f.path || f.name}
                      <span style={{ color: active ? 'rgba(255,255,255,0.7)' : 'var(--text-dim)' }}> · {f.doc_count ?? 0}</span>
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          {/* L1：跨域桥——本空间与其他空间共享的实体，是「空间之间为什么算相似」的唯一凭据 */}
          {level === 'space' && bridges.length > 0 && (
            <div style={{ marginTop: '16px', paddingTop: '16px', borderTop: '1px solid var(--card-border)' }}>
              <div style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: '4px', textTransform: 'uppercase' }}>
                跨域桥 · {bridges.length}
              </div>
              <div style={{ fontSize: '11px', color: 'var(--text-dim)', marginBottom: '8px' }}>与其他空间共享的实体</div>
              {bridges.map((b: any) => (
                <div key={`${b.node_type || 'entity'}:${b.id}`} style={{ marginBottom: '9px', fontSize: '12px' }}>
                  <span onClick={() => setFocusEntity({ node_type: 'entity', id: b.id, label: b.name })}
                    style={{ cursor: 'pointer', color: 'var(--accent)', fontWeight: 500 }}>
                    {b.name}
                  </span>
                  {b.type && <span style={{ color: 'var(--text-dim)', fontSize: '11px' }}> · {b.type}</span>}
                  <div style={{ marginTop: '2px' }}>
                    {(b.space_refs || []).map((r: any) => {
                      const mine = Number(r.source_id) === Number(spaceId)
                      return (
                        <span key={r.source_id}
                          onClick={() => { if (!mine) enterSpace({ space_id: r.source_id, label: r.source_name }) }}
                          style={{
                            display: 'inline-block', marginRight: '4px', marginBottom: '3px', fontSize: '11px',
                            padding: '1px 6px', borderRadius: '999px',
                            border: '1px solid var(--card-border)',
                            cursor: mine ? 'default' : 'pointer',
                            color: mine ? 'var(--text)' : 'var(--primary)',
                            background: mine ? 'var(--bg)' : 'transparent',
                          }}>
                          {r.source_name}{mine ? '（本空间）' : ''} ×{r.mentions ?? 0}
                        </span>
                      )
                    })}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Right floating panel: Node detail */}
      {selectedNode && (
        <div className="absolute top-4 right-4 rounded-xl p-4 max-h-full overflow-y-auto"
          style={{
            width: '280px', background: 'var(--glass)', backdropFilter: 'blur(20px)',
            border: '1px solid var(--card-border)', zIndex: 10, boxShadow: 'var(--shadow-lg)',
          }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
            <div style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>节点详情</div>
            <div onClick={() => setSelectedNode(null)}
              style={{ cursor: 'pointer', color: 'var(--text-dim)', fontSize: '16px', width: '20px', height: '20px', textAlign: 'center', lineHeight: '18px', borderRadius: '50%' }}
              onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--text)'; e.currentTarget.style.background = 'var(--bg)' }}
              onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--text-dim)'; e.currentTarget.style.background = 'transparent' }}>
              ×
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 12px', width: '56px', height: '56px', borderRadius: '50%', background: getNodeStyle(selectedNode.node_type).bg, color: 'var(--on-primary)', fontWeight: 700, fontSize: '16px', boxShadow: `0 0 20px ${getNodeStyle(selectedNode.node_type).bg}40` }}>
            {getNodeStyle(selectedNode.node_type).label}
          </div>
          <div style={{ textAlign: 'center', fontSize: '15px', fontWeight: 600, color: 'var(--text)', marginBottom: '4px' }}>
            {selectedNode.label || selectedNode.title || selectedNode.name}
          </div>
          <div style={{ textAlign: 'center', fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '16px' }}>
            {selectedNode.node_type} / {selectedNode.type || selectedNode.file_type || '-'}
          </div>
          {/* 空间节点：只提供下钻入口，不提供关系编辑（空间之间的关系是派生出来的，不可手改） */}
          {selectedNode.node_type === 'space' && (
            <div style={{ textAlign: 'center', marginBottom: '16px' }}>
              <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '10px' }}>
                {selectedNode.doc_count ?? 0} 篇文档 · {selectedNode.folder_count ?? 0} 个目录
              </div>
              <button onClick={() => enterSpace(selectedNode)}
                style={{
                  border: '1px solid var(--primary)', background: 'transparent', color: 'var(--primary)',
                  cursor: 'pointer', borderRadius: 6, fontSize: '12px', padding: '6px 16px',
                }}>进入该空间 ›</button>
            </div>
          )}
          {selectedNode.storage_type && (
            <div style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px solid var(--card-border)', fontSize: '12px' }}>
              <span style={{ color: 'var(--text-secondary)' }}>来源</span>
              <span style={{ color: 'var(--text)' }}>{selectedNode.storage_type === 'local' ? '本地' : '引用'}</span>
            </div>
          )}
          {selectedNode.file_size && (
            <div style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px solid var(--card-border)', fontSize: '12px' }}>
              <span style={{ color: 'var(--text-secondary)' }}>大小</span>
              <span style={{ color: 'var(--text)' }}>{(selectedNode.file_size / 1024 / 1024).toFixed(2)} MB</span>
            </div>
          )}
          {selectedNode.description && (
            <div style={{ padding: '8px 0', fontSize: '12px', color: 'var(--text-secondary)', lineHeight: 1.6 }}>
              {selectedNode.description}
            </div>
          )}

          {/* 重命名（仅实体）：关系走 id 关联，改名不会破坏图谱结构 */}
          {selectedNode.node_type === 'entity' && (
            <div style={{ borderTop: '1px solid var(--card-border)', paddingTop: '12px', marginTop: '8px' }}>
              <div style={{ fontSize: '11px', color: 'var(--text-dim)', marginBottom: '6px' }}>重命名实体</div>
              <div style={{ display: 'flex', gap: '6px' }}>
                <input value={renameValue} onChange={e => { setRenameValue(e.target.value); setEditMsg('') }}
                  onKeyDown={e => { if (e.key === 'Enter') applyRename() }}
                  placeholder="新的实体名称…" disabled={editBusy}
                  style={{ flex: 1, minWidth: 0, padding: '6px 8px', fontSize: '12px', borderRadius: 6, border: '1px solid var(--card-border)', background: 'var(--bg)', color: 'var(--text)' }} />
                <button disabled={editBusy || !renameValue.trim() || renameValue.trim() === (selectedNode.label || selectedNode.name || '')}
                  onClick={applyRename}
                  style={{
                    border: '1px solid var(--card-border)', background: 'transparent', cursor: 'pointer',
                    borderRadius: 4, fontSize: '11px', padding: '4px 10px',
                    color: editBusy || !renameValue.trim() ? 'var(--text-dim)' : 'var(--primary)',
                  }}>保存</button>
              </div>
              {editMsg && <div style={{ fontSize: '11px', color: 'var(--primary)', marginTop: '6px' }}>{editMsg}</div>}
              {editError && <div style={{ fontSize: '11px', color: '#ef4444', marginTop: '6px' }}>{editError}</div>}
            </div>
          )}

          {/* 别名（S2-08）：等义名共享给检索与消歧；删除别名不影响本体 */}
          {selectedNode.node_type === 'entity' && (
            <div style={{ borderTop: '1px solid var(--card-border)', paddingTop: '12px', marginTop: '8px' }}>
              <div style={{ fontSize: '11px', color: 'var(--text-dim)', marginBottom: '6px' }}>别名 · {aliases.length}</div>
              <div style={{ display: 'flex', gap: '6px', marginBottom: '6px' }}>
                <input value={aliasDraft} onChange={(e) => setAliasDraft(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') addAlias() }}
                  maxLength={200} placeholder="添加常出现的别称…" disabled={aliasBusy}
                  style={{ flex: 1, minWidth: 0, padding: '6px 8px', fontSize: '12px', borderRadius: 6, border: '1px solid var(--card-border)', background: 'var(--bg)', color: 'var(--text)' }} />
                <button disabled={aliasBusy || !aliasDraft.trim()} onClick={addAlias}
                  style={{
                    border: '1px solid var(--card-border)', background: 'transparent',
                    cursor: aliasBusy || !aliasDraft.trim() ? 'not-allowed' : 'pointer',
                    borderRadius: 4, fontSize: '11px', padding: '4px 10px',
                    color: aliasBusy || !aliasDraft.trim() ? 'var(--text-dim)' : 'var(--primary)',
                  }}>添加</button>
              </div>
              {aliases.length === 0 ? (
                <div style={{ fontSize: '11px', color: 'var(--text-dim)' }}>暂无别名。补充别称可减少实体重复建项。</div>
              ) : aliases.map((a: any) => (
                <div key={a.id} style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '3px 0', fontSize: '12px' }}>
                  <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--text)' }}>{a.alias}</span>
                  <span style={{ color: 'var(--text-dim)', fontSize: '10px', flexShrink: 0 }}>{a.source === 'merge' ? '合并产生' : '手动'}</span>
                  <button title="删除别名" disabled={aliasBusy} onClick={() => removeAlias(a.id)}
                    style={{ border: 'none', background: 'transparent', color: 'var(--text-dim)', cursor: 'pointer', padding: '0 2px', fontSize: '13px', lineHeight: 1 }}>×</button>
                </div>
              ))}
            </div>
          )}

          {/* 关系列表（可删除手动/自动关系；标签关联来自 document_tags，不可在此删） */}
          <div style={{ borderTop: '1px solid var(--card-border)', paddingTop: '12px', marginTop: '8px' }}>
            <div style={{ fontSize: '11px', color: 'var(--text-dim)', marginBottom: '6px' }}>关联关系 · {nodeEdges.length}</div>
            {nodeEdges.length === 0 && <div style={{ fontSize: '12px', color: 'var(--text-dim)' }}>暂无关系</div>}
            {nodeEdges.map(e => (
              <div key={e.id} style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '3px 0', fontSize: '12px' }}>
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--text)' }}>
                  {otherEnd(e)}
                </span>
                <span style={{ color: 'var(--text-dim)', fontSize: '11px', flexShrink: 0 }}>{e.relation_type || 'TAGGED'}</span>
                {e.id > 0 && (
                  <button title="删除关系" disabled={editBusy} onClick={() => deleteEdge(e.id)}
                    style={{ border: 'none', background: 'transparent', color: 'var(--text-dim)', cursor: 'pointer', padding: '0 2px', fontSize: '13px', lineHeight: 1 }}>×</button>
                )}
              </div>
            ))}
          </div>

          {/* 添加关联 / 合并实体（空间节点不参与手工建边） */}
          {selectedNode.node_type !== 'space' && (
          <div style={{ borderTop: '1px solid var(--card-border)', paddingTop: '12px', marginTop: '8px' }}>
            <div style={{ fontSize: '11px', color: 'var(--text-dim)', marginBottom: '6px' }}>
              {selectedNode.node_type === 'entity' ? '添加关联 / 合并实体' : '添加关联'}
            </div>
            <div style={{ display: 'flex', gap: '6px', marginBottom: '6px' }}>
              <input value={relQuery} onChange={e => searchTargets(e.target.value)}
                placeholder="搜索节点名称…" disabled={editBusy}
                style={{ flex: 1, minWidth: 0, padding: '6px 8px', fontSize: '12px', borderRadius: 6, border: '1px solid var(--card-border)', background: 'var(--bg)', color: 'var(--text)' }} />
              <input value={relType} onChange={e => setRelType(e.target.value)}
                placeholder="关系类型" disabled={editBusy}
                style={{ width: '80px', padding: '6px 8px', fontSize: '12px', borderRadius: 6, border: '1px solid var(--card-border)', background: 'var(--bg)', color: 'var(--text)' }} />
            </div>
            {editError && <div style={{ fontSize: '11px', color: '#ef4444', marginBottom: '6px' }}>{editError}</div>}
            {relResults.filter(r => nodeKey(r) !== nodeKey(selectedNode)).slice(0, 6).map(r => (
              <div key={nodeKey(r)} style={{ display: 'flex', alignItems: 'center', gap: '4px', padding: '4px 6px', marginBottom: '2px', borderRadius: 6, background: 'var(--bg)', fontSize: '12px' }}>
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--text)' }}>{r.label}</span>
                <small style={{ color: 'var(--text-dim)' }}>
                  {r.node_type === 'document' ? (r.file_type || 'doc') : r.node_type === 'entity' ? (r.type || 'entity') : 'tag'}
                </small>
                <button disabled={editBusy} onClick={() => addRelation(r)}
                  style={{ border: '1px solid var(--card-border)', background: 'transparent', color: 'var(--primary)', cursor: 'pointer', borderRadius: 4, fontSize: '11px', padding: '1px 6px' }}>关联</button>
                {selectedNode.node_type === 'entity' && r.node_type === 'entity' && (
                  <button disabled={editBusy} onClick={() => mergeInto(r)}
                    style={{ border: '1px solid var(--card-border)', background: 'transparent', color: 'var(--accent, #a06cd5)', cursor: 'pointer', borderRadius: 4, fontSize: '11px', padding: '1px 6px' }}>合并</button>
                )}
              </div>
            ))}
          </div>
          )}
        </div>
      )}

      {/* 批量实体合并面板 */}
      {batchOpen && (
        <div className="absolute bottom-4 left-4 rounded-xl p-4 overflow-y-auto"
          style={{
            width: '300px', maxHeight: 'calc(100% - 120px)', background: 'var(--glass)', backdropFilter: 'blur(20px)',
            border: '1px solid var(--card-border)', zIndex: 11, boxShadow: 'var(--shadow-lg)',
          }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
            <div style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>批量合并实体</div>
            <div onClick={closeBatch}
              style={{ cursor: 'pointer', color: 'var(--text-dim)', fontSize: '16px', width: '20px', height: '20px', textAlign: 'center', lineHeight: '18px', borderRadius: '50%' }}
              onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--text)'; e.currentTarget.style.background = 'var(--bg)' }}
              onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--text-dim)'; e.currentTarget.style.background = 'transparent' }}>
              ×
            </div>
          </div>

          {/* 目标实体 */}
          <div style={{ fontSize: '11px', color: 'var(--text-dim)', marginBottom: '4px' }}>1. 目标实体（保留它）</div>
          {batchTarget ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '5px 8px', marginBottom: '8px', borderRadius: 6, background: 'var(--bg)', border: '1px solid var(--primary)', fontSize: '12px' }}>
              <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--text)' }}>{batchTarget.label}</span>
              <small style={{ color: 'var(--text-dim)' }}>{batchTarget.type || 'entity'}</small>
              <button disabled={editBusy} onClick={() => { setBatchTarget(null); setBatchTargetQuery(''); setBatchTargetResults([]) }}
                style={{ border: 'none', background: 'transparent', color: 'var(--text-dim)', cursor: 'pointer', padding: '0 2px', fontSize: '13px', lineHeight: 1 }}>×</button>
            </div>
          ) : (
            <>
              <input value={batchTargetQuery} onChange={e => searchBatchTarget(e.target.value)}
                placeholder="搜索目标实体…" disabled={editBusy}
                style={{ width: '100%', boxSizing: 'border-box', padding: '6px 8px', fontSize: '12px', borderRadius: 6, border: '1px solid var(--card-border)', background: 'var(--bg)', color: 'var(--text)' }} />
              {batchTargetResults.slice(0, 5).map(r => (
                <div key={nodeKey(r)} style={{ display: 'flex', alignItems: 'center', gap: '4px', padding: '4px 6px', marginTop: '2px', borderRadius: 6, background: 'var(--bg)', fontSize: '12px' }}>
                  <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--text)' }}>{r.label}</span>
                  <small style={{ color: 'var(--text-dim)' }}>{r.type || 'entity'}</small>
                  <button disabled={editBusy} onClick={() => { setBatchTarget(r); setBatchTargetQuery(''); setBatchTargetResults([]) }}
                    style={{ border: '1px solid var(--card-border)', background: 'transparent', color: 'var(--primary)', cursor: 'pointer', borderRadius: 4, fontSize: '11px', padding: '1px 6px' }}>设为目标</button>
                </div>
              ))}
            </>
          )}

          {/* 待合并实体 */}
          <div style={{ fontSize: '11px', color: 'var(--text-dim)', margin: '12px 0 4px' }}>
            2. 待合并实体（已选 {batchSelected.length}）
          </div>
          <input value={batchQuery} onChange={e => searchBatchEntities(e.target.value)}
            placeholder="搜索实体并点击加入…" disabled={editBusy}
            style={{ width: '100%', boxSizing: 'border-box', padding: '6px 8px', fontSize: '12px', borderRadius: 6, border: '1px solid var(--card-border)', background: 'var(--bg)', color: 'var(--text)' }} />
          {batchResults.filter(r => !batchSelected.some(x => nodeKey(x) === nodeKey(r))).slice(0, 6).map(r => (
            <div key={nodeKey(r)} style={{ display: 'flex', alignItems: 'center', gap: '4px', padding: '4px 6px', marginTop: '2px', borderRadius: 6, background: 'var(--bg)', fontSize: '12px' }}>
              <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--text)' }}>{r.label}</span>
              <small style={{ color: 'var(--text-dim)' }}>{r.type || 'entity'}</small>
              <button disabled={editBusy} onClick={() => toggleBatchEntity(r)}
                style={{ border: '1px solid var(--card-border)', background: 'transparent', color: 'var(--primary)', cursor: 'pointer', borderRadius: 4, fontSize: '11px', padding: '1px 6px' }}>加入</button>
            </div>
          ))}

          {/* 已选芯片 */}
          {batchSelected.length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px', marginTop: '8px' }}>
              {batchSelected.map(n => {
                const isTarget = !!batchTarget && nodeKey(n) === nodeKey(batchTarget)
                return (
                  <span key={nodeKey(n)}
                    style={{
                      display: 'inline-flex', alignItems: 'center', gap: '4px', maxWidth: '100%',
                      padding: '2px 6px', borderRadius: 999, fontSize: '11px',
                      background: isTarget ? 'var(--primary)' : 'var(--bg)',
                      color: isTarget ? 'white' : 'var(--text-secondary)',
                      border: '1px solid var(--card-border)',
                    }}>
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '160px' }}>
                      {isTarget ? '★ ' : ''}{n.label}
                    </span>
                    <span onClick={() => toggleBatchEntity(n)} style={{ cursor: 'pointer', lineHeight: 1 }}>×</span>
                  </span>
                )
              })}
            </div>
          )}

          {editError && <div style={{ fontSize: '11px', color: '#ef4444', marginTop: '8px' }}>{editError}</div>}
          {editMsg && <div style={{ fontSize: '11px', color: 'var(--primary)', marginTop: '8px' }}>{editMsg}</div>}

          <button disabled={editBusy || !batchTarget || batchSelected.length === 0}
            onClick={runBatchMerge}
            style={{
              width: '100%', marginTop: '12px', padding: '8px', borderRadius: 8, border: 'none',
              fontSize: '12px', fontWeight: 600,
              cursor: editBusy || !batchTarget || batchSelected.length === 0 ? 'not-allowed' : 'pointer',
              background: editBusy || !batchTarget || batchSelected.length === 0 ? 'var(--bg)' : 'var(--accent, #a06cd5)',
              color: editBusy || !batchTarget || batchSelected.length === 0 ? 'var(--text-dim)' : 'white',
            }}>
            {editBusy ? '处理中…' : '执行合并'}
          </button>
          <div style={{ fontSize: '11px', color: 'var(--text-dim)', marginTop: '8px', lineHeight: 1.6 }}>
            目标实体本身不会被删除；其余实体的关系会转移到目标实体并自动去重。全部合并在单个事务内完成。
          </div>
        </div>
      )}

      {/* 实体消歧候选建议面板 */}
      {suggestOpen && (
        <div className="absolute left-4 rounded-xl p-4 overflow-y-auto"
          style={{
            bottom: '80px', width: '320px', maxHeight: 'calc(100% - 160px)',
            background: 'var(--glass)', backdropFilter: 'blur(20px)',
            border: '1px solid var(--card-border)', zIndex: 12, boxShadow: 'var(--shadow-lg)',
          }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
            <div style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
              消歧候选建议
            </div>
            <button onClick={() => setSuggestOpen(false)}
              style={{ border: 'none', background: 'transparent', color: 'var(--text-dim)', cursor: 'pointer', fontSize: '16px', lineHeight: 1 }}>
              ×
            </button>
          </div>

          {suggestLoading ? (
            <div style={{ fontSize: '12px', color: 'var(--text-dim)', padding: '8px 0' }}>正在比对实体名称…</div>
          ) : suggestPending.length === 0 ? (
            <div style={{ fontSize: '12px', color: 'var(--text-dim)', lineHeight: 1.7 }}>
              {suggestResult
                ? `已扫描 ${suggestResult.scanned} 个实体，暂未发现疑似重复项。`
                : '正在准备…'}
            </div>
          ) : (
            <>
              <div style={{ fontSize: '11px', color: 'var(--text-dim)', marginBottom: '8px', lineHeight: 1.6 }}>
                扫描 {suggestResult.scanned} 个实体，命中 {suggestResult.matched} 组候选
                {suggestResult.truncated ? '，仅显示前 50 组' : ''}
              </div>
              {suggestPending.map((s: any) => {
                const badgeColor = s.reason === 'exact' ? '#00dc6e' : s.reason === 'containment' ? '#a06cd5' : '#9aa0a8'
                return (
                  <div key={pairKey(s)}
                    style={{ padding: '8px', marginBottom: '6px', borderRadius: '8px', background: 'var(--bg)', border: '1px solid var(--card-border)' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px' }}>
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--text-dim)' }}>
                        {s.source.name}
                      </span>
                      <span style={{ color: 'var(--text-dim)' }}>→</span>
                      <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--text)' }}>
                        {s.target.name}
                      </span>
                      <span title={`${s.reason} · ${s.score}`}
                        style={{ flexShrink: 0, fontSize: '10px', padding: '1px 5px', borderRadius: '4px', color: badgeColor, border: `1px solid ${badgeColor}` }}>
                        {s.score.toFixed(2)}
                      </span>
                    </div>
                    <div style={{ fontSize: '11px', color: 'var(--text-dim)', margin: '4px 0 6px', lineHeight: 1.5 }}>
                      {s.detail}
                    </div>
                    <div style={{ display: 'flex', gap: '6px' }}>
                      <button disabled={editBusy} onClick={() => mergeSuggestion(s)}
                        style={chipBtn('var(--accent, #a06cd5)')}>合并</button>
                      <button disabled={editBusy} onClick={() => swapSuggestion(s)}
                        style={chipBtn('var(--text-secondary)')}>反向</button>
                      <button disabled={editBusy} onClick={() => ignoreSuggestion(s)} title="这两个名称不是同一个实体，记下来以后不再提示"
                        style={chipBtn('var(--text-dim)')}>不再提示</button>
                    </div>
                  </div>
                )
              })}
              <div style={{ fontSize: '11px', color: 'var(--text-dim)', marginTop: '8px', lineHeight: 1.6 }}>
                规则层只能提示、不能判定：「苹果公司」与「苹果手机」这类同形异义需人工确认。
                合并前请核对右侧目标实体是否为规范名。
              </div>

              {/* 合并历史（S2-08）：每次合并落库可回看，幸存者后来被并走/删除时名字留空 */}
              <div style={{ marginTop: '10px', borderTop: '1px solid var(--card-border)', paddingTop: '8px' }}>
                <button
                  onClick={() => { const next = !showHistory; setShowHistory(next); if (next) loadMergeHistory() }}
                  style={chipBtn('var(--text-secondary)')}>
                  {showHistory ? '收起合并历史' : '查看合并历史'}
                </button>
                {showHistory && (
                  <div style={{ marginTop: '6px' }}>
                    {mergeHistory.length === 0 ? (
                      <div style={{ fontSize: '11px', color: 'var(--text-dim)' }}>还没有合并记录。</div>
                    ) : mergeHistory.map((h: any) => (
                      <div key={h.id} style={{ fontSize: '11px', color: 'var(--text-dim)', padding: '3px 0', lineHeight: 1.6 }}>
                        「{h.merged_name}」并入「{h.survivor_name || '（已删除）'}」
                        {h.edges_relocated ? ` · 转移 ${h.edges_relocated} 条关系` : ''}
                        {fmtTimeSuffix(h.created_at)}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      )}

      {/* Bottom layout switch */}
      <div className="absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full p-1 flex gap-0.5"
        style={{ background: 'var(--glass)', backdropFilter: 'blur(20px)', border: '1px solid var(--card-border)', zIndex: 10, boxShadow: 'var(--shadow)' }}>
        {[
          { key: 'force', label: '力导向' },
          { key: 'circular', label: '环形' },
        ].map(item => (
          <button key={item.key}
            onClick={() => setLayout(item.key as any)}
            className="rounded-full text-xs transition-all"
            style={{ padding: '8px 16px', background: layout === item.key ? 'var(--primary)' : 'transparent', color: layout === item.key ? 'white' : 'var(--text-secondary)', border: 'none', cursor: 'pointer' }}>
            {item.label}
          </button>
        ))}
        <div style={{ width: '1px', background: 'var(--card-border)', margin: '4px 2px' }} />
        <button onClick={() => { if (batchOpen) { closeBatch(); return } setSuggestOpen(false); setBatchOpen(true) }}
          className="rounded-full text-xs transition-all"
          style={{
            padding: '8px 14px', border: 'none', cursor: 'pointer',
            background: batchOpen ? 'var(--accent, #a06cd5)' : 'transparent',
            color: batchOpen ? 'white' : 'var(--text-secondary)',
          }}>
          批量合并{batchSelected.length > 0 ? ` (${batchSelected.length})` : ''}
        </button>
        <button onClick={openSuggest}
          className="rounded-full text-xs transition-all"
          style={{
            padding: '8px 14px', border: 'none', cursor: 'pointer',
            background: suggestOpen ? 'var(--accent, #a06cd5)' : 'transparent',
            color: suggestOpen ? 'white' : 'var(--text-secondary)',
          }}>
          消歧建议{suggestPending.length > 0 ? ` (${suggestPending.length})` : ''}
        </button>
        <div style={{ width: '1px', background: 'var(--card-border)', margin: '4px 2px' }} />
        <button onClick={loadGraph}
          className="rounded-full text-xs transition-all"
          style={{ padding: '8px 14px', background: 'transparent', color: 'var(--text-secondary)', border: 'none', cursor: 'pointer' }}>
          刷新
        </button>
      </div>
    </div>
  )
}
