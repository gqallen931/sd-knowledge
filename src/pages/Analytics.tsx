import { useEffect, useMemo, useState } from 'react'
import type { SDAnalyticsOverview } from '../types/global'

/**
 * 智能分析（S2-02）：知识库规模总览 + 近 N 天入库 / 问答命中趋势。
 *
 * 数据全部来自 `analytics.overview`（服务端递归 CTE 补零日，本地不做口径计算）；
 * 样本不足时如实标注，不伪造趋势结论。
 */

const WINDOW_OPTIONS = [7, 14, 30]

function StatCard({ label, value, hint }: { label: string; value: number | string; hint?: string }) {
  return (
    <div className="panel" style={{ padding: '14px 16px', marginBottom: 0 }}>
      <div style={{ fontSize: 11.5, color: 'var(--text-note)' }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700, color: 'var(--text)', marginTop: 6, fontVariantNumeric: 'tabular-nums' }}>
        {typeof value === 'number' ? value.toLocaleString() : value}
      </div>
      {hint && <div style={{ fontSize: 11, color: 'var(--text-note)', marginTop: 4 }}>{hint}</div>}
    </div>
  )
}

/** 迷你柱状趋势：纯 CSS 实现，无图表库依赖 */
function TrendBars({ data, valueKey, color, label }: {
  data: Array<Record<string, any>>
  valueKey: string
  color: string
  label: string
}) {
  const max = Math.max(...data.map((row) => Number(row[valueKey] || 0)), 1)
  const total = data.reduce((sum, row) => sum + Number(row[valueKey] || 0), 0)
  const labelStep = data.length > 16 ? Math.ceil(data.length / 8) : 1
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 8 }}>
        <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{label}</span>
        <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)', fontVariantNumeric: 'tabular-nums' }}>
          {total.toLocaleString()} <span style={{ fontSize: 11, fontWeight: 400, color: 'var(--text-note)' }}>（峰值 {max === 1 && total === 0 ? 0 : max}）</span>
        </span>
      </div>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 3, height: 96 }}>
        {data.map((row) => {
          const value = Number(row[valueKey] || 0)
          return (
            <div
              key={row.date}
              title={`${row.date} · ${value}`}
              style={{
                flex: 1, minWidth: 3, height: `${Math.max((value / max) * 100, value > 0 ? 4 : 2)}%`,
                background: value > 0 ? color : 'var(--inset-bg)',
                borderRadius: '3px 3px 0 0',
                transition: 'height 0.2s var(--ease)',
              }}
            />
          )
        })}
      </div>
      <div style={{ display: 'flex', gap: 3, marginTop: 4 }}>
        {data.map((row, i) => (
          <div key={row.date} style={{ flex: 1, minWidth: 3, fontSize: 9, color: 'var(--text-note)', textAlign: 'center', overflow: 'hidden', whiteSpace: 'nowrap' }}>
            {i % labelStep === 0 ? row.date.slice(5).replace('-', '/') : ''}
          </div>
        ))}
      </div>
    </div>
  )
}

