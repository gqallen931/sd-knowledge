/** 作用域描述（ADR-002）：本次查询实际落在哪个范围 */
export interface SDScope {
  source_id: number | null
  source_name: string | null
  folder_path: string | null
  project_id: number | null
  project_name: string | null
}

/**
 * 统一结果信封（ADR-002）。
 *
 * `truncated` 取代了过去的「静默截断」——调用方据此决定是提高 limit 还是缩小作用域。
 */
export interface SDResultSet<T> {
  items: T[]
  total: number
  limit: number
  truncated: boolean
  truncated_reason?: 'limit' | 'candidate_window' | 'scope_filter' | 'token_budget'
  scope: SDScope | null
  /** total 为近似值时必须为 true：UI 显示「约 N 条」，不允许伪造精确数字 */
  total_is_approx?: boolean
  /** 本次检索实际启用的通道（混合检索用），如 { fulltext: true, semantic: true } */
  channels?: { fulltext: boolean; semantic: boolean }
}

/** 命中块（matched_chunk）：检索命中的那一段原文，用于展示匹配片段 */
export interface SDMatchedChunk {
  id: number
  chunk_index: number
  content: string
}

/**
 * 命中位置锚点（ADR-005 D8）：给不出位置时 `anchor_kind` 为 null，UI 不显示位置。
 * `anchor_index` 对 page/slide/chapter/sheet 是 1 起的序号；time 锚点看 `time_start_ms`。
 */
export interface SDChunkAnchor {
  chunk_id: number | null
  chunk_index: number | null
  char_start: number | null
  char_end: number | null
  anchor_kind: 'page' | 'slide' | 'chapter' | 'sheet' | 'time' | null
  anchor_index: number | null
  time_start_ms: number | null
  time_end_ms: number | null
}

/** 混合检索的打分拆解（score_parts）：用于诊断「为什么这条排在前面」 */
export interface SDScoreParts {
  rrf?: number
  rank_fulltext?: number | null
  rank_semantic?: number | null
  semantic_score?: number | null
  recency?: number
  scope_match?: number
  type_match?: number
  entity_overlap?: number
  title_hit?: number
  final?: number
  model?: string | null
}

/**
 * 检索结果条目：全文 / 语义 / 混合共用同一形态。
 * 全文结果可能不带 `matched_chunk` / `anchor` / `search_mode`，展示时按缺省处理。
 */
export interface SDSearchHit {
  id: number
  title: string | null
  file_name: string
  file_type: string
  file_size: number
  storage_type: string
  summary: string | null
  excerpt: string | null
  document_id: number
  score: number
  chunk_id: number | null
  chunk_index: number | null
  matched_chunk: SDMatchedChunk | null
  anchor: SDChunkAnchor | null
  /** 混合检索专有字段 */
  rank?: number
  score_parts?: SDScoreParts
  model_id?: string | null
  search_mode?: 'fulltext' | 'semantic' | 'hybrid'
}

export interface SDFolder {
  id: number
  source_id: number
  path: string
  name: string
  parent_id: number | null
  depth: number
  doc_count: number
  summary: string | null
  source_name?: string
  root_path?: string
}

export interface SDGraphOverview {
  nodes: Array<{
    id: string
    space_id: number
    label: string
    node_type: 'space'
    doc_count: number
    folder_count: number
    project_name: string | null
    root_path: string
    last_sync_at: string | null
  }>
  edges: Array<{
    id: string
    source: string
    target: string
    relation_type: 'SHARED_ENTITY'
    weight: number
    mentions: number
  }>
  total: number
  truncated: boolean
  truncated_reason?: 'limit'
}

/** 与 electron/services/workbench/types.ts 的 TASK_PRIORITIES / TASK_STATUSES / GROUP_COLORS 严格对齐 */
export type SDTaskPriority = '高' | '中' | '低'
export type SDTaskStatus = 'todo' | 'doing' | 'done'
export type SDGroupColor = 'blue' | 'green' | 'violet'
export type SDRepeatRule = 'none' | 'daily' | 'weekly'

/** 可写字段：projectId 不在其中，关联项目要走 workbench.project.assign/unassign */
export interface SDTaskPatch {
  name?: string
  description?: string
  priority?: SDTaskPriority
  status?: SDTaskStatus
  deadline?: string
  owner?: string
  groupId?: number
}

