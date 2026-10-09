import * as fs from 'fs'
import * as path from 'path'
import DatabaseService from './database'
import { FileService } from './fileService'

export interface FolderSourceInput {
  rootPath: string
  name?: string
  storageMode?: string
  recursive?: boolean
  includeExt?: string[] | string | null
  excludeGlobs?: string[] | string | null
  projectId?: number | null
  autoSync?: boolean
}

export interface ScanEntry {
  path: string
  relativePath: string
  size: number
  mtimeMs: number
}

export interface ScanStats {
  visited: number
  matched: number
  unsupported: number
  tooLarge: number
  ignored: number
  truncated: boolean
}

export interface SyncResult {
  sourceId: number
  added: number
  reused: number
  updated: number
  restored: number
  removed: number
  unchanged: number
  enqueued: number
  deferred: number
  stats: ScanStats
}

/** 扫描默认跳过的目录：版本库、依赖、构建产物、系统目录 */
const DEFAULT_IGNORED_DIRS = new Set([
  '.git', '.svn', '.hg', 'node_modules', '__pycache__', '.venv', 'venv',
  'dist', 'build', 'out', '.next', '.nuxt', '.cache', '.idea', '.vscode',
  '$recycle.bin', 'system volume information', 'target', 'coverage',
])

const MAX_SCAN_DEPTH = 16
/** 单次扫描条目上限，避免误把盘符根目录建成映射源时撑爆内存 */
const MAX_SCAN_ENTRIES = 20000
/** mtime 容差：文件系统与 JS 时间戳存在毫秒级差异，避免误判为变更 */
const MTIME_TOLERANCE_MS = 2000

interface ResolvedOptions {
  storageMode: 'reference' | 'copy'
  recursive: boolean
  includeExt: Set<string>
  exclude: RegExp[]
  projectId: number | null
  autoSync: boolean
  maxFileSizeBytes: number
}

/**
 * 目录映射：把本地文件夹作为知识来源长期关联，而不是逐个导入文件。
 * 首轮全量入库，之后（启动/手动）按「相对路径 + 内容哈希」做差集同步，
 * 只处理新增与真正变更的文件；解析参数（文本/摘要/向量/实体/标签）全部落库，
 * 重启后直接可用，无需重新解析。
 */
export class FolderSourceService {
  /** 正在同步的映射源，避免重复触发造成并发扫描 */
  private running = new Set<number>()

  constructor(
    private db: DatabaseService,
    private dataDir: string,
    private files: FileService,
    private enqueue: (documentId: number) => void
  ) {}

  listSources(): any[] {
    return this.db.prepare(`
      SELECT s.*,
        (SELECT COUNT(*) FROM documents d WHERE d.source_id = s.id AND d.is_available = 1) AS doc_count,
        (SELECT COUNT(*) FROM documents d WHERE d.source_id = s.id AND d.is_available = 0) AS missing_count,
        (SELECT COUNT(*) FROM documents d WHERE d.source_id = s.id AND d.processing_status = 'pending') AS pending_count,
        p.name AS project_name
      FROM folder_sources s
      LEFT JOIN projects p ON p.id = s.project_id
      ORDER BY s.created_at DESC
    `).all() as any[]
  }

  getSource(id: number): any {
    return this.db.prepare('SELECT * FROM folder_sources WHERE id = ?').get(id)
  }

  /**
   * 目录树（ADR-002）：不传 sourceId 返回所有空间的目录，按「路径深度 + 字典序」排好，
   * 前端可直接顺序装配成树。
   */
  listFolders(sourceId?: number | null): any[] {
    if (sourceId != null) {
      return this.db.prepare(`
        SELECT f.*, s.name AS source_name, s.root_path
        FROM folders f JOIN folder_sources s ON s.id = f.source_id
        WHERE f.source_id = ?
        ORDER BY f.depth, f.path
      `).all(sourceId) as any[]
    }
    return this.db.prepare(`
      SELECT f.*, s.name AS source_name, s.root_path
      FROM folders f JOIN folder_sources s ON s.id = f.source_id
      ORDER BY f.source_id, f.depth, f.path
    `).all() as any[]
  }

