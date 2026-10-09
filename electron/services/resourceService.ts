import DatabaseService from './database'
import { RESOURCE_SEED, ResourceSeed } from './resources/seed'

/**
 * 开源资源汇服务：卡片式展示外部收集的开源模型 / 技能 / 工具 / 项目。
 *
 * - 表结构由迁移 v5 建；
 * - 构造时若表为空则从种子数据灌入（仅一次）；
 * - 只读查询：列表 / 详情 / 分类统计，不做写接口（数据管理走后续编辑页或重跑种子）。
 */
export class ResourceService {
  constructor(private db: DatabaseService) {
    this.seedIfEmpty()
  }

  private seedIfEmpty() {
    const count = (this.db.prepare('SELECT COUNT(*) as n FROM resources').get() as any).n
    if (count > 0) return
    const stmt = this.db.prepare(`
      INSERT INTO resources (name, category, description, link, tags)
      VALUES (?, ?, ?, ?, ?)
    `)
    const tx = () => {
      for (const row of RESOURCE_SEED) {
        stmt.run(
          row.name,
          row.category,
          row.description,
          row.link,
          JSON.stringify({ subcategory: row.subcategory, links: row.links ?? [] })
        )
      }
    }
    this.db.transaction(tx)
  }

  /** 分类统计（含各分类条目数），按条目数降序 */
  categories(): Array<{ category: string; count: number }> {
    const rows = this.db.prepare(`
      SELECT category, COUNT(*) as count FROM resources GROUP BY category ORDER BY count DESC, category
    `).all() as any[]
    return rows.map(r => ({ category: r.category, count: r.count }))
  }

  /** 列表：可选分类 / 关键词（名称 + 描述 + 细分标签） */
  list(input: { category?: string; search?: string } = {}) {
    const { category, search } = input
    let sql = 'SELECT id, name, category, description, link, tags, created_at FROM resources'
    const where: string[] = []
    const params: any[] = []
    if (category) { where.push('category = ?'); params.push(category) }
    if (search) {
      where.push('(name LIKE ? OR description LIKE ? OR tags LIKE ?)')
      const q = `%${search}%`
      params.push(q, q, q)
    }
    if (where.length) sql += ' WHERE ' + where.join(' AND ')
    sql += ' ORDER BY id'
    const rows = this.db.prepare(sql).all(...params) as any[]
    return rows.map(r => ({
      ...r,
      tags: safeParse(r.tags, { subcategory: '', links: [] }),
    }))
  }

  get(id: number) {
    const row = this.db.prepare('SELECT * FROM resources WHERE id = ?').get(id) as any
    if (!row) return null
    return { ...row, tags: safeParse(row.tags, { subcategory: '', links: [] }) }
  }
}

function safeParse(text: string | null, fallback: any) {
  if (!text) return fallback
  try { return JSON.parse(text) } catch { return fallback }
}