export interface SDTask {
  id: string
  groupId: number
  name: string
  description: string
  priority: SDTaskPriority
  status: SDTaskStatus
  deadline: string | null
  owner: string
  participant: boolean
  position: number
  projectId?: number | null
  /** 入库时间：项目时间线的任务条以「创建 → 截止」为一个真实区间 */
  createdAt: string
}

export interface SDTaskGroup {
  id: number
  name: string
  color: SDGroupColor
  position: number
  tasks: SDTask[]
}

/** create 时可省略 id/position/projectId */
export type SDTaskInput = Partial<Omit<SDTaskPatch, 'status'>> & { name: string; groupId: number; status?: SDTaskStatus }

export interface SDWorkbenchProject {
  id: number
  workspaceId: number | null
  name: string
  description: string
  status: string
  deadline: string | null
  taskCount: number
  doneCount: number
  /** 关联文档数，来自 documents.project_id */
  docCount: number
  progress: number
}

export interface SDWorkspace {
  id: number
  name: string
  active: boolean
}

export interface SDNotification {
  id: number
  type: string
  title: string
  message: string
  isRead: boolean
  createdAt: string
}

export interface SDReminder {
  id: number
  taskCode: string | null
  title: string
  remindAt: string
  repeatRule: string
  status: string
  notifiedAt: string | null
  createdAt: string
}

export interface SDBackupFile {
  name: string
  size: number
  createdAt: string
}

/** 跨域时间线事件：任务（截止）与文档（入库）共用一种形态，差别只在 kind */
export interface SDTimelineEvent {
  kind: 'task' | 'document'
  /** 任务为编号（TK-…），文档为 doc:<id>，前端据此决定跳到哪里 */
  id: string
  title: string
  /** YYYY-MM-DD */
  at: string
  status: string
  projectName: string | null
  phase: 'past' | 'today' | 'upcoming'
}

/** LLM 网关可用性（ADR-003 决策 5）：configured=false 时前端展示「尚未接入」，而不是报错 */
export interface SDGatewayStatus {
  configured: boolean
  providerId: string | null
  label: string
  model: string
  reason: string
}

/** 日程页的日程单元（S2-01）：与 SDTask 同源，date 为服务端归一后的本地日（YYYY-MM-DD） */
export interface SDCalendarTask {
  id: string
  name: string
  status: SDTaskStatus
  priority: SDTaskPriority
  deadline: string | null
  /** 服务端 date(deadline) 归一结果；跨天判定以它为准 */
  date: string
  owner: string
  projectName: string | null
}

/** 日程页的提醒单元（S2-01）：date/time 为 remind_at 转本地口径后的结果 */
export interface SDCalendarReminder {
  id: number
  taskCode: string | null
  title: string
  remindAt: string
  repeatRule: string
  status: string
  /** 本地日 YYYY-MM-DD（SQL date(…,'localtime')） */
  date: string
  /** 本地时间 HH:mm */
  time: string
}

/** 日程页聚合（S2-01）：口径唯一真相源在服务端（today / date 字段），前端只做视图渲染 */
export interface SDCalendarData {
  today: string
  days: number
  tasks: SDCalendarTask[]
  todayTasks: SDCalendarTask[]
  overdue: SDCalendarTask[]
  unscheduled: Array<{ id: string; name: string; status: SDTaskStatus; priority: SDTaskPriority; projectName: string | null }>
  reminders: SDCalendarReminder[]
}

/** 分析页聚合（S2-02）：规模统计 + 近 N 天趋势；样本不足时 sample.note 给出可读说明 */
export interface SDAnalyticsOverview {
  windowDays: number
  totals: {
    documents: number
    chunks: number
    entities: number
    relationships: number
    projects: number
    localFiles: number
    referenceFiles: number
    indexedFiles: number
  }
  queries: { total: number; avgResults: number | null; avgLatencyMs: number | null; lastAt: string | null }
  sample: { queries: number; sufficient: boolean; note: string | null }
  trend: Array<{ date: string; documents: number; queries: number; avgResults: number | null; avgLatencyMs: number | null }>
}

