import * as fs from 'fs'
import * as path from 'path'
import { createHash } from 'crypto'
import { v4 as uuidv4 } from 'uuid'
import DatabaseService from './database'
import { normalizeFolderPath, wantsUnassigned } from './scope'
import { readChunks, writeChunks } from './chunks'
import { pluginRegistry } from './plugins'

/**
 * 扩展名 → 文件类型（**从插件注册表派生**，ADR-005 D21）。
 *
 * 注册了哪些扩展名就支持哪些格式：新增格式只需注册一个解析器插件，
 * 不用再改这里，也不用改目录映射扫描的过滤逻辑。
 * 返回的是当前快照（已启用的解析器插件），停用某解析器插件后该格式立即表现为「不支持」。
 */
export function fileTypeMap(): Record<string, string> {
  return pluginRegistry.fileTypeMap()
}

/** 支持解析的扩展名集合（不含点号），目录映射扫描时据此过滤 */
export function supportedExtensions(): ReadonlySet<string> {
  return new Set(Object.keys(fileTypeMap()))
}

/** 目录映射写入来源信息 */
export interface SourceContext {
  sourceId: number
  relativePath: string
  storageMode?: 'reference' | 'copy'
  projectId?: number | null
}

export class FileService {
  constructor(
    private db: DatabaseService,
    private dataDir: string
  ) {}

  /** 是否为可解析格式，供目录映射扫描过滤非知识文件（如 .exe/.zip/.log） */
  isSupportedFile(fileName: string): boolean {
    return supportedExtensions().has(path.extname(fileName).toLowerCase().replace('.', ''))
  }

  getFileType(fileName: string): string {
    const ext = path.extname(fileName).toLowerCase().replace('.', '')
    return fileTypeMap()[ext] || ext || 'unknown'
  }

  private getCategoryDir(fileType: string): string {
    if (['pdf', 'doc', 'docx', 'md', 'txt', 'html', 'pptx', 'epub'].includes(fileType)) return 'documents'
    if (['xls', 'xlsx', 'csv', 'json', 'xml'].includes(fileType)) return 'spreadsheets'
    if (fileType === 'image') return 'images'
    if (fileType === 'video') return 'videos'
    return 'others'
  }

  calculateHash(filePath: string): string {
    const buffer = fs.readFileSync(filePath)
    return createHash('sha256').update(buffer).digest('hex')
  }

