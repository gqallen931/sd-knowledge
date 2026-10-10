import DatabaseService from './database'
import { RESULT_LIMITS, ResultSet, capLimit, makeResultSet } from './resultSet'
import { ScopeFilter, describeScope, entityScopeWhere, hasScope, normalizeScope, scopeWhere } from './scope'

/**
 * 消歧比对时剥离的机构后缀（长后缀优先，避免「有限公司」被「公司」抢先匹配）。
 * 刻意不收单字「公司」：那会把「保险公司」剥成「保险」，引入大量误报。
 */
const ENTITY_NAME_SUFFIXES = [
  '股份有限公司', '有限责任公司', '集团有限公司', '有限公司', '株式会社',
  'corporation', 'holdings', 'limited', 'group',
  'corp.', 'corp', 'ltd.', 'ltd', 'llc', 'inc.', 'inc', 'gmbh', 'plc', 'co.', 'co',
].sort((a, b) => b.length - a.length)

export class GraphBuilder {
  constructor(private db: DatabaseService) {}

  /**
   * 图谱节点（ADR-002 起支持作用域与参数化上限）。
   *
   * 旧版把上限写死成 `500/200/100` 且**静默丢弃**超出部分——调用方无从知道看到的是不是全部。
   * 现在：上限由调用方给（仍有 max 兜底，防止单次响应撑爆 IPC），并回传真实总数与 `truncated`。
   */
  async getNodes(filters: any = {}): Promise<ResultSet<any>> {
    const scope = normalizeScope(filters)
    const descriptor = describeScope(this.db, scope)
    const docLimit = capLimit(filters.limit, RESULT_LIMITS.graphNodes)
    const entityLimit = capLimit(filters.entity_limit, RESULT_LIMITS.graphEntities)
    const tagLimit = capLimit(filters.tag_limit, RESULT_LIMITS.graphTags)

    // ---- 文档节点 ----
    const docConditions = ['d.is_available = 1']
    const docParams: any[] = []
    if (filters.file_type) { docConditions.push('d.file_type = ?'); docParams.push(filters.file_type) }
    if (filters.storage_type) { docConditions.push('d.storage_type = ?'); docParams.push(filters.storage_type) }
    const scoped = scopeWhere(scope, 'd')
    if (scoped.where) { docConditions.push(scoped.where); docParams.push(...scoped.params) }
    const docWhere = docConditions.join(' AND ')
    const docsTotal = ((this.db.prepare(`SELECT COUNT(*) AS n FROM documents d WHERE ${docWhere}`).get(...docParams) as any)?.n) || 0
    const docs = this.db.prepare(`
      SELECT d.id, d.title AS label, d.file_type, d.storage_type, d.source_id, d.relative_path
      FROM documents d WHERE ${docWhere}
      ORDER BY d.imported_at DESC LIMIT ?
    `).all(...docParams, docLimit) as any[]

    // ---- 实体节点：全局共享池，范围靠「哪些范围内的文档提到过它」反查 ----
    const entityScoped = entityScopeWhere(scope, 'e.id')
    const entityWhere = entityScoped.where || '1 = 1'
    const entitiesTotal = ((this.db.prepare(`SELECT COUNT(*) AS n FROM entities e WHERE ${entityWhere}`).get(...entityScoped.params) as any)?.n) || 0
    const entities = this.db.prepare(`
      SELECT e.id, e.name AS label, e.type FROM entities e WHERE ${entityWhere} LIMIT ?
    `).all(...entityScoped.params, entityLimit) as any[]

    // ---- 标签节点：同样按范围内的文档反查 ----
    const tagScope = scopeWhere(scope, 'td')
    const tagWhere = tagScope.where
      ? `EXISTS (SELECT 1 FROM document_tags tdt JOIN documents td ON td.id = tdt.document_id
           WHERE tdt.tag_id = t.id AND td.is_available = 1 AND ${tagScope.where})`
      : '1 = 1'
    const tagsTotal = ((this.db.prepare(`SELECT COUNT(*) AS n FROM tags t WHERE ${tagWhere}`).get(...tagScope.params) as any)?.n) || 0
    const tags = this.db.prepare(`SELECT t.id, t.name AS label FROM tags t WHERE ${tagWhere} LIMIT ?`)
      .all(...tagScope.params, tagLimit) as any[]

    const items = [
      ...docs.map(d => ({ ...d, node_type: 'document' })),
      ...entities.map(e => ({ ...e, node_type: 'entity' })),
      ...tags.map(t => ({ ...t, node_type: 'tag' })),
    ]
    return makeResultSet(items, docsTotal + entitiesTotal + tagsTotal, docLimit + entityLimit + tagLimit, descriptor, 'limit')
  }