/** 共享快照导出结果（S2-05）：文件落 Data/exports/，只回传摘要（counts + 路径），不回传正文 */
export interface SDShareSnapshotResult {
  path: string
  fileName: string
  size: number
  counts: Record<string, number>
  exportedAt: string
}

/** 摄像头感知层可用性（ADR-003 决策 5） */
export interface SDPerceptionStatus {
  available: boolean
  providerId: string | null
  label: string
  reason: string
  running: boolean
}

/** LLM provider 类型（ADR-004 决策 1）：`hosted` 本轮 available=false，不可选 */
export interface SDLlmProviderType {
  kind: 'byo-openai' | 'local-openai' | 'hosted'
  label: string
  requires_key: boolean
  available: boolean
  default_base_url: string
  note: string
}

/** 已配置的 provider（S1-01）：只给掩码，绝不含明文密钥 */
export interface SDLlmProviderInfo {
  id: number | null
  provider_id: string
  kind: 'byo-openai' | 'local-openai' | 'hosted'
  label: string
  base_url: string
  model: string
  has_key: boolean
  key_mask: string
  egress_policy: Record<string, unknown>
  timeout_ms: number
  is_default: boolean
  enabled: boolean
  last_check_at: string | null
  last_check_ok: boolean | null
}

/** llm.save 入参：api_key 只在写入时携带明文，留空表示「不更换现有密钥」 */
export interface SDLlmSaveInput {
  provider_id?: string
  kind?: string
  label?: string
  base_url?: string
  model?: string
  api_key?: string
  is_default?: boolean
  timeout_ms?: number | string
  max_retries?: number | string
  temperature?: number | string | null
  max_tokens?: number | string | null
}

export interface SDLlmTestResult {
  ok: boolean
  providerId: string
  kind: 'byo-openai' | 'local-openai' | 'hosted'
  model: string
  latencyMs: number
  models: string[]
  echo: string | null
  error: { code: string; message: string } | null
}

export interface SDLlmMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  toolCallId?: string
  name?: string
}

export interface SDLlmResponse {
  model: string
  content: string
  toolCalls: Array<{ id: string; name: string; arguments: string }>
  usage: { promptTokens: number; completionTokens: number; totalTokens: number } | null
  finishReason: 'stop' | 'length' | 'tool_calls' | 'error'
  chunks?: string[]
}

/** 出域范围三档（S1-02）：默认最小档 current_document；whole_library 需显式确认 */
export type SDLlmEgressScope = 'current_document' | 'selected_scope' | 'whole_library'

/** 一条出域记录（S1-02）：只含元信息（时间 / 目标 host / 范围 / 条数 / 结果），绝无正文与密钥 */
export interface SDLlmEgressLog {
  id: number
  provider_id: string
  model: string
  target_host: string
  scope_mode: SDLlmEgressScope
  document_count: number
  chunk_count: number
  prompt_chars: number
  completion_chars: number
  status: 'ok' | 'error' | 'timeout' | 'refused'
  error_code: string | null
  latency_ms: number
  actor: string
  created_at: string
}

/** 一条可验证引用（S1-03）：编号 + 块 id + 文档 id + 文件名 + 锚点 + 片段原文 */
export interface SDAnswerCitation {
  index: number
  chunk_id: number | null
  document_id: number
  title: string
  file_name: string
  anchor: SDChunkAnchor | null
  quote: string
}

/**
 * RAG 问答返回（S1-03，方法 `chat.ask`）。
 * `citations_unverified` 为 true 表示「答案没有引用」或「引用了不存在的编号」——如实标注，不假装有据。
 * `mode='retrieval_only'` 表示未配置模型，已降级为纯检索（`retrieval` 字段可切检索页）。
 */
export interface SDAnswerResult {
  mode: 'answer' | 'retrieval_only' | 'refused' | 'error'
  answer: string | null
  citations: SDAnswerCitation[]
  citation_map: Record<number, { chunk_id: number | null; document_id: number }>
  context_blocks: SDAnswerCitation[]
  cited_indexes: number[]
  invalid_indexes: number[]
  citations_unverified: boolean
  retrieval: SDResultSet<any>
  context_meta: {
    block_count: number
    chunk_count: number
    document_count: number
    prompt_chars: number
    estimated_tokens: number
    truncated: boolean
    truncated_reason: string | null
    channels: { fulltext: boolean; semantic: boolean } | null
  }
  provider: { provider_id: string; model: string; kind: string } | null
  egress: { scope: SDLlmEgressScope; allowed: boolean | null; reason: string | null }
  usage: unknown
  message: string
  meta: { reason?: string }
}

