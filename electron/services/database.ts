import Database from 'better-sqlite3'
import * as path from 'path'
import * as fs from 'fs'
import { openDatabase } from './sqlite'
import { QueueTask } from './processingQueue'
import { MigrationDb, runMigrations } from './migrations'
import { coreMigrations } from './coreMigrations'
import { workbenchMigrations } from './workbench/schema'

export default class DatabaseService {
  private db: Database.Database
  private dbPath: string
  /** 本次启动前数据库文件是否已存在：存量库迁移前需快照，新库不需要 */
  private isNewDatabase: boolean
  /** 是否已关闭：后台任务据此判断「库没了」并安静退出（见 isOpen） */
  private closed = false

  constructor(dbPath: string) {
    this.dbPath = dbPath
    // 必须在 openDatabase 之前判定：打开动作本身会创建出空文件
    this.isNewDatabase = dbPath === ':memory:' || !fs.existsSync(dbPath) || fs.statSync(dbPath).size === 0
    this.db = openDatabase(dbPath)
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('foreign_keys = ON')
  }

  async init() {
    this.createTables()
    const { applied, snapshot } = runMigrations(
      this.db as unknown as MigrationDb,
      [...coreMigrations, ...workbenchMigrations],
      { dbPath: this.dbPath, snapshot: !this.isNewDatabase },
    )
    if (snapshot) console.log(`[database] 迁移前已生成快照：${snapshot}`)
    if (applied.length) {
      console.log(`[database] 已应用迁移：${applied.map(m => `${m.version}:${m.name}`).join(', ')}`)
    }
    this.createIndexes()
    this.createFTS()
    await this.insertDefaultSettings()
  }

  private createTables() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS documents (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        file_name TEXT NOT NULL,
        file_path TEXT NOT NULL,
        file_type TEXT NOT NULL,
        file_size INTEGER,
        file_hash TEXT,
        storage_type TEXT DEFAULT 'local',
        original_path TEXT,
        content_text TEXT,
        summary TEXT,
        thumbnail_path TEXT,
        metadata TEXT,
        project_id INTEGER,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        imported_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        file_modified_at DATETIME,
        is_available INTEGER DEFAULT 1,
        last_checked DATETIME,
        version INTEGER DEFAULT 1,
        source_id INTEGER,
        relative_path TEXT,
        FOREIGN KEY (project_id) REFERENCES projects(id)
      );

      CREATE TABLE IF NOT EXISTS entities (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        description TEXT,
        metadata TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(name, type)
      );