  /**
   * 图谱边（支持作用域）。判断一条边是否「在范围内」按端点类型分别处理：
   * 文档端点看它自身是否在范围内，实体端点看它是否被范围内的文档提到过。
   */
  async getEdges(filters: any = {}): Promise<ResultSet<any>> {
    const scope = normalizeScope(filters)
    const descriptor = describeScope(this.db, scope)
    const limit = capLimit(filters.limit, RESULT_LIMITS.graphEdges)

    const documentScope = scopeWhere(scope, 'ed')
    const scopedDocuments = `SELECT ed.id FROM documents ed WHERE ed.is_available = 1 AND ${documentScope.where}`
    const sourceEntityScope = entityScopeWhere(scope, 'r.source_id')
    const targetEntityScope = entityScopeWhere(scope, 'r.target_id')

    const scoped = hasScope(scope)
    const relWhere = scoped
      ? `WHERE (
          (r.source_type = 'document' AND r.source_id IN (${scopedDocuments}))
          OR (r.target_type = 'document' AND r.target_id IN (${scopedDocuments}))
          OR (r.source_type = 'entity' AND ${sourceEntityScope.where})
          OR (r.target_type = 'entity' AND ${targetEntityScope.where})
        )`
      : ''
    const tagWhere = scoped ? `WHERE dt.document_id IN (${scopedDocuments})` : ''
    const params: any[] = scoped
      ? [...documentScope.params, ...documentScope.params, ...sourceEntityScope.params, ...targetEntityScope.params]
      : []
    const tagParams: any[] = scoped ? [...documentScope.params] : []

    const total = ((this.db.prepare(`
      SELECT COUNT(*) AS n FROM (
        SELECT r.id FROM relationships r ${relWhere}
        UNION ALL
        SELECT dt.rowid FROM document_tags dt ${tagWhere}
      )
    `).get(...params, ...tagParams) as any)?.n) || 0

    const rows = this.db.prepare(`
      SELECT * FROM (
        SELECT r.id AS id, r.source_type, r.source_id, r.target_type, r.target_id, r.relation_type, r.weight
        FROM relationships r ${relWhere}
        UNION ALL
        SELECT -dt.rowid AS id, 'document' AS source_type, dt.document_id AS source_id, 'tag' AS target_type, dt.tag_id AS target_id, 'TAGGED' AS relation_type, 1 AS weight
        FROM document_tags dt ${tagWhere}
      ) LIMIT ?
    `).all(...params, ...tagParams, limit) as any[]

    return makeResultSet(rows, total, limit, descriptor, 'limit')
  }

  /**
   * L0 全局总览（ADR-002 分级图谱的第一层）。
   *
   * 每个**空间**折叠成一个超级节点，边是空间之间的「跨域桥」。节点数量级 = 空间数量，
   * 因此可以整体渲染而不必担心规模——这正是把「一张越来越大的图」换成「分级折叠」的收益。
   *
   * 例外：不来自任何映射根的文档（逐份导入的本地文件，或映射源被「解除归属」后留下的）。
   * 它们不属于任何空间，只按空间折叠的话在 L0 就是一片空白，而统计面板照常计入它们——
   * 同一份数据两张页面自相矛盾。故追加一个「未归入空间」节点兜住这部分，下钻走
   * `scope = { unassigned: true }`。
   */
  async getOverview(): Promise<any> {
    const spaces = this.db.prepare(`
      SELECT s.id, s.name, s.root_path, s.project_id, p.name AS project_name,
        (SELECT COUNT(*) FROM documents d WHERE d.source_id = s.id AND d.is_available = 1) AS doc_count,
        (SELECT COUNT(*) FROM folders f WHERE f.source_id = s.id) AS folder_count,
        s.last_sync_at
      FROM folder_sources s
      LEFT JOIN projects p ON p.id = s.project_id
      ORDER BY s.id
    `).all() as any[]

    const unassigned = ((this.db.prepare(
      'SELECT COUNT(*) AS n FROM documents WHERE source_id IS NULL AND is_available = 1'
    ).get() as any)?.n) || 0

    const bridges = this.bridgesBySpacePair()
    const bridgeLimit = RESULT_LIMITS.graphEdges.default
    const edges = bridges.slice(0, bridgeLimit).map((b) => ({
      id: `bridge:${b.source_a}:${b.source_b}`,
      source: `s${b.source_a}`,
      target: `s${b.source_b}`,
      relation_type: 'SHARED_ENTITY',
      weight: b.bridge_count,
      mentions: b.mentions,
    }))

    const nodes: any[] = spaces.map((s) => ({
      id: `s${s.id}`,
      space_id: s.id,
      label: s.name,
      node_type: 'space',
      doc_count: s.doc_count,
      folder_count: s.folder_count,
      project_name: s.project_name,
      root_path: s.root_path,
      last_sync_at: s.last_sync_at,
    }))
    if (unassigned > 0) {
      nodes.push({
        id: 'unassigned',
        space_id: null,
        label: '未归入空间',
        node_type: 'space',
        unassigned: true,
        doc_count: unassigned,
        folder_count: 0,
        project_name: null,
        root_path: null,
        last_sync_at: null,
      })
    }

    return {
      nodes,
      edges,
      total: bridges.length,
      truncated: bridges.length > edges.length,
      ...(bridges.length > edges.length ? { truncated_reason: 'limit' as const } : {}),
    }
  }