/**
 * 插件状态（ADR-005）：`capabilities.extensions` 是解析器覆盖的扩展名，
 * 文件页据此派生「当前启用的支持格式」；停用后该插件覆盖的格式立即消失。
 */
export interface SDPluginStatus {
  id: string
  name: string
  version: string
  apiVersion?: number
  kind: 'parser' | 'embedding' | 'rerank' | 'method' | 'panel' | string
  runtime?: 'worker' | 'inline'
  builtin: boolean
  source: string
  enabled: boolean
  loaded: boolean
  error?: string | null
  permissions?: { fsRead?: boolean; net?: boolean; modelDownload?: string[] }
  capabilities?: { extensions?: string[]; fileTypes?: Record<string, string>; modelId?: string; dimension?: number; note?: string }
  /** 扩展名 → 库内 file_type 的解析后映射（png→image、js→code），供界面按类型筛选 */
  fileTypes?: Record<string, string>
  description?: string
}

/**
 * 工作台域门面（ADR-003）。
 *
 * 方法名即 `组.方法` 的完整 RPC 名称，前端由 Proxy 动态生成（见 src/api.ts），
 * 因此这里新增一个方法只需在主进程的 rpcHandlers.ts 里加一行。
 */
export interface SDAuthUser {
  id: number
  username: string
  displayName: string
  role: string
  contactType: 'email' | 'phone' | null
  /** 掩码后的联系方式，如 ab***@example.com / 138****0000；明文不回传到渲染进程 */
  maskedContact: string | null
}

