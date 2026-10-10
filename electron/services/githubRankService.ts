import DatabaseService from './database'

/**
 * GitHub 每日榜单服务：每天按领域拉取 star 前 15 的开源项目。
 *
 * 数据来自 GitHub Search API，按 stargazers_count 排序，每天缓存一份快照到本地表。
 * 无网络或 API 失败时返回上次缓存，绝不阻塞页面。
 *
 * 自动更新（S2 扩展）：应用运行期间每天 08:00 定时刷新全部领域；
 * 启动时若当天还没有快照，延迟 10s 后台补拉一次——应用没开的日子不刷，下次启动自动补上。
 */

export interface GithubRankItem {
  rank: number
  repo_name: string
  full_name: string
  description: string | null
  stars: number
  language: string | null
  url: string
}

export interface GithubRankCategory {
  category: string
  label: string
  query: string
}

const CATEGORIES: GithubRankCategory[] = [
  { category: 'ai', label: 'AI / 机器学习', query: 'topic:machine-learning topic:deep-learning topic:artificial-intelligence' },
  { category: 'web', label: 'Web 开发', query: 'topic:web topic:react topic:vue topic:frontend' },
  { category: 'devops', label: 'DevOps / 运维', query: 'topic:devops topic:docker topic:kubernetes topic:ci-cd' },
  { category: 'database', label: '数据库', query: 'topic:database topic:sql topic:nosql' },
  { category: 'security', label: '安全', query: 'topic:security topic:cryptography topic:penetration-testing' },
  { category: 'mobile', label: '移动端', query: 'topic:android topic:ios topic:flutter topic:react-native' },
  { category: 'game', label: '游戏开发', query: 'topic:game-development topic:unity topic:unreal-engine' },
  { category: 'blockchain', label: '区块链', query: 'topic:blockchain topic:web3 topic:smart-contracts' },
]

const DAY_MS = 24 * 60 * 60 * 1000

export class GithubRankService {
  private refreshTimer: ReturnType<typeof setTimeout> | null = null

  constructor(private db: DatabaseService) {}

