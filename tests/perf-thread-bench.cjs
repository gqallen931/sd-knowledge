/*
 * ONNX intra-op 线程数微基准
 *
 * 用法：node tests/perf-thread-bench.cjs
 *
 * 可选环境变量：
 *   ONNX_THREADS_LIST=default,1,2,4         候选值（default = 不注入，沿用 ORT 默认 = 物理核数）
 *   ONNX_THREADS_ROUNDS=3                   交替轮数（奇数轮正序、偶数轮逆序）
 *   ONNX_THREADS_ITER=8                     每配置每轮推理次数（取中位数）
 *   ONNX_THREADS_CHARS=0                    单条文本长度（字符），0 = 用内置短文本（约 60 token）；
 *                                           512 token 接近生产的 chunk 上限，用于看高负载下是否有差异
 *   ONNX_THREADS_MODEL=Xenova/bge-small-zh-v1.5
 *
 * 为什么单独做微基准：
 *   端到端基准的 ±50% 噪声来自多文档并发 + 文件 IO + SQLite，与纯推理无关（见
 *   docs/bugs/perf-benchmark-noise-and-deferred-tuning.md）。这里把模型加载排除在计时外，
 *   同一进程内为每个候选值各建一个 session，再按「正序 / 逆序 / 正序」交替测量取中位数——
 *   同进程交替可消掉机器升温与跨进程漂移，一次约 1 分钟即可判定。
 *
 * 测的是「推理」，输入规模对齐生产负载：bge-small-zh + 单块中文文本 + batch 2。
 */
const MODEL = process.env.ONNX_THREADS_MODEL || 'Xenova/bge-small-zh-v1.5'
const CANDIDATES = (process.env.ONNX_THREADS_LIST || 'default,1,2,4')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean)
const ROUNDS = Math.max(1, parseInt(process.env.ONNX_THREADS_ROUNDS || '3', 10))
const ITER = Math.max(1, parseInt(process.env.ONNX_THREADS_ITER || '8', 10))

const TEXTS = [
  '知识图谱把实体、概念与它们之间的关系组织成图结构，便于检索与推理。本文档说明本地知识库的解析链路：文件导入后先做格式识别，再抽取正文、实体与关键词，最后分块向量化写入索引。',
  '语义检索依赖向量索引，查询时把问题编码为向量，再在索引中做近邻搜索。为控制冷启动开销，索引常驻内存，模型加载采用单飞模式避免并发重复加载。',
]

/** 按 ONNX_THREADS_CHARS 把内置文本拉长到指定字符数，模拟接近 chunk 上限（512 token）的输入 */
function buildInput(chars) {
  const size = parseInt(chars || '0', 10)
  if (!Number.isFinite(size) || size <= 0) return TEXTS
  return TEXTS.map((t, i) => {
    let out = ''
    while (out.length < size) out += `片段${i}：${t}`
    return out.slice(0, size)
  })
}

let requested = 0
const hits = []

async function installPatch() {
  const mod = await import('onnxruntime-node')
  const session = mod.InferenceSession || (mod.default && mod.default.InferenceSession)
  if (!session || typeof session.create !== 'function') {
    throw new Error('InferenceSession.create 不可见，补丁点不成立')
  }
  const original = session.create.bind(session)
  session.create = (buffer, options = {}) => {
    hits.push({ requested, injected: requested > 0 ? requested : null })
    return original(buffer, requested > 0 ? { ...options, intraOpNumThreads: requested } : options)
  }
}

function median(xs) {
  const s = [...xs].sort((a, b) => a - b)
  const mid = s.length >> 1
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

async function main() {
  const { pipeline, env } = await import('@xenova/transformers')
  env.allowRemoteModels = true
  env.allowLocalModels = true
  if (process.env.HF_ENDPOINT) {
    const ep = process.env.HF_ENDPOINT
    env.remoteHost = ep.endsWith('/') ? ep : ep + '/'
  }

  await installPatch()

  const input = buildInput(process.env.ONNX_THREADS_CHARS)
  console.log(`模型 ${MODEL} · 输入 ${input[0].length} 字符 × ${input.length} 条 · 候选 ${CANDIDATES.join(' / ')} · ${ROUNDS} 轮 × 每轮 ${ITER} 次`)
  console.log('构建 session（不计入耗时统计）…')

  const sessions = []
  for (const name of CANDIDATES) {
    const n = name === 'default' ? 0 : parseInt(name, 10)
    if (name !== 'default' && (!Number.isFinite(n) || n < 1)) {
      console.warn(`  跳过非法候选 ${name}`)
      continue
    }
    requested = n
    const built = Date.now()
    const pipe = await pipeline('feature-extraction', MODEL, { quantized: true })
    sessions.push({ name, threads: n, pipe, buildMs: Date.now() - built })
    console.log(`  ${name}: 用时 ${Date.now() - built}ms，注入 ${n > 0 ? n : '（不注入）'}`)
  }
  if (!sessions.length) throw new Error('没有可用候选')

  console.log('预热…')
  for (const s of sessions) {
    for (let i = 0; i < 3; i++) await s.pipe(input, { pooling: 'mean', normalize: true })
  }

  const perRound = new Map(sessions.map(s => [s.name, []]))
  console.log('')
  for (let r = 0; r < ROUNDS; r++) {
    const seq = r % 2 === 0 ? sessions : [...sessions].reverse()
    const line = []
    for (const s of seq) {
      const times = []
      for (let i = 0; i < ITER; i++) {
        const t0 = process.hrtime.bigint()
        await s.pipe(input, { pooling: 'mean', normalize: true })
        times.push(Number(process.hrtime.bigint() - t0) / 1e6)
      }
      const med = median(times)
      perRound.get(s.name).push(med)
      line.push(`${s.name}=${med.toFixed(1)}ms`)
    }
    console.log(`轮次 ${r + 1}（${r % 2 === 0 ? '正序' : '逆序'}）: ${line.join('  ')}`)
  }

  const summary = sessions.map(s => ({ ...s, median: median(perRound.get(s.name)), rounds: perRound.get(s.name) }))
  const base = summary.find(s => s.name === 'default') || summary[0]
  console.log('')
  console.log('| 线程数 | 各轮中位数 | 汇总中位数 | 相对 default |')
  console.log('|--------|------------|------------|--------------|')
  for (const s of summary) {
    console.log(`| ${s.name} | ${s.rounds.map(v => v.toFixed(1)).join(' / ')} ms | ${s.median.toFixed(1)} ms | ${(s.median / base.median).toFixed(3)}× |`)
  }
  console.log('')
  console.log(`补丁命中 ${hits.length} 次，注入值: ${[...new Set(hits.map(h => h.injected))].map(v => (v === null ? '不注入' : v)).join(', ')}`)
  console.log(`结论基准：default = ${base.median.toFixed(1)}ms；小于 5% 的差异视为噪声，不做改动。`)
}

main().catch(e => {
  console.error(e)
  process.exit(1)
})
