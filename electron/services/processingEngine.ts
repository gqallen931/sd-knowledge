import * as fs from 'fs'
import * as path from 'path'
import DatabaseService from './database'
import { VectorIndex } from './vectorIndex'
import { PerfRecorder, createPerfRecorder, measure, measureSync } from './perfLogger'
import { ScopeFilter, hasScope, scopeWhere } from './scope'
import { ChunkAnchor, EmbeddingPlugin, ParserParseResult, ParserPlugin, PluginRuntime } from './plugins/types'
import {
  DEFAULT_CHUNK_OVERLAP,
  DEFAULT_CHUNK_SIZE,
  StoredChunk,
  anchorOf,
  buildChunkRows,
  normalizeLineBreaks,
  readChunks,
  splitTextChunksWithSpans,
  writeChunks,
} from './chunks'
import { pluginRegistry } from './plugins/registry'
import { initPluginSystem } from './plugins'
import { buildBuiltinEmbeddings, createAdHocEmbedding } from './plugins/builtin/embeddingTransformers'
import { buildDetachedBuiltinParsers } from './plugins/builtin/parsers'
import { builtinParserManifest } from './plugins/builtin/manifests'
import { DEFAULT_ONNX_THREADS, applyModelEnv, applyOnnxThreadOptions, clampInt, importModule } from './plugins/builtin/transformersEnv'
import { toEmbeddingVectors } from './plugins/builtin/embeddingVectors'
import { PREDICATE_TRIGGERS, extractPredicateEdges } from './predicateRules'
import { buildCompoundTerms } from './compoundTerms'

/**
 * 环境适配、线程注入、向量解码与整数收敛都已搬到 `plugins/builtin/`（内建插件与引擎共用，
 * 避免 `plugins → processingEngine → plugins` 的循环依赖）。此处同名再导出，外部引用不受影响。
 */
export { DEFAULT_ONNX_THREADS, applyModelEnv, toEmbeddingVectors }

/** 默认嵌入模型（未显式指定时的兜底）：仍由注册表给出，不写死模型名 */
const DEFAULT_EMBEDDING_ID = 'Xenova/bge-small-zh-v1.5'

/**
 * 关键词实体化的停用词（ADR-007）。
 *
 * 只挡高频虚词与泛化动词：像「系统」「数据」这类在各领域都成立的词不在此列，
 * 它们作为概念实体反而有助于把文档连起来。
 */
const KEYWORD_STOPWORDS = new Set([
  '我们', '你们', '他们', '它们', '这个', '那个', '这些', '那些', '一个', '一种',
  '可以', '可能', '需要', '应该', '已经', '正在', '进行', '通过', '由于', '因为',
  '所以', '但是', '然而', '以及', '或者', '如果', '虽然', '并且', '而且', '不是',
  '没有', '什么', '怎么', '如何', '这里', '那里', '目前', '同时', '另外', '其中',
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'have', 'has', 'are', 'was',
])

let nerPipelineFn: any = null
let nerModelLoaded = ''

let loadingNer: { name: string; promise: Promise<any> } | null = null

/** 默认分块参数（设置项缺省时使用）；实现与常量都搬到 `chunks.ts`，此处同名再导出保持引用不变 */
export { DEFAULT_CHUNK_SIZE, DEFAULT_CHUNK_OVERLAP }
/** 与 database.ts 的默认设置保持一致：CPU EP 上 batch=2 优于 1 与 8（见 tests/perf-report.cjs A/B） */
export const DEFAULT_EMBED_BATCH = 2
const MAX_EMBED_BATCH = 32

/**
 * 把长文本切成带重叠的块（文本列表）。
 *
 * 算法与改造前逐字一致，只是实现改为「带偏移分块的投影」——这样
 * `chunks.char_start/char_end` 与实际用于向量化的块文本**永远同源**（D8 的前提）。
 * 细节见 `chunks.ts`：窗口右界吸附到句子/段落终止符，next start = end - overlap。
 */
export function splitIntoTextChunks(text: string, size?: unknown, overlap?: unknown): string[] {
  return splitTextChunksWithSpans(text, size, overlap).map(span => span.content)
}

async function getNerPipeline(modelName: string) {
  if (nerPipelineFn && nerModelLoaded === modelName) return nerPipelineFn
  if (loadingNer && loadingNer.name === modelName) return loadingNer.promise
  const promise = (async () => {
    const { pipeline, env } = await importModule('@xenova/transformers')
    applyModelEnv(env)
    await applyOnnxThreadOptions()
    nerPipelineFn = await pipeline('token-classification', modelName, { quantized: true })
    nerModelLoaded = modelName
    return nerPipelineFn
  })()
  loadingNer = { name: modelName, promise }
  try {
    return await promise
  } catch (e) {
    console.error('Failed to load NER model:', e)
    throw new Error(`NER 模型 ${modelName} 加载失败，请检查网络或模型名称`)
  } finally {
    if (loadingNer?.promise === promise) loadingNer = null
  }
}

export class ProcessingEngine {
  private settings: Record<string, string> = {}
  private vectorIndex: VectorIndex
  /** 模型是否支持一次 forward 处理多条文本；不支持时置 false 并永久回退逐条推理 */
  private batchEmbedSupported = true

  constructor(
    private db: DatabaseService,
    private dataDir: string
  ) {
    this.vectorIndex = new VectorIndex(db, dataDir)
    // 插件子系统：内建解析器 / 内建嵌入模型先注册（吃狗粮 D21），再扫描 <Data>/plugins 下的本地插件。
    // 整个过程失败也只记状态：绝不能因为一个插件把宿主构造搞崩（D23）。
    try {
      this.registerBuiltinParsers()
      this.registerBuiltinEmbeddings()
      initPluginSystem({
        dataDir,
        getSettings: () => this.db.getSettingsSync(),
        log: (level, message) => {
          const line = `[plugins] ${message}`
          if (level === 'error') console.error(line)
          else if (level === 'warn') console.warn(line)
          else console.log(line)
        },
      })
    } catch (e) {
      console.error('[plugins] 插件系统初始化失败（宿主继续以零插件运行）:', e)
    }
  }

