/**
 * 块级溯源（D8）：分块偏移、锚点归一与 `chunks` 表读写。
 *
 * 三件事集中在这里，避免「解析路径、回填路径、检索路径」各写一份分块逻辑而慢慢跑偏：
 *   1. `splitTextChunksWithSpans`：与 `splitIntoTextChunks` **同一段代码**产出块文本，
 *      额外带回每块在正文中的 [char_start, char_end) —— 回填（P-a）与解析必须逐字一致；
 *   2. 锚点归一：把解析器插件返回的 `ChunkAnchor[]` 映射到块上（§5.6.3 的格式锚点表），
 *      给不出锚点的格式保持 NULL，**不编造**；
 *   3. `chunks` 表的写入/读取（写入必须在调用方的事务内，与 vectors 同批）。
 *
 * 偏移口径（必须锁死）：`char_start/char_end` 相对**归一化后**的 `documents.content_text`
 * （`\r\n → \n`）。写入 `content_text` 时同样归一化，否则偏移会错位。
 */
import type { ChunkAnchor, ChunkAnchorKind } from './plugins/types'
import { clampInt } from './plugins/builtin/transformersEnv'

/** 默认分块参数（设置项缺省时使用），与 `processingEngine` 同名常量同值 */
export const DEFAULT_CHUNK_SIZE = 512
export const DEFAULT_CHUNK_OVERLAP = 50

/** 与 `searchService.getContext` 一致的粗估口径：ceil(chars / 2) */
export function estimateTokens(text: string): number {
  return Math.ceil(String(text || '').length / 2)
}

/** 统一换行：偏移与分块都基于归一化后的文本 */
export function normalizeLineBreaks(text: unknown): string {
  return String(text ?? '').replace(/\r\n/g, '\n')
}

export interface TextChunkSpan {
  /** 文档内块序号，从 0 起（与 `vectors.chunk_index` 一致） */
  chunk_index: number
  content: string
  char_start: number
  char_end: number
}

/** 句子/段落终止符：用于把窗口边界吸附到语义断点（与改造前逐字一致） */
const CHUNK_BOUNDARY = /[。！？；!?;\n]/

/**
 * 带偏移的分块。算法与改造前的 `splitIntoTextChunks` 逐行一致
 * （窗口吸附右界、next start = end - overlap），只是把每块的起止偏移一并返回。
 */
export function splitTextChunksWithSpans(text: string, size?: unknown, overlap?: unknown): TextChunkSpan[] {
  const clean = normalizeLineBreaks(text)
  if (!clean.trim()) return []

  const chunkSize = clampInt(size, DEFAULT_CHUNK_SIZE, 64, 8000)
  const chunkOverlap = clampInt(overlap, DEFAULT_CHUNK_OVERLAP, 0, Math.floor(chunkSize / 2))
  if (clean.length <= chunkSize) {
    return [{ chunk_index: 0, content: clean, char_start: 0, char_end: clean.length }]
  }

  const spans: TextChunkSpan[] = []
  let start = 0
  while (start < clean.length) {
    let end = Math.min(clean.length, start + chunkSize)
    if (end < clean.length) {
      const limit = Math.min(clean.length, end + Math.floor(chunkSize / 4))
      for (let i = end; i < limit; i++) {
        if (CHUNK_BOUNDARY.test(clean[i])) { end = i + 1; break }
      }
    }
    const piece = clean.slice(start, end)
    // 纯空白块的偏移区间仍然推进（不丢区间），只是不单独成块——与改造前「空白块不入库」一致
    if (piece.trim()) {
      spans.push({ chunk_index: spans.length, content: piece, char_start: start, char_end: end })
    }
    if (end >= clean.length) break
    const next = end - chunkOverlap
    start = next > start ? next : start + 1
  }
  return spans
}

/** 锚点归一后的中间形态：char 区间用于选块，time 区间用于落库 */
export interface AnchorSpan {
  kind: ChunkAnchorKind
  /** 锚点值：页码 / 幻灯片序 / 章节序 / 工作表序（1 起）；时间锚点为起始秒 */
  index: number | null
  charStart: number | null
  charEnd: number | null
  timeStartMs: number | null
  timeEndMs: number | null
}