  async importFiles(filePaths: string[]): Promise<any[]> {
    const results: any[] = []
    for (const filePath of filePaths) {
      try {
        const stat = fs.statSync(filePath)
        if (!stat.isFile()) continue

        const fileName = path.basename(filePath)
        const fileType = this.getFileType(fileName)
        const hash = this.calculateHash(filePath)

        const existing = this.db.prepare('SELECT id FROM documents WHERE file_hash = ?').get(hash) as any
        if (existing) {
          results.push({ success: false, file: fileName, reason: 'duplicate', existingId: existing.id })
          continue
        }

        const categoryDir = this.getCategoryDir(fileType)
        const destDir = path.join(this.dataDir, 'files', categoryDir)
        if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true })

        const settings = await this.db.getSettings()
        if (stat.size > Number(settings.max_file_size || 500) * 1048576) throw new Error('文件超过设置中的大小限制')
        const destPath = path.join(destDir, `${uuidv4()}${path.extname(fileName)}`)
        fs.copyFileSync(filePath, destPath)

        const stmt = this.db.prepare(`
          INSERT INTO documents (title, file_name, file_path, file_type, file_size, file_hash, storage_type, content_text, file_modified_at)
          VALUES (?, ?, ?, ?, ?, ?, 'local', '', ?)
        `)
        const info = stmt.run(fileName, fileName, destPath, fileType, stat.size, hash, stat.mtime.toISOString())
        const docId = info.lastInsertRowid as number
        this.recordVersion(docId, 'initial', '初始导入')

        results.push({ success: true, file: fileName, documentId: docId })
      } catch (err: any) {
        results.push({ success: false, file: path.basename(filePath), reason: err.message })
      }
    }
    this.logAudit('user', 'import', 'document', `${filePaths.length} files imported`)
    return results
  }

  async addReferences(filePaths: string[]): Promise<any[]> {
    const results: any[] = []
    for (const filePath of filePaths) {
      try {
        const stat = fs.statSync(filePath)
        if (!stat.isFile()) continue

        const fileName = path.basename(filePath)
        const fileType = this.getFileType(fileName)
        const hash = this.calculateHash(filePath)

        const existing = this.db.prepare('SELECT id FROM documents WHERE file_hash = ?').get(hash) as any
        if (existing) {
          results.push({ success: false, file: fileName, reason: 'duplicate', existingId: existing.id })
          continue
        }

        const stmt = this.db.prepare(`
          INSERT INTO documents (title, file_name, file_path, file_type, file_size, file_hash, storage_type, original_path, file_modified_at)
          VALUES (?, ?, ?, ?, ?, ?, 'reference', ?, ?)
        `)
        const info = stmt.run(fileName, fileName, filePath, fileType, stat.size, hash, filePath, stat.mtime.toISOString())
        const docId = info.lastInsertRowid as number
        this.recordVersion(docId, 'initial', '初始导入（引用）')

        results.push({ success: true, file: fileName, documentId: docId, path: filePath })
      } catch (err: any) {
        results.push({ success: false, file: path.basename(filePath), reason: err.message })
      }
    }
    this.logAudit('user', 'reference', 'document', `${filePaths.length} files referenced`)
    return results
  }

  /**
   * 目录映射入库：以 (source_id, relative_path) 作为唯一键，
   * 避免相同内容文件在多个映射源之间按全局哈希互相顶掉而丢失目录结构。
   */
  async registerFromSource(filePath: string, ctx: SourceContext): Promise<any> {
    const stat = fs.statSync(filePath)
    const fileName = path.basename(filePath)
    const fileType = this.getFileType(fileName)
    const hash = this.calculateHash(filePath)
    const storageType = ctx.storageMode === 'copy' ? 'local' : 'reference'

    let storedPath = filePath
    if (storageType === 'local') {
      const destDir = path.join(this.dataDir, 'files', this.getCategoryDir(fileType))
      if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true })
      storedPath = path.join(destDir, `${uuidv4()}${path.extname(fileName)}`)
      fs.copyFileSync(filePath, storedPath)
    }

    const info = this.db.prepare(`
      INSERT INTO documents (title, file_name, file_path, file_type, file_size, file_hash,
        storage_type, original_path, file_modified_at, source_id, relative_path, project_id, content_text)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '')
    `).run(fileName, fileName, storedPath, fileType, stat.size, hash, storageType,
      filePath, stat.mtime.toISOString(), ctx.sourceId, ctx.relativePath, ctx.projectId ?? null)

    const documentId = Number(info.lastInsertRowid)
    this.recordVersion(documentId, 'initial', '目录映射入库')

    // 同内容文件直接复用已解析参数（文本/摘要/向量/标签/实体），跳过重复推理
    const reusable = this.db.prepare(`
      SELECT id FROM documents
      WHERE file_hash = ? AND id != ? AND is_available = 1 AND length(COALESCE(content_text, '')) > 0
      ORDER BY id LIMIT 1
    `).get(hash, documentId) as any
    if (reusable) this.reuseAnalysis(documentId, reusable.id)

    return { documentId, fileName, fileType, hash, storageType, reusedFrom: reusable?.id ?? null }
  }

  private reuseAnalysis(targetId: number, sourceId: number) {
    try {
      this.db.transaction(() => {
        this.db.prepare(`
          UPDATE documents SET
            content_text = (SELECT content_text FROM documents WHERE id = ?),
            summary = (SELECT summary FROM documents WHERE id = ?),
            processing_status = 'ready',
            updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).run(sourceId, sourceId, targetId)
        // 块级溯源（D8）：同内容复用必须**一并复制 chunks**，否则复用来的文档永远没有出处。
        // 先建「旧 chunk_id → 新 chunk_id」映射，向量复制时用它改写关联。
        const sourceChunks = readChunks(this.db, sourceId)
        const chunkIdMap = new Map<number, number>()
        if (sourceChunks.length) {
          const newIds = writeChunks(this.db, targetId, sourceChunks.map(c => ({
            chunk_index: c.chunk_index,
            content: c.content,
            char_start: c.char_start,
            char_end: c.char_end,
            anchor_kind: c.anchor_kind ?? null,
            anchor_index: c.anchor_index ?? null,
            time_start_ms: c.time_start_ms ?? null,
            time_end_ms: c.time_end_ms ?? null,
            bbox: c.bbox ?? null,
            token_count: c.token_count ?? 0,
            chunk_size: c.chunk_size ?? null,
            chunk_overlap: c.chunk_overlap ?? null,
          })))
          sourceChunks.forEach((chunk, index) => chunkIdMap.set(chunk.id, newIds[index]))
        }
        // 向量**不能再 `INSERT ... SELECT`**：`vectors.chunk_id` 加了外键后，整段复制会让新文档的
        // 向量指向源文档的 chunk（外键只保证「存在」，不保证「属于本文档」）。改为逐行映射插入。
        const sourceVectors = this.db.prepare(
          'SELECT chunk_id, chunk_index, embedding, model, dimension FROM vectors WHERE document_id = ?'
        ).all(sourceId) as any[]
        const insertVector = this.db.prepare(`
          INSERT INTO vectors (document_id, chunk_id, chunk_index, embedding, model, dimension)
          VALUES (?, ?, ?, ?, ?, ?)
        `)
        for (const vector of sourceVectors) {
          // 源向量没有块关联（回填未完成）时保持 NULL：宁可没有出处，也不指错
          const mappedChunkId = vector.chunk_id == null ? null : (chunkIdMap.get(vector.chunk_id) ?? null)
          insertVector.run(targetId, mappedChunkId, vector.chunk_index ?? null,
            vector.embedding, vector.model, vector.dimension)
        }
        this.db.prepare(`
          INSERT OR IGNORE INTO document_tags (document_id, tag_id)
          SELECT ?, tag_id FROM document_tags WHERE document_id = ?
        `).run(targetId, sourceId)
        this.db.prepare(`
          INSERT INTO relationships (source_type, source_id, target_type, target_id, relation_type, weight, metadata)
          SELECT source_type, ?, target_type, target_id, relation_type, weight, metadata
          FROM relationships WHERE source_type = 'document' AND source_id = ?
        `).run(targetId, sourceId)
      })
    } catch (e) {
      console.error('reuseAnalysis failed:', e)
    }
  }

  async listFiles(filters: any = {}): Promise<any[]> {
    let sql = `
      SELECT d.id, d.title, d.file_name, d.file_path, d.file_type, d.file_size,
             d.storage_type, d.original_path, d.summary, d.imported_at, d.is_available,
             d.file_modified_at, d.version, d.processing_status, d.processing_error,
             d.source_id, d.relative_path,
             (SELECT fs.name FROM folder_sources fs WHERE fs.id = d.source_id) as source_name,
             (SELECT GROUP_CONCAT(t.name, ',') FROM document_tags dt
              JOIN tags t ON dt.tag_id = t.id WHERE dt.document_id = d.id) as tags
      FROM documents d
      WHERE 1 = 1
    `
    const params: any[] = []
    const conditions: string[] = []

    // 目录映射中被删除的源文件采用软删除，默认不出现在列表；availability 可显式查看失效项
    if (filters.availability === 'unavailable') {
      conditions.push('d.is_available = 0')
    } else if (filters.availability !== 'all') {
      conditions.push('d.is_available = 1')
    }

    // 「未归入空间」（ADR-002 补漏）：逐份导入的本地文件，或映射源被解除归属后留下的文档。
    // 与 source_id 互斥——同时给出时以 unassigned 为准，与 scope.ts 的语义一致。
    if (wantsUnassigned(filters)) {
      conditions.push('d.source_id IS NULL')
    } else if (filters.source_id) {
      conditions.push('d.source_id = ?')
      params.push(filters.source_id)
    }
    if (filters.file_type) {
      conditions.push('d.file_type = ?')
      params.push(filters.file_type)
    }
    if (filters.storage_type) {
      conditions.push('d.storage_type = ?')
      params.push(filters.storage_type)
    }
    if (filters.project_id) {
      conditions.push('d.project_id = ?')
      params.push(filters.project_id)
    }
    if (filters.search) {
      conditions.push('(d.title LIKE ? OR d.file_name LIKE ?)')
      params.push(`%${filters.search}%`, `%${filters.search}%`)
    }

    // 目录前缀（ADR-002）：命中该目录及其全部子目录
    const folderPath = normalizeFolderPath(filters.folder_path ?? filters.folderPath)
    if (folderPath) {
      conditions.push("(d.relative_path = ? OR d.relative_path LIKE ? ESCAPE '\\')")
      params.push(folderPath, `${folderPath.replace(/[\\%_]/g, (ch) => `\\${ch}`)}/%`)
    }

    if (conditions.length > 0) {
      sql += ' AND ' + conditions.join(' AND ')
    }
    sql += ' ORDER BY d.imported_at DESC'
    if (filters.limit) {
      sql += ' LIMIT ?'
      params.push(filters.limit)
    }

    return this.db.prepare(sql).all(...params)
  }

  /**
   * 同条件的命中总数（ADR-002）。
   *
   * `listFiles` 本身保持返回数组（首页列表等调用方只关心分页结果），
   * 但 Agent 面向的入口需要知道「是不是被 limit 截断了」——由调用方按需补一次计数，
   * 而不是让每个列表渲染都多跑一条 COUNT。
   */
  async countFiles(filters: any = {}): Promise<number> {
    const conditions = ['1 = 1']
    const params: any[] = []

    if (filters.availability === 'unavailable') conditions.push('d.is_available = 0')
    else if (filters.availability !== 'all') conditions.push('d.is_available = 1')

    if (wantsUnassigned(filters)) conditions.push('d.source_id IS NULL')
    else if (filters.source_id) { conditions.push('d.source_id = ?'); params.push(filters.source_id) }
    if (filters.file_type) { conditions.push('d.file_type = ?'); params.push(filters.file_type) }
    if (filters.storage_type) { conditions.push('d.storage_type = ?'); params.push(filters.storage_type) }
    if (filters.project_id) { conditions.push('d.project_id = ?'); params.push(filters.project_id) }
    if (filters.search) {
      conditions.push('(d.title LIKE ? OR d.file_name LIKE ?)')
      params.push(`%${filters.search}%`, `%${filters.search}%`)
    }
    const folderPath = normalizeFolderPath(filters.folder_path ?? filters.folderPath)
    if (folderPath) {
      conditions.push("(d.relative_path = ? OR d.relative_path LIKE ? ESCAPE '\\')")
      params.push(folderPath, `${folderPath.replace(/[\\%_]/g, (ch) => `\\${ch}`)}/%`)
    }

    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM documents d WHERE ${conditions.join(' AND ')}`).get(...params) as any
    return row?.n || 0
  }

  async getFileDetail(id: number): Promise<any> {
    const doc = this.db.prepare(`
      SELECT d.*, p.name as project_name,
        (SELECT fs.name FROM folder_sources fs WHERE fs.id = d.source_id) as source_name
      FROM documents d
      LEFT JOIN projects p ON d.project_id = p.id
      WHERE d.id = ?
    `).get(id) as any

    if (!doc) return null

    const tags = this.db.prepare(`
      SELECT t.id, t.name, t.color
      FROM document_tags dt
      JOIN tags t ON dt.tag_id = t.id
      WHERE dt.document_id = ?
    `).all(id)

    const entities = this.db.prepare(`
      SELECT e.id, e.name, e.type
      FROM relationships r
      JOIN entities e ON r.target_id = e.id
      WHERE r.source_type = 'document' AND r.source_id = ? AND r.target_type = 'entity'
    `).all(id)

    const versions = this.db.prepare(`
      SELECT id, version_number, file_hash, file_size, change_type, change_summary, created_at
      FROM file_versions
      WHERE document_id = ?
      ORDER BY version_number DESC
    `).all(id)

    return { ...doc, tags, entities, versions }
  }

  async deleteFile(id: number): Promise<any> {
    const doc = this.db.prepare('SELECT * FROM documents WHERE id = ?').get(id) as any
    if (!doc) return { success: false, reason: 'not_found' }

    if (doc.storage_type === 'local' && doc.file_path && fs.existsSync(doc.file_path)) {
      fs.unlinkSync(doc.file_path)
    }

    this.db.prepare("DELETE FROM relationships WHERE (source_type='document' AND source_id=?) OR (target_type='document' AND target_id=?)").run(id, id)
    this.db.prepare('DELETE FROM documents WHERE id = ?').run(id)
    this.db.exec("DELETE FROM entities WHERE NOT EXISTS (SELECT 1 FROM relationships WHERE (target_type='entity' AND target_id=entities.id) OR (source_type='entity' AND source_id=entities.id)); DELETE FROM tags WHERE NOT EXISTS (SELECT 1 FROM document_tags WHERE tag_id=tags.id)")
    this.logAudit('user', 'delete', 'document', `Deleted: ${doc.file_name}`)
    return { success: true }
  }

  async addTag(documentId: number, tagName: string): Promise<void> {
    let tag = this.db.prepare('SELECT id FROM tags WHERE name = ?').get(tagName) as any
    if (!tag) {
      const info = this.db.prepare('INSERT INTO tags (name, color) VALUES (?, ?)').run(tagName, '#3b82f6')
      tag = { id: info.lastInsertRowid }
    }
    this.db.prepare('INSERT OR IGNORE INTO document_tags (document_id, tag_id) VALUES (?, ?)').run(documentId, tag.id)
  }

  async createProject(name: string, description: string, color: string): Promise<number> {
    // 融合后 projects 同时承载知识域的项目集与工作台域的项目，因此需归属当前激活工作区；
    // 否则工作台按工作区过滤时会"看不见"刚在知识侧建好的项目。
    // updated_at 由语句显式写入：该列是迁移期补出的，没有 DEFAULT CURRENT_TIMESTAMP。
    const info = this.db.prepare(`
      INSERT INTO projects (name, description, color, workspace_id, updated_at)
      VALUES (?, ?, ?, (SELECT id FROM workspaces WHERE active = 1 ORDER BY id LIMIT 1), CURRENT_TIMESTAMP)
    `).run(name, description, color)
    return info.lastInsertRowid as number
  }

  async listProjects(): Promise<any[]> {
    return this.db.prepare(`
      SELECT p.id, p.name, p.description, p.color, p.created_at,
             COUNT(d.id) as doc_count
      FROM projects p
      LEFT JOIN documents d ON d.project_id = p.id
      GROUP BY p.id
      ORDER BY p.created_at DESC
    `).all() as any[]
  }

  async updateProject(id: number, name: string, description: string, color: string): Promise<void> {
    if (!name?.trim()) throw new Error('项目名称不能为空')
    const info = this.db.prepare('UPDATE projects SET name = ?, description = ?, color = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(name.trim(), description || '', color || '#6366f1', id)
    if (info.changes === 0) throw new Error('项目不存在')
  }

  async deleteProject(id: number): Promise<void> {
    this.db.prepare('UPDATE documents SET project_id = NULL WHERE project_id = ?').run(id)
    this.db.prepare('DELETE FROM projects WHERE id = ?').run(id)
  }

  async removeFromProject(documentId: number): Promise<void> {
    this.db.prepare('UPDATE documents SET project_id = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(documentId)
  }

  async assignToProject(documentId: number, projectId: number): Promise<void> {
    this.db.prepare('UPDATE documents SET project_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(projectId, documentId)
  }

  /**
   * 批量指派 / 迁出项目（ADR-002 P3）。
   * 走单事务；只统计 project_id 真正变化的行，因此「拖回原项目」「拖动不存在的文档」
   * 都不会被算成成功，调用方拿到的 updated 可以直接当"迁移了几条"用。
   */
  async assignManyToProject(
    documentIds: number[],
    projectId: number | null
  ): Promise<{ updated: number; skipped: number; projectId: number | null }> {
    const ids = Array.from(new Set((documentIds || [])
      .map(n => Number(n))
      .filter(n => Number.isInteger(n) && n > 0)))
    if (!ids.length) throw new Error('未选择任何文件')
    const target = projectId == null ? null : Number(projectId)
    if (target != null) {
      const project = this.db.prepare('SELECT id FROM projects WHERE id = ?').get(target) as any
      if (!project) throw new Error('目标项目不存在')
    }
    const stmt = this.db.prepare(
      'UPDATE documents SET project_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND COALESCE(project_id, -1) <> COALESCE(?, -1)'
    )
    const updated = this.db.transaction(() => {
      let moved = 0
      for (const id of ids) moved += stmt.run(target, id, target).changes
      return moved
    })
    return { updated, skipped: ids.length - updated, projectId: target }
  }

  async checkReferenceAvailability(): Promise<any[]> {
    const refs = this.db.prepare(`
      SELECT id, file_name, original_path, file_hash
      FROM documents WHERE storage_type = 'reference'
    `).all() as any[]

    const unavailable: any[] = []
    for (const ref of refs) {
      const exists = ref.original_path ? fs.existsSync(ref.original_path) : false
      this.db.prepare('UPDATE documents SET is_available = ?, last_checked = CURRENT_TIMESTAMP WHERE id = ?')
        .run(exists ? 1 : 0, ref.id)
      // 文件存在时校验内容哈希，检测外部引用文件被修改的情况
      if (exists) {
        try {
          const currentHash = this.calculateHash(ref.original_path)
          if (currentHash !== ref.file_hash) {
            const stat = fs.statSync(ref.original_path)
            this.db.prepare(`UPDATE documents SET version = version + 1, file_hash = ?, file_size = ?, file_modified_at = ? WHERE id = ?`)
              .run(currentHash, stat.size, stat.mtime.toISOString(), ref.id)
            this.recordVersion(ref.id, 'modified', '外部引用文件内容变更')
          }
        } catch { /* 校验失败时跳过，不影响可用性状态 */ }
      }
      if (!exists) unavailable.push(ref)
    }
    return unavailable
  }

  /**
   * 版本控制：记录文档版本到 file_versions，并按 max_versions 裁剪历史。
   * 需在设置 version_control = true 时生效。
   */
  recordVersion(documentId: number, changeType: 'initial' | 'modified', summary?: string) {
    try {
      const settings = this.db.getSettingsSync()
      if (settings.version_control !== 'true') return
      const doc = this.db.prepare('SELECT version, file_hash, file_size FROM documents WHERE id = ?').get(documentId) as any
      if (!doc) return
      this.db.prepare(`
        INSERT INTO file_versions (document_id, version_number, file_hash, file_size, change_type, change_summary)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(documentId, doc.version, doc.file_hash, doc.file_size, changeType, summary || null)
      const maxVersions = Math.max(1, Number(settings.max_versions) || 10)
      this.db.prepare(`
        DELETE FROM file_versions
        WHERE document_id = ?
          AND id NOT IN (
            SELECT id FROM file_versions WHERE document_id = ?
            ORDER BY version_number DESC, id DESC LIMIT ?
          )
      `).run(documentId, documentId, maxVersions)
    } catch (e) {
      console.error('recordVersion failed:', e)
    }
  }

  private logAudit(actorType: string, action: string, resourceType: string, details: string) {
    this.db.prepare(`
      INSERT INTO audit_logs (actor_type, actor_name, action, resource_type, details, status)
      VALUES (?, ?, ?, ?, ?, 'success')
    `).run(actorType, 'user', action, resourceType, details)
  }
}