  /**
   * 跨域桥（ADR-002）。
   *
   * 桥的原料是 `entities` 全局共享池——同一实体出现在多个空间，就天然构成一条连接。
   * 这里刻意**只做只读统计、不落新表**：一条 GROUP BY 即可，物化反而引入过期风险。
   *
   * 注意权重排序不是装饰：全局池的同名歧义（两个空间各有一个「张三」）会让弱桥大量涌现，
   * 按「共同实体数 + 提及量」降序、只取 top-N 是控制噪声的必要手段。
   */
  async getBridges(options: { limit?: number; source_id?: number | null } = {}): Promise<any> {
    const limit = capLimit(options.limit, { default: 50, max: 500 })
    const sourceId = options.source_id != null ? Number(options.source_id) : null

    const mentionsCte = `
      WITH mentions AS (
        SELECT r.target_id AS entity_id, d.source_id AS source_id, COUNT(*) AS n
        FROM relationships r
        JOIN documents d ON d.id = r.source_id
        WHERE r.source_type = 'document' AND r.target_type = 'entity'
          AND d.is_available = 1 AND d.source_id IS NOT NULL
        GROUP BY r.target_id, d.source_id
      )`

    const filter = sourceId != null ? 'WHERE m.entity_id IN (SELECT entity_id FROM mentions WHERE source_id = ?)' : ''
    const params: any[] = sourceId != null ? [sourceId] : []
    const rows = this.db.prepare(`
      ${mentionsCte}
      SELECT e.id, e.name, e.type,
             COUNT(*) AS spaces,
             SUM(m.n) AS mentions
      FROM mentions m JOIN entities e ON e.id = m.entity_id
      ${filter}
      GROUP BY e.id
      HAVING COUNT(*) > 1
      ORDER BY spaces DESC, mentions DESC, e.name
      LIMIT ?
    `).all(...params, limit) as any[]

    if (!rows.length) return { items: [], total: 0, limit, truncated: false, spaces: [] }

    // 补上每个桥接实体横跨哪些空间（供 UI 直接连线，不必二次查询）
    const ids = rows.map((r) => r.id)
    const placeholders = ids.map(() => '?').join(',')
    const spaceRows = this.db.prepare(`
      ${mentionsCte}
      SELECT m.entity_id, m.source_id, m.n, s.name AS source_name
      FROM mentions m JOIN folder_sources s ON s.id = m.source_id
      WHERE m.entity_id IN (${placeholders})
      ORDER BY m.entity_id, m.n DESC
    `).all(...ids) as any[]

    const grouped = new Map<number, any[]>()
    for (const row of spaceRows) {
      if (!grouped.has(row.entity_id)) grouped.set(row.entity_id, [])
      grouped.get(row.entity_id)!.push({ source_id: row.source_id, source_name: row.source_name, mentions: row.n })
    }
    for (const row of rows) row.space_refs = grouped.get(row.id) || []

    const totalBridges = (this.db.prepare(`
      ${mentionsCte}
      SELECT COUNT(*) AS n FROM (SELECT entity_id FROM mentions GROUP BY entity_id HAVING COUNT(*) > 1)
    `).get() as any)?.n || 0

    return {
      items: rows,
      total: totalBridges,
      limit,
      truncated: totalBridges > rows.length,
      ...(totalBridges > rows.length ? { truncated_reason: 'limit' as const } : {}),
    }
  }

  /** 空间两两之间的共享实体统计——L0 总览的边 */
  private bridgesBySpacePair(): any[] {
    return this.db.prepare(`
      WITH mentions AS (
        SELECT r.target_id AS entity_id, d.source_id AS source_id, COUNT(*) AS n
        FROM relationships r
        JOIN documents d ON d.id = r.source_id
        WHERE r.source_type = 'document' AND r.target_type = 'entity'
          AND d.is_available = 1 AND d.source_id IS NOT NULL
        GROUP BY r.target_id, d.source_id
      )
      SELECT a.source_id AS source_a, b.source_id AS source_b,
             COUNT(*) AS bridge_count,
             SUM(a.n + b.n) AS mentions
      FROM mentions a
      JOIN mentions b ON b.entity_id = a.entity_id AND b.source_id > a.source_id
      GROUP BY a.source_id, b.source_id
      ORDER BY bridge_count DESC, mentions DESC
    `).all() as any[]
  }

  async getEntityGraph(entityName: string): Promise<any> {
    const entity = this.db.prepare(`
      SELECT id, name, type, description FROM entities WHERE name = ? LIMIT 1
    `).get(entityName) as any

    if (!entity) return { nodes: [], edges: [] }

    const docNodes = this.db.prepare(`
      SELECT d.id, d.title, d.file_type, d.storage_type, r.relation_type
      FROM relationships r
      JOIN documents d ON r.source_id = d.id
      WHERE r.source_type = 'document' AND r.target_type = 'entity' AND r.target_id = ?
      LIMIT 50
    `).all(entity.id) as any[]

    const relatedEntities = this.db.prepare(`
      SELECT DISTINCT e.id, e.name, e.type, r.relation_type
      FROM relationships r
      JOIN entities e ON (r.target_id = e.id OR r.source_id = e.id)
      WHERE e.id != ? AND (
        (r.source_type = 'entity' AND r.source_id = ?) OR
        (r.target_type = 'entity' AND r.target_id = ?)
      )
      LIMIT 30
    `).all(entity.id, entity.id, entity.id) as any[]

    const nodes = [
      { id: `e${entity.id}`, label: entity.name, type: 'entity', entity_type: entity.type },
      ...docNodes.map(d => ({ id: `d${d.id}`, label: d.title, type: 'document' })),
      ...relatedEntities.map(e => ({ id: `e${e.id}`, label: e.name, type: 'entity' }))
    ]

    const edges = docNodes.map(d => ({
      source: `d${d.id}`, target: `e${entity.id}`, relation: 'CONTAINS'
    }))

    return { nodes, edges, entity }
  }

