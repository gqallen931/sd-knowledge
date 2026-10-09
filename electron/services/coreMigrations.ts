import type { Migration } from './migrations'

/**
 * 内核域迁移（版本号 1..99）。
 *
 * v1 是「baseline」：把原先写在 DatabaseService.init() 里的三段隐式补列收编进来。
 * 这些 ALTER 都带列存在性判断，因此对存量库是幂等的空操作、对新库也不需要执行
 * （createTables 已按最新结构建表），但登记进 schema_migrations 后就不再每次启动重复探测。
 */
export const coreMigrations: Migration[] = [
  {
    version: 1,
    name: 'baseline-document-and-queue-columns',
    up(db) {
      const docColumns = db.prepare('PRAGMA table_info(documents)').all()
      const hasDoc = (name: string) => docColumns.some((column: any) => column.name === name)

      if (!hasDoc('processing_status')) {
        db.exec("ALTER TABLE documents ADD COLUMN processing_status TEXT DEFAULT 'pending'; ALTER TABLE documents ADD COLUMN processing_error TEXT")
        // 存量数据里已有正文的文档按已完成回填，避免升级后全库重新解析
        db.exec("UPDATE documents SET processing_status = 'ready' WHERE length(content_text) > 0")
      }
      // 目录映射：来源目录归属与相对路径（新库已由 createTables 建好）
      if (!hasDoc('source_id')) {
        db.exec('ALTER TABLE documents ADD COLUMN source_id INTEGER; ALTER TABLE documents ADD COLUMN relative_path TEXT')
      }

      const queueColumns = db.prepare('PRAGMA table_info(processing_queue)').all()
      if (!queueColumns.some((column: any) => column.name === 'priority')) {
        db.exec('ALTER TABLE processing_queue ADD COLUMN priority INTEGER DEFAULT 50')
      }
    },
  },
  {
    version: 2,
    name: 'chunks-and-vector-chunk-link',
    /**
     * 块级溯源（D8）：建 `chunks` 并让 `vectors` 关联到块。
     *
     * **迁移内只建表、不搬数**：存量回填要走「重建分块 + 重新推理向量」，是分钟级甚至更长的
     * 后台任务，放进迁移会让启动直接卡死（架构文档 §3.3.3）。回填由 `chunkBackfill.ts` 分批执行。
     *
     * 幂等：DDL 全部 IF NOT EXISTS；加列前用 `PRAGMA table_info` 判断列是否存在，
     * 因此即使 `schema_migrations` 记录丢失（人工恢复快照）后重复执行也没有副作用。
     */
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS chunks (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          document_id   INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
          /** 文档内块序号，从 0 起；与 vectors.chunk_index 一致，用于稳定排序与回填对齐 */
          chunk_index   INTEGER NOT NULL,
          content       TEXT    NOT NULL,
          /** 字符偏移：相对于 documents.content_text（归一化后的文本，\\r\\n→\\n） */
          char_start    INTEGER NOT NULL,
          char_end      INTEGER NOT NULL,
          /** 位置锚点：PDF 页码 / PPT slide 号 / EPUB 章节号 / XLS sheet 序（无则 NULL） */
          anchor_kind   TEXT    CHECK (anchor_kind IN ('page','slide','chapter','sheet','time')),
          anchor_index  INTEGER,
          /** 音视频时间戳（毫秒）；纯文本为 NULL */
          time_start_ms INTEGER,
          time_end_ms   INTEGER,
          /** OCR 来源的文本块可带 bbox（JSON: [x,y,w,h]，坐标基于源图/帧） */
          bbox          TEXT,
          /** 粗估 token 数（口径 ceil(chars/2)，与 searchService.getContext 一致） */
          token_count   INTEGER NOT NULL DEFAULT 0,
          /** 生成本块的参数快照：参数变了就能识别出需要重建 */
          chunk_size    INTEGER,
          chunk_overlap INTEGER,
          created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
          UNIQUE (document_id, chunk_index)
        )
      `)
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_chunks_document ON chunks(document_id, chunk_index);
        CREATE INDEX IF NOT EXISTS idx_chunks_anchor   ON chunks(document_id, anchor_kind, anchor_index);
      `)

      const vectorColumns = db.prepare('PRAGMA table_info(vectors)').all()
      const hasVectorColumn = (name: string) => vectorColumns.some((column: any) => column.name === name)
      if (!hasVectorColumn('chunk_id')) {
        // 可空：回填未完成的文档其向量仍可用，只是暂时给不出可定位出处
        db.exec('ALTER TABLE vectors ADD COLUMN chunk_id INTEGER REFERENCES chunks(id) ON DELETE CASCADE')
      }
      if (!hasVectorColumn('chunk_index')) {
        // 冗余存一份，便于对齐期不 JOIN（回填与检索都按它排序）
        db.exec('ALTER TABLE vectors ADD COLUMN chunk_index INTEGER')
      }
      db.exec('CREATE INDEX IF NOT EXISTS idx_vectors_chunk ON vectors(chunk_id);')
    },
  },
  {
    version: 3,
    name: 'llm-providers-and-egress-logs',
    /**
     * LLM provider 配置 + 出域审计（S1-01，架构文档 §3.2.2）。
     *
     * 只建表、不搬数，也无存量回填：`api_key_enc/iv/tag` 是密文（AES-256-GCM，密钥不在库里），
     * 明文永不落库、不进日志、不进错误消息。`llm_egress_logs` 供将来「隐私」页逐条回看
     * 「送了什么、送到哪里、什么时候」。
     *
     * 幂等：DDL 全部 IF NOT EXISTS，重复执行无副作用（同 v2 的处理）。
     */
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS llm_providers (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          provider_id   TEXT NOT NULL UNIQUE,
          label         TEXT NOT NULL,
          base_url      TEXT NOT NULL,
          model         TEXT NOT NULL,
          /* 密文：AES-256-GCM，密钥来自平台级密钥文件；明文永不出主进程 */
          api_key_enc   BLOB,
          api_key_iv    BLOB,
          api_key_tag   BLOB,
          /* 明文前缀（仅前 8 位，用于 UI 显示 sk-abc123…），不可用于鉴权 */
          api_key_hint  TEXT,
          /* 出域授权：默认仅当前文档/选中范围，不是整库（评审 A 的硬约束） */
          egress_policy TEXT NOT NULL DEFAULT '{"mode":"selection"}',
          timeout_ms    INTEGER NOT NULL DEFAULT 60000,
          max_retries   INTEGER NOT NULL DEFAULT 2,
          rate_limit_rpm INTEGER,
          temperature   REAL,
          max_tokens    INTEGER,
          enabled       INTEGER NOT NULL DEFAULT 1,
          last_check_at DATETIME,
          last_check_ok INTEGER,
          created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at    DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `)
      db.exec(`
        CREATE TABLE IF NOT EXISTS llm_egress_logs (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          provider_id   TEXT NOT NULL,
          model         TEXT NOT NULL,
          scope_json    TEXT,
          document_ids  TEXT,
          chunk_ids     TEXT,
          prompt_chars  INTEGER,
          completion_chars INTEGER,
          prompt_tokens INTEGER,
          completion_tokens INTEGER,
          status        TEXT NOT NULL,
          error_code    TEXT,
          latency_ms    INTEGER,
          actor         TEXT,
          created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_llm_egress_time ON llm_egress_logs(created_at);
        CREATE INDEX IF NOT EXISTS idx_llm_egress_provider ON llm_egress_logs(provider_id, created_at);
      `)
    },
  },
  {
    version: 4,
    name: 'llm-egress-scope-and-host-columns',
    /**
     * 出域审计补列（S1-02，架构文档 §5.1.4）。
     *
     * v3 的 `llm_egress_logs` 只到 `scope_json`（自由文本），无法结构化回看「送到哪个 host / 哪个范围档位 /
     * 送了几块、几篇」。补四个字段：`target_host`（**只存 host，剥掉 query**，query 里可能带 key）、
     * `scope_mode`（current_document / selected_scope / whole_library）、`chunk_count` / `document_count`
     * （id 列表可截断存储，但计数必须完整）。
     *
     * 幂等：加列前用 `PRAGMA table_info` 判断列是否存在，重复执行无副作用。
     */
    up(db) {
      const columns = db.prepare('PRAGMA table_info(llm_egress_logs)').all()
      const has = (name: string) => columns.some((column: any) => column.name === name)
      if (!has('target_host')) db.exec('ALTER TABLE llm_egress_logs ADD COLUMN target_host TEXT')
      if (!has('scope_mode')) db.exec('ALTER TABLE llm_egress_logs ADD COLUMN scope_mode TEXT')
      if (!has('chunk_count')) db.exec('ALTER TABLE llm_egress_logs ADD COLUMN chunk_count INTEGER')
      if (!has('document_count')) db.exec('ALTER TABLE llm_egress_logs ADD COLUMN document_count INTEGER')
    },
  },
  {
    version: 5,
    name: 'resources-open-source-hub',
    /**
     * 开源资源汇表（S2-扩展）：存放从外部平台（抖音/微信/GitHub）收集整理的
     * 开源模型、技能、工具、项目等汇总信息，供工作台卡片式浏览与分类筛选。
     *
     * 幂等：DDL 全部 IF NOT EXISTS；加列前 PRAGMA 判断。
     */
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS resources (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          name          TEXT NOT NULL,
          category      TEXT NOT NULL,
          description   TEXT NOT NULL,
          link          TEXT,
          tags          TEXT,
          created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at    DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `)
      db.exec(`CREATE INDEX IF NOT EXISTS idx_resources_category ON resources(category);`)
    },
  },
  {
    version: 6,
    name: 'github-daily-rank',
    /**
     * GitHub 每日榜单（S2-扩展）：缓存每日从 GitHub API 拉取的各领域 star 前 15 项目。
     *
     * 幂等：DDL 全部 IF NOT EXISTS。
     */
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS github_rank_snapshots (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          snapshot_date TEXT NOT NULL,
          category      TEXT NOT NULL,
          rank          INTEGER NOT NULL,
          repo_name     TEXT NOT NULL,
          full_name     TEXT NOT NULL,
          description   TEXT,
          stars         INTEGER NOT NULL,
          language      TEXT,
          url           TEXT NOT NULL,
          created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
          UNIQUE (snapshot_date, category, rank)
        )
      `)
      db.exec(`CREATE INDEX IF NOT EXISTS idx_github_rank_date ON github_rank_snapshots(snapshot_date, category);`)
    },
  },
]