  /**
   * 注册内建解析器插件：**核心不再按 file_type 写 switch**（ADR-005 D21/D22）。
   *
   * - pptx / epub / xls 的实现已移出本类，是独立模块（`plugins/builtin/parser*.ts`）；
   * - pdf / word / excel / text / image / video / audio 是**薄适配器**，内部仍调用本类原有的
   *   `extract*` 方法，行为与改造前逐字段一致；
   * - 能给出锚点的格式如实给（PDF 页码、视频关键帧时间、音频分段），给不出的返回空数组。
   */
  private registerBuiltinParsers(): void {
    for (const { manifest, plugin } of buildDetachedBuiltinParsers()) {
      pluginRegistry.registerParser({ manifest, parser: plugin, source: 'builtin' })
    }

    const register = (
      id: string,
      name: string,
      description: string,
      extensions: string[],
      fileTypes: Record<string, string>,
      parse: ParserPlugin['parse'],
      runtime?: PluginRuntime
    ) => {
      pluginRegistry.registerParser({
        manifest: builtinParserManifest({ id, name, extensions, description, runtime }),
        parser: { kind: 'parser', extensions, parse },
        fileTypes,
        source: 'builtin',
      })
    }

    register(
      'sd.parser.pdf', 'PDF 解析器',
      '文本型 PDF 内容提取（扫描件走 OCR），产出页码锚点',
      ['pdf'], { pdf: 'pdf' },
      // 锚点：每页 { kind: 'page', value: 页码, start, end }（见 extractPDF）
      async ({ filePath, settings, perf }) => this.extractPDF(filePath, settings as Record<string, string>, perf),
      'worker'
    )
    register(
      'sd.parser.word', 'Word 解析器',
      'mammoth 抽取 doc/docx 正文',
      ['doc', 'docx'], { doc: 'doc', docx: 'docx' },
      async ({ filePath, perf }) => this.extractWord(filePath, perf)
    )
    register(
      'sd.parser.xlsx', 'XLSX 解析器',
      'exceljs 解析 xlsx 表格，按工作表分节',
      ['xlsx'], { xlsx: 'xlsx' },
      async ({ filePath, perf }) => this.extractExcel(filePath, perf)
    )
    register(
      'sd.parser.text', '文本解析器',
      '纯文本 / 代码 / 配置 / 标记语言按文本读取',
      ['csv', 'md', 'markdown', 'txt', 'html', 'htm', 'json', 'xml', 'js', 'ts', 'py', 'java', 'go', 'rs', 'cpp', 'sql', 'yaml', 'yml', 'toml', 'ini', 'env'],
      {
        csv: 'csv', md: 'md', markdown: 'md', txt: 'txt', html: 'html', htm: 'html', json: 'json', xml: 'xml',
        js: 'code', ts: 'code', py: 'code', java: 'code', go: 'code', rs: 'code', cpp: 'code', sql: 'code',
        yaml: 'config', yml: 'config', toml: 'config', ini: 'config', env: 'config',
      },
      async ({ filePath, perf }) => this.extractText(filePath, perf)
    )
    register(
      'sd.parser.image', '图片解析器',
      'EXIF 结构化字段 + 可选 OCR，缩略图为图片自身',
      ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp'],
      { jpg: 'image', jpeg: 'image', png: 'image', gif: 'image', bmp: 'image', webp: 'image' },
      async ({ filePath, settings, perf }) => this.extractImage(filePath, settings as Record<string, string>, perf),
      'worker'
    )
    register(
      'sd.parser.video', '视频解析器',
      'ffmpeg 抽关键帧 + 可选 OCR，产出时间锚点与首帧缩略图',
      ['mp4', 'avi', 'mkv', 'mov'],
      { mp4: 'video', avi: 'video', mkv: 'video', mov: 'video' },
      async ({ filePath, settings, perf }) => this.extractVideo(filePath, settings as Record<string, string>, perf),
      'worker'
    )
    register(
      'sd.parser.audio', '音频解析器',
      'whisper-tiny 语音转文字，产出行级时间锚点',
      ['mp3', 'wav', 'flac'],
      { mp3: 'audio', wav: 'audio', flac: 'audio' },
      async ({ filePath, settings, perf }) => this.extractAudio(filePath, settings as Record<string, string>, perf),
      'worker'
    )
  }

  /** 注册内建嵌入模型插件（S1 项，本轮一并交付）：向量化与语义检索都从注册表取模型 */
  private registerBuiltinEmbeddings(): void {
    for (const { manifest, plugin } of buildBuiltinEmbeddings()) {
      pluginRegistry.registerEmbedding({ manifest, embedding: plugin, source: 'builtin' })
    }
  }

  /**
   * 取当前设置指定的嵌入模型插件（向量化与语义检索的唯一入口，不再直接写死模型加载）。
   *
   * - 注册表中已启用 → 直接用；
   * - 注册表中有但被停用 / 加载失败 → 抛可读错误（由调用方透给用户，不做「尽力而为」）；
   * - 完全未登记的模型名（例如手工改过库的历史配置）→ 退化为临时适配器，行为同改造前，
   *   但不参与设置页的可选清单，并在日志里留痕。
   */
  private resolveEmbeddingPlugin(modelId?: string): EmbeddingPlugin {
    const id = modelId || DEFAULT_EMBEDDING_ID
    const registered = pluginRegistry.getEmbedding(id)
    if (registered) return registered
    const status = pluginRegistry.status(id)
    if (status && status.kind === 'embedding') {
      throw new Error(status.enabled
        ? `嵌入模型插件「${status.name}」加载失败，无法向量化：${status.error || '原因未知'}`
        : `嵌入模型插件「${status.name}」已停用，请在 设置 → 扩展 中启用`)
    }
    console.warn(`[plugins] 未登记的嵌入模型 ${id}，退化为临时适配器（行为同改造前）`)
    return {
      kind: 'embedding',
      id,
      dimension: 0,
      descriptor: { quantized: true, source: 'transformers.js · HuggingFace Hub' },
      ...createAdHocEmbedding(id),
    }
  }

  /**
   * 进程退出前调用：把内存向量索引快照落盘（ADR-002 P2）。
   * 平时由防抖定时器负责，这里只兜住「最后一次变更还没等到防抖触发就退出」。
   */
  flushIndexes() {
    this.vectorIndex.flush()
  }

  private async loadSettings() {
    this.settings = await this.db.getSettings()
    return this.settings
  }

  /** 存量 chunks 回填（D8）：把某文档的旧向量从内存索引摘掉（tombstone），随后按块逐条加回 */
  removeFromIndex(documentId: number) {
    this.vectorIndex.removeDocument(documentId)
  }

  /** 存量 chunks 回填（D8）：把一条带块关联的向量加回内存索引（口径与 generateEmbedding 一致） */
  addVectorToIndex(model: string, documentId: number, vector: Float32Array, chunkId: number | null, chunkIndex: number | null) {
    this.vectorIndex.addVector(model, documentId, vector, chunkId, chunkIndex)
  }

