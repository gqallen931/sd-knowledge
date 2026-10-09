/**
 * 存量 `chunks` 回填（D8 / 架构文档 §3.3.3 的 **P-a 确定性重建**）。
 *
 * 为什么不在迁移里做：回填要「重建分块 + 重新推理向量」，是分钟级以上的活，
 * 放进迁移会让启动直接卡死。这里以「分批 + 每批提交 + 让出事件循环」的后台任务实现。
 *
 * 幂等键 = 「该 document_id 是否已有 chunks 行」：
 *   - 扫描本身用 `NOT EXISTS (SELECT 1 FROM chunks ...)` 过滤，中断后重跑天然幂等；
 *   - 全部完成后写 `settings.chunks_backfill_done='true'`，之后启动不再做全表 EXISTS 扫描。
 *
 * 写入顺序（§5.6.1）与失败回滚：
 *   事务 A 重建 chunks（拿到 chunk id）→ 事务外重新推理 → 事务 B 删旧向量并插入带 chunk_id 的新向量。
 *   推理失败时**旧向量原样保留**（其 chunk_id 为 NULL），文档仍可语义检索，只是暂时给不出出处——
 *   「先建新、再删旧」的顺序保证不会出现「向量没了、新的还没来」。
 *
 * P-b（按插入序启发式对齐）**不实现**：它依赖 `vectors.id` 的写入顺序，一旦历史库经历过
 * 重解析/复用就会错位，且错位无法被检测。宁可留 NULL（前端显示「暂无可定位出处」），也不指错。
 */
import DatabaseService from './database'
import { PerfRecorder, createPerfRecorder } from './perfLogger'
import { buildChunkRows, normalizeLineBreaks, readChunks, writeChunks } from './chunks'

/** 回填所需的推理/索引能力（由 `ProcessingEngine` 提供，避免回填服务反向依赖整个引擎） */
export interface ChunkEmbedder {
  embedTexts(texts: string[], perf?: PerfRecorder | null): Promise<{ model: string; vectors: Float32Array[] }>
  removeFromIndex(documentId: number): void
  addVectorToIndex(model: string, documentId: number, vector: Float32Array, chunkId: number | null, chunkIndex: number | null): void
}

export interface BackfillReport {
  /** 本轮扫描到的「有正文但还没有块」的文档数 */
  scanned: number
  /** 成功重建块并关联向量的文档数 */
  rebuilt: number
  /** 重新推理向量成功、完成块↔向量关联的文档数 */
  reembedded: number
  /** 重建了块但向量没能关联（推理不可用/失败，或语义检索未开启）的文档数 */
  vectorsPending: number
  /** 因没有正文而跳过的文档数（迁移不会为它们造块） */
  skippedNoText: number
  /** 单文档失败数（该文档保留旧向量，下一轮会重试） */
  failed: number
  /** 是否已全部完成（写入了 chunks_backfill_done） */
  done: boolean
}

const DEFAULT_BATCH = 200
/** 单次调用的批数上限：最多 1 万篇/次，避免后台任务在超大库上长时间占着事件循环 */
const DEFAULT_MAX_BATCHES = 50

export class ChunkBackfillService {
  constructor(
    private db: DatabaseService,
    private engine: ChunkEmbedder,
    private dataDir: string,
  ) {}

  /** 待回填的文档 id（有正文、已就绪、还没有块） */
  private pendingIds(limit: number): number[] {
    return (this.db.prepare(`
      SELECT d.id FROM documents d
      WHERE d.is_available = 1
        AND COALESCE(d.processing_status, 'ready') = 'ready'
        AND length(COALESCE(d.content_text, '')) > 0
        AND NOT EXISTS (SELECT 1 FROM chunks c WHERE c.document_id = d.id)
      ORDER BY d.id
      LIMIT ?
    `).all(limit) as any[]).map(row => Number(row.id))
  }

  /** 没有正文（或未就绪）而永远不会有块的文档数——如实记账，不把它们算作「回填失败」 */
  private noTextCount(): number {
    const row = this.db.prepare(`
      SELECT COUNT(*) AS n FROM documents d
      WHERE d.is_available = 1
        AND (length(COALESCE(d.content_text, '')) = 0 OR COALESCE(d.processing_status, 'ready') <> 'ready')
    `).get() as any
    return Number(row?.n || 0)
  }

