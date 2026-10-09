import * as fs from 'fs'
import * as path from 'path'
import * as crypto from 'crypto'
import DatabaseService from './database'

/**
 * 内存向量索引：替代每次查询全表读 BLOB + 暴力余弦。
 * - N < IVF_MIN：平面扫描（已在内存 Float32Array 矩阵上，无 SQLite I/O）
 * - N >= IVF_MIN：IVF 倒排文件（球面 k-means 聚类，查询只扫 top-nprobe 簇）
 * - 增量：addVector 直接追加并归入最近质心；删除用 tombstone，超出阈值整体重建
 *
 * ADR-002 P2：索引落盘（`Data/indexes/vectors-<hash>.bin`）。
 * 冷启动先读磁盘快照，省掉「全表读 BLOB + 逐行归一化 + k-means 训练」三段可观测卡顿。
 * 快照一律以 DB 为准做校验（`DB 有效行数 === 快照有效行数`），不一致即静默丢弃重建，
 * 因此「落盘失败 / 落后于 DB / 版本变更」都不会污染检索结果。
 */

interface Shard {
  dim: number
  capacity: number
  n: number                      // 已写入行数（含 tombstone）
  data: Float32Array             // 归一化向量矩阵 (capacity * dim)
  docIds: number[]               // 行号 -> document_id
  /** 行号 -> chunk_id（D8：块级溯源）；0 表示该行没有块（回填未完成 / 摘要向量） */
  chunkIds: number[]
  deleted: Set<number>           // tombstone 行号
  centroids: Float32Array | null // k * dim（归一化）
  k: number
  clusters: number[][] | null    // 质心 -> 行号列表
  trainedAt: number              // 训练时的有效向量数
  pendingAdds: number
}

const IVF_MIN = 512
const RETRAIN_RATIO = 0.2
const TOMBSTONE_RATIO = 0.3
const KMEANS_ITERS = 6

/** 落盘格式版本；任何影响二进制布局的改动都必须 +1（v2 起带 chunkIds 列） */
const SNAPSHOT_VERSION = 2
const SNAPSHOT_MAGIC = 'SDVX'
/** 变更后静默多久再落盘（防抖，保证批量导入期间不反复写大文件） */
const PERSIST_DELAY_MS = 3000

/**
 * k-means 初始质心的随机源。
 *
 * 默认用 `Math.random()`（导入期每次都不同，无害）；评测模式（`SD_VECTOR_SEED`）下
 * 换成固定种子的 mulberry32 —— 评测脚本必须**禁掉随机性**，否则「换一次参数重跑」
 * 与「换一次随机初始化重跑」分不清谁带来的差异（架构文档 §5.4.4）。
 */