  /** 启动每日定时刷新：每天 hour 点整拉取全部领域榜单（应用运行期间生效） */
  scheduleDaily(hour = 8) {
    if (this.refreshTimer) return
    const msUntilNextRun = () => {
      const now = new Date()
      const next = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, 0, 0, 0)
      if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1)
      return next.getTime() - now.getTime()
    }
    const tick = async () => {
      try { await this.refreshNow() } catch (e) { console.error('[github-rank] 每日定时刷新失败:', e) }
      this.refreshTimer = setTimeout(tick, DAY_MS)
      ;(this.refreshTimer as any)?.unref?.()
    }
    this.refreshTimer = setTimeout(tick, msUntilNextRun())
    ;(this.refreshTimer as any)?.unref?.()
  }

  /** 启动补拉：当天还没有快照时，延迟后台拉一次（避免拖慢启动） */
  catchUp(delayMs = 10_000) {
    const today = localDate()
    const row = this.db.prepare('SELECT COUNT(*) as n FROM github_rank_snapshots WHERE snapshot_date = ?').get(today) as any
    if (row?.n > 0) return
    const t = setTimeout(() => { this.refresh(today).catch(() => {}) }, delayMs)
    ;(t as any)?.unref?.()
  }

  /** 获取今日榜单：优先读缓存，过期或缺失则后台刷新 */
  async getDailyRank(category?: string): Promise<{ date: string; categories: Array<{ category: string; label: string; items: GithubRankItem[] }> }> {
    const today = localDate()
    const cached = this.readSnapshot(today, category)
    if (cached.length > 0) {
      // 后台异步刷新（不阻塞返回）
      void this.refreshIfStale(today)
      return { date: today, categories: this.groupByCategory(cached) }
    }
    // 无缓存时同步拉取
    await this.refresh(today, category)
    const fresh = this.readSnapshot(today, category)
    return { date: today, categories: this.groupByCategory(fresh) }
  }

  /** 强制刷新（手动触发） */
  async refreshNow(category?: string): Promise<{ date: string; categories: Array<{ category: string; label: string; items: GithubRankItem[] }> }> {
    const today = localDate()
    await this.refresh(today, category)
    const items = this.readSnapshot(today, category)
    return { date: today, categories: this.groupByCategory(items) }
  }

  /** 可用分类列表 */
  listCategories(): GithubRankCategory[] {
    return CATEGORIES
  }

  private readSnapshot(date: string, category?: string): Array<GithubRankItem & { category: string }> {
    let sql = `SELECT category, rank, repo_name, full_name, description, stars, language, url
               FROM github_rank_snapshots WHERE snapshot_date = ?`
    const params: any[] = [date]
    if (category) { sql += ' AND category = ?'; params.push(category) }
    sql += ' ORDER BY category, rank'
    return this.db.prepare(sql).all(...params) as any[]
  }

  private groupByCategory(rows: Array<GithubRankItem & { category: string }>) {
    const map = new Map<string, GithubRankItem[]>()
    for (const row of rows) {
      const list = map.get(row.category) || []
      list.push({ rank: row.rank, repo_name: row.repo_name, full_name: row.full_name, description: row.description, stars: row.stars, language: row.language, url: row.url })
      map.set(row.category, list)
    }
    return CATEGORIES.filter(c => map.has(c.category)).map(c => ({ category: c.category, label: c.label, items: map.get(c.category)! }))
  }

  /** 缓存超过 1 天则刷新 */
  private async refreshIfStale(today: string) {
    // created_at 是 SQLite CURRENT_TIMESTAMP（UTC 无时区标记），需补 Z 按 UTC 解析，否则时区偏差会提前触发
    const row = this.db.prepare('SELECT MAX(created_at) as latest FROM github_rank_snapshots WHERE snapshot_date = ?').get(today) as any
    if (!row?.latest) return
    const age = Date.now() - new Date(String(row.latest).replace(' ', 'T') + 'Z').getTime()
    if (age > DAY_MS) await this.refresh(today).catch(() => {})
  }

  /** 从 GitHub API 拉取并写入缓存 */
  private async refresh(date: string, categoryFilter?: string) {
    const targets = categoryFilter ? CATEGORIES.filter(c => c.category === categoryFilter) : CATEGORIES
    for (const cat of targets) {
      try {
        const items = await fetchTopRepos(cat.query, 15)
        this.saveSnapshot(date, cat.category, items)
      } catch (e) {
        console.error(`[github-rank] 拉取 ${cat.category} 失败:`, e)
      }
    }
  }

  private saveSnapshot(date: string, category: string, items: GithubRankItem[]) {
    this.db.transaction(() => {
      // 先清掉旧数据，保证幂等
      this.db.prepare('DELETE FROM github_rank_snapshots WHERE snapshot_date = ? AND category = ?').run(date, category)
      const stmt = this.db.prepare(`
        INSERT INTO github_rank_snapshots (snapshot_date, category, rank, repo_name, full_name, description, stars, language, url)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      for (const item of items) {
        stmt.run(date, category, item.rank, item.repo_name, item.full_name, item.description, item.stars, item.language, item.url)
      }
    })
  }
}

/** 本地日期 YYYY-MM-DD：榜单按用户本地「一天」为周期（toISOString 是 UTC，早 8 点前日期会错位） */
function localDate(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** 调 GitHub Search API 取 star 前 N 的项目 */
async function fetchTopRepos(topicQuery: string, limit: number): Promise<GithubRankItem[]> {
  const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(topicQuery)}&sort=stars&order=desc&per_page=${limit}`
  const res = await fetch(url, {
    headers: { 'Accept': 'application/vnd.github.v3+json', 'User-Agent': 'SD-Knowledge-App' },
    signal: AbortSignal.timeout(15000),
  })
  if (!res.ok) throw new Error(`GitHub API ${res.status}: ${res.statusText}`)
  const data = await res.json() as any
  return (data.items || []).map((item: any, i: number) => ({
    rank: i + 1,
    repo_name: item.name,
    full_name: item.full_name,
    description: item.description || null,
    stars: item.stargazers_count,
    language: item.language || null,
    url: item.html_url,
  }))
}