  async getStats(): Promise<any> {
    const docCount = this.db.prepare('SELECT COUNT(*) as count FROM documents WHERE is_available = 1').get() as any
    const entityCount = this.db.prepare('SELECT COUNT(*) as count FROM entities').get() as any
    const relCount = this.db.prepare('SELECT COUNT(*) as count FROM relationships').get() as any
    const tagCount = this.db.prepare('SELECT COUNT(*) as count FROM tags').get() as any

    const entityByType = this.db.prepare(`
      SELECT type, COUNT(*) as count FROM entities GROUP BY type ORDER BY count DESC
    `).all() as any[]

    const docsByType = this.db.prepare(`
      SELECT file_type, COUNT(*) as count FROM documents WHERE is_available = 1 GROUP BY file_type ORDER BY count DESC
    `).all() as any[]

    // ADR-002：把「空间 / 目录 / 跨域桥」的规模一并报出来——分级图谱的导航入口需要它
    const spaceCount = ((this.db.prepare('SELECT COUNT(*) AS n FROM folder_sources').get() as any)?.n) || 0
    const folderCount = ((this.db.prepare('SELECT COUNT(*) AS n FROM folders').get() as any)?.n) || 0
    const bridgeCount = (this.db.prepare(`
      WITH mentions AS (
        SELECT r.target_id AS entity_id, d.source_id AS source_id
        FROM relationships r JOIN documents d ON d.id = r.source_id
        WHERE r.source_type = 'document' AND r.target_type = 'entity'
          AND d.is_available = 1 AND d.source_id IS NOT NULL
        GROUP BY r.target_id, d.source_id
      )
      SELECT COUNT(*) AS n FROM (SELECT entity_id FROM mentions GROUP BY entity_id HAVING COUNT(*) > 1)
    `).get() as any)?.n || 0

    return {
      total_nodes: docCount.count + entityCount.count + tagCount.count,
      documents: docCount.count,
      entities: entityCount.count,
      relationships: relCount.count + (this.db.prepare('SELECT COUNT(*) as count FROM document_tags').get() as any).count,
      tags: tagCount.count,
      spaces: spaceCount,
      folders: folderCount,
      bridges: bridgeCount,
      entity_types: entityByType,
      file_types: docsByType
    }
  }