/** 7 种格式锚点表里「有字符区间」的四类：按字符区间落到块上 */
const CHAR_RANGE_KINDS: readonly ChunkAnchorKind[] = ['page', 'slide', 'chapter', 'sheet']

function toAnchorIndex(kind: ChunkAnchorKind, value: number | string): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    // 时间锚点的 value 是秒（可带小数）：索引取整秒（毫秒级精度落在 time_start_ms/time_end_ms）
    return kind === 'time' ? Math.round(value) : Math.round(value)
  }
  const n = Number(value)
  return Number.isFinite(n) ? Math.round(n) : null
}

/**
 * 把解析器给的锚点归一成可映射的区间。
 *
 * 规则（不做猜测）：
 * - `page/slide/chapter/sheet`：`start/end` 必须是落在正文内的合法字符区间，否则该锚点丢弃；
 * - `time`：`start/end` 是字符区间时按块映射，时间取 `value`（起）/`timeEnd`（止）秒 → 毫秒；
 *   给不出字符区间的时间锚点（如未对齐的转写段）保留时间但**不参与选块**。
 */
export function normalizeAnchors(anchors: ChunkAnchor[] | undefined, textLength: number): AnchorSpan[] {
  if (!Array.isArray(anchors) || !anchors.length) return []
  const out: AnchorSpan[] = []
  for (const anchor of anchors) {
    const kind = anchor?.kind
    if (!kind) continue
    const hasRange =
      typeof anchor.start === 'number' && typeof anchor.end === 'number' &&
      Number.isFinite(anchor.start) && Number.isFinite(anchor.end) &&
      anchor.start >= 0 && anchor.end > anchor.start && anchor.end <= textLength
    const isCharKind = CHAR_RANGE_KINDS.includes(kind)
    if (isCharKind && !hasRange) continue
    const index = toAnchorIndex(kind, anchor.value)
    const timeStartMs = kind === 'time'
      ? (typeof anchor.value === 'number' && Number.isFinite(anchor.value) ? Math.round(anchor.value * 1000) : null)
      : null
    const timeEndMs = kind === 'time'
      ? (() => {
        const endSeconds = typeof anchor.timeEnd === 'number' && Number.isFinite(anchor.timeEnd)
          ? anchor.timeEnd
          : (typeof anchor.value === 'number' && Number.isFinite(anchor.value) ? anchor.value : null)
        return endSeconds == null ? null : Math.round(endSeconds * 1000)
      })()
      : null
    out.push({
      kind,
      index,
      charStart: hasRange ? (anchor.start as number) : null,
      charEnd: hasRange ? (anchor.end as number) : null,
      timeStartMs,
      timeEndMs,
    })
  }
  return out
}

/** 落在该块上的锚点：优先「包含块起点」，否则取与块区间重叠最大的那个；无重叠则不给锚点 */
function pickAnchor(anchors: AnchorSpan[], chunk: TextChunkSpan): AnchorSpan | null {
  let containing: AnchorSpan | null = null
  let best: AnchorSpan | null = null
  let bestOverlap = 0
  for (const anchor of anchors) {
    if (anchor.charStart == null || anchor.charEnd == null) continue
    if (anchor.charStart <= chunk.char_start && anchor.charEnd >= chunk.char_end) {
      // 多个区间包含该块时取最紧的一个
      if (!containing || (anchor.charEnd - anchor.charStart) < (containing.charEnd! - containing.charStart!)) {
        containing = anchor
      }
      continue
    }
    const overlap = Math.min(anchor.charEnd, chunk.char_end) - Math.max(anchor.charStart, chunk.char_start)
    if (overlap > bestOverlap) { bestOverlap = overlap; best = anchor }
  }
  return containing || best
}

/** 一条待写入的 `chunks` 记录 */
export interface ChunkRow extends TextChunkSpan {
  anchor_kind: ChunkAnchorKind | null
  anchor_index: number | null
  time_start_ms: number | null
  time_end_ms: number | null
  bbox: string | null
  token_count: number
  /** 生成参数快照（可空：回填期允许留空，用当前设置重建） */
  chunk_size: number | null
  chunk_overlap: number | null
}

/**
 * 由正文 + 锚点构造 `chunks` 行（解析路径与回填路径共用同一个函数，
 * 这就是「P-a 确定性重建」能成立的前提）。
 */