export interface SDWorkbenchApi {
  auth: {
    status: () => Promise<{ needsSetup: boolean; authenticated: boolean; user: SDAuthUser | null }>
    /** 注册：邮箱或手机号 + 验证码 + 密码（验证码由 requestCode 发送） */
    register: (payload: { contact: string; code: string; password: string; displayName?: string }) => Promise<SDAuthUser>
    /** 登录：account 为注册时使用的邮箱或手机号 */
    login: (payload: { account: string; password: string }) => Promise<SDAuthUser>
    /** 申请验证码。reset 时账户不存在也返回 accepted，不泄露是否注册 */
    requestCode: (payload: { purpose: 'register' | 'reset'; contact: string }) => Promise<{ accepted: true; cooldownSeconds: number; expiresInSeconds: number }>
    /** 凭已绑定联系方式的验证码重置密码；成功后该账户所有会话失效 */
    resetPassword: (payload: { contact: string; code: string; newPassword: string; confirmPassword: string }) => Promise<boolean>
    logout: () => Promise<boolean>
    changePassword: (payload: { currentPassword: string; newPassword: string }) => Promise<boolean>
  }
  workbench: {
    dashboard: () => Promise<any>
    /** 跨域时间线：任务截止 + 文档入库，按日期倒序 */
    timeline: (options?: { days?: number; limit?: number }) => Promise<SDTimelineEvent[]>
    /** 日程页聚合（S2-01）：任务分桶 + 今日待办 + 逾期 + 提醒，日期口径以服务端为准 */
    calendar: (options?: { days?: number }) => Promise<SDCalendarData>
    search: (query: string, options?: { limit?: number; source_id?: number | null; folder_path?: string | null; project_id?: number | null }) => Promise<{ tasks: any[]; projects: any[]; files: any[]; documents: SDResultSet<SDSearchHit>; documentSearchMode: 'fulltext' | 'semantic' | 'hybrid' }>
    workspaces: () => Promise<SDWorkspace[]>
    workspace: {
      create: (payload: { name: string }) => Promise<SDWorkspace>
      switch: (id: number) => Promise<{ id: number; name: string }>
      stats: () => Promise<Array<SDWorkspace & { projectCount: number; fileCount: number; taskCount: number; doneCount: number }>>
    }
    project: {
      list: () => Promise<SDWorkbenchProject[]>
      create: (payload: { name: string; description?: string; deadline?: string; color?: string }) => Promise<SDWorkbenchProject>
      update: (id: number, payload: { name: string; description?: string; deadline?: string }) => Promise<SDWorkbenchProject>
      archive: (id: number) => Promise<boolean>
      remove: (id: number) => Promise<boolean>
      tasks: (id: number) => Promise<SDTask[]>
      assign: (projectId: number, taskCode: string) => Promise<boolean>
      unassign: (taskCode: string) => Promise<boolean>
    }
    file: {
      list: () => Promise<any[]>
      add: (files: Array<{ name: string; path: string; size?: number }>) => Promise<any[]>
      remove: (id: number) => Promise<boolean>
    }
  }
  task: {
    groups: () => Promise<SDTaskGroup[]>
    list: () => Promise<SDTask[]>
    detail: (id: string) => Promise<SDTask | null>
    seed: (groups: any[]) => Promise<SDTaskGroup[]>
    group: { create: (payload: { name: string; color?: SDGroupColor }) => Promise<SDTaskGroup> }
    create: (payload: SDTaskInput) => Promise<SDTask>
    update: (id: string, payload: SDTaskPatch) => Promise<SDTask>
    complete: (id: string) => Promise<SDTask>
    archive: (id: string) => Promise<boolean>
    remove: (id: string) => Promise<boolean>
  }
  tag: {
    list: (taskCode?: string) => Promise<Array<{ id: number; name: string; color: string }>>
    add: (taskCode: string, payload: { name: string; color?: string }) => Promise<{ id: number; name: string; color: string }>
    remove: (taskCode: string, tagId: number) => Promise<boolean>
  }
  notification: {
    list: () => Promise<SDNotification[]>
    unread: () => Promise<number>
    read: () => Promise<boolean>
  }
  reminder: {
    list: () => Promise<SDReminder[]>
    create: (payload: { title: string; remindAt: string; repeatRule?: SDRepeatRule; taskCode?: string }) => Promise<SDReminder>
    dismiss: (id: number) => Promise<boolean>
    remove: (id: number) => Promise<boolean>
  }
  data: {
    stats: () => Promise<Record<string, number>>
    export: () => Promise<any>
    import: (payload: any) => Promise<any>
    backups: () => Promise<SDBackupFile[]>
    backup: {
      create: (kind?: string) => Promise<{ path: string; name: string; createdAt: string }>
      restore: (name: string) => Promise<any>
      delete: (name: string) => Promise<boolean>
      history: () => Promise<any[]>
    }
    settings: {
      get: () => Promise<Record<string, string>>
      save: (payload: Record<string, any>) => Promise<Record<string, string>>
    }
  }
  /** 接缝探针（ADR-003 决策 5）：只汇报「接没接上」，不触发任何模型/设备调用 */
  gateway: {
    status: () => Promise<SDGatewayStatus>
  }
  /**
   * RAG 问答（S1-03）：提问 → 混合检索 → 上下文组装 → LLM → 答案 + 可验证引用。
   * 未配置模型时返回 `mode='retrieval_only'`（带纯检索结果，不抛异常）。
   */
  chat: {
    ask: (payload: {
      query: string
      document_id?: number | null
      scope?: { source_id?: number | null; folder_path?: string | null; project_id?: number | null; unassigned?: boolean }
      egress_scope?: SDLlmEgressScope
      limit?: number
      max_tokens?: number
    }) => Promise<SDAnswerResult>
  }
  /**
   * LLM 网关（S1-01/S1-02）：配置类方法只回掩码，绝不回明文密钥。
   * list/providers/logs 只读；save/remove/test/chat/stream/setEgress 为写方法（REST reader 密钥会被拒）。
   */
  llm: {
    providers: () => Promise<SDLlmProviderType[]>
    list: () => Promise<SDLlmProviderInfo[]>
    save: (payload: SDLlmSaveInput) => Promise<SDLlmProviderInfo>
    remove: (payload: { provider_id?: string; kind?: string }) => Promise<{ success: boolean }>
    test: (payload?: { provider_id?: string; kind?: string }) => Promise<SDLlmTestResult>
    chat: (messages: SDLlmMessage[], options?: Record<string, unknown>) => Promise<SDLlmResponse>
    stream: (messages: SDLlmMessage[], options?: Record<string, unknown>) => Promise<SDLlmResponse>
    /** 设置出域范围档位（S1-02）；whole_library 需 confirm=true（显式风险确认） */
    setEgress: (payload: { provider_id?: string; kind?: string; scope: SDLlmEgressScope; confirm?: boolean }) => Promise<SDLlmProviderInfo>
    /** 最近出域记录（只读，只含元信息，绝无正文与密钥） */
    logs: (payload?: { limit?: number }) => Promise<SDLlmEgressLog[]>
  }
  perception: {
    status: () => Promise<SDPerceptionStatus>
  }
  /** 插件注册表（ADR-005）：list/status 只读，enable/disable/reload 为写操作 */
  plugin: {
    list: () => Promise<SDPluginStatus[]>
    status: (id: string) => Promise<SDPluginStatus>
    enable: (id: string) => Promise<SDPluginStatus>
    disable: (id: string) => Promise<SDPluginStatus>
    reload: () => Promise<{ loaded: string[]; rejected: string[] }>
  }
  /** 开源资源汇：卡片式展示收集的开源模型/技能/工具（只读） */
  resource: {
    categories: () => Promise<Array<{ category: string; count: number }>>
    list: (payload?: { category?: string; search?: string }) => Promise<SDResourceItem[]>
    get: (id: number) => Promise<SDResourceItem | null>
  }
  /** GitHub 每日榜单：缓存每日各领域 star 前 15 项目 */
  githubRank: {
    categories: () => Promise<Array<{ category: string; label: string; query: string }>>
    daily: (payload?: { category?: string }) => Promise<{ date: string; categories: Array<{ category: string; label: string; items: SDGithubRankItem[] }> }>
    refresh: (payload?: { category?: string }) => Promise<{ date: string; categories: Array<{ category: string; label: string; items: SDGithubRankItem[] }> }>
  }
}