  async addRelationship(
    sourceType: string, sourceId: number,
    targetType: string, targetId: number,
    relationType: string, weight: number = 1.0
  ): Promise<number> {
    // relationships 无唯一索引，先查重避免手动添加产生重复边
    const existing = this.db.prepare(`
      SELECT id FROM relationships
      WHERE source_type = ? AND source_id = ? AND target_type = ? AND target_id = ? AND relation_type = ?
    `).get(sourceType, sourceId, targetType, targetId, relationType) as any
    if (existing) return existing.id
    const info = this.db.prepare(`
      INSERT OR IGNORE INTO relationships (source_type, source_id, target_type, target_id, relation_type, weight)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(sourceType, sourceId, targetType, targetId, relationType, weight)
    this.logAudit(`addRelationship: ${sourceType}#${sourceId} -[${relationType}]-> ${targetType}#${targetId}`)
    return info.lastInsertRowid as number
  }

  async deleteRelationship(id: number): Promise<boolean> {
    const info = this.db.prepare('DELETE FROM relationships WHERE id = ?').run(id)
    if (info.changes > 0) this.logAudit(`deleteRelationship: #${id}`)
    return info.changes > 0
  }

  /**
   * 实体合并的同步核心（不含审计与事务），供单条合并与批量合并共用。
   * 把 source 实体的全部关系转移到 target 后删除 source，转移过程中去重
   * （同一对端点+关系类型只保留一条）；仅实体相关边被转移，文档与标签的关系不受影响。
   */
  private mergeEntityCore(sourceId: number, targetId: number) {
    const source = this.db.prepare('SELECT id, name, type, description FROM entities WHERE id = ?').get(sourceId) as any
    const target = this.db.prepare('SELECT id, name, type, description FROM entities WHERE id = ?').get(targetId) as any
    if (!source) throw new Error('源实体不存在')
    if (!target) throw new Error('目标实体不存在')

    let moved = 0, deduped = 0
    const rows = this.db.prepare(`
      SELECT id, source_type, source_id, target_type, target_id, relation_type, weight FROM relationships
      WHERE (source_type = 'entity' AND source_id = ?) OR (target_type = 'entity' AND target_id = ?)
    `).all(sourceId, sourceId) as any[]

    for (const r of rows) {
      const newSourceId = r.source_type === 'entity' && r.source_id === sourceId ? targetId : r.source_id
      const newTargetId = r.target_type === 'entity' && r.target_id === sourceId ? targetId : r.target_id
      if (newSourceId === newTargetId && r.source_type === 'entity' && r.target_type === 'entity') {
        // 自环（source 与 target 互指的边）：直接删除
        this.db.prepare('DELETE FROM relationships WHERE id = ?').run(r.id)
        deduped++
        continue
      }
      const dup = this.db.prepare(`
        SELECT id FROM relationships
        WHERE source_type = ? AND source_id = ? AND target_type = ? AND target_id = ? AND relation_type = ? AND id != ?
      `).get(r.source_type, newSourceId, r.target_type, newTargetId, r.relation_type, r.id) as any
      if (dup) {
        this.db.prepare('DELETE FROM relationships WHERE id = ?').run(r.id)
        deduped++
      } else {
        this.db.prepare('UPDATE relationships SET source_id = ?, target_id = ? WHERE id = ?')
          .run(newSourceId, newTargetId, r.id)
        moved++
      }
    }

    // 目标实体没有描述时继承源实体的描述，避免合并后丢失信息
    if (!target.description && source.description) {
      this.db.prepare('UPDATE entities SET description = ? WHERE id = ?').run(source.description, targetId)
    }

    // S2-08：被并实体名留作别名（合并后按旧名仍能定位到幸存者）+ 落一条可回看的合并历史。
    // 先摘掉源实体自己的别名：否则源实体的 manual 别名与旧名 NOCASE 撞车时，
    // INSERT OR IGNORE 会吞掉合并别名，而那一行又随源实体级联删除——旧名就再也定位不到幸存者了。
    this.db.prepare('DELETE FROM entity_aliases WHERE entity_id = ?').run(sourceId)
    this.db.prepare("INSERT OR IGNORE INTO entity_aliases (entity_id, alias, source) VALUES (?, ?, 'merge')")
      .run(targetId, source.name)
    this.db.prepare(`
      INSERT INTO entity_merge_history (survivor_id, merged_id, merged_name, merged_type, edges_relocated, performed_by)
      VALUES (?, ?, ?, ?, ?, 'user')
    `).run(targetId, source.id, source.name, source.type ?? null, moved)

    this.db.prepare('DELETE FROM entities WHERE id = ?').run(sourceId)
    return { source, target, moved, deduped }
  }

  /**
   * 实体合并（消歧）：把 source 实体的全部关系转移到 target 后删除 source。
   */
  async mergeEntities(sourceId: number, targetId: number): Promise<any> {
    if (sourceId === targetId) throw new Error('不能合并同一实体')
    const r = this.db.transaction(() => this.mergeEntityCore(sourceId, targetId))
    this.logAudit(`mergeEntities: "${r.source.name}" -> "${r.target.name}" (moved ${r.moved}, deduped ${r.deduped})`)
    return { success: true, moved: r.moved, deduped: r.deduped, mergedInto: { id: r.target.id, name: r.target.name } }
  }

  /**
   * 批量实体合并：把多个源实体一次性并入同一个目标实体。
   * 与逐次调用 mergeEntities 的区别是全部合并在单个事务内完成，任一步失败整体回滚，
   * 不会留下"合并了一半"的中间状态。
   */
  async mergeEntitiesBatch(sourceIds: number[], targetId: number): Promise<any> {
    const target = this.db.prepare('SELECT id, name, type FROM entities WHERE id = ?').get(Number(targetId)) as any
    if (!target) throw new Error('目标实体不存在')

    const ids = Array.from(new Set(
      (Array.isArray(sourceIds) ? sourceIds : [])
        .map((n: any) => Number(n))
        .filter((n: number) => Number.isInteger(n))
    )).filter((id: number) => id !== Number(targetId))
    if (ids.length === 0) throw new Error('请至少选择一个要合并的实体')
    if (ids.length > 200) throw new Error('单次最多合并 200 个实体')

    const missing = ids.filter((id: number) => !this.db.prepare('SELECT 1 FROM entities WHERE id = ?').get(id))
    if (missing.length > 0) throw new Error(`以下实体不存在：${missing.join('、')}`)

    const result = this.db.transaction(() => {
      let moved = 0, deduped = 0
      const details: any[] = []
      for (const id of ids) {
        const r = this.mergeEntityCore(id, Number(targetId))
        moved += r.moved
        deduped += r.deduped
        details.push({ id, name: r.source.name, type: r.source.type, moved: r.moved, deduped: r.deduped })
      }
      return { moved, deduped, details }
    })

    this.logAudit(`mergeEntitiesBatch: ${ids.length} 个实体 -> "${target.name}" (moved ${result.moved}, deduped ${result.deduped})`)
    return {
      success: true,
      merged: ids.length,
      moved: result.moved,
      deduped: result.deduped,
      mergedInto: { id: target.id, name: target.name, type: target.type },
      details: result.details,
    }
  }

  /** 归一化实体名称：折叠连续空白并去除首尾空格 */
  private static normalizeEntityName(name: any): string {
    return String(name ?? '').replace(/\s+/g, ' ').trim()
  }

  /**
   * 实体重命名的同步核心，返回结果对象而不抛异常，便于批量场景逐条汇总。
   * entities 表上有 UNIQUE(name, type)，撞名时不静默覆盖，而是返回可读错误引导改用合并。
   */
  private renameEntityCore(id: number, rawName: string, rawType?: string): {
    ok: boolean
    error?: string
    unchanged?: boolean
    entity?: { id: number; name: string; type: string }
    previous?: { name: string; type: string }
  } {
    const entity = this.db.prepare('SELECT id, name, type FROM entities WHERE id = ?').get(id) as any
    if (!entity) return { ok: false, error: '实体不存在' }

    const name = GraphBuilder.normalizeEntityName(rawName)
    const type = rawType == null ? entity.type : (GraphBuilder.normalizeEntityName(rawType) || entity.type)
    if (!name) return { ok: false, error: '实体名称不能为空' }
    if (name.length > 200) return { ok: false, error: '实体名称不能超过 200 个字符' }

    if (name === entity.name && type === entity.type) {
      return {
        ok: true,
        unchanged: true,
        entity: { id, name, type },
        previous: { name: entity.name, type: entity.type },
      }
    }

    const conflict = this.db.prepare(
      'SELECT id FROM entities WHERE name = ? AND type = ? AND id != ?'
    ).get(name, type, id) as any
    if (conflict) return { ok: false, error: `已存在同名同类型实体「${name}」(${type})，请改用合并` }

    this.db.prepare('UPDATE entities SET name = ?, type = ? WHERE id = ?').run(name, type, id)
    return { ok: true, entity: { id, name, type }, previous: { name: entity.name, type: entity.type } }
  }

  /**
   * 实体重命名。关系通过实体 id 关联，重命名不影响图谱结构，无需重建边。
   */
  async renameEntity(id: number, newName: string, newType?: string): Promise<any> {
    const result = this.renameEntityCore(Number(id), newName, newType)
    if (!result.ok) throw new Error(result.error || '重命名失败')
    if (!result.unchanged) {
      this.logAudit(`renameEntity: "${result.previous!.name}" -> "${result.entity!.name}" (#${Number(id)})`)
    }
    return { success: true, unchanged: !!result.unchanged, entity: result.entity, previous: result.previous }
  }

  /**
   * 批量实体重命名。逐条独立处理，单项失败（空名称、撞名等）不影响其余项，
   * 返回每一项的结果供前端逐条提示。
   */
  async batchRenameEntities(items: Array<{ id: number; name: string; type?: string }>): Promise<any> {
    const list = (Array.isArray(items) ? items : []).filter(
      (it: any) => it && Number.isInteger(Number(it.id))
    )
    if (list.length === 0) throw new Error('没有需要重命名的实体')
    if (list.length > 200) throw new Error('单次最多重命名 200 个实体')

    const result = this.db.transaction(() => {
      const ok: any[] = []
      const failed: any[] = []
      for (const it of list) {
        const id = Number(it.id)
        const r = this.renameEntityCore(id, it.name, it.type)
        if (r.ok) {
          ok.push({ id, name: r.entity!.name, type: r.entity!.type, previous: r.previous, unchanged: !!r.unchanged })
        } else {
          failed.push({ id, name: it.name, error: r.error })
        }
      }
      return { ok, failed }
    })

    if (result.ok.length > 0) {
      this.logAudit(`batchRenameEntities: ${result.ok.length} 个实体重命名，${result.failed.length} 个失败`)
    }
    return {
      success: result.failed.length === 0,
      renamed: result.ok.length,
      failed: result.failed,
      entities: result.ok,
    }
  }

  /**
   * 节点搜索：供"添加关联 / 合并实体"选择器使用，按名称前缀/包含匹配。
   */
  async searchNodes(query: string, limit: number = 20): Promise<any[]> {
    const text = String(query || '').trim()
    if (!text) return []
    const pattern = '%' + text.replace(/[\\%_]/g, (c: string) => '\\' + c) + '%'
    const cap = Math.min(50, Math.max(1, Number(limit) || 20))
    const docs = this.db.prepare(`
      SELECT id, title AS label, file_type, storage_type, 'document' AS node_type
      FROM documents WHERE is_available = 1 AND title LIKE ? ESCAPE '\\' LIMIT ?
    `).all(pattern, cap) as any[]
    const entities = this.db.prepare(`
      SELECT id, name AS label, type, 'entity' AS node_type
      FROM entities WHERE name LIKE ? ESCAPE '\\' LIMIT ?
    `).all(pattern, cap) as any[]
    const tags = this.db.prepare(`
      SELECT id, name AS label, 'tag' AS node_type
      FROM tags WHERE name LIKE ? ESCAPE '\\' LIMIT ?
    `).all(pattern, cap) as any[]
    return [...entities, ...docs, ...tags].slice(0, cap)
  }

  /**
   * 仅检索实体节点，供批量合并/重命名的选择器使用。
   * searchNodes 会混入文档与标签，且总量被 cap 截断，不适合实体多选场景。
   */
  /**
   * 实体检索（ADR-002 起支持作用域）。
   *
   * 实体没有归属字段，范围判定靠「哪些范围内的文档提到过它」反查；
   * 未限定范围时行为与旧版一致（全库按类型过滤）。
   */
  async getEntities(options: { type?: string; limit?: number | string } & ScopeFilter = {}): Promise<ResultSet<any>> {
    const scope = normalizeScope(options)
    const descriptor = describeScope(this.db, scope)
    const limit = capLimit(options.limit, { default: 50, max: 500 })

    const conditions: string[] = []
    const params: any[] = []
    if (options.type) { conditions.push('e.type = ?'); params.push(options.type) }
    const entityScoped = entityScopeWhere(scope, 'e.id')
    if (entityScoped.where) { conditions.push(entityScoped.where); params.push(...entityScoped.params) }
    const where = conditions.length ? conditions.join(' AND ') : '1 = 1'

    const total = ((this.db.prepare(`SELECT COUNT(*) AS n FROM entities e WHERE ${where}`).get(...params) as any)?.n) || 0
    const items = this.db.prepare(`
      SELECT e.id, e.name, e.name AS label, e.type, e.description, 'entity' AS node_type
      FROM entities e WHERE ${where}
      ORDER BY e.name LIMIT ?
    `).all(...params, limit) as any[]

    return makeResultSet(items, total, limit, descriptor, 'limit')
  }

  async searchEntities(query: string, limit: number = 20): Promise<any[]> {
    const text = String(query || '').trim()
    if (!text) return []
    const pattern = '%' + text.replace(/[\\%_]/g, (c: string) => '\\' + c) + '%'
    const cap = Math.min(50, Math.max(1, Number(limit) || 20))
    return this.db.prepare(`
      SELECT id, name AS label, type, 'entity' AS node_type
      FROM entities WHERE name LIKE ? ESCAPE '\\'
      ORDER BY length(name), name LIMIT ?
    `).all(pattern, cap) as any[]
  }

  /**
   * 实体名归一化：仅用于消歧比对，不改动库中任何数据。
   * 全角转半角 → 小写压空白 → 剥离机构后缀 → 最后去掉空格与点号。
   */
  private normalizeEntityName(raw: string): string {
    let s = String(raw || '')
      .replace(/[\uFF01-\uFF5E]/g, (c: string) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
      .replace(/\u3000/g, ' ')
      .toLowerCase()
      .trim()
      .replace(/\s+/g, ' ')
    for (const suf of ENTITY_NAME_SUFFIXES) {
      if (s.length <= suf.length || !s.endsWith(suf)) continue
      const head = s.slice(0, s.length - suf.length)
      // 拉丁后缀必须与主体有分隔（"apple inc" ✓ / "cisco" 不能被当成 "cis"+"co"）
      if (/^[a-z]/.test(suf) && !/[\s.]$/.test(head)) continue
      const body = head.replace(/[\s.]+$/, '')
      if (body.length < 2) continue
      s = body
      break
    }
    return s.replace(/[\s.]+/g, '')
  }

  /**
   * 带上限的编辑距离：超过 max 立即返回 max + 1，避免为明显不相近的名付出完整 O(n·m)。
   */
  private static editDistanceBeyond(a: string, b: string, max: number): number {
    const la = a.length
    const lb = b.length
    if (Math.abs(la - lb) > max) return max + 1
    if (a === b) return 0
    let prev: number[] = new Array(lb + 1)
    let curr: number[] = new Array(lb + 1)
    for (let j = 0; j <= lb; j++) prev[j] = j
    for (let i = 1; i <= la; i++) {
      curr[0] = i
      let rowMin = i
      for (let j = 1; j <= lb; j++) {
        const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1
        const v = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost)
        curr[j] = v
        if (v < rowMin) rowMin = v
      }
      if (rowMin > max) return max + 1
      const swap = prev
      prev = curr
      curr = swap
    }
    return prev[lb]
  }

  private buildSuggestion(source: any, target: any, score: number, reason: string, detail: string) {
    return {
      source: { id: source.id, name: source.name, type: source.type },
      target: { id: target.id, name: target.name, type: target.type },
      score: Math.round(score * 100) / 100,
      reason,
      detail,
    }
  }

  /**
   * 单对实体比对。返回 null 表示不构成合并建议。
   * 方向统一为「把 source 并入 target」，target 取更具体（归一化后更长）的一方，
   * 因为信息量更大的一方通常是用户想保留的规范名。
   */
  private compareEntityPair(a: any, b: any): any {
    const na = a.norm
    const nb = b.norm
    const la = na.length
    const lb = nb.length
    const maxLen = Math.max(la, lb)
    const minLen = Math.min(la, lb)

    // 1) 归一化后完全相同：最强信号。不限制 type —— 同名却分属两类，往往正是漏合并的重复项
    if (na === nb) {
      const first = a.id <= b.id ? a : b
      const second = a.id <= b.id ? b : a
      return this.buildSuggestion(
        second, first, 1, 'exact',
        a.type !== b.type ? `名称相同但类型不同（${a.type} / ${b.type}）` : '名称归一化后完全相同'
      )
    }

    // 类型不同不参与模糊匹配，避免「苹果(ORG)」并掉「苹果(FOOD)」
    if (a.type !== b.type) return null

    // 2) 包含关系：短名是长名的子串（「华为」⊂「华为技术」）
    if (minLen >= 2 && (na.includes(nb) || nb.includes(na))) {
      const ratio = minLen / maxLen
      const short = la <= lb ? a : b
      const long = la <= lb ? b : a
      return this.buildSuggestion(
        short, long, 0.6 + 0.4 * ratio, 'containment',
        `「${short.name}」是「${long.name}」的一部分`
      )
    }

    // 3) 拼写相近（保守）：长度接近且首字相同才比，否则人名之间误报太多
    if (minLen >= 3 && maxLen - minLen <= 1 && na[0] === nb[0]) {
      const maxDist = maxLen <= 5 ? 1 : 2
      const dist = GraphBuilder.editDistanceBeyond(na, nb, maxDist)
      if (dist <= maxDist) {
        const short = la <= lb ? a : b
        const long = la <= lb ? b : a
        return this.buildSuggestion(
          short, long, 1 - dist / maxLen, 'fuzzy', `拼写相近（编辑距离 ${dist}）`
        )
      }
    }
    return null
  }

  /**
   * 实体消歧候选建议：只读。扫描全部实体两两比对，产出「疑似同一实体」候选，
   * 交由用户确认后走既有的 mergeEntities / mergeEntitiesBatch 执行。
   * 不自动合并 —— 规则层无法区分「苹果公司」与「苹果手机」这类同形异义。
   */
  async suggestEntityMerges(options: { limit?: number; minScore?: number; type?: string } = {}): Promise<any> {
    const limit = Math.min(200, Math.max(1, Number(options?.limit) || 50))
    const minScore = Math.min(1, Math.max(0, Number(options?.minScore ?? 0.6)))
    const typeFilter = options?.type ? String(options.type) : ''

    const rows = this.db.prepare(`
      SELECT id, name, type FROM entities WHERE name IS NOT NULL AND TRIM(name) <> ''
    `).all() as any[]

    const items = rows
      .map(r => ({
        id: Number(r.id),
        name: String(r.name),
        type: String(r.type || ''),
        norm: this.normalizeEntityName(r.name),
      }))
      .filter(it => it.norm && (!typeFilter || it.type === typeFilter))

    // S2-08 忽略记忆：用户明确说过「不是同一个东西」的组合不再出现在建议里
    const ignoredPairs = new Set(
      (this.db.prepare('SELECT name_a, name_b FROM entity_merge_ignores').all() as any[])
        .map(r => mergeIgnorePairKey(r.name_a, r.name_b)),
    )

    const found: any[] = []
    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        if (ignoredPairs.has(mergeIgnorePairKey(items[i].norm, items[j].norm))) continue
        const hit = this.compareEntityPair(items[i], items[j])
        if (hit && hit.score >= minScore) found.push(hit)
      }
    }
    found.sort((x, y) =>
      y.score - x.score || x.target.id - y.target.id || x.source.id - y.source.id
    )