export function buildChunkRows(
  text: string,
  anchors: ChunkAnchor[] | undefined,
  chunkSize?: unknown,
  chunkOverlap?: unknown,
): ChunkRow[] {
  const clean = normalizeLineBreaks(text)
  const spans = splitTextChunksWithSpans(clean, chunkSize, chunkOverlap)
  const size = clampInt(chunkSize, DEFAULT_CHUNK_SIZE, 64, 8000)
  const overlap = clampInt(chunkOverlap, DEFAULT_CHUNK_OVERLAP, 0, Math.floor(size / 2))
  const normalized = normalizeAnchors(anchors, clean.length)
  return spans.map((span) => {
    const anchor = normalized.length ? pickAnchor(normalized, span) : null
    return {
      ...span,
      anchor_kind: anchor ? anchor.kind : null,
      anchor_index: anchor ? anchor.index : null,
      time_start_ms: anchor ? anchor.timeStartMs : null,
      time_end_ms: anchor ? anchor.timeEndMs : null,
      bbox: null,
      token_count: estimateTokens(span.content),
      chunk_size: size,
      chunk_overlap: overlap,
    }
  })
}

/** 写入型数据库接口（只用到这几条；`prepare` 放开为 any 以免与 better-sqlite3 的泛型签名较劲） */
export interface ChunkWriteDb {
  prepare: (sql: string) => any
  exec: (sql: string) => unknown
}

/**
 * 重建某文档的 `chunks`：先删后插（幂等）。
 *
 * **必须在调用方的事务内执行**：与 `documents.content_text`、`vectors` 的写入同批，
 * 避免出现「正文已更新但块还是旧的」这种半截状态。
 * 返回按 chunk_index 升序的 chunk id，供 vectors 关联。
 */
export function writeChunks(db: ChunkWriteDb, documentId: number, rows: ChunkRow[]): number[] {
  db.prepare('DELETE FROM chunks WHERE document_id = ?').run(documentId)
  const insert = db.prepare(`
    INSERT INTO chunks (document_id, chunk_index, content, char_start, char_end,
                        anchor_kind, anchor_index, time_start_ms, time_end_ms, bbox,
                        token_count, chunk_size, chunk_overlap)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  const ids: number[] = []
  for (const row of rows) {
    const info = insert.run(
      documentId, row.chunk_index, row.content, row.char_start, row.char_end,
      row.anchor_kind, row.anchor_index, row.time_start_ms, row.time_end_ms, row.bbox,
      row.token_count, row.chunk_size, row.chunk_overlap,
    )
    ids.push(Number(info.lastInsertRowid))
  }
  return ids
}

/** 读取某文档的块（按 chunk_index 升序）；chunk_id 一并带回，供检索引用 */
export interface StoredChunk extends ChunkRow {
  id: number
  document_id: number
}

export function readChunks(db: { prepare: (sql: string) => any }, documentId: number): StoredChunk[] {
  return db.prepare(`
    SELECT id, document_id, chunk_index, content, char_start, char_end,
           anchor_kind, anchor_index, time_start_ms, time_end_ms, bbox,
           token_count, chunk_size, chunk_overlap
    FROM chunks WHERE document_id = ? ORDER BY chunk_index
  `).all(documentId) as StoredChunk[]
}

/** 检索结果里的可定位出处（`items[].anchor`）；块本身没有锚点时返回 null，前端据此显示「暂无可定位出处」 */
export interface ResultAnchor {
  chunk_id: number
  chunk_index: number
  char_start: number
  char_end: number
  anchor_kind: ChunkAnchorKind | null
  anchor_index: number | null
  time_start_ms: number | null
  time_end_ms: number | null
}

export function anchorOf(chunk: StoredChunk | null | undefined): ResultAnchor | null {
  if (!chunk) return null
  return {
    chunk_id: chunk.id,
    chunk_index: chunk.chunk_index,
    char_start: chunk.char_start,
    char_end: chunk.char_end,
    anchor_kind: chunk.anchor_kind ?? null,
    anchor_index: chunk.anchor_index ?? null,
    time_start_ms: chunk.time_start_ms ?? null,
    time_end_ms: chunk.time_end_ms ?? null,
  }
}