  getFolder(sourceId: number, folderPath: string): any {
    return this.db.prepare('SELECT * FROM folders WHERE source_id = ? AND path = ?').get(sourceId, folderPath)
  }

  /**
   * 从扫描结果重建该空间的目录树。
   *
   * 目录集合直接从 `relativePath` 的父路径推导——不额外遍历文件系统，
   * 因此树的形状与「实际入库的文件」严格一致（被排除/超限的目录不会凭空出现）。
   *
   * `INSERT OR IGNORE` 依赖 `(source_id, path)` 唯一键保留既有 id：
   * `name` / `depth` 都是 path 的纯函数，不需要更新；只有新行才需要补 `parent_id`。
   */
  private rebuildFolderTree(sourceId: number, entries: ScanEntry[]): void {
    const dirPaths = new Set<string>([''])
    for (const entry of entries) {
      let dir = entry.relativePath
      const idx = dir.lastIndexOf('/')
      if (idx < 0) continue
      dir = dir.slice(0, idx)
      while (dir) {
        dirPaths.add(dir)
        const parentIdx = dir.lastIndexOf('/')
        dir = parentIdx < 0 ? '' : dir.slice(0, parentIdx)
      }
    }

    const ordered = [...dirPaths].sort(
      (a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b)
    )

    this.db.transaction(() => {
      const insert = this.db.prepare('INSERT OR IGNORE INTO folders (source_id, path, name, depth) VALUES (?, ?, ?, ?)')
      for (const dir of ordered) {
        const depth = dir ? dir.split('/').length : 0
        insert.run(sourceId, dir, dir ? dir.slice(dir.lastIndexOf('/') + 1) : '', depth)
      }

      // 只为新行补 parent_id：父目录在 ordered 里必然已插入
      const orphans = this.db.prepare(
        "SELECT path FROM folders WHERE source_id = ? AND path != '' AND parent_id IS NULL"
      ).all(sourceId) as any[]
      const link = this.db.prepare(`
        UPDATE folders SET parent_id = (
          SELECT p.id FROM folders p WHERE p.source_id = ? AND p.path = ?
        ) WHERE source_id = ? AND path = ?
      `)
      for (const row of orphans) {
        const parentPath = row.path.includes('/') ? row.path.slice(0, row.path.lastIndexOf('/')) : ''
        link.run(sourceId, parentPath, sourceId, row.path)
      }

      // 清理已消失的目录（被排除、删除或超出扫描上限）
      const placeholders = ordered.map(() => '?').join(',')
      this.db.prepare(`DELETE FROM folders WHERE source_id = ? AND path NOT IN (${placeholders})`)
        .run(sourceId, ...ordered)
    })

    this.refreshFolderCounts(sourceId)
  }

  /** 重算目录的文件计数：每个文档向其全部祖先目录各累加一次 */
  private refreshFolderCounts(sourceId?: number | null): void {
    const rows = (sourceId != null
      ? this.db.prepare('SELECT source_id, relative_path FROM documents WHERE source_id = ? AND is_available = 1').all(sourceId)
      : this.db.prepare('SELECT source_id, relative_path FROM documents WHERE source_id IS NOT NULL AND is_available = 1').all()) as any[]

    const counts = new Map<string, number>()
    for (const row of rows) {
      const relative: string = row.relative_path || ''
      const cut = relative.lastIndexOf('/')
      let dir = cut < 0 ? '' : relative.slice(0, cut)
      while (true) {
        const key = `${row.source_id}|${dir}`
        counts.set(key, (counts.get(key) || 0) + 1)
        if (!dir) break
        const parentCut = dir.lastIndexOf('/')
        dir = parentCut < 0 ? '' : dir.slice(0, parentCut)
      }
    }

    this.db.transaction(() => {
      if (sourceId != null) {
        this.db.prepare('UPDATE folders SET doc_count = 0 WHERE source_id = ?').run(sourceId)
      } else {
        this.db.prepare('UPDATE folders SET doc_count = 0').run()
      }
      const update = this.db.prepare('UPDATE folders SET doc_count = ? WHERE source_id = ? AND path = ?')
      for (const [key, count] of counts) {
        const separator = key.indexOf('|')
        update.run(count, Number(key.slice(0, separator)), key.slice(separator + 1))
      }
    })
  }

