import { useEffect, useMemo, useState } from 'react'

/**
 * 资源汇（开源项目卡片墙）。
 *
 * 展示从抖音 / 微信 / GitHub 收集、经整合的开源模型与技能资源：
 * 分类筛选 + 关键词搜索 + 卡片网格，点卡片看详情（能力描述与仓库链接）。
 * 数据来自内核域 `resources` 表（迁移 v5 + 种子数据），只读。
 */

interface ResourceItem {
  id: number
  name: string
  category: string
  description: string
  link: string | null
  tags: { subcategory?: string; links?: string[] }
}

interface ResourceCategory {
  category: string
  count: number
}

export default function Resources() {
  const [items, setItems] = useState<ResourceItem[]>([])
  const [categories, setCategories] = useState<ResourceCategory[]>([])
  const [active, setActive] = useState<string>('')
  const [query, setQuery] = useState('')
  const [detail, setDetail] = useState<ResourceItem | null>(null)
  const [error, setError] = useState('')

  // GitHub 每日榜单
  const [rankDate, setRankDate] = useState('')
  const [rankCategories, setRankCategories] = useState<Array<{ category: string; label: string; items: any[] }>>([])
  const [rankLoading, setRankLoading] = useState(false)
  const [rankError, setRankError] = useState('')
  const [rankTab, setRankTab] = useState<string>('')

  const load = async (category: string, search: string) => {
    try {
      const [list, cats] = await Promise.all([
        window.sd.resource.list({ category: category || undefined, search: search || undefined }),
        window.sd.resource.categories(),
      ])
      setItems(list || [])
      setCategories(cats || [])
    } catch (e: any) { setError(e?.message || String(e)) }
  }

  const loadRank = async (category?: string) => {
    setRankLoading(true)
    setRankError('')
    try {
      const result = await window.sd.githubRank.daily({ category })
      setRankDate(result.date)
      setRankCategories(result.categories)
      if (!rankTab && result.categories.length) setRankTab(result.categories[0].category)
    } catch (e: any) { setRankError(e?.message || '网络异常，请稍后重试') }
    finally { setRankLoading(false) }
  }

  const refreshRank = async () => {
    setRankLoading(true)
    setRankError('')
    try {
      const result = await window.sd.githubRank.refresh({ category: rankTab || undefined })
      setRankDate(result.date)
      setRankCategories(result.categories)
    } catch (e: any) { setRankError(e?.message || '刷新失败，请稍后重试') }
    finally { setRankLoading(false) }
  }

  useEffect(() => { void load(active, query) }, [active])
  useEffect(() => { void loadRank() }, [])

  const total = useMemo(() => categories.reduce((s, c) => s + c.count, 0), [categories])

  const search = () => void load(active, query)

  const openLink = (url: string) => {
    // 桌面版走系统浏览器；Web 模式直接新标签页
    const openExternal = (window.sd as any)?.shell?.openExternal
    if (typeof openExternal === 'function') void openExternal(url).catch(() => window.open(url, '_blank', 'noopener'))
    else window.open(url, '_blank', 'noopener')
  }

  const currentRankItems = rankCategories.find(c => c.category === rankTab)?.items || []

  return (
    <div className="page-scroll" style={{ padding: '22px 26px 26px' }}>
      <div className="page-heading">
        <div>
          <div className="eyebrow">OPEN SOURCE COLLECTION</div>
          <h1>资源汇<span className="heading-dot">.</span></h1>
          <p>收集的开源模型、技能与工具，共 {total} 条，按用途分类。</p>
        </div>
        <div className="heading-actions">
          <button className="button secondary" onClick={() => void load(active, query)}>↻ 刷新</button>
        </div>
      </div>

      {/* GitHub 每日榜单 */}
      <div className="panel" style={{ marginBottom: 16 }}>
        <div className="panel-heading">
          <div><h2>GitHub 每日榜单</h2><p>各领域 star 前 15 的开源项目 · 每日 08:00 自动更新{rankDate ? ` · 数据日期 ${rankDate}` : ''}</p></div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            {rankLoading && <span className="pill">加载中…</span>}
            <button className="button secondary" onClick={refreshRank} disabled={rankLoading}>↻ 刷新</button>
          </div>
        </div>
        {rankError && <div className="error-banner" role="alert">榜单加载失败：{rankError}<button onClick={() => void loadRank(rankTab || undefined)}>重试</button></div>}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 14 }}>
          {rankCategories.map(c => (
            <button
              key={c.category}
              className="pill"
              onClick={() => setRankTab(c.category)}
              style={rankTab === c.category ? { background: 'var(--primary)', color: 'var(--on-primary)', borderColor: 'var(--primary)' } : undefined}
            >{c.label}</button>
          ))}
        </div>
        {currentRankItems.length > 0 ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {currentRankItems.map((item: any) => (
              <button
                key={item.rank}
                onClick={() => openLink(item.url)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 12, padding: '10px 12px',
                  border: '1px solid var(--card-border)', borderRadius: 'var(--radius-m)',
                  background: 'var(--card-bg)', color: 'var(--text)', textAlign: 'left',
                  transition: 'background 0.18s var(--ease), border-color 0.18s var(--ease)',
                }}
                onMouseEnter={e => { e.currentTarget.style.background = 'var(--card-bg-hover)'; e.currentTarget.style.borderColor = 'var(--card-border-hover)' }}
                onMouseLeave={e => { e.currentTarget.style.background = 'var(--card-bg)'; e.currentTarget.style.borderColor = 'var(--card-border)' }}
              >
                <span style={{
                  width: 24, height: 24, borderRadius: 6, display: 'grid', placeItems: 'center',
                  background: item.rank <= 3 ? 'var(--primary-light)' : 'var(--inset-bg)',
                  color: item.rank <= 3 ? 'var(--primary)' : 'var(--text-note)',
                  fontWeight: 700, fontSize: 11, flexShrink: 0,
                }}>{item.rank}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600, fontSize: 12.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.full_name}</div>
                  <div style={{ fontSize: 11, color: 'var(--text-note)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.description || '暂无描述'}</div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
                  {item.language && <span className="pill" style={{ fontSize: 10 }}>{item.language}</span>}
                  <span style={{ fontSize: 12, color: 'var(--text-secondary)', fontVariantNumeric: 'tabular-nums' }}>★ {item.stars.toLocaleString()}</span>
                </div>
              </button>
            ))}
          </div>
        ) : (
          <div className="empty-state" style={{ minHeight: 120 }}>
            <span className="empty-symbol">✧</span>
            <p>{rankLoading ? '正在拉取 GitHub 数据…' : '暂无榜单数据，点击刷新获取'}</p>
          </div>
        )}
      </div>

      {/* 搜索 + 分类筛选 */}
      <div className="panel" style={{ marginBottom: 16 }}>
        <div className="panel-heading">
          <div><h2>筛选</h2><p>按分类与关键词过滤</p></div>
        </div>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
          <input
            value={query}
            placeholder="搜索名称或能力描述…"
            onChange={e => setQuery(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') search() }}
            style={{
              flex: 1, minWidth: 180, border: '1px solid var(--card-border)',
              color: 'var(--text)', background: 'rgba(255,255,255,0.04)',
              borderRadius: 9, padding: '9px 13px', fontSize: 12.5,
            }}
          />
          <button className="button" onClick={search}>搜索</button>
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 14 }}>
          <button
            className={`pill${active === '' ? ' pill--on' : ''}`}
            onClick={() => setActive('')}
            style={active === '' ? { background: 'var(--primary)', color: 'var(--on-primary)', borderColor: 'var(--primary)' } : undefined}
          >全部 · {total}</button>
          {categories.map(c => (
            <button
              key={c.category}
              className="pill"
              onClick={() => setActive(c.category)}
              style={active === c.category ? { background: 'var(--primary)', color: 'var(--on-primary)', borderColor: 'var(--primary)' } : undefined}
            >{c.category} · {c.count}</button>
          ))}
        </div>
      </div>

      {error && <div className="error-banner" role="alert">加载失败：{error}<button onClick={() => void load(active, query)}>重试</button></div>}

      {/* 卡片网格 */}
      <div className="panel">
        <div className="panel-heading">
          <div><h2>项目卡片</h2><p>{active ? `「${active}」分类下` : '全部'}共 {items.length} 条</p></div>
          <span className="pill">{active || '全部'}</span>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 14 }}>
          {items.map(item => (
            <button
              key={item.id}
              onClick={() => setDetail(item)}
              style={{
                textAlign: 'left', cursor: 'pointer', borderRadius: 'var(--radius-m)',
                padding: '14px 16px', border: '1px solid var(--card-border)',
                background: 'var(--card-bg)', color: 'var(--text)',
                display: 'flex', flexDirection: 'column', gap: 8, minHeight: 132,
                transition: 'background 0.18s var(--ease), transform 0.18s var(--ease), border-color 0.18s var(--ease)',
              }}
              onMouseEnter={e => { e.currentTarget.style.background = 'var(--card-bg-hover)'; e.currentTarget.style.transform = 'translateY(-1px)' }}
              onMouseLeave={e => { e.currentTarget.style.background = 'var(--card-bg)'; e.currentTarget.style.transform = 'none' }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: 11, color: 'var(--text-note)' }}>{item.tags?.subcategory || item.category}</span>
                {item.link && <span style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--primary)', boxShadow: '0 0 8px var(--primary)' }} title="有开源仓库" />}
              </div>
              <div style={{ fontWeight: 600, fontSize: 14, wordBreak: 'break-all' }}>{item.name}</div>
              <div style={{
                fontSize: 12, color: 'var(--text-note)', lineHeight: 1.55,
                display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden',
              }}>{item.description}</div>
            </button>
          ))}
          {!items.length && !error && (
            <div className="empty-state" style={{ gridColumn: '1 / -1' }}>
              <span className="empty-symbol">✧</span>
              <p>这个分类/关键词下没有资源。</p>
            </div>
          )}
        </div>
      </div>

      {/* 详情弹窗 */}
      {detail && (
        <div className="settings-modal__backdrop" onClick={() => setDetail(null)}>
          <div className="settings-modal__dialog" style={{ width: 'min(560px, 100%)' }} onClick={e => e.stopPropagation()}>
            <div className="settings-modal__titlebar">
              <div>
                <div style={{ fontSize: 11, color: 'var(--text-note)', marginBottom: 4 }}>
                  {detail.category}{detail.tags?.subcategory ? ` / ${detail.tags.subcategory}` : ''}
                </div>
                <h2 style={{ fontSize: 18, fontWeight: 700, color: 'var(--text)' }}>{detail.name}</h2>
              </div>
              <button className="settings-modal__close" onClick={() => setDetail(null)} aria-label="关闭">×</button>
            </div>
            <p style={{ margin: '14px 0', lineHeight: 1.7, color: 'var(--text-secondary)', fontSize: 13 }}>{detail.description}</p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'flex-start' }}>
              {(detail.tags?.links?.length ? detail.tags.links : detail.link ? [detail.link] : []).map(url => (
                <button key={url} className="button primary" onClick={() => openLink(url)}>
                  打开仓库 ↗ {url.replace(/^https?:\/\//, '').slice(0, 48)}
                </button>
              ))}
              {!detail.link && !(detail.tags?.links?.length) && (
                <span style={{ fontSize: 12, color: 'var(--text-note)' }}>暂未找到独立开源仓库，常见于对应技能合集。</span>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