      CREATE TABLE IF NOT EXISTS relationships (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_type TEXT NOT NULL,
        source_id INTEGER NOT NULL,
        target_type TEXT NOT NULL,
        target_id INTEGER NOT NULL,
        relation_type TEXT NOT NULL,
        weight REAL DEFAULT 1.0,
        metadata TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS tags (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        color TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS document_tags (
        document_id INTEGER,
        tag_id INTEGER,
        PRIMARY KEY (document_id, tag_id),
        FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE,
        FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS projects (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        description TEXT,
        color TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS folder_sources (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        root_path TEXT NOT NULL UNIQUE,
        storage_mode TEXT DEFAULT 'reference',
        recursive INTEGER DEFAULT 1,
        include_ext TEXT,
        exclude_globs TEXT,
        project_id INTEGER,
        auto_sync INTEGER DEFAULT 1,
        enabled INTEGER DEFAULT 1,
        file_count INTEGER DEFAULT 0,
        missing_count INTEGER DEFAULT 0,
        last_scan_at DATETIME,
        last_sync_at DATETIME,
        last_scan_status TEXT DEFAULT 'idle',
        last_error TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS vectors (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        document_id INTEGER,
        embedding BLOB,
        model TEXT,
        dimension INTEGER,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
      );

      -- 目录树（ADR-002）：由 folder_sources + documents.relative_path 派生，随扫描重建。
      -- 独立成表而非塞进 entities：不同空间下同名子目录（src/docs）在 entities 的
      -- UNIQUE(name,type) 下会互相撞车。
      --
      -- 自然键是 (source_id, path)：扫描时用 INSERT OR IGNORE 保留既有 id，
      -- 只清理已消失的 path——否则每次扫描重建，id 漂移会让挂在目录上的边全部失效。
      CREATE TABLE IF NOT EXISTS folders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_id INTEGER NOT NULL,
        path TEXT NOT NULL,
        name TEXT NOT NULL,
        parent_id INTEGER,
        depth INTEGER NOT NULL DEFAULT 0,
        doc_count INTEGER DEFAULT 0,
        summary TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (source_id, path)
      );

      CREATE TABLE IF NOT EXISTS file_versions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        document_id INTEGER NOT NULL,
        version_number INTEGER NOT NULL,
        file_hash TEXT NOT NULL,
        file_size INTEGER,
        change_type TEXT,
        change_summary TEXT,
        diff_path TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS api_keys (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        key_hash TEXT NOT NULL,
        key_prefix TEXT NOT NULL,
        name TEXT NOT NULL,
        role TEXT DEFAULT 'reader',
        scopes TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        last_used_at DATETIME,
        expires_at DATETIME,
        is_active INTEGER DEFAULT 1
      );

      CREATE TABLE IF NOT EXISTS agent_sessions (
        id TEXT PRIMARY KEY,
        agent_name TEXT NOT NULL,
        agent_type TEXT,
        api_key_id INTEGER,
        connected_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        last_active_at DATETIME,
        queries_count INTEGER DEFAULT 0,
        status TEXT DEFAULT 'active'
      );

      CREATE TABLE IF NOT EXISTS agent_query_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT,
        query_type TEXT,
        query_params TEXT,
        result_count INTEGER,
        response_time_ms INTEGER,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (session_id) REFERENCES agent_sessions(id)
      );

      CREATE TABLE IF NOT EXISTS audit_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        actor_type TEXT,
        actor_name TEXT,
        action TEXT NOT NULL,
        resource_type TEXT,
        resource_id TEXT,
        details TEXT,
        ip_address TEXT,
        user_agent TEXT,
        status TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT
      );

      CREATE TABLE IF NOT EXISTS processing_queue (
        document_id INTEGER PRIMARY KEY,
        status TEXT DEFAULT 'pending',
        priority INTEGER DEFAULT 50,
        attempts INTEGER DEFAULT 0,
        error TEXT,
        enqueued_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
      );
    `)
  }

  private createIndexes() {
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_documents_type ON documents(file_type);
      CREATE INDEX IF NOT EXISTS idx_documents_storage ON documents(storage_type);
      CREATE INDEX IF NOT EXISTS idx_documents_project ON documents(project_id);
      CREATE INDEX IF NOT EXISTS idx_documents_hash ON documents(file_hash);
      CREATE INDEX IF NOT EXISTS idx_documents_imported ON documents(imported_at DESC);
      CREATE INDEX IF NOT EXISTS idx_documents_source ON documents(source_id, relative_path);
      CREATE INDEX IF NOT EXISTS idx_documents_availability ON documents(is_available);
      CREATE INDEX IF NOT EXISTS idx_folders_source ON folders(source_id, path);
      CREATE INDEX IF NOT EXISTS idx_folders_parent ON folders(parent_id);
      CREATE INDEX IF NOT EXISTS idx_relationships_mention ON relationships(target_type, target_id, source_type);
      CREATE INDEX IF NOT EXISTS idx_relationships_source ON relationships(source_type, source_id);
      CREATE INDEX IF NOT EXISTS idx_relationships_target ON relationships(target_type, target_id);
      CREATE INDEX IF NOT EXISTS idx_entities_type ON entities(type);
      CREATE INDEX IF NOT EXISTS idx_audit_logs_time ON audit_logs(created_at);
      CREATE INDEX IF NOT EXISTS idx_audit_logs_actor ON audit_logs(actor_name);
      CREATE INDEX IF NOT EXISTS idx_audit_logs_action ON audit_logs(action);
      CREATE INDEX IF NOT EXISTS idx_processing_queue_time ON processing_queue(enqueued_at);
      CREATE INDEX IF NOT EXISTS idx_processing_queue_order ON processing_queue(priority DESC, enqueued_at);
    `)
  }