  /** 扫描预览：只统计不写库，让用户在执行前确认影响范围 */
  async previewScan(rootPath: string, options: Partial<FolderSourceInput> = {}): Promise<any> {
    const target = path.resolve(String(rootPath || ''))
    if (!this.isDirectory(target)) throw new Error(`目录不可访问：${target}`)

    const existing = this.db.prepare('SELECT id FROM folder_sources WHERE root_path = ?').get(target) as any
    const known = existing
      ? (this.db.prepare('SELECT id, relative_path, file_size, file_modified_at FROM documents WHERE source_id = ?').all(existing.id) as any[])
      : []
    const resolved = this.resolveOptions(options)
    const { entries, stats } = this.scan(target, resolved)
    const knownMap = new Map<string, any>(known.map((row) => [row.relative_path, row]))

    let newFiles = 0
    let changed = 0
    let unchanged = 0
    for (const entry of entries) {
      const row = knownMap.get(entry.relativePath)
      if (!row) {
        newFiles++
        continue
      }
      knownMap.delete(entry.relativePath)
      if (this.isModified(row, entry)) changed++
      else unchanged++
    }

    return {
      rootPath: target,
      sourceId: existing?.id ?? null,
      alreadyMapped: !!existing,
      stats,
      newFiles,
      changed,
      unchanged,
      missing: knownMap.size,
      sample: entries.slice(0, 10).map((entry) => entry.relativePath),
    }
  }