export interface SDGithubRankItem {
  rank: number
  repo_name: string
  full_name: string
  description: string | null
  stars: number
  language: string | null
  url: string
}

export interface SDResourceItem {
  id: number
  name: string
  category: string
  description: string
  link: string | null
  tags: { subcategory?: string; links?: string[] }
  created_at?: string
}

export interface SDAPI extends SDWorkbenchApi {
  file: {
    import: (paths: string[]) => Promise<any[]>
    reference: (paths: string[]) => Promise<any[]>
    list: (filters: any) => Promise<any[]>
    detail: (id: number) => Promise<any>
    delete: (id: number) => Promise<any>
    process: (id: number) => Promise<any>
    select: () => Promise<string[]>
    selectFolder: () => Promise<string[]>
  }
  search: {
    fulltext: (query: string, filters?: any) => Promise<SDResultSet<any>>
    semantic: (query: string, options?: any) => Promise<SDResultSet<any>>
  }
  graph: {
    nodes: (filters?: any) => Promise<SDResultSet<any>>
    edges: (filters?: any) => Promise<SDResultSet<any>>
    /** L0 全局折叠总览：空间超级节点 + 跨域桥边 */
    overview: () => Promise<SDGraphOverview>
    /** 跨域桥：同一实体横跨多个空间的连接点 */
    bridges: (options?: { limit?: number; source_id?: number | null }) => Promise<SDResultSet<any>>
    entities: (options?: any) => Promise<SDResultSet<any>>
    entity: (name: string) => Promise<any>
    stats: () => Promise<any>
    addRelationship: (sourceType: string, sourceId: number, targetType: string, targetId: number, relationType: string) => Promise<number>
    deleteRelationship: (id: number) => Promise<boolean>
    mergeEntities: (sourceId: number, targetId: number) => Promise<any>
    mergeEntitiesBatch: (sourceIds: number[], targetId: number) => Promise<any>
    renameEntity: (id: number, name: string, type?: string) => Promise<any>
    batchRenameEntities: (items: { id: number; name: string; type?: string }[]) => Promise<any>
    searchNodes: (query: string, limit?: number) => Promise<any[]>
    searchEntities: (query: string, limit?: number) => Promise<any[]>
    suggestEntityMerges: (options?: { limit?: number; minScore?: number; type?: string }) => Promise<{
      scanned: number
      matched: number
      truncated: boolean
      min_score: number
      suggestions: Array<{
        source: { id: number; name: string; type: string }
        target: { id: number; name: string; type: string }
        score: number
        reason: 'exact' | 'containment' | 'fuzzy'
        detail: string
      }>
    }>
    /** S2-08：实体别名 / 合并历史 / 忽略记忆 */
    listAliases: (entityId?: number) => Promise<any[]>
    addAlias: (entityId: number, alias: string) => Promise<any>
    removeAlias: (id: number) => Promise<boolean>
    listMergeHistory: (limit?: number) => Promise<any[]>
    ignoreMergeSuggestion: (nameA: string, nameB: string) => Promise<any>
    listIgnoredMergePairs: () => Promise<any[]>
  }
  dashboard: {
    stats: () => Promise<any>
    recent: () => Promise<any[]>
  }
  folder: {
    select: () => Promise<string[]>
    preview: (rootPath: string, options?: any) => Promise<any>
    create: (payload: any) => Promise<any>
    list: () => Promise<any[]>
    update: (id: number, patch: any) => Promise<any>
    remove: (id: number, deleteDocuments?: boolean) => Promise<any>
    sync: (id: number) => Promise<any>
    syncAll: () => Promise<any>
    cleanup: (id?: number) => Promise<any>
    /** 目录树（ADR-002）：作用域寻址的第二级 */
    listFolders: (sourceId?: number) => Promise<SDFolder[]>
  }
  queue: {
    status: () => Promise<{ running: number; waiting: number; concurrency: number }>
  }
  project: {
    list: () => Promise<any[]>
    create: (name: string, description: string, color: string) => Promise<number>
    update: (id: number, name: string, description: string, color: string) => Promise<void>
    remove: (id: number) => Promise<void>
    assign: (documentId: number, projectId: number | null) => Promise<void>
    /** 批量迁移（ADR-002 P3）：updated 为真正发生变化的行数，skipped 为原有归属未变/文档不存在 */
    assignMany: (documentIds: number[], projectId: number | null) => Promise<{ updated: number; skipped: number; projectId: number | null }>
  }
  settings: {
    get: () => Promise<any>
    update: (settings: any) => Promise<any>
  }
  security: {
    status: () => Promise<any>
    setup: (password: string) => Promise<any>
    verify: (password: string) => Promise<any>
    apiKeys: {
      list: () => Promise<any[]>
      create: (name: string, role: string) => Promise<any>
      revoke: (id: number) => Promise<any>
    }
  }
  audit: {
    list: (filters?: any) => Promise<any[]>
    /** S2-10：审计保留天数（缺省 90，允许 7–365）与手动清理（清理前自动快照） */
    retentionGet: () => Promise<number>
    retentionSet: (days: number) => Promise<number>
    prune: () => Promise<{ removed: number; remaining: number; snapshot: string | null }>
  }
  /** S2-02：分析页聚合（知识库规模 + 近 N 天入库/问答命中趋势，样本不足如实标注） */
  analytics: {
    overview: (options?: { days?: number }) => Promise<SDAnalyticsOverview>
  }
  /** S2-05：共享快照导出（自包含 JSON，剥离密钥/明文敏感字段；不含向量、密钥、审计与出域日志） */
  share: {
    exportSnapshot: () => Promise<SDShareSnapshotResult>
  }
  shell: {
    openPath: (filePath: string) => Promise<void>
    showInFolder: (filePath: string) => Promise<void>
  }
  /** 桌面端工作台 RPC 桥；Web 模式下不存在，前端门面据此分流 */
  __workbenchRpc?: (method: string, ...args: any[]) => Promise<any>
  /**
   * 问答流式（S1-05，桌面通道）：每块增量经 IPC 事件推给 `onChunk`，最终结果由此 Promise 返回。
   * Web 模式不存在这两个方法（`src/api.ts` 的 `askStream` 走 `/local/ask/stream` SSE）。
   */
  askStream?: (requestId: string, payload: Record<string, unknown>, onChunk: (chunk: string) => void) => Promise<SDAnswerResult>
  askStreamCancel?: (requestId: string) => Promise<boolean>
  on: (channel: string, callback: (...args: any[]) => void) => void
}

declare global {
  interface Window {
    sd: SDAPI
  }
}