export default function Analytics() {
  const [data, setData] = useState<SDAnalyticsOverview | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [days, setDays] = useState(14)

  const load = async (windowDays: number) => {
    try {
      const result = await window.sd.analytics.overview({ days: windowDays })
      setData(result)
      setError('')
    } catch (e: any) { setError(e?.message || String(e)) }
    finally { setLoading(false) }
  }

  useEffect(() => { void load(days) }, [days])

  const lastQueryAt = useMemo(() => {
    if (!data?.queries.lastAt) return '—'
    // 服务端 CURRENT_TIMESTAMP 是 UTC 无时区标记，展示前补 Z 再转本地
    const raw = String(data.queries.lastAt)
    const value = /[zZ]|[+-]\d{2}:?\d{2}$/.test(raw) ? raw : `${raw.replace(' ', 'T')}Z`
    const parsed = new Date(value)
    return Number.isNaN(parsed.getTime()) ? raw : parsed.toLocaleString('zh-CN')
  }, [data])

  const totals = data?.totals

  return (
    <div className="page-scroll" style={{ padding: '22px 26px 26px' }}>
      <div className="page-heading">
        <div>
          <div className="eyebrow">ANALYTICS</div>
          <h1>智能分析<span className="heading-dot">.</span></h1>
          <p>知识库规模与问答命中趋势 · 趋势窗口 {data?.windowDays ?? days} 天</p>
        </div>
        <div className="heading-actions" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <div style={{ display: 'flex', gap: 4 }}>
            {WINDOW_OPTIONS.map((option) => (
              <button
                key={option}
                className="pill"
                onClick={() => setDays(option)}
                style={days === option ? { background: 'var(--primary)', color: 'var(--on-primary)', borderColor: 'var(--primary)' } : undefined}
              >{option} 天</button>
            ))}
          </div>
          <button className="button secondary" onClick={() => void load(days)}>↻ 刷新</button>
        </div>
      </div>

      {error && <div className="notice" role="alert" style={{ borderColor: 'var(--danger)' }}>加载失败：{error}</div>}
      {data && !data.sample.sufficient && (
        <div className="notice" role="status" style={{ borderColor: 'var(--warning)' }}>{data.sample.note}</div>
      )}

      {loading ? (
        <div className="empty-state" style={{ minHeight: 200 }}>
          <span className="empty-symbol">◔</span>
          <p>正在统计…</p>
        </div>
      ) : !data || !totals ? (
        <div className="empty-state" style={{ minHeight: 200 }}>
          <span className="empty-symbol">✧</span>
          <p>暂无统计数据，请先导入文档</p>
        </div>
      ) : (
        <>
          {/* 规模总览 */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 12, marginBottom: 16 }}>
            <StatCard label="文档" value={totals.documents} hint={`本地 ${totals.localFiles} · 引用 ${totals.referenceFiles}`} />
            <StatCard label="分块" value={totals.chunks} hint="检索的最小单元" />
            <StatCard label="实体" value={totals.entities} />
            <StatCard label="关系" value={totals.relationships} />
            <StatCard label="项目" value={totals.projects} />
            <StatCard label="已建向量索引" value={totals.indexedFiles} hint={`占文档 ${totals.documents ? Math.round((totals.indexedFiles * 100) / totals.documents) : 0}%`} />
          </div>

          {/* 问答命中面板 */}
          <div className="panel" style={{ marginBottom: 16 }}>
            <div className="panel-heading">
              <div><h2>问答命中</h2><p>读自 agent_query_logs，三个问答出口（界面 / REST / MCP）共用一份记录</p></div>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 12 }}>
              <div style={{ padding: '10px 12px', borderRadius: 'var(--radius-m)', background: 'var(--inset-bg)' }}>
                <div style={{ fontSize: 11, color: 'var(--text-note)' }}>窗口内问答次数</div>
                <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--text)', marginTop: 4, fontVariantNumeric: 'tabular-nums' }}>{data.queries.total.toLocaleString()}</div>
              </div>
              <div style={{ padding: '10px 12px', borderRadius: 'var(--radius-m)', background: 'var(--inset-bg)' }}>
                <div style={{ fontSize: 11, color: 'var(--text-note)' }}>平均命中块数</div>
                <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--text)', marginTop: 4, fontVariantNumeric: 'tabular-nums' }}>
                  {data.queries.avgResults == null ? '—' : data.queries.avgResults}
                </div>
              </div>
              <div style={{ padding: '10px 12px', borderRadius: 'var(--radius-m)', background: 'var(--inset-bg)' }}>
                <div style={{ fontSize: 11, color: 'var(--text-note)' }}>平均响应耗时</div>
                <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--text)', marginTop: 4, fontVariantNumeric: 'tabular-nums' }}>
                  {data.queries.avgLatencyMs == null ? '—' : `${data.queries.avgLatencyMs} ms`}
                </div>
              </div>
              <div style={{ padding: '10px 12px', borderRadius: 'var(--radius-m)', background: 'var(--inset-bg)' }}>
                <div style={{ fontSize: 11, color: 'var(--text-note)' }}>最近一次问答</div>
                <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)', marginTop: 7 }}>{lastQueryAt}</div>
              </div>
            </div>
          </div>

          {/* 趋势 */}
          <div className="panel">
            <div className="panel-heading">
              <div><h2>趋势</h2><p>近 {data.windowDays} 天逐日统计（缺失日补零）</p></div>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 28 }}>
              <TrendBars data={data.trend} valueKey="documents" color="var(--primary)" label="文档入库" />
              <TrendBars data={data.trend} valueKey="queries" color="var(--success)" label="问答次数" />
            </div>
          </div>
        </>
      )}
    </div>
  )
}
