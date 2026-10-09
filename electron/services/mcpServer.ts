import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import DatabaseService from './database'
import { FileService } from './fileService'
import { SearchService } from './searchService'
import { GraphBuilder } from './graphBuilder'
import { AnswerService } from './answerService'
import { ResultSet } from './resultSet'
import { describeScope, normalizeScope } from './scope'

/**
 * 作用域参数（ADR-002）。
 *
 * 这是本轮最重要的一处能力补齐：在此之前 Agent **无法表达「在哪个文件夹里找」**——
 * 所有检索都只能在整库范围内做。四个入口共享同一套语义，见 `services/scope.ts`。
 */
const SCOPE_PROPERTIES = {
  source_id: { type: 'number', description: '空间（映射文件夹）ID，可用 list_scopes 查询' },
  folder_path: { type: 'string', description: '空间内的目录前缀，如 "src/utils"（含全部子目录）；省略 = 整个空间' },
  project_id: { type: 'number', description: '项目集 ID（可跨空间）' },
} as const

/**
 * 工作台域的 MCP 接缝（ADR-003 决策 4：工作台域与内核域一样暴露到 MCP）。
 *
 * 这里刻意用结构性接口而不是直接 import 工作台的服务类：
 * 「MCP 只是能力出口」——内核域与工作台域都不需要知道 MCP 的存在，
 * 出口在这一层单向聚合，方向不会反过来。
 */
export interface McpWorkbenchDomains {
  workbench: {
    activeWorkspace(): { id: number; name: string } | undefined
    listWorkspaces(): any[]
    workspaceStats(): any[]
    listProjects(): any[]
    listTags(): any[]
    dashboard(): any
    search(query: unknown): any
    searchAll(query: unknown, searchService: SearchService, options?: any): Promise<any>
    timeline(options?: { days?: unknown; limit?: unknown }): any[]
    projectTasks(id: unknown): any[]
    assignTask(projectId: unknown, taskCode: unknown): boolean
    unassignTask(taskCode: unknown): boolean
  }
  tasks: {
    list(): any[]
    flat(): any[]
    get(id: string): any
    createGroup(input: any): any
    createTask(input: any): any
    updateTask(id: string, input: any): any
    completeTask(id: string): any
  }
}

/**
 * 工作台域的工具名，与 `workbenchTools()` 的清单一一对应。
 *
 * 未装配 `workbenchDomains` 时用它把调用挡在 switch 之前——否则会落到
 * 各分支的 `this.workbenchDomains!` 上，炸出一句 Agent 看不懂的 TypeError。
 */
const WORKBENCH_TOOL_NAMES = new Set([
  'workbench_overview',
  'list_workspaces',
  'list_tasks',
  'get_task',
  'create_task',
  'update_task',
  'complete_task',
  'assign_task_to_project',
  'project_tasks',
  'get_timeline',
  'search_all',
])

export class McpServerService {
  private server: Server
  private running = false
  /** 工具分发实现，由 setupHandlers 装配；与 MCP 传输层共用，供集成测试直接调用。 */
  private dispatch?: (name: string, args: any) => Promise<any>

  constructor(
    private db: DatabaseService,
    private fileService: FileService,
    private searchService: SearchService,
    private graphBuilder: GraphBuilder,
    private workbenchDomains?: McpWorkbenchDomains,
    /** RAG 问答链路（S1-03）：未装配时 `ask` 工具返回可读的「未装配」而不是崩 */
    private answerService?: AnswerService
  ) {
    this.server = new Server(
      { name: 'sd-knowledge', version: '1.0.0' },
      { capabilities: { resources: {}, tools: {} } }
    )
    this.setupHandlers()
  }

  /**
   * 统一结果信封（ADR-002）。
   *
   * 旧版这里直接把数组 `JSON.stringify` 出去，**截断是隐式的**——Agent 只能假设
   * 「看到的就是全部」。现在连同 `total` / `truncated` / `scope` 一起给，
   * Agent 才能自己判断「要不要缩小范围再问一次」。
   */
  private envelope<T>(set: ResultSet<T>, project: (item: T) => any): string {
    return JSON.stringify({
      scope: set.scope,
      total: set.total,
      returned: set.items.length,
      limit: set.limit,
      truncated: set.truncated,
      ...(set.truncated_reason ? { truncated_reason: set.truncated_reason } : {}),
      items: set.items.map(project),
    }, null, 2)
  }