  async createSource(input: FolderSourceInput): Promise<any> {
    const rootPath = path.resolve(String(input.rootPath || ''))
    if (!this.isDirectory(rootPath)) throw new Error('请选择一个可访问的文件夹')

    const duplicate = this.db.prepare('SELECT id, name FROM folder_sources WHERE root_path = ?').get(rootPath) as any
    if (duplicate) throw new Error(`该文件夹已建立映射：${duplicate.name}`)

    const resolved = this.resolveOptions(input)
    const name = String(input.name || '').trim() || path.basename(rootPath) || rootPath
    const info = this.db.prepare(`
      INSERT INTO folder_sources (name, root_path, storage_mode, recursive, include_ext, exclude_globs, project_id, auto_sync)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      name,
      rootPath,
      resolved.storageMode,
      resolved.recursive ? 1 : 0,
      [...resolved.includeExt].join(','),
      input.excludeGlobs ? this.normalizeList(input.excludeGlobs).join(',') : '',
      resolved.projectId,
      resolved.autoSync ? 1 : 0
    )

    const sourceId = Number(info.lastInsertRowid)
    const sync = await this.syncSource(sourceId)
    return { source: this.getSource(sourceId), sync }
  }

  async updateSource(id: number, patch: Partial<FolderSourceInput> & { enabled?: boolean }): Promise<any> {
    const source = this.getSource(id)
    if (!source) throw new Error('映射源不存在')

    const fields: string[] = []
    const params: any[] = []
    const push = (column: string, value: any) => {
      fields.push(`${column} = ?`)
      params.push(value)
    }

    if (patch.name !== undefined) push('name', String(patch.name).trim() || source.name)
    if (patch.storageMode !== undefined) push('storage_mode', patch.storageMode === 'copy' ? 'copy' : 'reference')
    if (patch.recursive !== undefined) push('recursive', patch.recursive ? 1 : 0)
    if (patch.includeExt !== undefined) push('include_ext', patch.includeExt ? this.normalizeList(patch.includeExt).join(',') : '')
    if (patch.excludeGlobs !== undefined) push('exclude_globs', patch.excludeGlobs ? this.normalizeList(patch.excludeGlobs).join(',') : '')
    if (patch.projectId !== undefined) push('project_id', patch.projectId ?? null)
    if (patch.autoSync !== undefined) push('auto_sync', patch.autoSync ? 1 : 0)
    if (patch.enabled !== undefined) push('enabled', patch.enabled ? 1 : 0)

    if (fields.length === 0) return this.getSource(id)

    fields.push('updated_at = CURRENT_TIMESTAMP')
    params.push(id)
    this.db.prepare(`UPDATE folder_sources SET ${fields.join(', ')} WHERE id = ?`).run(...params)
    return this.getSource(id)
  }

  /**
   * 移除映射：默认保留已解析文档（解除归属，转为普通引用），
   * 传入 deleteDocuments 时连解析结果一并清理。
   */
  async removeSource(id: number, options: { deleteDocuments?: boolean } = {}): Promise<any> {
    const source = this.getSource(id)
    if (!source) throw new Error('映射源不存在')
    if (this.running.has(id)) throw new Error('该映射源正在同步中，请稍后再试')

    if (options.deleteDocuments) {
      const rows = this.db.prepare('SELECT id FROM documents WHERE source_id = ?').all(id) as any[]
      for (const row of rows) await this.files.deleteFile(row.id)
    } else {
      this.db.prepare('UPDATE documents SET source_id = NULL, relative_path = NULL WHERE source_id = ?').run(id)
    }
    this.db.prepare('DELETE FROM folders WHERE source_id = ?').run(id)
    this.db.prepare('DELETE FROM folder_sources WHERE id = ?').run(id)
    return { success: true, detached: !options.deleteDocuments }
  }

  async syncSource(sourceId: number, options: { enqueueLimit?: number } = {}): Promise<SyncResult> {
    const source = this.getSource(sourceId)
    if (!source) throw new Error('映射源不存在')
    if (this.running.has(sourceId)) throw new Error('该映射源正在同步中')

    this.running.add(sourceId)
    try {
      this.db.prepare("UPDATE folder_sources SET last_scan_status = 'scanning', last_error = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(sourceId)
      const resolved = this.resolveOptions(source)
      if (!this.isDirectory(source.root_path)) throw new Error(`目录不可访问：${source.root_path}`)

      const { entries, stats } = this.scan(source.root_path, resolved)
      const rows = this.db.prepare(`
        SELECT id, relative_path, file_hash, file_size, file_modified_at, is_available, processing_status
        FROM documents WHERE source_id = ?
      `).all(sourceId) as any[]
      const remaining = new Map<string, any>(rows.map((row) => [row.relative_path, row]))

      let added = 0
      let reused = 0
      let updated = 0
      let restored = 0
      let unchanged = 0
      const queued: number[] = []

      for (const entry of entries) {
        const known = remaining.get(entry.relativePath)
        if (known) remaining.delete(entry.relativePath)

        if (!known) {
          try {
            const result = await this.files.registerFromSource(entry.path, {
              sourceId,
              relativePath: entry.relativePath,
              storageMode: resolved.storageMode,
              projectId: resolved.projectId,
            })
            added++
            // 同内容文件已复用解析参数，无需再进推理队列
            if (result.reusedFrom) reused++
            else queued.push(result.documentId)
          } catch (e: any) {
            console.error(`映射入库失败：${entry.relativePath}`, e?.message || e)
          }
          continue
        }

        if (this.isModified(known, entry)) {
          this.applyModification(known.id, entry)
          updated++
          queued.push(known.id)
        } else if (known.is_available === 0) {
          this.db.prepare('UPDATE documents SET is_available = 1, last_checked = CURRENT_TIMESTAMP WHERE id = ?').run(known.id)
          restored++
        } else if (known.processing_status === 'pending') {
          // 上一轮被入队上限截断，本轮继续补跑
          queued.push(known.id)
        } else {
          unchanged++
        }
      }

      let removed = 0
      for (const row of remaining.values()) {
        if (row.is_available === 1) {
          this.db.prepare('UPDATE documents SET is_available = 0, last_checked = CURRENT_TIMESTAMP WHERE id = ?').run(row.id)
          removed++
        }
      }

      const planned = [...new Set(queued)]
      const configured = Number(this.db.getSettingsSync().folder_sync_limit)
      const limit = Math.max(1, Number(options.enqueueLimit) || configured || 200)
      const allowed = planned.slice(0, limit)
      for (const documentId of allowed) this.enqueue(documentId)

      const now = new Date().toISOString()
      this.refreshCounters(sourceId, entries.length)
      this.rebuildFolderTree(sourceId, entries)
      this.db.prepare(`
        UPDATE folder_sources SET last_scan_at = ?, last_sync_at = ?, last_scan_status = 'idle',
          last_error = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?
      `).run(now, now, sourceId)

      return {
        sourceId, added, reused, updated, restored, removed, unchanged,
        enqueued: allowed.length, deferred: planned.length - allowed.length, stats,
      }
    } catch (e: any) {
      this.db.prepare("UPDATE folder_sources SET last_scan_status = 'error', last_error = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
        .run(String(e?.message || e), sourceId)
      throw e
    } finally {
      this.running.delete(sourceId)
    }
  }

  /** 启动时自动同步启用的映射源；单个源失败不影响其余 */
  async syncAllSources(): Promise<{ synced: number; errors: { sourceId: number; error: string }[]; results: SyncResult[] }> {
    const rows = this.db.prepare('SELECT id FROM folder_sources WHERE enabled = 1 AND auto_sync = 1').all() as any[]
    const results: SyncResult[] = []
    const errors: { sourceId: number; error: string }[] = []
    for (const row of rows) {
      try {
        results.push(await this.syncSource(row.id))
      } catch (e: any) {
        errors.push({ sourceId: row.id, error: String(e?.message || e) })
      }
    }
    return { synced: results.length, errors, results }
  }

  /** 清理软删除（源文件已消失）的文档及其解析参数 */
  async cleanupUnavailable(sourceId?: number): Promise<{ removed: number }> {
    const rows = (sourceId
      ? this.db.prepare('SELECT id FROM documents WHERE is_available = 0 AND source_id = ?').all(sourceId)
      : this.db.prepare('SELECT id FROM documents WHERE is_available = 0 AND source_id IS NOT NULL').all()) as any[]
    for (const row of rows) await this.files.deleteFile(row.id)
    if (sourceId) this.refreshCounters(sourceId)
    return { removed: rows.length }
  }

  private scan(rootPath: string, options: ResolvedOptions): { entries: ScanEntry[]; stats: ScanStats } {
    const entries: ScanEntry[] = []
    const stats: ScanStats = { visited: 0, matched: 0, unsupported: 0, tooLarge: 0, ignored: 0, truncated: false }

    const walk = (dir: string, depth: number) => {
      if (entries.length >= MAX_SCAN_ENTRIES) {
        stats.truncated = true
        return
      }
      let items: fs.Dirent[]
      try {
        items = fs.readdirSync(dir, { withFileTypes: true })
      } catch {
        return // 权限不足或目录被占用时跳过该项，不中断整轮同步
      }
      for (const item of items) {
        if (entries.length >= MAX_SCAN_ENTRIES) {
          stats.truncated = true
          return
        }
        stats.visited++
        const full = path.join(dir, item.name)
        const relativePath = path.relative(rootPath, full).split(path.sep).join('/')
        if (this.isExcluded(options.exclude, relativePath, item.name)) {
          stats.ignored++
          continue
        }
        if (item.isDirectory()) {
          if (!options.recursive || depth >= MAX_SCAN_DEPTH) continue
          if (DEFAULT_IGNORED_DIRS.has(item.name.toLowerCase())) {
            stats.ignored++
            continue
          }
          walk(full, depth + 1)
          continue
        }
        if (!item.isFile()) continue
        if (item.name.startsWith('.')) {
          stats.ignored++
          continue
        }
        const ext = path.extname(item.name).toLowerCase().replace('.', '')
        const accepted = options.includeExt.size > 0 ? options.includeExt.has(ext) : this.files.isSupportedFile(item.name)
        if (!accepted) {
          stats.unsupported++
          continue
        }
        let stat: fs.Stats
        try {
          stat = fs.statSync(full)
        } catch {
          continue
        }
        if (stat.size > options.maxFileSizeBytes) {
          stats.tooLarge++
          continue
        }
        entries.push({ path: full, relativePath, size: stat.size, mtimeMs: stat.mtimeMs })
      }
    }

    walk(rootPath, 0)
    stats.matched = entries.length
    return { entries, stats }
  }

  private resolveOptions(input: any): ResolvedOptions {
    const rawInclude = input?.includeExt ?? input?.include_ext ?? ''
    const rawExclude = input?.excludeGlobs ?? input?.exclude_globs ?? ''
    const storageMode = input?.storageMode ?? input?.storage_mode
    const projectId = input?.projectId ?? input?.project_id
    const autoSync = input?.autoSync ?? input?.auto_sync
    return {
      storageMode: storageMode === 'copy' ? 'copy' : 'reference',
      recursive: input?.recursive === undefined ? true : !!input.recursive,
      includeExt: new Set(this.normalizeList(rawInclude).map((ext) => ext.toLowerCase())),
      exclude: this.normalizeList(rawExclude).map((pattern) => this.globToRegExp(pattern)),
      projectId: projectId === undefined || projectId === null ? null : Number(projectId) || null,
      autoSync: autoSync === undefined ? true : !!autoSync,
      maxFileSizeBytes: (Number(this.db.getSettingsSync().max_file_size) || 500) * 1048576,
    }
  }

  private normalizeList(value: unknown): string[] {
    if (value === undefined || value === null || value === '') return []
    const items = Array.isArray(value) ? value : String(value).split(/[,;\n]/)
    return items.map((item) => String(item).trim()).filter(Boolean)
  }

  private globToRegExp(pattern: string): RegExp {
    const escaped = pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*\*/g, '\u0000')
      .replace(/\*/g, '[^/\\\\]*')
      .replace(/\u0000/g, '.*')
    return new RegExp(`^${escaped}$`, 'i')
  }

  private isExcluded(exclude: RegExp[], relativePath: string, name: string): boolean {
    if (exclude.length === 0) return false
    const segments = relativePath.split('/')
    for (const rule of exclude) {
      if (rule.test(relativePath) || rule.test(name)) return true
      if (segments.some((segment) => rule.test(segment))) return true
    }
    return false
  }

  /** 先比大小与修改时间，命中后再用内容哈希二次确认，避免仅 touch 文件就触发重新解析 */
  private isModified(row: any, entry: ScanEntry): boolean {
    const previous = row.file_modified_at ? Date.parse(row.file_modified_at) : 0
    if (row.file_size === entry.size && Math.abs(previous - entry.mtimeMs) <= MTIME_TOLERANCE_MS) return false
    try {
      return this.files.calculateHash(entry.path) !== row.file_hash
    } catch {
      return true
    }
  }

  private applyModification(documentId: number, entry: ScanEntry) {
    const hash = this.files.calculateHash(entry.path)
    this.db.transaction(() => {
      this.db.prepare(`
        UPDATE documents SET file_hash = ?, file_size = ?, file_modified_at = ?, version = version + 1,
          processing_status = 'pending', processing_error = NULL, is_available = 1,
          last_checked = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(hash, entry.size, new Date(entry.mtimeMs).toISOString(), documentId)
      this.files.recordVersion(documentId, 'modified', '映射目录源文件变更')
    })
  }

  private refreshCounters(sourceId: number, entryCount?: number) {
    const missing = (this.db.prepare('SELECT COUNT(*) AS c FROM documents WHERE source_id = ? AND is_available = 0').get(sourceId) as any)?.c ?? 0
    const total = entryCount ?? (this.db.prepare('SELECT COUNT(*) AS c FROM documents WHERE source_id = ? AND is_available = 1').get(sourceId) as any)?.c ?? 0
    this.db.prepare('UPDATE folder_sources SET file_count = ?, missing_count = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(total, missing, sourceId)
  }

  private isDirectory(target: string): boolean {
    try {
      return fs.statSync(target).isDirectory()
    } catch {
      return false
    }
  }
}