  private createFTS() {
    try {
      // 旧版 unicode61 分词将连续中文视为单一 token，无法命中子串查询；
      // 检测到旧表时重建为 trigram 分词（支持中文子串检索与 LIKE 加速）
      const existing = this.db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='documents_fts'").get() as any
      let rebuilt = false
      if (existing && !/trigram/i.test(existing.sql || '')) {
        this.db.exec(`
          DROP TRIGGER IF EXISTS documents_ai;
          DROP TRIGGER IF EXISTS documents_ad;
          DROP TRIGGER IF EXISTS documents_au;
          DROP TABLE IF EXISTS documents_fts;
        `)
        rebuilt = true
      }
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts USING fts5(
          title, content_text, summary,
          content='documents',
          content_rowid='id',
          tokenize='trigram'
        );

        CREATE TRIGGER IF NOT EXISTS documents_ai AFTER INSERT ON documents BEGIN
          INSERT INTO documents_fts(rowid, title, content_text, summary)
          VALUES (new.id, new.title, new.content_text, new.summary);
        END;

        CREATE TRIGGER IF NOT EXISTS documents_ad AFTER DELETE ON documents BEGIN
          INSERT INTO documents_fts(documents_fts, rowid, title, content_text, summary)
          VALUES('delete', old.id, old.title, old.content_text, old.summary);
        END;

        CREATE TRIGGER IF NOT EXISTS documents_au AFTER UPDATE ON documents BEGIN
          INSERT INTO documents_fts(documents_fts, rowid, title, content_text, summary)
          VALUES('delete', old.id, old.title, old.content_text, old.summary);
          INSERT INTO documents_fts(rowid, title, content_text, summary)
          VALUES (new.id, new.title, new.content_text, new.summary);
        END;
      `)
      // 旧分词表重建后需要从 documents 全量回填索引内容
      if (rebuilt) {
        this.db.exec(`INSERT INTO documents_fts(documents_fts) VALUES('rebuild')`)
      }
    } catch (e) {
      console.error('FTS5 setup error:', e)
    }
  }

  private async insertDefaultSettings() {
    const defaults = {
      'api_port': '17890',
      'api_enabled': 'true',
      'data_dir': '',
      'theme': 'dark',
      'auto_start': 'false',
      'minimize_to_tray': 'true',
      'ocr_enabled': 'true',
      'vector_enabled': 'true',
      'embedding_model': 'Xenova/bge-small-zh-v1.5',
      // 深度 NER（transformers.js token-classification）：默认关闭，开启后会下载模型、首次解析变慢，
      // 结果与规则层自动合并去重。注意本处为 INSERT OR IGNORE，仅对新库生效；存量库读不到时
      // processingEngine 按 'false' 兜底，不会报错。
      'deep_ner_enabled': 'false',
      'ner_model': 'Xenova/bert-base-NER',
      'chunk_size': '512',
      'chunk_overlap': '50',
      // 混合检索（D10）：RRF 融合权重与规则重排系数。上限约束 α≤0.2、五者之和≤1.0
      // 由 searchService 强制（防止「最近导入的总是赢」把相关性挤掉）。
      'search.rrf.fulltext': '1',
      'search.rrf.semantic': '1',
      'search.rerank.alpha': '0.15',
      'search.rerank.beta': '0.10',
      'search.rerank.gamma': '0.05',
      'search.rerank.delta': '0.05',
      'search.rerank.epsilon': '0.20',
      // 存量回填（D8）进度标记：全部完成后置 true，避免每次启动都做全表 EXISTS 扫描
      'chunks_backfill_done': 'false',
      // 实测：onnxruntime-node 的 CPU EP 在 batch>4 时批 GEMM 效率显著下降（batch=8 比 batch=1 慢约 20%），
      // batch=2 推理耗时与串行持平但写库事务数减半，故取 2 为默认。
      'embed_batch_size': '2',
      'max_file_size': '500',
      // 目录映射：启动时自动同步已启用的映射源，单次同步最多入队解析的任务数（超出部分留待下次同步继续）
      'folder_sync_on_start': 'true',
      'folder_sync_limit': '200',
      // 解析队列：并发度。1 = 严格串行（原行为）；2 起允许长文档推理期间其它文档并行做解析/写库。
      // 取 2 是因为并发过高会争抢 onnxruntime 的 CPU 线程，反而拉低单篇吞吐。
      'queue_concurrency': '2',
      'backup_interval': '24',
      'backup_count': '7',
      'version_control': 'true',
      'max_versions': '10',
      'rate_limit': '100',
      'security_enabled': 'false',
      'perf_log_enabled': 'false',
    }

    // updated_at 由语句显式写入：该列是迁移期补出来的，没有 DEFAULT CURRENT_TIMESTAMP
    const stmt = this.db.prepare('INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)')
    for (const [key, value] of Object.entries(defaults)) {
      stmt.run(key, value)
    }
  }

  prepare(sql: string) {
    return this.db.prepare(sql)
  }

  exec(sql: string) {
    return this.db.exec(sql)
  }

  /**
   * 在单个事务中执行同步回调。
   * 批量实体操作需要"全成功或全回滚"语义，避免中途失败留下半合并状态。
   */
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)()
  }

  /** 解析队列持久化：入队时落库（含优先级），保证异常退出后可断点续传 */
  markQueued(documentId: number, priority: number = 50) {
    try {
      this.db.prepare(`
        INSERT INTO processing_queue (document_id, status, attempts, error, priority, enqueued_at, updated_at)
        VALUES (?, 'pending', 1, NULL, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        ON CONFLICT(document_id) DO UPDATE SET
          status = 'pending', error = NULL, priority = MAX(priority, excluded.priority),
          attempts = attempts + 1, updated_at = CURRENT_TIMESTAMP
      `).run(documentId, priority)
    } catch (e) {
      console.error('markQueued failed:', e)
    }
  }

  /** 任务收尾（成功或失败）后清理队列记录 */
  unmarkQueued(documentId: number) {
    try {
      this.db.prepare('DELETE FROM processing_queue WHERE document_id = ?').run(documentId)
    } catch (e) {
      console.error('unmarkQueued failed:', e)
    }
  }

  /** 待处理任务：优先级高者在前，同优先级按入队时间；断点续传据此还原出队顺序 */
  getQueuedTasks(): QueueTask[] {
    try {
      const rows = this.db.prepare('SELECT document_id, priority FROM processing_queue ORDER BY priority DESC, enqueued_at, document_id').all() as any[]
      return rows
        .filter(r => typeof r.document_id === 'number')
        .map(r => ({ documentId: r.document_id, priority: typeof r.priority === 'number' ? r.priority : 50 }))
    } catch (e) {
      console.error('getQueuedTasks failed:', e)
      return []
    }
  }

  getQueuedDocumentIds(): number[] {
    return this.getQueuedTasks().map(task => task.documentId)
  }

  /**
   * Agent 查询日志（S2-09）：`agent_query_logs` 有表无写入的现状在此收口。
   * 仅日志，绝不让写日志失败影响主流程（调用方 answerService.ask 的返回不受影响）。
   */
  logAgentQuery(row: { sessionId?: string | null; queryType: string; queryParams: unknown; resultCount?: number | null; responseTimeMs?: number | null }) {
    try {
      this.db.prepare(`
        INSERT INTO agent_query_logs (session_id, query_type, query_params, result_count, response_time_ms)
        VALUES (?, ?, ?, ?, ?)
      `).run(
        row.sessionId ?? null,
        row.queryType,
        typeof row.queryParams === 'string' ? row.queryParams : JSON.stringify(row.queryParams ?? {}),
        row.resultCount ?? null,
        row.responseTimeMs ?? null,
      )
    } catch (e) {
      console.error('logAgentQuery failed:', e)
    }
  }

  clearQueue() {
    try {
      this.db.prepare('DELETE FROM processing_queue').run()
    } catch (e) {
      console.error('clearQueue failed:', e)
    }
  }

  async getDashboardStats() {
    const docCount = this.db.prepare('SELECT COUNT(*) as count FROM documents WHERE is_available = 1').get() as any
    const entityCount = this.db.prepare('SELECT COUNT(*) as count FROM entities').get() as any
    const relCount = this.db.prepare('SELECT COUNT(*) as count FROM relationships').get() as any
    const projectCount = this.db.prepare('SELECT COUNT(*) as count FROM projects').get() as any
    const localCount = this.db.prepare("SELECT COUNT(*) as count FROM documents WHERE storage_type = 'local'").get() as any
    const refCount = this.db.prepare("SELECT COUNT(*) as count FROM documents WHERE storage_type = 'reference'").get() as any

    return {
      documents: docCount.count,
      entities: entityCount.count,
      relationships: relCount.count,
      projects: projectCount.count,
      localFiles: localCount.count,
      referenceFiles: refCount.count,
      total_files: docCount.count,
      total_entities: entityCount.count,
      total_relationships: relCount.count,
      local_files: localCount.count,
      reference_files: refCount.count,
      total_size: (this.db.prepare('SELECT COALESCE(SUM(file_size),0) AS value FROM documents WHERE is_available=1').get() as any).value,
      indexed_files: (this.db.prepare('SELECT COUNT(DISTINCT document_id) AS value FROM vectors').get() as any).value,
      processing: this.db.prepare('SELECT processing_status AS name, COUNT(*) AS value FROM documents GROUP BY processing_status').all(),
      file_types: this.db.prepare('SELECT upper(file_type) AS name, COUNT(*) AS value FROM documents WHERE is_available=1 GROUP BY file_type ORDER BY value DESC').all(),
      entity_types: this.db.prepare('SELECT type AS name, COUNT(*) AS value FROM entities GROUP BY type ORDER BY value DESC').all(),
      storage: this.db.prepare("SELECT CASE storage_type WHEN 'local' THEN '本地文件' ELSE '外部引用' END AS name, COALESCE(SUM(file_size),0) AS value FROM documents WHERE is_available=1 GROUP BY storage_type").all(),
      trend: this.db.prepare(`WITH RECURSIVE days(day) AS (
        SELECT date('now','localtime','-29 days') UNION ALL SELECT date(day,'+1 day') FROM days WHERE day < date('now','localtime')
      ) SELECT day,
        (SELECT COUNT(*) FROM documents WHERE date(imported_at,'localtime')=day) AS files,
        (SELECT COUNT(*) FROM entities WHERE date(created_at,'localtime')=day) AS entities,
        (SELECT COUNT(*) FROM relationships WHERE date(created_at,'localtime')=day) AS relationships
      FROM days`).all(),
    }
  }

  /**
   * 分析页聚合（S2-02）：知识库规模 + 近 N 天入库/问答命中趋势。
   *
   * 命中趋势读 `agent_query_logs`（S2-09 起 answerService.ask 逐次落行，三个问答出口共用）；
   * 样本不足（窗口内问答次数过少）时如实标注，不伪造趋势结论。
   * created_at / imported_at 均为 CURRENT_TIMESTAMP（UTC 无时区标记），SQL 内用 'localtime' 修正口径。
   */
  async getAnalyticsOverview(windowDays = 14) {
    const days = Math.min(60, Math.max(7, Math.round(Number(windowDays) || 14)))

    const trend = this.db.prepare(`WITH RECURSIVE days(day) AS (
        SELECT date('now','localtime','-${days - 1} days')
        UNION ALL SELECT date(day,'+1 day') FROM days WHERE day < date('now','localtime')
      ) SELECT day,
        (SELECT COUNT(*) FROM documents WHERE is_available=1 AND date(imported_at,'localtime')=day) AS documents,
        (SELECT COUNT(*) FROM agent_query_logs WHERE date(created_at,'localtime')=day) AS queries,
        (SELECT AVG(result_count) FROM agent_query_logs WHERE date(created_at,'localtime')=day) AS avg_results,
        (SELECT AVG(response_time_ms) FROM agent_query_logs WHERE date(created_at,'localtime')=day) AS avg_latency_ms
      FROM days ORDER BY day`).all() as any[]

    const one = (sql: string) => Number((this.db.prepare(sql).get() as any)?.value || 0)
    const totals = {
      documents: one('SELECT COUNT(*) AS value FROM documents WHERE is_available=1'),
      chunks: one('SELECT COUNT(*) AS value FROM chunks'),
      entities: one('SELECT COUNT(*) AS value FROM entities'),
      relationships: one('SELECT COUNT(*) AS value FROM relationships'),
      projects: one('SELECT COUNT(*) AS value FROM projects'),
      localFiles: one("SELECT COUNT(*) AS value FROM documents WHERE storage_type='local' AND is_available=1"),
      referenceFiles: one("SELECT COUNT(*) AS value FROM documents WHERE storage_type='reference' AND is_available=1"),
      indexedFiles: one('SELECT COUNT(DISTINCT document_id) AS value FROM vectors'),
    }

    const queryRow = this.db.prepare(`
      SELECT COUNT(*) AS total, AVG(result_count) AS avg_results, AVG(response_time_ms) AS avg_latency_ms,
        MAX(created_at) AS last_at
      FROM agent_query_logs WHERE date(created_at,'localtime') >= date('now','localtime','-${days - 1} days')
    `).get() as any
    const queries = {
      total: Number(queryRow?.total || 0),
      avgResults: queryRow?.avg_results == null ? null : Math.round(Number(queryRow.avg_results) * 10) / 10,
      avgLatencyMs: queryRow?.avg_latency_ms == null ? null : Math.round(Number(queryRow.avg_latency_ms)),
      lastAt: queryRow?.last_at || null,
    }
    // 样本口径：窗口内不足 10 次问答不画趋势结论，只报「样本不足」
    const sample = {
      queries: queries.total,
      sufficient: queries.total >= 10,
      note: queries.total >= 10
        ? null
        : `近 ${days} 天仅 ${queries.total} 次问答，样本不足，趋势仅供参考`,
    }

    return {
      windowDays: days,
      totals,
      queries,
      sample,
      trend: trend.map((row) => ({
        date: row.day,
        documents: Number(row.documents || 0),
        queries: Number(row.queries || 0),
        avgResults: row.avg_results == null ? null : Math.round(Number(row.avg_results) * 10) / 10,
        avgLatencyMs: row.avg_latency_ms == null ? null : Math.round(Number(row.avg_latency_ms)),
      })),
    }
  }

  async getRecentFiles(limit: number = 10) {
    return this.db.prepare(`
      SELECT d.id, d.title, d.file_name, d.file_type, d.file_size, d.storage_type, d.original_path,
             d.imported_at, d.is_available
      FROM documents d
      WHERE d.is_available = 1
      ORDER BY d.imported_at DESC
      LIMIT ?
    `).all(limit)
  }

  getSettingsSync() {
    const rows = this.db.prepare('SELECT key, value FROM settings').all() as any[]
    const settings: any = {}
    rows.forEach(r => { settings[r.key] = r.value })
    return settings
  }

  async getSettings() {
    return this.getSettingsSync()
  }

  async updateSettings(settings: Record<string, string>) {
    const stmt = this.db.prepare('INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)')
    const tx = this.db.transaction(() => {
      for (const [key, value] of Object.entries(settings)) {
        stmt.run(key, value)
      }
    })
    tx()
    return { success: true }
  }

  /**
   * 备份数据库到目标路径（快照方式，不阻塞写入）。
   * better-sqlite3 使用原生 backup API；node:sqlite 回退 VACUUM INTO。
   */
  async backupTo(destPath: string): Promise<void> {
    const anyDb = this.db as any
    if (typeof anyDb.backup === 'function') {
      await anyDb.backup(destPath)
    } else {
      this.db.exec(`VACUUM INTO '${destPath.replace(/'/g, "''")}'`)
    }
  }

  /** 连接是否仍然可用：后台任务（如 chunks 回填）在库已关闭时应安静退出，而不是抛「database is not open」 */
  isOpen(): boolean {
    return !this.closed
  }

  close() {
    this.closed = true
    this.db.close()
  }
}