  private setupHandlers() {
    this.server.setRequestHandler(ListResourcesRequestSchema, async () => {
      // 空间本身也暴露为资源：Agent 挂载后第一眼就能看到「用户的资料分成了哪几块」
      const spaces = this.db.prepare(`
        SELECT id, name, root_path,
          (SELECT COUNT(*) FROM documents d WHERE d.source_id = s.id AND d.is_available = 1) AS doc_count
        FROM folder_sources s ORDER BY id
      `).all() as any[]

      const docs = this.db.prepare(`
        SELECT id, title, file_type, storage_type, summary
        FROM documents WHERE is_available = 1
        LIMIT 100
      `).all() as any[]

      return {
        resources: [
          ...spaces.map(space => ({
            uri: `sd://spaces/${space.id}`,
            name: `空间：${space.name}`,
            mimeType: 'application/json',
            description: `${space.doc_count} 个文档 | ${space.root_path}`,
          })),
          ...docs.map(doc => ({
            uri: `sd://documents/${doc.id}`,
            name: doc.title,
            mimeType: 'text/plain',
            description: `${doc.file_type} | ${doc.storage_type === 'local' ? '本地' : '引用'} | ${doc.summary || ''}`.substring(0, 200),
          })),
        ]
      }
    })

    this.server.setRequestHandler(ReadResourceRequestSchema, async (request: any) => {
      const spaceMatch = request.params.uri.match(/^sd:\/\/spaces\/(\d+)$/)
      if (spaceMatch) {
        const spaceId = parseInt(spaceMatch[1], 10)
        const space = this.db.prepare('SELECT * FROM folder_sources WHERE id = ?').get(spaceId) as any
        if (!space) return { contents: [] }
        const folders = this.db.prepare('SELECT path, depth, doc_count FROM folders WHERE source_id = ? ORDER BY path').all(spaceId) as any[]
        const topEntities = this.db.prepare(`
          SELECT e.name, e.type, COUNT(*) AS mentions
          FROM relationships r
          JOIN documents d ON d.id = r.source_id
          JOIN entities e ON e.id = r.target_id
          WHERE r.source_type = 'document' AND r.target_type = 'entity' AND d.source_id = ? AND d.is_available = 1
          GROUP BY e.id ORDER BY mentions DESC LIMIT 30
        `).all(spaceId) as any[]
        return {
          contents: [{
            uri: request.params.uri,
            mimeType: 'application/json',
            text: JSON.stringify({
              space: { id: space.id, name: space.name, root_path: space.root_path, file_count: space.file_count, last_sync_at: space.last_sync_at },
              folders: folders.map(f => ({ path: f.path || '/', depth: f.depth, doc_count: f.doc_count })),
              top_entities: topEntities,
            }, null, 2),
          }]
        }
      }

      const match = request.params.uri.match(/^sd:\/\/documents\/(\d+)$/)
      if (!match) return { contents: [] }

      const docId = parseInt(match[1])
      const doc = this.db.prepare('SELECT content_text, title, summary FROM documents WHERE id = ?').get(docId) as any
      if (!doc) return { contents: [] }

      return {
        contents: [{
          uri: request.params.uri,
          mimeType: 'text/plain',
          text: `${doc.title}\n\n${doc.content_text || doc.summary || ''}`,
        }]
      }
    })

    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: 'list_scopes',
          description: '列出知识库的全部空间（映射文件夹）与目录结构。**建议先调用它了解用户的资料全貌**，再用返回的 source_id / folder_path 限定后续检索范围。',
          inputSchema: {
            type: 'object',
            properties: {
              source_id: { type: 'number', description: '只看某个空间的目录树；省略则返回全部空间' },
              include_folders: { type: 'boolean', description: '是否附带目录树（可能较长），默认 false' },
            },
          },
        },
        {
          name: 'search',
          description: '搜索用户知识库（全文搜索）。可用 source_id / folder_path / project_id 限定范围。',
          inputSchema: {
            type: 'object',
            properties: {
              query: { type: 'string', description: '搜索关键词' },
              file_type: { type: 'string', description: '文件类型筛选: pdf/docx/xlsx/md等' },
              storage_type: { type: 'string', description: '存储类型: local或reference' },
              limit: { type: 'number', description: '返回数量上限', default: 20 },
              ...SCOPE_PROPERTIES,
            },
            required: ['query'],
          },
        },
        {
          name: 'semantic_search',
          description: '语义搜索 - 用自然语言描述找到语义相关的文档。可用 source_id / folder_path / project_id 限定范围。',
          inputSchema: {
            type: 'object',
            properties: {
              query: { type: 'string', description: '自然语言查询' },
              limit: { type: 'number', description: '返回数量上限', default: 10 },
              ...SCOPE_PROPERTIES,
            },
            required: ['query'],
          },
        },
        {
          name: 'get_context',
          description: '获取AI上下文 - 汇总与查询相关的知识内容（文档 + 关联实体），让AI读懂用户。可用 source_id / folder_path / project_id 限定范围。',
          inputSchema: {
            type: 'object',
            properties: {
              query: { type: 'string', description: '用户意图或查询' },
              max_tokens: { type: 'number', description: '最大token数', default: 4000 },
              ...SCOPE_PROPERTIES,
            },
            required: ['query'],
          },
        },
        {
          name: 'ask',
          description: 'RAG 问答：混合检索 → 上下文组装 → 大语言模型 → 答案 + 可验证引用（每条可定位到块）。'
            + '未配置模型时返回 mode="retrieval_only" 的本地检索结果（不是错误）。'
            + '可按 document_id 限定到某篇文档，或用 source_id / folder_path / project_id 限定作用域；'
            + 'egress_scope 声明本次出域范围（默认最小档 current_document）。',
          inputSchema: {
            type: 'object',
            properties: {
              query: { type: 'string', description: '用户问题' },
              document_id: { type: 'number', description: '限定到某篇文档（出域最小档：仅当前文档）' },
              egress_scope: { type: 'string', enum: ['current_document', 'selected_scope', 'whole_library'], description: '本次声明的出域范围档位' },
              max_tokens: { type: 'number', description: '上下文 token 预算', default: 4000 },
              limit: { type: 'number', description: '返回的检索候选上限', default: 8 },
              ...SCOPE_PROPERTIES,
            },
            required: ['query'],
          },
        },
        {
          name: 'list_documents',
          description: '列出知识库中的文档。可用 source_id / folder_path / project_id 限定范围。',
          inputSchema: {
            type: 'object',
            properties: {
              file_type: { type: 'string' },
              storage_type: { type: 'string' },
              search: { type: 'string', description: '按标题/文件名关键词过滤' },
              limit: { type: 'number', default: 50 },
              ...SCOPE_PROPERTIES,
            },
          },
        },
        {
          name: 'get_document',
          description: '获取文档详情和内容',
          inputSchema: {
            type: 'object',
            properties: {
              id: { type: 'number', description: '文档ID' },
            },
            required: ['id'],
          },
        },
        {
          name: 'get_graph_stats',
          description: '获取知识图谱统计信息（文档/实体/关系/空间/目录/跨域桥数量）',
          inputSchema: { type: 'object', properties: {} },
        },
        {
          name: 'get_entities',
          description: '查询知识图谱中的实体。可用 source_id / folder_path / project_id 限定范围（只返回在该范围内被提及过的实体）。',
          inputSchema: {
            type: 'object',
            properties: {
              type: { type: 'string', description: '实体类型: person/location/organization/date等' },
              limit: { type: 'number', default: 50 },
              ...SCOPE_PROPERTIES,
            },
          },
        },
        {
          name: 'get_entity_graph',
          description: '获取某个实体的关联图谱（关联文档和其他实体）',
          inputSchema: {
            type: 'object',
            properties: {
              name: { type: 'string', description: '实体名称' },
            },
            required: ['name'],
          },
        },
        {
          name: 'find_connections',
          description: '跨空间探索 - 找出横跨多个文件夹的共有实体（人名/项目/概念），用于回答「这几块资料有什么共同点」。',
          inputSchema: {
            type: 'object',
            properties: {
              source_id: { type: 'number', description: '只看与某个空间有连接的部分；省略则返回全体跨域桥' },
              limit: { type: 'number', description: '返回数量上限', default: 50 },
            },
          },
        },
        {
          name: 'search_entities',
          description: '按名称检索实体（批量重命名/合并前用来确认实体ID）',
          inputSchema: {
            type: 'object',
            properties: {
              query: { type: 'string', description: '实体名称关键词' },
              limit: { type: 'number', description: '返回数量上限', default: 20 },
            },
            required: ['query'],
          },
        },
        {
          name: 'rename_entity',
          description: '重命名实体（仅改名称/类型，关系通过ID关联故不受影响；撞名时会报错，请改用合并）',
          inputSchema: {
            type: 'object',
            properties: {
              id: { type: 'number', description: '实体ID' },
              name: { type: 'string', description: '新的实体名称' },
              type: { type: 'string', description: '可选：同时修改实体类型' },
            },
            required: ['id', 'name'],
          },
        },
        {
          name: 'merge_entities',
          description: '批量合并实体（消歧）：把多个源实体的全部关系转移到目标实体后删除源实体，全部在单个事务内完成',
          inputSchema: {
            type: 'object',
            properties: {
              source_ids: { type: 'array', items: { type: 'number' }, description: '待合并的源实体ID列表' },
              target_id: { type: 'number', description: '目标实体ID（被保留）' },
            },
            required: ['source_ids', 'target_id'],
          },
        },
        {
          name: 'list_projects',
          description: '列出全部项目（课题工作区）及其文档数量。拿到 project_id 后可传给 search / semantic_search 限定范围，或传给 assign_to_project 做批量整理。',
          inputSchema: { type: 'object', properties: {} },
        },
        {
          name: 'assign_to_project',
          description: '批量把文档指派/迁移到某个项目，或从项目中移出（project_id 传 null）。用于「把这几个文件归到毕业论文项目」这类整理动作，单事务提交，只统计真正改了归属的行。',
          inputSchema: {
            type: 'object',
            properties: {
              document_ids: { type: 'array', items: { type: 'number' }, description: '文档ID列表（可由 search / list_documents 得到）' },
              project_id: { type: ['number', 'null'], description: '目标项目ID；传 null 表示移出项目' },
            },
            required: ['document_ids'],
          },
        },
        ...this.workbenchTools(),
      ],
    }))

    // 分发逻辑抽成具名闭包：既挂给 MCP 传输层，也经 handleToolCall 暴露给集成测试，
    // 保证两条路径走的是同一份实现（测试不会对着影子代码断言）。
    const dispatch = async (name: string, args: any): Promise<any> => {
      // 未装配工作台域时，这些工具既不在 tools/list 里，也不该被 tools/call 命中。
      if (!this.workbenchDomains && WORKBENCH_TOOL_NAMES.has(name)) {
        return { content: [{ type: 'text', text: `Unknown tool: ${name}` }] }
      }

      switch (name) {
        case 'list_scopes': {
          const sourceId = args.source_id != null ? Number(args.source_id) : null
          const spaces = (sourceId != null
            ? this.db.prepare(`
                SELECT s.id, s.name, s.root_path, s.storage_mode, s.last_sync_at,
                  (SELECT COUNT(*) FROM documents d WHERE d.source_id = s.id AND d.is_available = 1) AS doc_count
                FROM folder_sources s WHERE s.id = ?`).all(sourceId)
            : this.db.prepare(`
                SELECT s.id, s.name, s.root_path, s.storage_mode, s.last_sync_at,
                  (SELECT COUNT(*) FROM documents d WHERE d.source_id = s.id AND d.is_available = 1) AS doc_count
                FROM folder_sources s ORDER BY s.id`).all()) as any[]

          const payload: any = {
            spaces: spaces.map(s => ({
              source_id: s.id,
              name: s.name,
              root_path: s.root_path,
              storage_mode: s.storage_mode,
              doc_count: s.doc_count,
              last_sync_at: s.last_sync_at,
            })),
            usage: '把 source_id 传给 search / semantic_search / get_context / list_documents / get_entities 即可限定范围；再配合 folder_path 可下钻到子目录。',
          }

          if (args.include_folders) {
            payload.folders = (sourceId != null
              ? this.db.prepare('SELECT source_id, path, depth, doc_count FROM folders WHERE source_id = ? ORDER BY depth, path').all(sourceId)
              : this.db.prepare('SELECT source_id, path, depth, doc_count FROM folders ORDER BY source_id, depth, path').all()) as any[]
            payload.folders = (payload.folders as any[]).map(f => ({ ...f, path: f.path || '/' }))
          }

          return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] }
        }

        case 'search': {
          const set = await this.searchService.fullTextSearch(args.query, {
            file_type: args.file_type,
            storage_type: args.storage_type,
            limit: args.limit,
            ...normalizeScope(args),
          })
          return {
            content: [{
              type: 'text',
              text: this.envelope(set, (r: any) => ({
                id: r.id,
                title: r.title,
                type: r.file_type,
                excerpt: r.excerpt,
                score: r.rank,
              })),
            }],
          }
        }

        case 'semantic_search': {
          const set = await this.searchService.semanticSearch(args.query, {
            limit: args.limit ?? 10,
            ...normalizeScope(args),
          })
          return {
            content: [{
              type: 'text',
              text: this.envelope(set, (r: any) => ({
                id: r.id,
                title: r.title,
                type: r.file_type,
                summary: r.summary,
                score: r.score,
              })),
            }],
          }
        }

        case 'get_context': {
          const context = await this.searchService.getContext(args.query, args.max_tokens || 4000, normalizeScope(args))
          return {
            content: [{
              type: 'text',
              text: context.context,
            }],
            metadata: {
              scope: context.scope,
              documents: context.documents,
              entities: context.entities,
              token_count: context.token_count,
              truncated: context.truncated,
              truncated_reason: context.truncated_reason,
            },
          }
        }

        case 'ask': {
          // 未装配问答服务：可读提示而非崩溃
          if (!this.answerService) {
            return { content: [{ type: 'text', text: JSON.stringify({ mode: 'error', message: 'RAG 问答服务尚未装配' }, null, 2) }], isError: false }
          }
          // 出域被拒 / 未配置模型都不抛异常：结果里带 mode 与可读 message（isError 恒 false，由 Agent 读模式判断）
          const result = await this.answerService.ask({
            query: args.query,
            document_id: args.document_id,
            egress_scope: args.egress_scope,
            max_tokens: args.max_tokens,
            limit: args.limit,
            scope: normalizeScope(args),
            actor: 'mcp',
          })
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                mode: result.mode,
                answer: result.answer,
                citations: result.citations,
                citation_map: result.citation_map,
                citations_unverified: result.citations_unverified,
                cited_indexes: result.cited_indexes,
                invalid_indexes: result.invalid_indexes,
                context_meta: result.context_meta,
                egress: result.egress,
                retrieval: {
                  total: result.retrieval?.total ?? 0,
                  returned: result.retrieval?.items?.length ?? 0,
                  truncated: result.retrieval?.truncated ?? false,
                  truncated_reason: result.retrieval?.truncated_reason ?? null,
                  channels: result.retrieval?.channels ?? null,
                },
                message: result.message,
              }, null, 2),
            }],
            isError: false,
          }
        }

        case 'list_documents': {
          const scope = normalizeScope(args)
          const limit = Number(args.limit) > 0 ? Math.min(500, Math.floor(Number(args.limit))) : 50
          const filters = {
            file_type: args.file_type,
            storage_type: args.storage_type,
            search: args.search,
            limit,
            ...scope,
          }
          const docs = await this.fileService.listFiles(filters)
          const total = await this.fileService.countFiles(filters)
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                scope: describeScope(this.db, scope),
                total,
                returned: docs.length,
                limit,
                truncated: total > docs.length,
                ...(total > docs.length ? { truncated_reason: 'limit' } : {}),
                items: docs.map((d: any) => ({
                  id: d.id,
                  title: d.title,
                  type: d.file_type,
                  storage: d.storage_type,
                  size: d.file_size,
                  source_name: d.source_name,
                  relative_path: d.relative_path,
                  tags: d.tags,
                })),
              }, null, 2),
            }],
          }
        }

        case 'get_document': {
          const doc = await this.fileService.getFileDetail(args.id)
          if (!doc) {
            return { content: [{ type: 'text', text: 'Document not found' }] }
          }
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                id: doc.id,
                title: doc.title,
                type: doc.file_type,
                storage: doc.storage_type,
                size: doc.file_size,
                summary: doc.summary,
                content: (doc.content_text || '').substring(0, 5000),
                entities: doc.entities,
                tags: doc.tags,
                versions: doc.versions,
              }, null, 2),
            }],
          }
        }

        case 'get_graph_stats': {
          const stats = await this.graphBuilder.getStats()
          return {
            content: [{
              type: 'text',
              text: JSON.stringify(stats, null, 2),
            }],
          }
        }

        case 'get_entities': {
          const scope = normalizeScope(args)
          const limit = Number(args.limit) > 0 ? Math.min(500, Math.floor(Number(args.limit))) : 50
          const set = await this.graphBuilder.getEntities({ type: args.type, limit, ...scope })
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                scope: describeScope(this.db, scope),
                total: set.total,
                returned: set.items.length,
                limit: set.limit,
                truncated: set.truncated,
                ...(set.truncated_reason ? { truncated_reason: set.truncated_reason } : {}),
                items: set.items,
              }, null, 2),
            }],
          }
        }

        case 'get_entity_graph': {
          const graph = await this.graphBuilder.getEntityGraph(args.name)
          return {
            content: [{
              type: 'text',
              text: JSON.stringify(graph, null, 2),
            }],
          }
        }

        case 'find_connections': {
          const bridges = await this.graphBuilder.getBridges({
            limit: args.limit,
            source_id: args.source_id != null ? Number(args.source_id) : null,
          })
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                description: '这些实体同时出现在多个文件夹中，是各块资料之间的天然连接点。',
                total: bridges.total,
                returned: bridges.items.length,
                truncated: bridges.truncated,
                ...(bridges.truncated_reason ? { truncated_reason: bridges.truncated_reason } : {}),
                items: bridges.items,
              }, null, 2),
            }],
          }
        }

        case 'search_entities': {
          const entities = await this.graphBuilder.searchEntities(args.query, args.limit || 20)
          return {
            content: [{
              type: 'text',
              text: JSON.stringify(entities, null, 2),
            }],
          }
        }

        case 'rename_entity': {
          const result = await this.graphBuilder.renameEntity(Number(args.id), args.name, args.type)
          return {
            content: [{
              type: 'text',
              text: JSON.stringify(result, null, 2),
            }],
          }
        }

        case 'merge_entities': {
          const result = await this.graphBuilder.mergeEntitiesBatch(args.source_ids, Number(args.target_id))
          return {
            content: [{
              type: 'text',
              text: JSON.stringify(result, null, 2),
            }],
          }
        }

        case 'list_projects': {
          // ADR-003：「同一个项目既挂文档又挂任务」——这里同时给出两侧计数，
          // Agent 才能一眼看出哪个项目的资料已齐、活还没干完。
          const rows = this.db.prepare(`
            SELECT p.id, p.name, p.description, p.color, p.created_at,
              (SELECT COUNT(*) FROM documents d WHERE d.project_id = p.id AND d.is_available = 1) AS doc_count,
              (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND t.archived = 0) AS task_count,
              (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND t.archived = 0 AND t.status = 'done') AS done_count
            FROM projects p ORDER BY p.id`).all() as any[]
          const items = rows.map(row => {
            const taskCount = Number(row.task_count || 0)
            const doneCount = Number(row.done_count || 0)
            return {
              ...row,
              task_count: taskCount,
              done_count: doneCount,
              progress: taskCount > 0 ? Math.round((doneCount * 100) / taskCount) : 0,
            }
          })
          return { content: [{ type: 'text', text: JSON.stringify({ items, total: items.length }, null, 2) }] }
        }

        case 'assign_to_project': {
          const ids = Array.isArray(args.document_ids) ? args.document_ids : []
          const target = args.project_id == null ? null : Number(args.project_id)
          const res = await this.fileService.assignManyToProject(ids, target)
          const where = target == null ? '已移出项目' : `已归入项目 #${target}`
          return { content: [{ type: 'text', text: `${where}：更新 ${res.updated} 份，未变化 ${res.skipped} 份。` }] }
        }

        case 'workbench_overview': {
          const { workbench } = this.workbenchDomains!
          const overview = workbench.dashboard()
          return { content: [{ type: 'text', text: JSON.stringify({
            ...overview,
            workspace_stats: workbench.workspaceStats(),
          }, null, 2) }] }
        }

        case 'list_workspaces': {
          const { workbench } = this.workbenchDomains!
          const items = workbench.workspaceStats()
          return { content: [{ type: 'text', text: JSON.stringify({
            active_workspace_id: workbench.activeWorkspace()?.id ?? null,
            items,
            total: items.length,
          }, null, 2) }] }
        }

        case 'list_tasks': {
          const { tasks, workbench } = this.workbenchDomains!
          const statusFilter = typeof args.status === 'string' && args.status ? args.status : null
          const projectFilter = args.project_id == null ? null : Number(args.project_id)
          const workspaceFilter = args.workspace_id == null ? null : Number(args.workspace_id)

          // tasks 表本身没有 workspace_id，工作区归属只能经「任务 → 项目 → 工作区」推导。
          // 这里直查 projects，而不是复用 workbench.listProjects()：后者的口径是
          // 「当前工作区 + 未归属工作区」，用它过滤会让 workspace_id 参数只对当前工作区生效。
          // MCP 是能力出口，不该继承 UI 的当前视角。
          const projectWorkspace = new Map<number, number | null>(
            (this.db.prepare('SELECT id, workspace_id FROM projects').all() as any[]).map((project: any) => [
              Number(project.id),
              project.workspace_id ?? null,
            ]),
          )
          const inWorkspace = (task: any) =>
            workspaceFilter == null || (task.projectId != null && projectWorkspace.get(Number(task.projectId)) === workspaceFilter)

          const groups = tasks.list().map(group => ({
            id: group.id,
            name: group.name,
            color: group.color,
            position: group.position,
            tasks: (group.tasks || [])
              .filter((task: any) =>
                (!statusFilter || task.status === statusFilter) &&
                (projectFilter == null || Number(task.projectId) === projectFilter) &&
                inWorkspace(task))
              .map((task: any) => ({
                code: task.id,
                name: task.name,
                status: task.status,
                priority: task.priority,
                deadline: task.deadline || null,
                owner: task.owner || null,
                project_id: task.projectId ?? null,
              })),
          }))
          const all = groups.flatMap(g => g.tasks)
          const today = new Date().toISOString().slice(0, 10)
          return { content: [{ type: 'text', text: JSON.stringify({
            workspace_id: workspaceFilter ?? workbench.activeWorkspace()?.id ?? null,
            total: all.length,
            counts: {
              todo: all.filter(t => t.status === 'todo').length,
              doing: all.filter(t => t.status === 'doing').length,
              done: all.filter(t => t.status === 'done').length,
              overdue: all.filter(t => t.deadline && t.deadline < today && t.status !== 'done').length,
            },
            groups,
          }, null, 2) }] }
        }

        case 'get_task': {
          const { tasks } = this.workbenchDomains!
          const task = tasks.get(String(args.code ?? ''))
          if (!task) return { content: [{ type: 'text', text: `任务不存在：${args.code}` }] }
          return { content: [{ type: 'text', text: JSON.stringify(task, null, 2) }] }
        }

        case 'create_task': {
          try {
            const { tasks, workbench } = this.workbenchDomains!
            const groupId = this.resolveTaskGroupId(args.group_id, args.group_name)
            const created = tasks.createTask({
              groupId,
              name: String(args.name ?? ''),
              description: typeof args.description === 'string' ? args.description : '',
              priority: args.priority ?? '中',
              status: args.status ?? 'todo',
              deadline: args.deadline ?? '',
              owner: args.owner ?? '',
            })
            if (args.project_id != null) workbench.assignTask(Number(args.project_id), created.id)
            return { content: [{ type: 'text', text: `已创建任务 ${created.id}：${created.name}${args.project_id != null ? `（归入项目 #${Number(args.project_id)}）` : ''}` }] }
          } catch (error) {
            return this.fail(error)
          }
        }

        case 'update_task': {
          try {
            const { tasks, workbench } = this.workbenchDomains!
            const existing = tasks.get(String(args.code ?? ''))
            if (!existing) return { content: [{ type: 'text', text: `任务不存在：${args.code}` }] }

            const patch: Record<string, unknown> = {}
            if (args.name != null) patch.name = args.name
            if (args.description != null) patch.description = args.description
            if (args.priority != null) patch.priority = args.priority
            if (args.status != null) patch.status = args.status
            if (args.deadline != null) patch.deadline = args.deadline
            if (args.owner != null) patch.owner = args.owner
            if (args.group_id != null) patch.groupId = Number(args.group_id)

            const updated = Object.keys(patch).length ? tasks.updateTask(existing.id, patch) : existing
            if (args.project_id !== undefined) {
              if (args.project_id == null) workbench.unassignTask(existing.id)
              else workbench.assignTask(Number(args.project_id), existing.id)
            }
            return { content: [{ type: 'text', text: JSON.stringify({ task: updated, project_id: args.project_id === undefined ? existing.projectId ?? null : args.project_id }, null, 2) }] }
          } catch (error) {
            return this.fail(error)
          }
        }

        case 'complete_task': {
          try {
            const { tasks } = this.workbenchDomains!
            const done = tasks.completeTask(String(args.code ?? ''))
            return { content: [{ type: 'text', text: `任务 ${done.id}「${done.name}」已完成` }] }
          } catch (error) {
            return this.fail(error)
          }
        }

        case 'assign_task_to_project': {
          try {
            const { workbench } = this.workbenchDomains!
            const code = String(args.code ?? '')
            if (!code) return { content: [{ type: 'text', text: '缺少参数 code' }] }
            if (args.project_id == null) {
              workbench.unassignTask(code)
              return { content: [{ type: 'text', text: `任务 ${code} 已移出项目` }] }
            }
            if (!workbench.assignTask(Number(args.project_id), code)) {
              return { content: [{ type: 'text', text: `任务 ${code} 归入项目失败：任务或项目不存在` }] }
            }
            return { content: [{ type: 'text', text: `任务 ${code} 已归入项目 #${Number(args.project_id)}` }] }
          } catch (error) {
            return this.fail(error)
          }
        }

        case 'project_tasks': {
          const { workbench } = this.workbenchDomains!
          const items = workbench.projectTasks(args.project_id)
          return { content: [{ type: 'text', text: JSON.stringify({ project_id: Number(args.project_id), items, total: items.length }, null, 2) }] }
        }

        case 'get_timeline': {
          const { workbench } = this.workbenchDomains!
          const items = workbench.timeline({ days: args.days, limit: args.limit })
          return { content: [{ type: 'text', text: JSON.stringify({
            range: { days: Number(args.days) || 30, limit: Number(args.limit) || 60 },
            counts: {
              tasks: items.filter(e => e.kind === 'task').length,
              documents: items.filter(e => e.kind === 'document').length,
              upcoming: items.filter(e => e.phase !== 'past').length,
            },
            items,
          }, null, 2) }] }
        }

        case 'search_all': {
          const { workbench } = this.workbenchDomains!
          const scope = normalizeScope(args)
          const limit = Number(args.limit) > 0 ? Math.min(50, Math.floor(Number(args.limit))) : 10
          const all = await workbench.searchAll(args.query, this.searchService, { limit, ...scope })
          const set = all.documents
          return { content: [{ type: 'text', text: JSON.stringify({
            query: args.query,
            scope: describeScope(this.db, scope),
            tasks: all.tasks ?? [],
            projects: all.projects ?? [],
            files: all.files ?? [],
            documents: {
              total: set.total,
              returned: set.items.length,
              truncated: set.truncated,
              ...(set.truncated_reason ? { truncated_reason: set.truncated_reason } : {}),
              items: set.items.map((r: any) => ({ id: r.id, title: r.title, type: r.file_type, excerpt: r.excerpt })),
            },
          }, null, 2) }] }
        }

        default:
          return { content: [{ type: 'text', text: `Unknown tool: ${name}` }] }
      }
    }

    this.server.setRequestHandler(CallToolRequestSchema, (request: any) =>
      dispatch(String(request.params.name), request.params.arguments ?? {}))
    this.dispatch = dispatch
  }

  /**
   * 直接分发一次工具调用（ADR-003 决策 4）。
   *
   * 抽出来的唯一目的是可测：集成测试不必启动 stdio 传输层，就能断言
   * `workbench_overview` / `list_tasks` / `get_timeline` 等工具的返回结构。
   */
  async handleToolCall(name: string, args: any = {}): Promise<any> {
    if (!this.dispatch) throw new Error('MCP 工具处理器尚未装配')
    return this.dispatch(name, args)
  }

  /**
   * 工作台域工具清单（ADR-003 决策 4）。
   *
   * 未装配工作台域时返回空数组——单进程单库下这不该发生，
   * 但保持「缺件即静默降级」能让内核域的 MCP 能力不被工作台拖住。
   */
  private workbenchTools(): any[] {
    if (!this.workbenchDomains) return []
    return [
      {
        name: 'workbench_overview',
        description: '工作台总览：当前空间、项目进度（文档数与任务完成率）、标签分布、任务统计。回答「我这周有哪些活、哪些项目卡住了」时先用它。',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'list_workspaces',
        description: '列出全部工作区及其统计（项目数/文件数/任务数/已完成数），并标出当前激活的工作区。',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'list_tasks',
        description: '列出工作台任务（按分组返回，即看板视角），含状态/优先级/截止日期/负责人/所属项目。可按 status 与 project_id 过滤。',
        inputSchema: {
          type: 'object',
          properties: {
            status: { type: 'string', enum: ['todo', 'doing', 'done'], description: '仅看某个状态' },
            project_id: { type: 'number', description: '仅看某个项目下的任务（与文档共用项目）' },
            workspace_id: { type: 'number', description: '仅看某个工作区（按任务所属项目的工作区归属推导）；省略 = 不按工作区限制' },
          },
        },
      },
      {
        name: 'get_task',
        description: '按任务编号（如 TK-2026-0001）获取任务详情。',
        inputSchema: {
          type: 'object',
          properties: { code: { type: 'string', description: '任务编号' } },
          required: ['code'],
        },
      },
      {
        name: 'create_task',
        description: '新建任务。可指定分组（group_id 或 group_name，都不给则落到首个分组/新建「收集箱」），也可直接用 project_id 归入某个项目。',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: '任务名称' },
            description: { type: 'string', description: '任务描述' },
            group_id: { type: 'number', description: '分组ID' },
            group_name: { type: 'string', description: '分组名称（不存在则自动创建）' },
            priority: { type: 'string', enum: ['高', '中', '低'], description: '优先级，默认「中」' },
            status: { type: 'string', enum: ['todo', 'doing', 'done'], description: '状态，默认 todo' },
            deadline: { type: 'string', description: '截止日期 YYYY-MM-DD' },
            owner: { type: 'string', description: '负责人' },
            project_id: { type: 'number', description: '归入的项目ID（与文档项目共用同一张表）' },
          },
          required: ['name'],
        },
      },
      {
        name: 'update_task',
        description: '更新任务（状态/优先级/名称/描述/截止日期/负责人/分组），或用 project_id 调整项目归属（传 null 移出项目）。',
        inputSchema: {
          type: 'object',
          properties: {
            code: { type: 'string', description: '任务编号' },
            name: { type: 'string' },
            description: { type: 'string' },
            status: { type: 'string', enum: ['todo', 'doing', 'done'] },
            priority: { type: 'string', enum: ['高', '中', '低'] },
            deadline: { type: 'string', description: '截止日期 YYYY-MM-DD，传空串可清空' },
            owner: { type: 'string' },
            group_id: { type: 'number' },
            project_id: { type: ['number', 'null'], description: '目标项目ID；传 null 表示移出项目' },
          },
          required: ['code'],
        },
      },
      {
        name: 'complete_task',
        description: '把任务标记为已完成（会记录完成时间）。',
        inputSchema: {
          type: 'object',
          properties: { code: { type: 'string', description: '任务编号' } },
          required: ['code'],
        },
      },
      {
        name: 'assign_task_to_project',
        description: '把任务归入某个项目，或从项目中移出（project_id 传 null）。与 assign_to_project（文档）配对使用，让同一项目下的资料与活对齐。',
        inputSchema: {
          type: 'object',
          properties: {
            code: { type: 'string', description: '任务编号' },
            project_id: { type: ['number', 'null'], description: '目标项目ID；传 null 表示移出项目' },
          },
          required: ['code'],
        },
      },
      {
        name: 'project_tasks',
        description: '列出某个项目下的全部任务——配合 list_documents 的 project_id 过滤，即可同时看到「这个项目的资料」和「这个项目的活」。',
        inputSchema: {
          type: 'object',
          properties: { project_id: { type: 'number', description: '项目ID' } },
          required: ['project_id'],
        },
      },
      {
        name: 'get_timeline',
        description: '跨域时间线：把任务截止与文档入库放进同一条事件流（按日期倒序）。回答「最近/接下来有什么」时用它，比分别查任务和文档更省事。',
        inputSchema: {
          type: 'object',
          properties: {
            days: { type: 'number', description: '回溯天数（含未来事件），默认 30', default: 30 },
            limit: { type: 'number', description: '事件条数上限，默认 60', default: 60 },
          },
        },
      },
      {
        name: 'search_all',
        description: '跨域统一检索：一次同时搜任务、项目、文档。可用 source_id / folder_path / project_id 限定文档范围。用户说「关于 X 的一切」时用它。',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: '关键词' },
            limit: { type: 'number', description: '文档返回数量上限', default: 10 },
            ...SCOPE_PROPERTIES,
          },
          required: ['query'],
        },
      },
    ]
  }

  /** 解析任务分组：显式 ID > 分组名（不存在则建）> 首个分组 > 兜底建「收集箱」。 */
  private resolveTaskGroupId(groupId?: unknown, groupName?: unknown): number {
    const { tasks } = this.workbenchDomains!
    const groups = tasks.list()

    if (groupId != null && Number.isInteger(Number(groupId))) {
      const found = groups.find((group: any) => group.id === Number(groupId))
      if (!found) throw new Error(`任务分组不存在：#${Number(groupId)}`)
      return found.id
    }

    const name = typeof groupName === 'string' ? groupName.trim() : ''
    if (name) {
      const found = groups.find((group: any) => group.name === name)
      if (found) return found.id
      return tasks.createGroup({ name, color: 'blue' }).id
    }

    if (groups.length > 0) return groups[0].id
    return tasks.createGroup({ name: '收集箱', color: 'blue' }).id
  }

  /** 把异常转成 Agent 可读的文本，而不是让整轮调用以栈信息失败。 */
  private fail(error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    return { content: [{ type: 'text', text: `操作失败：${message}` }], isError: true }
  }

  async start(): Promise<void> {
    if (this.running) return
    const transport = new StdioServerTransport()
    await this.server.connect(transport)
    this.running = true
    console.error('SD MCP Server started (stdio mode)')
  }

  isRunning(): boolean {
    return this.running
  }
}