  /**
   * 执行回填（一次调用内按批推进，直到没有待回填文档或触到批次上限）。
   *
   * @param options.force 忽略 `chunks_backfill_done` 强制重扫（用于「回填后偏移错乱」的人工重跑）
   * @param options.limit 每批处理的文档数（默认 200）
   * @param options.maxBatches 单次调用的批数上限（默认 50 ⇒ 最多 1 万篇；防止后台任务无限占着事件循环）
   */
  async run(options: { force?: boolean; limit?: number; maxBatches?: number } = {}): Promise<BackfillReport> {
    const report: BackfillReport = {
      scanned: 0, rebuilt: 0, reembedded: 0, vectorsPending: 0,
      skippedNoText: 0, failed: 0, done: false,
    }
    // 后台任务可能在库已关闭之后才被触发（例如应用退出、测试提前 close）：安静退出，不抛错
    if (typeof this.db.isOpen === 'function' && !this.db.isOpen()) {
      report.done = true
      return report
    }
    const settings = this.db.getSettingsSync()
    if (!options.force && settings.chunks_backfill_done === 'true') {
      report.done = true
      return report
    }
    report.skippedNoText = this.noTextCount()

    const batch = Math.max(1, Math.min(2000, Number(options.limit) || DEFAULT_BATCH))
    const maxBatches = Math.max(1, Number(options.maxBatches) || DEFAULT_MAX_BATCHES)
    const vectorEnabled = settings.vector_enabled === 'true'

    for (let round = 0; round < maxBatches; round++) {
      const ids = this.pendingIds(batch)
      if (!ids.length) break
      report.scanned += ids.length
      for (const id of ids) {
        try {
          const rebuilt = await this.rebuildOne(id, vectorEnabled, settings)
          report.rebuilt++
          if (rebuilt) report.reembedded++
          else if (vectorEnabled) report.vectorsPending++
          this.db.updateSettings({ backfill_chunks_progress: String(id) })
        } catch (e: any) {
          // 单文档失败不影响其它文档；不标记完成，下一轮扫描会重新尝试
          report.failed++
          console.error(`[chunk-backfill] 文档 #${id} 回填失败：`, e?.message || e)
        }
        // 让出事件循环：回填是后台任务，不能让主进程的 IPC/解析队列长时间等不到时间片
        await new Promise(resolve => setTimeout(resolve, 0))
        if (!this.db.isOpen()) { report.done = true; return report }
      }
      // 这一批没取满 ⇒ 已经没有更多待回填文档
      if (ids.length < batch) break
    }
    // 收尾：没有失败且确实扫不出待回填文档时，写 done 标记，之后启动不再做全表 EXISTS 扫描。
    // 有失败时保持 false —— 下一次启动会重试那些文档。
    if (!report.failed && !this.pendingIds(1).length) {
      this.db.updateSettings({ chunks_backfill_done: 'true' })
      report.done = true
    }
    return report
  }

  /**
   * 单文档重建：事务 A 写块 → 事务外推理 → 事务 B 换向量。返回是否完成了向量关联。
   */
  private async rebuildOne(documentId: number, vectorEnabled: boolean, settings: Record<string, string>): Promise<boolean> {
    const doc = this.db.prepare('SELECT id, content_text, metadata FROM documents WHERE id = ?').get(documentId) as any
    if (!doc || !String(doc.content_text || '').length) return false

    // 锚点取自解析时落库的 metadata.anchors（P-a 的「尽可能用现有 metadata/锚点信息对齐」）：
    // 拿不到就按无锚点重建，块与偏移仍然正确，只是没有页码/时间。
    let anchors: any[] = []
    try {
      const metadata = doc.metadata ? JSON.parse(String(doc.metadata)) : null
      if (Array.isArray(metadata?.anchors)) anchors = metadata.anchors
    } catch { /* metadata 非法按无锚点处理 */ }

    const perf = createPerfRecorder(this.dataDir, settings, 'backfill', { doc: `#${documentId}` })
    try {
      // 存量库的 content_text 可能是改造前原样写入的（含 \r\n）。块的偏移必须相对**归一化后**的正文，
      // 因此这里把正文一并对齐成归一化形式；不改这一步，偏移就会整体错位（架构文档 §5.6.3 锁死的细节）。
      const text = normalizeLineBreaks(doc.content_text)
      // 事务 A：重建块（与解析路径共用 buildChunkRows/writeChunks，保证 P-a 与解析结果逐字一致）
      this.db.transaction(() => {
        if (text !== doc.content_text) {
          this.db.prepare('UPDATE documents SET content_text = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(text, documentId)
        }
        writeChunks(this.db, documentId, buildChunkRows(text, anchors, settings.chunk_size, settings.chunk_overlap))
      })
      const chunks = readChunks(this.db, documentId)
      if (!chunks.length) return false
      if (!vectorEnabled) return false

      // 推理放在事务外（长任务不占写锁）
      const { model, vectors } = await this.engine.embedTexts(chunks.map(c => c.content), perf)

      // 事务 B：先删「没有块关联」的旧向量，再插入新向量（此时才动旧数据）
      this.db.transaction(() => {
        this.db.prepare('DELETE FROM vectors WHERE document_id = ? AND chunk_id IS NULL').run(documentId)
        const insert = this.db.prepare(`
          INSERT INTO vectors (document_id, chunk_id, chunk_index, embedding, model, dimension)
          VALUES (?, ?, ?, ?, ?, ?)
        `)
        chunks.forEach((chunk, index) => {
          const vector = vectors[index]
          if (!vector) return
          insert.run(documentId, chunk.id, chunk.chunk_index,
            Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength), model, vector.length)
        })
      })
      // 索引同步：先摘旧行（tombstone），再按块逐条加回
      this.engine.removeFromIndex(documentId)
      chunks.forEach((chunk, index) => {
        const vector = vectors[index]
        if (vector) this.engine.addVectorToIndex(model, documentId, vector, chunk.id, chunk.chunk_index)
      })
      perf?.finish()
      return true
    } catch (e: any) {
      perf?.finish(e?.message || String(e))
      throw e
    }
  }
}