  async processDocument(docId: number): Promise<void> {
    const doc = this.db.prepare('SELECT * FROM documents WHERE id = ?').get(docId) as any
    if (!doc) return

    const filePath = doc.storage_type === 'reference' ? doc.original_path : doc.file_path
    if (!filePath || !fs.existsSync(filePath)) {
      this.db.prepare('UPDATE documents SET is_available = 0 WHERE id = ?').run(docId)
      return
    }

    const startedAt = Date.now()
    let perf: PerfRecorder | null = null
    try {
      this.db.prepare("UPDATE documents SET processing_status='processing', processing_error=NULL WHERE id=?").run(docId)
      const settings = await this.loadSettings()
      perf = createPerfRecorder(this.dataDir, settings, 'process', {
        doc: `#${docId}`,
        name: doc.file_name || '',
        type: doc.file_type || '',
        size: `${Math.round((doc.file_size || 0) / 1024)}KB`,
      }, startedAt)

      const content = await measure(perf, 'extract', () => this.extractContent(filePath, doc.file_type, settings, perf))
      // 统一换行（\r\n → \n）：`chunks` 的字符偏移相对写库后的 content_text，
      // 只有「写入前归一化」才能保证偏移与正文一致（架构文档 §5.6.3 锁死的细节）
      const text = normalizeLineBreaks(content.text)
      // 图片/视频的价值可能只在元数据与缩略图（未开 OCR 时本就无文字），不应因无文本判失败；
      // 其余格式仍要求有文本，避免不支持的格式静默落成空文档。
      const textOptional = doc.file_type === 'image' || doc.file_type === 'video'
      if (!textOptional && !text.trim()) throw new Error('未提取到文本，请检查格式、OCR 或模型配置后重试')
      perf?.setField('chars', text.length)

      const summary = measureSync(perf, 'summary', () => this.generateSummary(text))
      let entities = measureSync(perf, 'ner_rule', () => this.extractEntities(text))
      if (settings.deep_ner_enabled === 'true' && text.trim()) {
        try {
          const deep = await measure(perf, 'ner_deep', () => this.extractEntitiesDeep(text, settings))
          const seen = new Set(entities.map(e => `${e.type}|${e.name}`))
          for (const d of deep) {
            const key = `${d.type}|${d.name}`
            if (!seen.has(key)) { entities.push(d); seen.add(key) }
          }
        } catch (e: any) {
          console.error('深度 NER 失败，已回退规则抽取:', e?.message || e)
        }
      } else {
        perf?.skip('ner_deep')
      }
      const keywords = measureSync(perf, 'keywords', () => this.extractKeywords(text))
      // ADR-007 的前置条件：规则 NER 只认人名/机构/地名，任意名词（「向量检索」）进不了图谱，
      // 语义边就无从谈起。把 TF-IDF 关键词按 concept 补进实体集，门槛见 keywordEntities。
      const keywordExtra = this.keywordEntities(keywords, text)
      if (keywordExtra.length) {
        const seen = new Set(entities.map(e => `${e.type}|${e.name}`))
        for (const extra of keywordExtra) {
          const key = `${extra.type}|${extra.name}`
          if (seen.has(key) || entities.length >= 60) continue
          entities.push(extra)
          seen.add(key)
        }
      }
      // 语义边（ADR-007）：纯规则抽取，不依赖任何模型。计算放在写库之前，
      // 落库与实体链接共用同一个事务，避免出现「实体有了、边没有」的中间态。
      const predicateEdges = measureSync(perf, 'predicate', () => extractPredicateEdges(text, entities))
      perf?.setField('entities', entities.length)
      perf?.setField('tags', keywords.length)
      perf?.setField('predicate_candidates', predicateEdges.length)

      measureSync(perf, 'db_document', () => {
        // 缩略图与解析结果同一次 UPDATE 落库，避免二次写库：
        // 视频取首个关键帧、图片取自身，其余类型保持 NULL
        const thumbnailPath = content.metadata?.thumbnail_path || null
        // 块级溯源锚点随 metadata 一起落库（documents 表结构不变：锚点是结构化元数据，不是新列）
        const metadata: Record<string, unknown> = { ...(content.metadata || {}) }
        if (content.anchors?.length) metadata.anchors = content.anchors
        this.db.prepare(`
          UPDATE documents
          SET content_text = ?, summary = ?, metadata = ?, thumbnail_path = ?, updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).run(text, summary, JSON.stringify(metadata), thumbnailPath, docId)

        this.db.prepare("DELETE FROM relationships WHERE source_type='document' AND source_id=? AND target_type='entity'").run(docId)
        this.db.prepare('DELETE FROM vectors WHERE document_id=?').run(docId)
        this.vectorIndex.removeDocument(docId)
      })

      // 块级溯源（D8）：先落 chunks（拿到 chunk id），向量化时再把 vectors 关联上去。
      // 与正文同一次写入事务之外单独一个事务，是为了让「无向量」的库（vector_enabled=false）
      // 也能得到块与偏移——块是正文的结构，不依赖模型。
      const chunkIds = measureSync(perf, 'chunks', () => {
        const rows = buildChunkRows(text, content.anchors, settings.chunk_size, settings.chunk_overlap)
        let ids: number[] = []
        this.db.transaction(() => { ids = writeChunks(this.db, docId, rows) })
        return ids
      })
      perf?.setField('chunks_written', chunkIds.length)

      measureSync(perf, 'db_graph', () => {
        const insertEntity = this.db.prepare('INSERT OR IGNORE INTO entities (name, type, description) VALUES (?, ?, ?)')
        const selectEntity = this.db.prepare('SELECT id FROM entities WHERE name = ? AND type = ?')
        const linkEntity = this.db.prepare(`
          INSERT OR IGNORE INTO relationships (source_type, source_id, target_type, target_id, relation_type)
          VALUES ('document', ?, 'entity', ?, ?)
        `)
        // 规则边按文档精确重算：删掉本文档上次产出的边再重建。
        // 人工创建的边 source_doc_id 为 NULL，天然不会被这条语句命中。
        const clearPredicateEdges = this.db.prepare('DELETE FROM relationships WHERE source_doc_id = ?')
        const insertPredicateEdge = this.db.prepare(`
          INSERT INTO relationships (
            source_type, source_id, target_type, target_id, relation_type, weight, metadata, source_doc_id
          ) VALUES ('entity', ?, 'entity', ?, ?, ?, ?, ?)
        `)
        let created = 0
        let predicateWritten = 0
        this.db.transaction(() => {
          clearPredicateEdges.run(docId)
          for (const entity of entities) {
            if (insertEntity.run(entity.name, entity.type, entity.description || '').changes > 0) created++
            const ent = selectEntity.get(entity.name, entity.type) as any
            if (ent) linkEntity.run(docId, ent.id, entity.relation || 'CONTAINS')
          }
          for (const edge of predicateEdges) {
            const source = selectEntity.get(edge.sourceName, edge.sourceType) as any
            const target = selectEntity.get(edge.targetName, edge.targetType) as any
            // 实体可能在上一步被别名归一或未落库，跳过而不是凭空补一个实体
            if (!source || !target || source.id === target.id) continue
            insertPredicateEdge.run(
              source.id,
              target.id,
              edge.relation,
              edge.weight,
              JSON.stringify({ origin: 'predicate-rule', evidence: edge.evidence, sentence: edge.sentence }),
              docId,
            )
            predicateWritten++
          }
        })
        perf?.setField('entities_new', created)
        perf?.setField('predicate_edges', predicateWritten)
      })

      measureSync(perf, 'db_tags', () => this.syncDocumentTags(docId, keywords, perf))

      if (settings.vector_enabled === 'true') {
        await measure(perf, 'embed', () => this.generateEmbedding(docId, content.text || summary, perf))
      } else {
        perf?.skip('embed')
      }

      measureSync(perf, 'finalize', () => {
        this.db.prepare(`
          INSERT INTO audit_logs (actor_type, actor_name, action, resource_type, resource_id, details, status)
          VALUES ('system', 'processing', 'update', 'document', ?, ?, 'success')
        `).run(String(docId), `Processed: ${doc.file_name}`)
        this.db.prepare("UPDATE documents SET processing_status='ready' WHERE id=?").run(docId)
      })

      perf?.finish()
    } catch (err: any) {
      perf?.finish(err?.message || String(err))
      console.error(`Error processing document ${docId}:`, err)
      this.db.prepare("UPDATE documents SET processing_status='failed', processing_error=? WHERE id=?").run(err.message, docId)
      this.db.prepare(`
        INSERT INTO audit_logs (actor_type, actor_name, action, resource_type, resource_id, details, status)
        VALUES ('system', 'processing', 'update', 'document', ?, ?, 'failed')
      `).run(String(docId), err.message)
    }
  }

  /**
   * 解析文档内容。
   *
   * ADR-005 D21/D22 之后，这里**不再有按 `fileType` 的 switch**：一律交给插件注册表分发
   * （内建解析器与本地插件走同一条路径）。注册表负责三件事：
   * - 无插件认领该格式 → 返回空文本（与改造前 `default: { text: '' }` 行为一致）；
   * - 有插件但被停用 → 抛可读错误（该格式表现为「不支持」）;
   * - 插件抛错 → 记到插件状态并把错误上抛（文档标 failed，宿主不崩）。
   *
   * 返回的 `anchors` 是归一后的块级溯源锚点（页码 / 幻灯片序 / 章节序 / 时间），
   * 由 `processDocument` 随 metadata 落库。
   */
  async extractContent(
    filePath: string,
    fileType: string,
    settings?: Record<string, string>,
    perf?: PerfRecorder | null
  ): Promise<{ text: string; anchors?: ChunkAnchor[]; metadata?: any }> {
    const cfg = settings || await this.loadSettings()
    const result: ParserParseResult = await pluginRegistry.parse(filePath, fileType, cfg, perf)
    const metadata: any = { ...(result.metadata || {}) }
    // 兼容两种写法：插件可直接给 thumbnailPath，宿主统一落到 metadata.thumbnail_path（落库字段来源不变）
    if (result.thumbnailPath && !metadata.thumbnail_path) metadata.thumbnail_path = result.thumbnailPath
    return { text: result.text, anchors: result.anchors || [], metadata }
  }

  private async extractPDF(filePath: string, settings: Record<string, string>, perf?: PerfRecorder | null): Promise<{ text: string; anchors?: ChunkAnchor[]; metadata?: any }> {
    let text = ''
    const metadata: any = {}
    const anchors: ChunkAnchor[] = []
    try {
      const pdfjs = await importModule('pdfjs-dist/legacy/build/pdf.mjs')
      const data = measureSync(perf, 'read', () => new Uint8Array(fs.readFileSync(filePath)))
      const pdf = await measure(perf, 'pdf.open', () => pdfjs.getDocument({ data }).promise)
      metadata.pages = pdf.numPages
      perf?.setField('pages', pdf.numPages)
      await measure(perf, 'pdf.text', async () => {
        for (let i = 1; i <= pdf.numPages; i++) {
          const page = await pdf.getPage(i)
          const content = await page.getTextContent()
          // 单页文本先归一化换行，再计算偏移——否则 `\r\n` 被写成 `\n` 后锚点会整体前移
          const pageText = normalizeLineBreaks(content.items.map((item: any) => item.str).join(''))
          // 页码锚点：value 为 1 起的页码，start/end 为该页文本在返回 text 中的字符偏移
          const start = text.length
          text += pageText + '\n'
          anchors.push({ kind: 'page', value: i, start, end: text.length })
        }
      })
      const info: any = await measure(perf, 'pdf.meta', () => pdf.getMetadata())
      if (info?.info) {
        metadata.title = info.info.Title
        metadata.author = info.info.Author
        metadata.subject = info.info.Subject
        metadata.creator = info.info.Creator
      }
    } catch (e) {
      console.error('PDF extraction error:', e)
    }

    if (!text.trim() && settings.ocr_enabled === 'true') {
      const ocrText = await measure(perf, 'ocr', () => this.runOCR(filePath))
      text = ocrText || text
      metadata.ocr = true
      // OCR 回退产出的文本没有可靠的页边界，锚点作废（宁可不给，也不给错的页码）
      anchors.length = 0
    } else {
      perf?.skip('ocr')
    }
    return { text, anchors, metadata }
  }

  private async extractWord(filePath: string, perf?: PerfRecorder | null): Promise<{ text: string; anchors?: ChunkAnchor[]; metadata?: any }> {
    try {
      const mammoth = require('mammoth')
      const result = await measure(perf, 'docx.parse', () => mammoth.extractRawText({ path: filePath }))
      // doc/docx 无稳定页边界（分页由渲染器决定），按契约返回空锚点，不编造
      return { text: result.value || '', anchors: [] }
    } catch (e) {
      console.error('Word extraction error:', e)
      return { text: '', anchors: [] }
    }
  }

  private async extractExcel(filePath: string, perf?: PerfRecorder | null): Promise<{ text: string; anchors?: ChunkAnchor[]; metadata?: any }> {
    try {
      const ExcelJS = require('exceljs')
      const workbook = new ExcelJS.Workbook()
      await measure(perf, 'xlsx.parse', () => workbook.xlsx.readFile(filePath))
      let text = ''
      const sheets: string[] = []
      const anchors: ChunkAnchor[] = []
      measureSync(perf, 'xlsx.walk', () => {
        workbook.eachSheet((worksheet: any) => {
          sheets.push(worksheet.name)
          const start = text.length
          text += `## ${worksheet.name}\n`
          worksheet.eachRow((row: any) => {
            const values = row.values.filter((v: any) => v !== null && v !== undefined)
            // 单元格里可能带 \r\n：先归一化再累加，保证 start/end 是归一化后正文的偏移
            text += normalizeLineBreaks(values.join('\t')) + '\n'
          })
          // 工作表锚点（§5.6.3）：value 取 1 起的工作表序，名称与 metadata.sheets 同序对齐
          anchors.push({ kind: 'sheet', value: sheets.length, start, end: text.length })
        })
      })
      return { text, anchors, metadata: { sheets } }
    } catch (e) {
      console.error('Excel extraction error:', e)
      return { text: '', anchors: [] }
    }
  }

  private async extractText(filePath: string, perf?: PerfRecorder | null): Promise<{ text: string; anchors?: ChunkAnchor[]; metadata?: any }> {
    try {
      const content = measureSync(perf, 'read', () => fs.readFileSync(filePath, 'utf-8'))
      // 纯文本没有可比对的结构边界，锚点为空数组（ADR-005：给不出就不给）
      return { text: content, anchors: [] }
    } catch (e) {
      console.error('Text extraction error:', e)
      return { text: '', anchors: [] }
    }
  }

  private async extractImage(filePath: string, settings: Record<string, string>, perf?: PerfRecorder | null): Promise<{ text: string; anchors?: ChunkAnchor[]; metadata?: any }> {
    const metadata: any = {}
    let text = ''

    try {
      const exifr = require('exifr')
      const exif = await measure(perf, 'image.exif', () => exifr.parse(filePath, { gps: true, exif: true, ifd0: true }))
      if (exif) {
        metadata.exif = exif
        if (exif.Make || exif.Model) metadata.camera = `${exif.Make || ''} ${exif.Model || ''}`
        if (exif.latitude && exif.longitude) metadata.gps = { lat: exif.latitude, lng: exif.longitude }
        if (exif.DateTimeOriginal) metadata.dateTime = exif.DateTimeOriginal
      }
    } catch (e) { /* no exif */ }

    if (settings.ocr_enabled === 'true') {
      text = await measure(perf, 'ocr', () => this.runOCR(filePath)) || ''
      metadata.ocr = !!text
    } else {
      perf?.skip('ocr')
    }

    // 图片的缩略图即自身（与 file_path 同为绝对路径口径）
    metadata.thumbnail_path = filePath

    // 图片没有「页/章/时间」这类可比对锚点（EXIF 时间不等于内容锚点），按契约返回空数组
    return { text, anchors: [], metadata }
  }

  private async extractVideo(filePath: string, settings: Record<string, string>, perf?: PerfRecorder | null): Promise<{ text: string; anchors?: ChunkAnchor[]; metadata?: any }> {
    const metadata: any = { keyframes: [] }
    const anchors: ChunkAnchor[] = []
    let text = ''

    try {
      const ffmpeg = require('fluent-ffmpeg')
      const thumbnailDir = path.join(this.dataDir, 'thumbnails', path.basename(filePath, path.extname(filePath)))
      if (!fs.existsSync(thumbnailDir)) fs.mkdirSync(thumbnailDir, { recursive: true })

      const duration = await measure(perf, 'video.probe', () => new Promise<number>((resolve) => {
        ffmpeg.ffprobe(filePath, (err: any, data: any) => {
          if (err) return resolve(0)
          metadata.duration = data.format?.duration
          resolve(data.format?.duration || 0)
        })
      }))

      const intervals = Math.min(5, Math.max(1, Math.floor(duration / 30)))
      perf?.setField('frames', intervals)
      let thumbnailPath: string | null = null
      for (let i = 0; i < intervals; i++) {
        // 抽帧时间以 ffprobe 实测时长推算；screenshots 走 ffmpeg 输入 seek（帧精确），
        // 因此该时间戳即实际取到的那一帧所在时间点，可直接作为关键帧溯源锚点。
        const timestamp = Number(((duration / intervals) * (i + 0.5)).toFixed(3))
        const framePath = path.join(thumbnailDir, `frame_${i}.jpg`)
        await measure(perf, 'video.frame', () => new Promise<void>((resolve) => {
          ffmpeg(filePath)
            .screenshots({ timestamps: [timestamp], filename: `frame_${i}.jpg`, folder: thumbnailDir, size: '640x?' })
            .on('end', () => resolve())
            .on('error', () => resolve())
        }))
        if (!fs.existsSync(framePath)) continue
        if (!thumbnailPath) thumbnailPath = framePath // 优先第 1 帧作为文档缩略图
        let frameText = ''
        if (settings.ocr_enabled === 'true') {
          const ocrText = await measure(perf, 'ocr', () => this.runOCR(framePath))
          if (ocrText) {
            // OCR 文本先归一化换行，避免 \r\n 在写库时被改成 \n 而让后续偏移整体前移
            frameText = normalizeLineBreaks(ocrText)
            text += `[关键帧 ${i + 1}] ${frameText}\n`
          }
        }
        metadata.keyframes.push({ timestamp, text: frameText })
        // 关键帧时间锚点：`value`/`timeEnd` 是该帧时间点（秒），`start`/`end` 是它在正文中的字符区间
        // （块级溯源靠字符区间选块，时间戳落在 time_start_ms/time_end_ms）。未开 OCR 时无正文，
        // 区间为空（start==end），该锚点不会挂到任何块上——不猜。
        const anchorText = frameText ? `[关键帧 ${i + 1}] ${frameText}\n` : ''
        const anchorStart = anchorText ? text.length - anchorText.length : text.length
        anchors.push({
          kind: 'time', value: timestamp, timeEnd: timestamp,
          start: anchorStart, end: anchorStart + anchorText.length,
        })
      }
      if (thumbnailPath) metadata.thumbnail_path = thumbnailPath
    } catch (e) {
      console.error('Video extraction error:', e)
    }

    return { text, anchors, metadata }
  }

  private async extractAudio(filePath: string, _settings: Record<string, string>, perf?: PerfRecorder | null): Promise<{ text: string; anchors?: ChunkAnchor[]; metadata?: any }> {
    try {
      const { pipeline, env } = await importModule('@xenova/transformers')
      applyModelEnv(env)
      await applyOnnxThreadOptions()
      const transcriber = await measure(perf, 'audio.model', () => pipeline('automatic-speech-recognition', 'Xenova/whisper-tiny', { quantized: true }))
      const ffmpeg = require('fluent-ffmpeg')
      const audioData = await measure(perf, 'audio.decode', () => new Promise<Buffer>((resolve, reject) => {
        const chunks: Buffer[] = []
        const output = ffmpeg(filePath).audioFrequency(16000).audioChannels(1).format('f32le').on('error', reject).pipe()
        output.on('data', (chunk: Buffer) => chunks.push(chunk))
        output.on('error', reject)
        output.on('end', () => resolve(Buffer.concat(chunks)))
      }))
      // 请求词/段级时间戳（transformers.js ASR）：chunk_length_s/stride_length_s 让长音频分块推理并回带
      // 每段 [start, end]，作为后续「块级溯源」的锚点；content_text 仍保留纯文本供下游检索。
      const result = await measure(perf, 'audio.transcribe', () => transcriber(
        new Float32Array(Uint8Array.from(audioData).buffer),
        { return_timestamps: true, chunk_length_s: 30, stride_length_s: 5 }
      ))
      const chunks: any[] = Array.isArray(result?.chunks) ? result.chunks : []
      const segments = chunks
        .map((c: any) => ({
          start: Array.isArray(c?.timestamp) ? c.timestamp[0] : null,
          end: Array.isArray(c?.timestamp) ? c.timestamp[1] : null,
          text: String(c?.text ?? '').trim(),
        }))
        .filter((s: any) => s.text)
      const metadata: any = { model: 'whisper-tiny' }
      if (segments.length) metadata.transcript_segments = segments
      // 转写分段 → 时间锚点：`value`/`timeEnd` 是段的起止秒，`start`/`end` 是段文本在正文中的字符区间。
      // 段文本可能在整段转写里带空白差异，顺序定位（游标向前）找到才给区间，找不到就不给——
      // 宁可让该块没有出处，也不编一个对不上的时间。
      const text = String(result.text || '')
      let cursor = 0
      const anchors: ChunkAnchor[] = []
      for (const segment of segments) {
        if (segment.start == null) continue
        const segmentText = normalizeLineBreaks(segment.text)
        const found = segmentText ? text.indexOf(segmentText, cursor) : -1
        if (found >= 0) cursor = found + segmentText.length
        anchors.push({
          kind: 'time',
          value: segment.start,
          timeEnd: segment.end ?? segment.start,
          ...(found >= 0 ? { start: found, end: found + segmentText.length } : {}),
        })
      }
      return { text, anchors, metadata }
    } catch (e) {
      console.error('Audio extraction error:', e)
      return { text: '', anchors: [] }
    }
  }

  private async runOCR(imagePath: string): Promise<string> {
    try {
      const { createWorker } = require('tesseract.js')
      const worker = await createWorker('chi_sim+eng')
      const { data: { text } } = await worker.recognize(imagePath)
      await worker.terminate()
      return text || ''
    } catch (e) {
      console.error('OCR error:', e)
      return ''
    }
  }

  async generateEmbedding(docId: number, text: string, perf?: PerfRecorder | null): Promise<void> {
    if (!text || text.trim().length === 0) return
    const settings = await this.loadSettings()
    const modelName = settings.embedding_model || DEFAULT_EMBEDDING_ID
    // 模型从注册表取（而不是写死加载）：插件缺失/停用属配置问题，把可读原因直接抛给用户，
    // 因此这一步放在下面的统一兜底之外。
    const plugin = this.resolveEmbeddingPlugin(modelName)
    try {
      // 与改造前一致：把「加载模型」与「推理」的耗时分开记（插件通过 ensureReady 暴露加载）
      await measure(perf, 'embed.model', () => plugin.ensureReady ? plugin.ensureReady() : Promise.resolve())

      // 块与向量一一对应（D8）：优先用 `processDocument` 刚落库的 chunks，
      // 这样 vectors.chunk_id/chunk_index 与 chunk 的正文偏移严格同源。
      // 只有「正文为空、退化为摘要向量」这类文档没有块，此时按原逻辑重新分块，
      // 向量不带 chunk 关联（chunk_id 为 NULL），检索结果如实表示「暂无可定位出处」。
      const stored = readChunks(this.db, docId)
      const chunks = stored.length ? stored.map(c => c.content) : splitIntoTextChunks(text, settings.chunk_size, settings.chunk_overlap)
      const chunkRefs = stored.length
        ? stored.map(c => ({ id: c.id as number | null, index: c.chunk_index }))
        : chunks.map((_, index) => ({ id: null as number | null, index }))

      const batchSize = clampInt(settings.embed_batch_size, DEFAULT_EMBED_BATCH, 1, MAX_EMBED_BATCH)
      perf?.setField('chunks', chunks.length)
      perf?.setField('batch', this.batchEmbedSupported ? batchSize : 'off')
      if (!chunks.length) return

      const insertVector = this.db.prepare(`
        INSERT INTO vectors (document_id, chunk_id, chunk_index, embedding, model, dimension)
        VALUES (?, ?, ?, ?, ?, ?)
      `)
      let storedCount = 0

      for (let i = 0; i < chunks.length; i += batchSize) {
        const vectors = await this.embedBatch(plugin, chunks.slice(i, i + batchSize), perf)
        measureSync(perf, 'embed.store', () => {
          this.db.transaction(() => {
            vectors.forEach((vec, offset) => {
              const ref = chunkRefs[i + offset]
              insertVector.run(docId, ref?.id ?? null, ref?.index ?? null,
                Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength), modelName, vec.length)
              this.vectorIndex.addVector(modelName, docId, vec, ref?.id ?? null, ref?.index ?? null)
            })
          })
        })
        storedCount += vectors.length
      }
      perf?.setField('vectors', storedCount)
    } catch (e) {
      console.error('Embedding generation error:', e)
      throw new Error('文本已解析，但语义向量生成失败，请检查模型后重新解析')
    }
  }

  /**
   * 供 `chunks` 回填（P-a）复用：按当前嵌入模型批量推理，**只算不写**。
   *
   * 回填要先把 chunks 落库、再重嵌入、最后替换 vectors（「先建新、再删旧」），
   * 因此推理必须能与写库分开调用——这里只暴露推理那一半。
   */
  async embedTexts(texts: string[], perf?: PerfRecorder | null): Promise<{ model: string; vectors: Float32Array[] }> {
    const settings = await this.loadSettings()
    const modelName = settings.embedding_model || DEFAULT_EMBEDDING_ID
    const plugin = this.resolveEmbeddingPlugin(modelName)
    const batchSize = clampInt(settings.embed_batch_size, DEFAULT_EMBED_BATCH, 1, MAX_EMBED_BATCH)
    await measure(perf, 'embed.model', () => plugin.ensureReady ? plugin.ensureReady() : Promise.resolve())
    const vectors: Float32Array[] = []
    for (let i = 0; i < texts.length; i += batchSize) {
      vectors.push(...await this.embedBatch(plugin, texts.slice(i, i + batchSize), perf))
    }
    return { model: modelName, vectors }
  }

  /**
   * 一次 forward 处理整批文本。若模型/环境不支持批量输入（返回条数不匹配或抛错），
   * 则置 batchEmbedSupported=false 并永久回退逐条推理，避免每批重复试错。
   * 批量成功时 embed.infer 只累加一次耗时，因此日志中的 embed.infer×N 即为实际 forward 次数。
   *
   * 推理本身由嵌入插件负责（`plugin.embed`），宿主只保留「批量 vs 逐条」的决策与计时，与改造前一致。
   */
  private async embedBatch(plugin: EmbeddingPlugin, batch: string[], perf?: PerfRecorder | null): Promise<Float32Array[]> {
    if (this.batchEmbedSupported && batch.length > 1) {
      const started = Date.now()
      try {
        const vectors = await plugin.embed(batch)
        if (vectors.length === batch.length) {
          perf?.add('embed.infer', Date.now() - started)
          return vectors
        }
        console.warn(`批推理返回 ${vectors.length} 条，期望 ${batch.length} 条，回退逐条推理`)
      } catch (e: any) {
        console.warn('批推理不可用，回退逐条推理:', e?.message || e)
      }
      this.batchEmbedSupported = false
      perf?.setField('batch', 'off')
    }

    const vectors: Float32Array[] = []
    for (const chunk of batch) {
      vectors.push(await measure(perf, 'embed.infer', () => this.embedOne(plugin, chunk)))
    }
    return vectors
  }

  private async embedOne(plugin: EmbeddingPlugin, text: string): Promise<Float32Array> {
    const vectors = await plugin.embed([text])
    if (!vectors.length) throw new Error('模型输出的向量维度异常')
    return vectors[0]
  }

  /**
   * 文档标签差异写入：只写「新增关联」并删除「已失效关联」。
   *
   * 相比原先「关键词循环里反复 prepare + 无条件 INSERT OR IGNORE」，这里把三条语句
   * 预编译一次、整批放进单事务，并先读出当前关联做差集，避免重复写库与重新解析后
   * 残留旧标签。
   */
  private syncDocumentTags(docId: number, keywords: string[], perf?: PerfRecorder | null): void {
    const names = Array.from(new Set(keywords.map(k => String(k ?? '').trim()).filter(Boolean)))
    const wanted = new Set(names)

    const insertTag = this.db.prepare('INSERT OR IGNORE INTO tags (name) VALUES (?)')
    const selectTag = this.db.prepare('SELECT id FROM tags WHERE name = ?')
    const linkTag = this.db.prepare('INSERT OR IGNORE INTO document_tags (document_id, tag_id) VALUES (?, ?)')
    const unlinkTag = this.db.prepare('DELETE FROM document_tags WHERE document_id = ? AND tag_id = ?')
    const selectLinked = this.db.prepare(`
      SELECT t.id AS id, t.name AS name
      FROM document_tags dt JOIN tags t ON t.id = dt.tag_id
      WHERE dt.document_id = ?
    `)

    let created = 0
    let linked = 0
    let unlinked = 0

    this.db.transaction(() => {
      const existing = selectLinked.all(docId) as Array<{ id: number; name: string }>
      const linkedNames = new Set(existing.map(r => r.name))

      for (const name of names) {
        if (linkedNames.has(name)) continue
        if (insertTag.run(name).changes > 0) created++
        const tag = selectTag.get(name) as { id: number } | undefined
        if (!tag) continue
        linkTag.run(docId, tag.id)
        linked++
      }

      for (const row of existing) {
        if (wanted.has(row.name)) continue
        unlinkTag.run(docId, row.id)
        unlinked++
      }
    })

    perf?.setField('tags_new', created)
    perf?.setField('tags_linked', linked)
    perf?.setField('tags_unlinked', unlinked)
  }

  async generateQueryEmbedding(query: string): Promise<Float32Array | null> {
    try {
      const settings = await this.loadSettings()
      const modelName = settings.embedding_model || DEFAULT_EMBEDDING_ID
      // 与向量化走同一个注册表入口，避免「写入用 A 模型、检索用 B 模型」的错配
      const plugin = this.resolveEmbeddingPlugin(modelName)
      const vectors = await plugin.embed([query])
      if (!vectors.length) return null
      return vectors[0]
    } catch (e) {
      console.error('Query embedding error:', e)
      return null
    }
  }

  /**
   * 语义检索（ADR-002 起支持作用域）。
   *
   * 向量索引按 model 分片、只存 `document_id`，没有元数据，**无法在检索阶段按作用域预过滤**。
   * 因此采用「扩大候选窗口 → 命中后按 scope 过滤 → 不足则继续放大」的迭代策略，
   * 并如实返回 `complete`——窗口耗尽仍不满足时，结果可能不完整，由调用方向用户交代。
   */
  async semanticSearch(
    query: string,
    limit: number = 20,
    scope?: ScopeFilter
  ): Promise<{ items: any[]; examined: number; complete: boolean }> {
    const settings = await this.loadSettings()
    // 向量索引按 model 分片，这里的 modelName 必须与写入 vectors.model 的插件 id 完全一致
    const modelName = settings.embedding_model || DEFAULT_EMBEDDING_ID
    const perf = createPerfRecorder(this.dataDir, settings, 'search', { q: query.slice(0, 40), limit })
    try {
      const target = Math.max(1, Number(limit) || 20)
      const queryEmbedding = await measure(perf, 'query.embed', () => this.generateQueryEmbedding(query))
      if (!queryEmbedding) throw new Error('无法生成查询向量，请检查模型配置')

      const scoped = hasScope(scope)
      const { where, params: scopeParams } = scopeWhere(scope, 'd')

      // 限定范围时先按倍数放大候选窗口；未限定范围时一轮取够即可
      let fetch = scoped ? Math.min(target * 10, 1000) : target
      let items: any[] = []
      let examined = 0
      let complete = false

      for (let round = 0; round < 4; round++) {
        const hits = measureSync(perf, 'vector.search', () => this.vectorIndex.search(modelName, queryEmbedding, fetch))
        if (!hits.length) { examined = 0; complete = true; break }
        examined = hits.length

        const placeholders = hits.map(() => '?').join(',')
        const docs = measureSync(perf, 'db.hydrate', () => this.db.prepare(`
          SELECT d.id, d.title, d.file_name, d.file_type, d.file_size, d.storage_type, d.summary,
                 substr(d.content_text, 1, 200) as excerpt
          FROM documents d
          WHERE d.is_available = 1 AND d.id IN (${placeholders})
            ${where ? `AND ${where}` : ''}
        `).all(...hits.map(h => h.document_id), ...scopeParams) as any[])
        const byId = new Map(docs.map(d => [d.id, d]))
        // 命中块：索引已按「同文档保留最高分 chunk」去重，这里把块正文与锚点补齐
        const chunkById = this.chunksById(hits.map(h => h.chunk_id))

        items = hits
          .map(h => {
            const d = byId.get(h.document_id)
            if (!d) return null
            const chunk = h.chunk_id != null ? chunkById.get(h.chunk_id) : undefined
            return {
              ...d,
              document_id: h.document_id,
              score: h.score,
              // 只增字段：块级出处（D8）。回填未完成的旧向量 chunk_id 为 NULL，此时 matched_chunk/anchor 为 null，
              // 前端必须显示「暂无可定位出处」而不是伪造页码。
              chunk_id: h.chunk_id ?? null,
              chunk_index: chunk ? chunk.chunk_index : null,
              matched_chunk: chunk ? { id: chunk.id, chunk_index: chunk.chunk_index, content: chunk.content } : null,
              anchor: anchorOf(chunk),
            }
          })
          .filter(Boolean) as any[]

        // 索引返回的条数少于请求量 ⇒ 该分片已经见底，这就是全部候选
        if (hits.length < fetch) { complete = true; break }
        if (items.length >= target) break
        if (round === 3) break
        fetch = Math.min(fetch * 5, 2000)
      }

      perf?.setField('hits', items.length)
      perf?.finish()
      return { items: items.slice(0, target), examined, complete }
    } catch (e: any) {
      perf?.finish(e?.message || String(e))
      throw e
    }
  }

  /**
   * 按 chunk id 取块（检索结果补出处用）。id 里的 None 直接忽略——
   * 回填未完成的文档其向量 chunk_id 为 NULL，此时结果不带出处，属如实降级。
   */
  private chunksById(ids: Array<number | null | undefined>): Map<number, StoredChunk> {
    const wanted = Array.from(new Set(ids.filter((id): id is number => typeof id === 'number' && Number.isInteger(id))))
    const out = new Map<number, StoredChunk>()
    if (!wanted.length) return out
    const rows = this.db.prepare(`
      SELECT id, document_id, chunk_index, content, char_start, char_end,
             anchor_kind, anchor_index, time_start_ms, time_end_ms, bbox,
             token_count, chunk_size, chunk_overlap
      FROM chunks WHERE id IN (${wanted.map(() => '?').join(',')})
    `).all(...wanted) as StoredChunk[]
    for (const row of rows) out.set(row.id, row)
    return out
  }

  /**
   * 查询文本里的实体（规则层，与解析时的 `extractEntities` 同一实现）。
   *
   * 供混合检索的「实体重合度」规则重排使用（§5.3.3 的 δ 项）；这里只暴露一个
   * 只读包装，避免把检索层写成 `processingEngine` 的私有实现副本。
   */
  extractQueryEntities(query: string): Array<{ name: string; type: string }> {
    try {
      const entities = this.extractEntities(query)
      const seen = new Set(entities.map(e => `${e.type}|${e.name}`))
      // 查询里的概念词同样要能映射到 concept 实体，否则社区亲和度恒为 0
      for (const extra of this.keywordEntities(this.extractKeywords(query), query, 1)) {
        const key = `${extra.type}|${extra.name}`
        if (seen.has(key)) continue
        entities.push(extra)
        seen.add(key)
      }
      return entities.map(e => ({ name: e.name, type: e.type }))
    } catch {
      return []
    }
  }

  private generateSummary(text: string): string {
    if (!text) return ''
    const sentences = text.split(/[。！？\.\!\?\n]+/).filter((s: string) => s.trim().length > 10)
    if (sentences.length === 0) return text.substring(0, 300)

    const wordFreq: Record<string, number> = {}
    sentences.forEach((s: string) => {
      const words = s.split(/\s+/)
      words.forEach((w: string) => {
        if (w.length > 2) wordFreq[w] = (wordFreq[w] || 0) + 1
      })
    })

    const scored = sentences.map((s: string) => {
      const words = s.split(/\s+/)
      let score = 0
      words.forEach((w: string) => {
        if (wordFreq[w]) score += wordFreq[w]
      })
      return { sentence: s, score: score / Math.max(words.length, 1) }
    })

    return scored.sort((a, b) => b.score - a.score).slice(0, 3).map(s => s.sentence).join(' ').substring(0, 300)
  }

  private extractEntities(text: string): Array<{ name: string; type: string; description?: string; relation?: string }> {
    if (!text) return []
    const entities: Array<{ name: string; type: string; description?: string; relation?: string }> = []

    try {
      const nlp = require('compromise')
      const doc = nlp(text)

      doc.people().forEach((p: any) => {
        const name = p.text().trim()
        if (name.length > 1 && name.length < 20) {
          entities.push({ name, type: 'person', relation: 'MENTIONS_PERSON' })
        }
      })

      doc.places().forEach((p: any) => {
        const name = p.text().trim()
        if (name.length > 1 && name.length < 30) {
          entities.push({ name, type: 'location', relation: 'MENTIONS_PLACE' })
        }
      })

      doc.organizations().forEach((o: any) => {
        const name = o.text().trim()
        if (name.length > 1 && name.length < 40) {
          entities.push({ name, type: 'organization', relation: 'MENTIONS_ORG' })
        }
      })
    } catch (e) {
      console.error('NLP entity extraction error:', e)
    }

    const datePattern = /\b(20\d{2}[-\/年]\d{1,2}[-\/月]\d{1,2})\b/g
    let match
    while ((match = datePattern.exec(text)) !== null) {
      entities.push({ name: match[1], type: 'date', relation: 'MENTIONS_DATE' })
    }

    const emailPattern = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g
    while ((match = emailPattern.exec(text)) !== null) {
      entities.push({ name: match[0], type: 'email', relation: 'MENTIONS_EMAIL' })
    }

    const urlPattern = /https?:\/\/[^\s<>"']+/g
    while ((match = urlPattern.exec(text)) !== null) {
      entities.push({ name: match[0].substring(0, 60), type: 'url', relation: 'MENTIONS_URL' })
    }

    try {
      const jieba = require('nodejieba')
      const words = jieba.tag(text)
      const nerTypes: Record<string, string> = {
        'nr': 'person',
        'ns': 'location',
        'nt': 'organization',
      }
      for (const w of words) {
        if (nerTypes[w.tag] && w.word.length > 1 && w.word.length < 20) {
          entities.push({ name: w.word, type: nerTypes[w.tag], relation: 'CONTAINS' })
        }
      }
    } catch (e) {
      console.error('Jieba NER error:', e)
    }

    const unique = entities.filter((e, i, self) =>
      i === self.findIndex(e2 => e2.name === e.name && e2.type === e.type)
    )
    return unique.slice(0, 50)
  }

  /**
   * 深度 NER：transformers.js token-classification 模型（默认 Xenova/bert-base-NER），
   * 输入截断至 4000 字符控制推理时长；失败时调用方回退规则抽取。
   */
  private async extractEntitiesDeep(text: string, settings: Record<string, string>): Promise<Array<{ name: string; type: string; description?: string; relation?: string }>> {
    const modelName = settings.ner_model || 'Xenova/bert-base-NER'
    const pipe = await getNerPipeline(modelName)
    const capped = text.slice(0, 4000)
    const output = await pipe(capped, { aggregation_strategy: 'simple' }) as any[]
    const typeMap: Record<string, { type: string; relation: string }> = {
      PER: { type: 'person', relation: 'MENTIONS_PERSON' },
      PERSON: { type: 'person', relation: 'MENTIONS_PERSON' },
      ORG: { type: 'organization', relation: 'MENTIONS_ORG' },
      GPE: { type: 'location', relation: 'MENTIONS_PLACE' },
      LOC: { type: 'location', relation: 'MENTIONS_PLACE' },
      MISC: { type: 'concept', relation: 'CONTAINS' },
    }
    const results: Array<{ name: string; type: string; description?: string; relation?: string }> = []
    const seen = new Set<string>()
    for (const ent of output || []) {
      const name = String(ent.word || '').replace(/\s+/g, '').trim()
      if (name.length < 2 || name.length > 40) continue
      const mapped = typeMap[String(ent.entity_group || '').toUpperCase()] || { type: 'concept', relation: 'CONTAINS' }
      const key = `${mapped.type}|${name}`
      if (seen.has(key)) continue
      seen.add(key)
      results.push({ name, type: mapped.type, relation: mapped.relation, description: '深度NER识别' })
    }
    return results.slice(0, 50)
  }

  /**
   * 把关键词转成 concept 实体（ADR-007 的前置条件）。
   *
   * 门槛刻意收紧：长度 2~20、非纯数字/日期、非停用词、在正文里至少出现 `minOccurrences` 次。
   * 单次出现的 jieba 关键词大多是「偶然提及」，都做成实体会把图谱稀释成关键词云。
   * 查询侧传 1：查询词天然只出现一次，不放宽就永远映射不到概念实体。
   */
  private keywordEntities(
    keywords: string[],
    text: string,
    minOccurrences: number = 2,
  ): Array<{ name: string; type: string; relation: string; description?: string }> {
    const result: Array<{ name: string; type: string; relation: string; description?: string }> = []
    const lowered = text.toLowerCase()
    const blocked = (term: string) =>
      KEYWORD_STOPWORDS.has(term.toLowerCase()) || PREDICATE_TRIGGERS.has(term.toLowerCase())
    const seen = new Set<string>()

    // 1) 复合词先行（中心词判定，见 compoundTerms）：分词把「向量索引」切成「向量 + 索引」，
    //    合并后长名优先的实体定位会让整体压过碎片，语义边的端点才不会落在修饰语上。
    for (const compound of buildCompoundTerms(keywords, text, { minOccurrences, isBlocked: blocked })) {
      if (seen.has(compound.name)) continue
      seen.add(compound.name)
      result.push({
        name: compound.name,
        type: 'concept',
        relation: 'MENTIONS_KEYWORD',
        description: `复合词（中心词：${compound.head}）`,
      })
    }

    // 2) 原有单词关键词
    for (const raw of keywords) {
      const name = String(raw || '').trim()
      if (name.length < 2 || name.length > 20) continue
      if (/^[\d\s.\-/:年月日]+$/.test(name)) continue
      if (KEYWORD_STOPWORDS.has(name.toLowerCase())) continue
      // 动词不是实体：谓词触发词一旦被实体化，`A 依赖 B` 里的「依赖」会把两侧切成空白，
      // 抽取阶段反而看不到谓词（真实语料里这是首要的漏抽原因）
      if (PREDICATE_TRIGGERS.has(name.toLowerCase())) continue
      if (lowered.split(name.toLowerCase()).length - 1 < minOccurrences) continue
      if (seen.has(name)) continue
      seen.add(name)
      result.push({ name, type: 'concept', relation: 'MENTIONS_KEYWORD' })
    }
    return result.slice(0, 18)
  }

  private extractKeywords(text: string): string[] {
    if (!text) return []
    try {
      const jieba = require('nodejieba')
      const words = jieba.extract(text, 15)
      return words.map((w: any) => w.word).filter((w: string) => w.length > 1)
    } catch {
      const words = text.toLowerCase().match(/[\u4e00-\u9fa5]{2,}|[a-z]{3,}/g) || []
      const freq: Record<string, number> = {}
      words.forEach((w: string) => { freq[w] = (freq[w] || 0) + 1 })
      return Object.entries(freq)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 15)
        .map(([word]) => word)
    }
  }

  async processAll(): Promise<void> {
    // 排除已 ready 的空文本文档：图片/视频在无 OCR 文字时也会以空文本落成 ready，
    // 若不加过滤，每次启动都会被当成「待解析」反复重跑。
    const docs = this.db.prepare(`
      SELECT id FROM documents
      WHERE (content_text IS NULL OR content_text = '') AND is_available = 1 AND processing_status <> 'ready'
    `).all() as any[]

    for (const doc of docs) {
      await this.processDocument(doc.id)
    }
  }
}
