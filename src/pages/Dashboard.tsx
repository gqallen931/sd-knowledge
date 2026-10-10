import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { EChartsOption } from 'echarts'
import Chart from '../components/Chart'

/**
 * ECharts 走 Canvas，读不到 CSS 变量：这里从 index.css 的图表色板令牌取实际值。
 * 主题切换是给 documentElement 加/去 .light，所以订阅它的 class 变化后重取，
 * 浅色主题下图表才会跟着换成压深的语义色。
 */
const CHART_TOKENS = ['--chart-1', '--chart-2', '--chart-3', '--chart-4', '--chart-5', '--chart-6', '--chart-7', '--chart-8']
interface ChartTokens { palette: string[]; axisText: string; titleText: string; gridLine: string }
function readChartTokens(): ChartTokens {
  const style = getComputedStyle(document.documentElement)
  const value = (name: string) => style.getPropertyValue(name).trim()
  return {
    palette: CHART_TOKENS.map(value),
    axisText: value('--text-secondary'),
    titleText: value('--text'),
    gridLine: value('--card-border'),
  }
}
const labels: Record<string, string> = { person: '人物', organization: '组织', location: '地点', date: '日期', concept: '概念', email: '邮箱', url: '链接' }
const size = (n: number) => n >= 1073741824 ? `${(n / 1073741824).toFixed(1)} GB` : n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${(n / 1024).toFixed(1)} KB`
export default function Dashboard() {
  const navigate = useNavigate()
  const [stats, setStats] = useState<any>(null)
  const [recent, setRecent] = useState<any[]>([])
  const [error, setError] = useState('')
  const [days, setDays] = useState(30)
  const [tokens, setTokens] = useState(readChartTokens)
  useEffect(() => {
    const observer = new MutationObserver(() => setTokens(readChartTokens()))
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
    return () => observer.disconnect()
  }, [])
  const palette = tokens.palette
  const axisText = tokens.axisText
  const load = async () => {
    try { const [s, r] = await Promise.all([window.sd.dashboard.stats(), window.sd.dashboard.recent()]); setStats(s); setRecent(r); setError('') }
    catch (e: any) { console.error('Dashboard load error:', e); setError('无法连接本地服务，请确认软件正在运行后重试') }
  }
  useEffect(() => {
    load()
    const timer = setInterval(() => { if (!document.hidden) load() }, 5000)
    const onVisible = () => { if (!document.hidden) load() }
    document.addEventListener('visibilitychange', onVisible)
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', onVisible) }
  }, [])
  const trend = (stats?.trend || []).slice(-days)
  const common: EChartsOption = { color: palette, animationDuration: 600, textStyle: { fontFamily: 'Inter, PingFang SC, Microsoft YaHei, sans-serif' }, tooltip: { trigger: 'item', renderMode: 'richText' } }
  const line: EChartsOption = { ...common, tooltip: { trigger: 'axis', renderMode: 'richText' }, grid: { left: 12, right: 16, top: 24, bottom: 8, containLabel: true }, xAxis: { type: 'category', boundaryGap: false, data: trend.map((d: any) => d.day.slice(5)), axisLine: { show: false }, axisTick: { show: false }, axisLabel: { color: axisText, margin: 14 } }, yAxis: { type: 'value', minInterval: 1, splitLine: { lineStyle: { color: tokens.gridLine, type: 'dashed' } }, axisLabel: { color: axisText } }, series: [{ name: '导入文件', type: 'line', smooth: 0.3, symbol: 'circle', symbolSize: 7, showSymbol: days <= 7, lineStyle: { width: 3 }, areaStyle: { color: { type: 'linear', x: 0, y: 0, x2: 0, y2: 1, colorStops: [{ offset: 0, color: `${palette[0]}50` }, { offset: 1, color: `${palette[0]}02` }] } }, data: trend.map((d: any) => d.files) }] }
  const donut: EChartsOption = { ...common, legend: { bottom: 0, icon: 'circle', itemWidth: 8, itemHeight: 8, textStyle: { color: axisText } }, title: { text: String(stats?.total_files || 0), subtext: '全部文件', left: 'center', top: '31%', textStyle: { color: tokens.titleText, fontSize: 30, fontWeight: 600 }, subtextStyle: { color: axisText, fontSize: 11 } }, series: [{ type: 'pie', radius: ['58%', '77%'], center: ['50%', '43%'], padAngle: 5, itemStyle: { borderRadius: 7 }, label: { show: false }, data: stats?.file_types || [] }] }
  const entities: EChartsOption = { ...common, series: [{ type: 'treemap', roam: false, nodeClick: false, breadcrumb: { show: false }, left: 0, top: 12, right: 0, bottom: 0, label: { formatter: '{b}\n{c}', lineHeight: 25, fontSize: 13 }, itemStyle: { borderWidth: 3, borderColor: 'transparent', gapWidth: 5 }, data: (stats?.entity_types || []).map((d: any) => ({ ...d, name: labels[d.name] || d.name })) }] }
  const graph: EChartsOption = { ...line, color: [palette[1], palette[3]], legend: { right: 0, top: 0, textStyle: { color: axisText }, icon: 'circle' }, grid: { left: 12, right: 12, top: 44, bottom: 8, containLabel: true }, series: ['entities', 'relationships'].map((key, i) => ({ name: i === 0 ? '新增实体' : '新增关系', type: 'line', smooth: true, showSymbol: false, lineStyle: { width: 2.5 }, data: trend.map((d: any) => d[key]) })) }
  const totalBytes = (stats?.storage || []).reduce((sum: number, d: any) => sum + d.value, 0)
  const ready = stats?.processing?.find((d: any) => d.name === 'ready')?.value || 0
  return <div className="dashboard page-scroll">
    <div className="page-heading"><div><div className="eyebrow">YOUR PERSONAL KNOWLEDGE SPACE</div><h1>知识概览<span className="heading-dot">.</span></h1><p>让分散的信息，成为相互连接的知识。</p></div><div className="heading-actions"><button className="button secondary" onClick={load}>↻ 刷新</button><button className="button primary" onClick={() => navigate('/files?import=1')}>＋ 导入文件</button></div></div>
    {error && <div className="error-banner" role="alert">数据加载失败：{error}<button onClick={load}>重试</button></div>}
    <div className="metric-grid">{[
      ['文件总量', stats?.total_files, '份', '本地导入与引用文件', '▤'],
      ['知识实体', stats?.total_entities, '个', '从文档中自动提取', '✧'],
      ['知识关联', stats?.total_relationships, '条', '文档与实体之间的连接', '⌘'],
      ['文件总大小', stats ? size(stats.total_size) : null, '', '含引用文件的源文件大小', '◈'],
    ].map(([label, value, unit, note, icon], i) => <div className="metric-card" key={label}><div className="metric-top"><span>{label}</span><span className="metric-icon" style={{ color: palette[i], background: `${palette[i]}18` }}>{icon}</span></div><div className="metric-value">{value ?? '—'}<small>{unit}</small></div><div className="metric-note">{note}</div></div>)}</div>
    <div className="dashboard-grid">
      <section className="panel trend-panel"><div className="panel-heading"><div><h2>知识积累</h2><p>每天导入的文件数量</p></div><div className="segmented">{[7, 30].map(n => <button className={days === n ? 'active' : ''} key={n} onClick={() => setDays(n)}>近 {n} 天</button>)}</div></div><Chart option={line} height="235px" /></section>
      <section className="panel"><div className="panel-heading"><div><h2>文件组成</h2><p>知识来源，一目了然</p></div><span className="pill">按数量</span></div>{stats?.total_files ? <Chart option={donut} height="235px" /> : <Empty text="导入第一份文件，开启知识积累" action={() => navigate('/files?import=1')} />}</section>
      <section className="panel"><div className="panel-heading"><div><h2>实体版图</h2><p>各类实体的数量与占比</p></div><span className="pill">{stats?.entity_types?.length || 0} 种类型</span></div>{stats?.total_entities ? <Chart option={entities} height="210px" /> : <Empty text="文档解析后将在这里呈现实体分布" />}</section>
      <section className="panel graph-trend-panel"><div className="panel-heading"><div><h2>连接的力量</h2><p>实体与关系的每日新增数量</p></div><button className="text-button" onClick={() => navigate('/graph')}>探索图谱 ↗</button></div><Chart option={graph} height="210px" /></section>
      <section className="panel recent-panel"><div className="panel-heading"><div><h2>最近导入</h2><p>每一份资料，都是新的起点</p></div><button className="text-button" onClick={() => navigate('/files')}>全部文件 →</button></div>{recent.length ? recent.slice(0, 5).map(f => <button className="recent-row" key={f.id} onClick={() => navigate(`/files?id=${f.id}`)}><span className="file-badge">{f.file_type.toUpperCase().slice(0, 4)}</span><span className="recent-name"><strong>{f.file_name}</strong><small>{f.storage_type === 'local' ? '本地导入' : '外部引用'} · {size(f.file_size || 0)}</small></span><span>↗</span></button>) : <Empty text="还没有文件，从一份笔记开始" action={() => navigate('/files?import=1')} />}</section>
      <section className="panel storage-panel"><div className="panel-heading"><div><h2>数据与处理</h2><p>来自本地数据库的实时状态</p></div><span className="status-dot" /></div><div className="storage-total">{size(totalBytes)}<small>文件总大小</small></div><div className="storage-track">{(stats?.storage || []).map((d: any, i: number) => <span key={d.name} style={{ width: `${totalBytes ? d.value / totalBytes * 100 : 0}%`, background: palette[i] }} />)}</div><div className="storage-legend">{(stats?.storage || []).map((d: any, i: number) => <span key={d.name}><i style={{ background: palette[i] }} />{d.name}<strong>{size(d.value)}</strong></span>)}</div><div className="health-row"><span>内容解析完成</span><strong>{ready} / {stats?.total_files ?? '—'}</strong></div><div className="health-row"><span>已生成语义向量</span><strong>{stats?.indexed_files ?? '—'} 份</strong></div><div className="health-row"><span>本地 API</span><strong className={stats?.api_running ? 'success-text' : ''}>{stats ? stats.api_running ? `运行中 · ${stats.api_port}` : '未运行' : '连接中'}</strong></div>{stats?.api_error && <p className="error-text">{stats.api_error}</p>}</section>
    </div><footer className="dashboard-footer"><span>◈ 数据存储在本机 · 统计每 5 秒更新</span><span>SD KNOWLEDGE / 工作与知识的连接处</span></footer>
  </div>
}
function Empty({ text, action }: { text: string; action?: () => void }) { return <div className="empty-state"><span className="empty-symbol">✧</span><p>{text}</p>{action && <button className="text-button" onClick={action}>导入文件 →</button>}</div> }