function createRng(): () => number {
  const seedRaw = process.env.SD_VECTOR_SEED
  if (seedRaw == null || seedRaw === '') return Math.random
  const seed = Number(seedRaw)
  if (!Number.isFinite(seed)) return Math.random
  let state = (Math.floor(seed) >>> 0) || 1
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function align4(n: number): number {
  return (n + 3) & ~3
}

export class VectorIndex {
  private shards = new Map<string, Shard>()
  private dirty = new Set<string>()
  private timers = new Map<string, ReturnType<typeof setTimeout>>()
  private snapshotDir: string | null

  constructor(private db: DatabaseService, dataDir?: string) {
    this.snapshotDir = dataDir ? path.join(dataDir, 'indexes') : null
  }

  private fileFor(model: string): string | null {
    if (!this.snapshotDir) return null
    const hash = crypto.createHash('sha1').update(model).digest('hex').slice(0, 16)
    return path.join(this.snapshotDir, `vectors-${hash}.bin`)
  }

  private newShard(dim: number, capacity = 1024): Shard {
    return { dim, capacity, n: 0, data: new Float32Array(capacity * dim), docIds: [], chunkIds: [], deleted: new Set(), centroids: null, k: 0, clusters: null, trainedAt: 0, pendingAdds: 0 }
  }

  private grow(shard: Shard) {
    const capacity = shard.capacity * 2
    const data = new Float32Array(capacity * shard.dim)
    data.set(shard.data)
    shard.data = data
    shard.capacity = capacity
  }

  private normalize(v: Float32Array): Float32Array {
    let norm = 0
    for (let i = 0; i < v.length; i++) norm += v[i] * v[i]
    norm = Math.sqrt(norm)
    if (norm > 0) {
      const out = new Float32Array(v.length)
      for (let i = 0; i < v.length; i++) out[i] = v[i] / norm
      return out
    }
    return v.slice()
  }

  private loadShard(model: string): Shard {
    const cached = this.shards.get(model)
    if (cached) return cached
    let shard = this.loadFromDisk(model)
    if (!shard) {
      shard = this.loadFromDb(model)
      // 重建结果立刻固化：本次白等一次，下次冷启动就能直接命中快照
      if (shard.n > 0) this.schedulePersist(model)
    }
    this.shards.set(model, shard)
    return shard
  }

  /** 快照命中：直接拿归一化矩阵 + 已训练质心，跳过 BLOB 解析 / 归一化 / k-means */
  private loadFromDisk(model: string): Shard | null {
    const file = this.fileFor(model)
    if (!file || !fs.existsSync(file)) return null
    try {
      const buf = fs.readFileSync(file)
      if (buf.length < 12 || buf.toString('latin1', 0, 4) !== SNAPSHOT_MAGIC) return null
      if (buf.readUInt32LE(4) !== SNAPSHOT_VERSION) return null
      const headerLen = buf.readUInt32LE(8)
      if (12 + headerLen > buf.length) return null
      // 写入时按 4 字节对齐做了补零，解析前去掉尾部 NUL
      const header = JSON.parse(buf.toString('utf8', 12, 12 + headerLen).replace(/\u0000+$/, ''))
      if (header.model !== model) return null

      const dim = header.dim, n = header.n, k = header.k
      if (!Number.isInteger(dim) || dim <= 0) return null
      if (!Number.isInteger(n) || n < 0) return null
      if (!Number.isInteger(k) || k < 0) return null

      const deletedRows: number[] = Array.isArray(header.deleted) ? header.deleted : []
      // 与 DB 对齐：快照有效行数必须等于 DB 现存向量行数，否则说明快照过期
      const dbCount = (this.db.prepare('SELECT COUNT(*) as c FROM vectors WHERE model = ?').get(model) as any)?.c || 0
      if (dbCount !== n - deletedRows.length) return null

      let off = align4(12 + headerLen)
      const need = (n * dim + n + n + deletedRows.length + k * dim + (k ? k + 1 : 0)) * 4
      if (off + need > buf.length) return null

      const shard = this.newShard(dim, Math.max(1024, n * 2))
      // 注意：矩阵必须装进 capacity 大小的数组，否则后续 addVector 追加会越界
      shard.data.set(new Float32Array(buf.buffer.slice(buf.byteOffset + off, buf.byteOffset + off + n * dim * 4)))
      off += n * dim * 4
      const ids = new Int32Array(buf.buffer.slice(buf.byteOffset + off, buf.byteOffset + off + n * 4))
      off += n * 4
      shard.docIds = Array.from(ids)
      const chunkIds = new Int32Array(buf.buffer.slice(buf.byteOffset + off, buf.byteOffset + off + n * 4))
      off += n * 4
      shard.chunkIds = Array.from(chunkIds)
      shard.n = n
      const del = new Int32Array(buf.buffer.slice(buf.byteOffset + off, buf.byteOffset + off + deletedRows.length * 4))
      off += deletedRows.length * 4
      shard.deleted = new Set(Array.from(del))

      if (k > 0) {
        shard.centroids = new Float32Array(buf.buffer.slice(buf.byteOffset + off, buf.byteOffset + off + k * dim * 4))
        off += k * dim * 4
        const offsets = new Int32Array(buf.buffer.slice(buf.byteOffset + off, buf.byteOffset + off + (k + 1) * 4))
        off += (k + 1) * 4
        if (offsets[k] < 0 || offsets[k] > n || off + offsets[k] * 4 > buf.length) return null
        const rows = new Int32Array(buf.buffer.slice(buf.byteOffset + off, buf.byteOffset + off + offsets[k] * 4))
        shard.k = k
        shard.clusters = []
        for (let c = 0; c < k; c++) {
          shard.clusters.push(Array.from(rows.subarray(offsets[c], offsets[c + 1])))
        }
        shard.trainedAt = header.trainedAt || 0
        shard.pendingAdds = header.pendingAdds || 0
      }
      return shard
    } catch {
      return null  // 快照损坏按未命中处理，回退 DB 重建
    }
  }

  /**
   * BLOB → Float32Array。必须走字节级拷贝：
   * `new Float32Array(uint8Array)` 会把它当类数组逐字节展开（长度变成字节数），
   * 且 SQLite 返回的 Buffer 偏移未必 4 字节对齐——两者都会让向量变成垃圾数据。
   */
  private blobToFloat32(blob: any): Float32Array {
    if (blob instanceof Float32Array) return blob
    const buf = Buffer.isBuffer(blob) ? blob : Buffer.from(blob as ArrayBuffer)
    return new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength))
  }

  private loadFromDb(model: string): Shard {
    const rows = this.db.prepare('SELECT document_id, chunk_id, embedding, dimension FROM vectors WHERE model = ?').all(model) as any[]
    if (!rows.length) {
      return this.newShard(1)  // 空占位，dim 待首个向量确定
    }
    const dim = rows[0].dimension || this.blobToFloat32(rows[0].embedding).length
    const shard = this.newShard(dim, Math.max(1024, rows.length * 2))
    for (const row of rows) {
      if (row.document_id == null || !row.embedding) continue
      const vec = this.blobToFloat32(row.embedding)
      if (vec.length !== dim) continue
      const normed = this.normalize(vec)
      if (shard.n >= shard.capacity) this.grow(shard)
      shard.data.set(normed, shard.n * dim)
      shard.docIds[shard.n] = row.document_id
      shard.chunkIds[shard.n] = row.chunk_id ?? 0
      shard.n++
    }
    this.maybeTrain(shard)
    return shard
  }

  private validCount(shard: Shard): number {
    return shard.n - shard.deleted.size
  }

  private maybeTrain(shard: Shard) {
    const n = this.validCount(shard)
    if (n < IVF_MIN) { shard.centroids = null; shard.clusters = null; return }
    if (shard.centroids && shard.pendingAdds < RETRAIN_RATIO * shard.trainedAt) return
    // 球面 k-means：以归一化向量的 dot 最大作为最近质心
    const k = Math.min(256, Math.max(8, Math.round(Math.sqrt(n))))
    const dim = shard.dim
    const centroids = new Float32Array(k * dim)
    // 随机挑选 k 个有效行作为初始质心（评测模式下走固定种子，见 createRng）
    const rng = createRng()
    const pool: number[] = []
    for (let i = 0; i < shard.n; i++) if (!shard.deleted.has(i)) pool.push(i)
    for (let c = 0; c < k; c++) {
      const src = pool[Math.floor(rng() * pool.length)]
      centroids.set(shard.data.subarray(src * dim, src * dim + dim), c * dim)
    }
    const clusters: number[][] = Array.from({ length: k }, () => [])
    for (let iter = 0; iter < KMEANS_ITERS; iter++) {
      for (let c = 0; c < k; c++) clusters[c] = []
      for (const row of pool) {
        let best = 0, bestScore = -Infinity
        for (let c = 0; c < k; c++) {
          let dot = 0
          const off = row * dim, coff = c * dim
          for (let d = 0; d < dim; d++) dot += shard.data[off + d] * centroids[coff + d]
          if (dot > bestScore) { bestScore = dot; best = c }
        }
        clusters[best].push(row)
      }
      for (let c = 0; c < k; c++) {
        const members = clusters[c]
        if (!members.length) continue
        const acc = new Float64Array(dim)
        for (const row of members) {
          const off = row * dim
          for (let d = 0; d < dim; d++) acc[d] += shard.data[off + d]
        }
        let norm = 0
        for (let d = 0; d < dim; d++) norm += acc[d] * acc[d]
        norm = Math.sqrt(norm)
        for (let d = 0; d < dim; d++) centroids[c * dim + d] = norm > 0 ? acc[d] / norm : 0
      }
    }
    shard.centroids = centroids
    shard.k = k
    shard.clusters = clusters
    shard.trainedAt = n
    shard.pendingAdds = 0
  }

  /**
   * 新文档向量入库后调用（内存增量，不动 SQLite）。
   * `chunkId`/`chunkIndex` 为 D8 的块级溯源关联：`chunkId` 记进分片（检索才能带回出处），
   * `chunkIndex` 只用于日志可读性（检索时按 chunk id 回查 chunks 表即得序号）。
   */
  addVector(model: string, documentId: number, vector: Float32Array, chunkId?: number | null, chunkIndex?: number | null) {
    let shard = this.shards.get(model)
    if (!shard || (shard.n === 0 && shard.dim !== vector.length)) {
      shard = this.newShard(vector.length)
      this.shards.set(model, shard)
    }
    if (vector.length !== shard.dim) return  // 模型输出维度变化，忽略（下次全量重建）
    const normed = this.normalize(vector)
    if (shard.n >= shard.capacity) this.grow(shard)
    const row = shard.n
    shard.data.set(normed, row * shard.dim)
    shard.docIds[row] = documentId
    shard.chunkIds[row] = chunkId ?? 0
    shard.n++
    shard.pendingAdds++
    if (shard.centroids && shard.clusters) {
      // 归入最近质心
      let best = 0, bestScore = -Infinity
      for (let c = 0; c < shard.k; c++) {
        let dot = 0
        for (let d = 0; d < shard.dim; d++) dot += normed[d] * shard.centroids[c * shard.dim + d]
        if (dot > bestScore) { bestScore = dot; best = c }
      }
      shard.clusters[best].push(row)
    }
    this.schedulePersist(model)
  }

  /** 文档重解析/删除前调用：tombstone，超出阈值后丢弃缓存下次全量重建 */
  removeDocument(documentId: number) {
    for (const [model, shard] of this.shards) {
      if (!shard.docIds.includes(documentId)) continue
      for (let i = 0; i < shard.n; i++) {
        if (shard.docIds[i] === documentId) shard.deleted.add(i)
      }
      if (shard.deleted.size > TOMBSTONE_RATIO * shard.n) {
        this.shards.delete(model)
        this.dropSnapshot(model)
      } else {
        this.schedulePersist(model)
      }
    }
  }

  /** 防抖落盘：导入期间不断有 addVector 时持续推迟，避免反复写大文件 */
  private schedulePersist(model: string) {
    if (!this.snapshotDir) return
    this.dirty.add(model)
    const timer = this.timers.get(model)
    if (timer) clearTimeout(timer)
    const next = setTimeout(() => {
      this.timers.delete(model)
      this.persist(model)
    }, PERSIST_DELAY_MS)
    if (typeof (next as any).unref === 'function') (next as any).unref()
    this.timers.set(model, next)
  }

  /** 立即落盘（进程退出前调用，否则最后一次变更会丢） */
  flush() {
    for (const model of Array.from(this.dirty)) {
      const timer = this.timers.get(model)
      if (timer) { clearTimeout(timer); this.timers.delete(model) }
      this.persist(model)
    }
  }

  private persist(model: string) {
    const file = this.fileFor(model)
    const shard = this.shards.get(model)
    this.dirty.delete(model)
    if (!file || !shard || shard.n === 0) return
    try {
      const headerBuf = Buffer.from(JSON.stringify({
        model,
        dim: shard.dim,
        n: shard.n,
        k: shard.centroids ? shard.k : 0,
        trainedAt: shard.trainedAt,
        pendingAdds: shard.pendingAdds,
        deleted: Array.from(shard.deleted)
      }), 'utf8')
      const headerLen = align4(headerBuf.length)
      const k = shard.centroids ? shard.k : 0
      const clusterOffsets = new Int32Array(k + 1)
      const clusterRows: number[] = []
      if (k) {
        for (let c = 0; c < k; c++) {
          clusterOffsets[c] = clusterRows.length
          clusterRows.push(...shard.clusters![c])
        }
        clusterOffsets[k] = clusterRows.length
      }
      const head = Buffer.alloc(align4(12 + headerBuf.length))
      head.write(SNAPSHOT_MAGIC, 0, 'latin1')
      head.writeUInt32LE(SNAPSHOT_VERSION, 4)
      head.writeUInt32LE(headerLen, 8)
      headerBuf.copy(head, 12)

      const parts: Buffer[] = [head]
      parts.push(Buffer.from(shard.data.buffer, shard.data.byteOffset, shard.n * shard.dim * 4))
      parts.push(Buffer.from(new Int32Array(shard.docIds.slice(0, shard.n)).buffer))
      parts.push(Buffer.from(new Int32Array(shard.chunkIds.slice(0, shard.n).map(id => id || 0)).buffer))
      parts.push(Buffer.from(new Int32Array(Array.from(shard.deleted)).buffer))
      if (k) {
        parts.push(Buffer.from(shard.centroids!.buffer, shard.centroids!.byteOffset, k * shard.dim * 4))
        parts.push(Buffer.from(clusterOffsets.buffer))
        parts.push(Buffer.from(new Int32Array(clusterRows).buffer))
      }

      fs.mkdirSync(path.dirname(file), { recursive: true })
      const tmp = `${file}.tmp`
      fs.writeFileSync(tmp, Buffer.concat(parts))
      fs.renameSync(tmp, file)  // 原子替换，避免半截文件被下次启动读到
    } catch (e: any) {
      console.warn(`向量索引落盘失败（${model}）: ${e?.message || e}`)
    }
  }

  private dropSnapshot(model: string) {
    const file = this.fileFor(model)
    this.dirty.delete(model)
    const timer = this.timers.get(model)
    if (timer) { clearTimeout(timer); this.timers.delete(model) }
    if (!file) return
    try { if (fs.existsSync(file)) fs.unlinkSync(file) } catch { /* 删除失败下次靠校验兜底 */ }
  }

  /**
   * 返回 top 命中：`document_id` + 该文档最高分块的 `chunk_id`（0 表示该行没有块）+ 余弦得分。
   *
   * 去重口径（§5.6.2 方案 A）：**同文档保留最高分的那一行**，并把该行的 chunk 一并带回，
   * 这样结果不只是「哪个文档相关」，还知道「文档里的哪一块相关」。
   */
  search(model: string, query: Float32Array, limit: number): Array<{ document_id: number; chunk_id: number | null; score: number }> {
    const shard = this.loadShard(model)
    if (!shard || shard.n === 0 || shard.deleted.size >= shard.n) return []
    const dim = shard.dim
    if (query.length !== dim) return []
    const q = this.normalize(query)
    const results: Array<{ document_id: number; chunk_id: number | null; score: number }> = []
    const push = (row: number) => {
      const off = row * dim
      let dot = 0
      for (let d = 0; d < dim; d++) dot += shard.data[off + d] * q[d]
      results.push({ document_id: shard.docIds[row], chunk_id: shard.chunkIds[row] || null, score: dot })
    }
    const validN = this.validCount(shard)
    if (validN < IVF_MIN || !shard.centroids || !shard.clusters) {
      if (shard.pendingAdds >= RETRAIN_RATIO * Math.max(shard.trainedAt, 1)) this.maybeTrain(shard)
      for (let i = 0; i < shard.n; i++) if (!shard.deleted.has(i)) push(i)
    } else {
      if (shard.pendingAdds >= RETRAIN_RATIO * shard.trainedAt) {
        this.maybeTrain(shard)
        return this.search(model, query, limit)  // 重训后走新索引
      }
      // 探测最近的 nprobe 个簇
      const nprobe = Math.max(1, Math.round(shard.k / 10))
      const centroidScores: Array<{ c: number; s: number }> = []
      for (let c = 0; c < shard.k; c++) {
        let dot = 0
        for (let d = 0; d < dim; d++) dot += shard.centroids[c * dim + d] * q[d]
        centroidScores.push({ c, s: dot })
      }
      centroidScores.sort((a, b) => b.s - a.s)
      for (let p = 0; p < nprobe; p++) {
        for (const row of shard.clusters[centroidScores[p].c]) {
          if (!shard.deleted.has(row)) push(row)
        }
      }
    }
    results.sort((a, b) => b.score - a.score)
    // 同文档多 chunk 去重（保留最高分那一块，并把它的 chunk_id 带回）
    const seen = new Map<number, number>()
    const out: Array<{ document_id: number; chunk_id: number | null; score: number }> = []
    for (const r of results) {
      if (!seen.has(r.document_id)) {
        seen.set(r.document_id, r.score)
        out.push(r)
        if (out.length >= limit) break
      }
    }
    return out
  }
}