    return {
      scanned: items.length,
      matched: found.length,
      truncated: found.length > limit,
      min_score: minScore,
      suggestions: found.slice(0, limit),
    }
  }

  // ── 实体别名 / 合并历史 / 忽略记忆（S2-08）──────────────────────────

  /** 实体别名列表；不传 entityId 时返回全部（附实体名，供管理面板展示） */
  listAliases(entityId?: number): any[] {
    if (entityId != null) {
      return this.db.prepare(`
        SELECT a.id, a.entity_id, a.alias, a.source, a.created_at, e.name AS entity_name, e.type AS entity_type
        FROM entity_aliases a LEFT JOIN entities e ON e.id = a.entity_id
        WHERE a.entity_id = ? ORDER BY a.id
      `).all(Number(entityId)) as any[]
    }
    return this.db.prepare(`
      SELECT a.id, a.entity_id, a.alias, a.source, a.created_at, e.name AS entity_name, e.type AS entity_type
      FROM entity_aliases a LEFT JOIN entities e ON e.id = a.entity_id
      ORDER BY a.id DESC LIMIT 200
    `).all() as any[]
  }

  /**
   * 给实体补一个别名。别名全局唯一（大小写不敏感）：被别的实体占用时给出可读错误，
   * 而不是静默丢弃——否则用户会以为保存成功了。
   */
  addAlias(entityId: number, rawAlias: string): any {
    const entity = this.db.prepare('SELECT id, name FROM entities WHERE id = ?').get(Number(entityId)) as any
    if (!entity) throw new Error('实体不存在')
    const alias = this.normalizeEntityName(rawAlias)
    if (!alias) throw new Error('别名不能为空')
    if (alias.length > 200) throw new Error('别名不能超过 200 个字符')

    const owner = this.db.prepare('SELECT entity_id FROM entity_aliases WHERE alias = ? COLLATE NOCASE').get(alias) as any
    if (owner) {
      if (Number(owner.entity_id) === Number(entityId)) return { success: true, unchanged: true, alias }
      const ownerEntity = this.db.prepare('SELECT name FROM entities WHERE id = ?').get(Number(owner.entity_id)) as any
      throw new Error(`别名「${alias}」已被实体「${ownerEntity?.name ?? `#${owner.entity_id}`}」占用`)
    }
    this.db.prepare("INSERT INTO entity_aliases (entity_id, alias, source) VALUES (?, ?, 'manual')").run(Number(entityId), alias)
    this.logAudit(`addAlias: "${alias}" -> "${entity.name}" (#${Number(entityId)})`)
    return { success: true, alias }
  }

  removeAlias(id: number): boolean {
    const removed = this.db.prepare('DELETE FROM entity_aliases WHERE id = ?').run(Number(id)).changes > 0
    if (removed) this.logAudit(`removeAlias: #${Number(id)}`)
    return removed
  }

  /** 合并历史（最近在前）；幸存者可能后来又被并走/删除，名字取得到就带、取不到就留空 */
  listMergeHistory(limit: number = 50): any[] {
    return this.db.prepare(`
      SELECT h.*, e.name AS survivor_name, e.type AS survivor_type
      FROM entity_merge_history h LEFT JOIN entities e ON e.id = h.survivor_id
      ORDER BY h.id DESC LIMIT ?
    `).all(Math.min(200, Math.max(1, Number(limit) || 50))) as any[]
  }

  /** 消歧建议「忽略这组」：写入忽略记忆（键序归一），下次扫描不再出现 */
  ignoreMergeSuggestion(nameA: string, nameB: string): any {
    const a = this.normalizeEntityName(nameA)
    const b = this.normalizeEntityName(nameB)
    if (!a || !b) throw new Error('实体名称不能为空')
    if (a === b) throw new Error('两个名称相同，无需忽略')
    const [lo, hi] = [a, b].sort((x, y) => x.localeCompare(y, 'zh-CN'))
    this.db.prepare('INSERT OR IGNORE INTO entity_merge_ignores (name_a, name_b) VALUES (?, ?)').run(lo, hi)
    this.logAudit(`ignoreMergeSuggestion: "${lo}" / "${hi}"`)
    return { success: true, pair: [lo, hi] }
  }

  listIgnoredMergePairs(): any[] {
    return this.db.prepare('SELECT * FROM entity_merge_ignores ORDER BY id DESC LIMIT 200').all() as any[]
  }

  private logAudit(details: string) {
    try {
      this.db.prepare(`
        INSERT INTO audit_logs (actor_type, actor_name, action, resource_type, details, status)
        VALUES ('user', 'user', 'update', 'graph', ?, 'success')
      `).run(details)
    } catch { /* 审计失败不影响主流程 */ }
  }
}

/** 忽略记忆的键：无序对归一成确定顺序，写入与比对两侧必须用同一把尺子 */
function mergeIgnorePairKey(a: string, b: string): string {
  return [String(a ?? '').trim().toLowerCase(), String(b ?? '').trim().toLowerCase()]
    .sort((x, y) => x.localeCompare(y, 'zh-CN'))
    .join('\u0001')
}
