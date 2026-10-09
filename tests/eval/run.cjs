/**
 * `npm run eval` —— 检索评测（D11 / 架构文档 §5.4）。
 *
 * 一条命令跑完：临时数据目录 → 装配语料 → 解析入库 → 逐题检索 → 算指标 → 与基线对比。
 * 评测不依赖也不修改用户库（`Data/` 一律不碰），语料与索引都在系统临时目录里。
 *
 * 输出：
 *   - stdout：recall@1/3/5/10、MRR、块级命中率，按 mode / tags / split 分桶；
 *   - `<tmp>/eval/run-<ts>.json`：本次全部明细（可回溯到每一题的排名）；
 *   - `<tmp>/eval/report.md`：人读版本；
 *   - `tests/eval/baseline.json`：基线（`--update-baseline` 时覆盖）。
 *
 * 退出码：holdout 的 recall@5 或 MRR 相对基线下降超过阈值（默认 0.02）→ 非零。
 * 首次运行（没有基线文件）只落基线，不判失败。
 */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

/** 固定随机种子：评测禁用随机性，否则「换参数」与「换随机初始化」分不清谁带来的差异（§5.4.4） */
process.env.SD_VECTOR_SEED = process.env.SD_VECTOR_SEED || '20260920'
const { createRuntime } = require('../../dist-electron/services/runtime')
const { buildCorpus } = require('./corpus')

const EVAL_DIR = __dirname
const QUERIES_PATH = path.join(EVAL_DIR, 'queries.jsonl')
const BASELINE_PATH = path.join(EVAL_DIR, 'baseline.json')
/** 两个通道都跑，用于分桶报告与「RRF 是否真的融合了两路」的对照 */
const MODES = ['fulltext', 'semantic', 'hybrid']
const KS = [1, 3, 5, 10]
/** 基线门槛：holdout 指标下降超过该值即失败 */
const REGRESSION_THRESHOLD = 0.02

function loadQueries() {
  const lines = fs.readFileSync(QUERIES_PATH, 'utf8').split('\n').map(line => line.trim()).filter(Boolean)
  return lines.map((line, index) => {
    const item = JSON.parse(line)
    if (!item.id || !item.query || !Array.isArray(item.expect_documents)) {
      throw new Error(`queries.jsonl 第 ${index + 1} 行缺少必填字段（id / query / expect_documents）`)
    }
    return { ...item, split: item.split || 'dev', mode: item.mode || 'hybrid', tags: item.tags || [] }
  })
}

/**
 * 单题命中：`expect_documents[].file` 映射到本次运行的真实文档 id。
 * 题目用文件名而不是数据库 id：id 是自增的、随运行环境变化，写进数据集就不可复现。
 */
function rankOfFirstExpected(items, expectDocuments, minGrade) {
  for (let i = 0; i < items.length; i++) {
    const fileName = items[i].file_name
    const hit = expectDocuments.find(doc => doc.file === fileName && doc.grade >= minGrade)
    if (hit) return i + 1
  }
  return 0
}

function recallAt(items, expectDocuments, k) {
  const expected = expectDocuments.filter(doc => doc.grade >= 2)
  if (!expected.length) return null
  const top = new Set(items.slice(0, k).map(item => item.file_name))
  const hits = expected.filter(doc => top.has(doc.file)).length
  return hits / expected.length
}

function ndcgAt(items, expectDocuments, k) {
  const grades = new Map(expectDocuments.map(doc => [doc.file, doc.grade]))
  const gain = (grade) => (2 ** grade) - 1
  const dcg = items.slice(0, k).reduce((sum, item, index) => sum + (gain(grades.get(item.file_name) || 0) / Math.log2(index + 2)), 0)
  const ideal = expectDocuments.map(doc => doc.grade).sort((a, b) => b - a).slice(0, k)
    .reduce((sum, grade, index) => sum + (gain(grade) / Math.log2(index + 2)), 0)
  return ideal > 0 ? dcg / ideal : null
}

function precisionAt(items, expectDocuments, k) {
  const negatives = new Set(expectDocuments.filter(doc => doc.grade === 0).map(doc => doc.file))
  if (!negatives.size) return null
  const top = items.slice(0, k)
  if (!top.length) return null
  return top.filter(item => !negatives.has(item.file_name)).length / top.length
}

/** 块级命中率：结果里带回的块正文是否包含期望片段（按题给的关键片段，而不是硬编码自增 id） */
function chunkHits(items, expectChunks) {
  if (!Array.isArray(expectChunks) || !expectChunks.length) return null
  // 该通道根本不返回块信息时记为「无数据」而不是 0：0 会被误读成「块找错了」
  if (!items.some(item => item.matched_chunk)) return null
  let hit = 0
  for (const expected of expectChunks) {
    const found = items.some(item =>
      item.file_name === expected.file
      && item.matched_chunk
      && String(item.matched_chunk.content).includes(expected.contains))
    if (found) hit++
  }
  return hit / expectChunks.length
}

function mean(values) {
  const list = values.filter(value => typeof value === 'number' && !Number.isNaN(value))
  if (!list.length) return null
  return list.reduce((sum, value) => sum + value, 0) / list.length
}

function round(value) {
  return typeof value === 'number' ? Math.round(value * 1000) / 1000 : null
}

function bucketMetrics(rows) {
  const metrics = {}
  for (const k of KS) metrics[`recall@${k}`] = round(mean(rows.map(row => row[`recall@${k}`])))
  metrics.mrr = round(mean(rows.map(row => row.mrr)))
  metrics['ndcg@10'] = round(mean(rows.map(row => row['ndcg@10'])))
  metrics['precision@5'] = round(mean(rows.map(row => row['precision@5'])))
  metrics['chunk_hit'] = round(mean(rows.map(row => row.chunk_hit)))
  metrics.queries = rows.length
  return metrics
}

/**
 * 分桶。
 *
 * 口径分两类，避免把「通道对比」和「生产路径质量」混在一张表里：
 *   - `channel:*` —— 三个通道**各自**跑全部题目的结果（对照 RRF 是否真的比单通道好）；
 *   - `all` / `split:*` / `query_mode:*` / `tag:*` —— 只统计 **hybrid**（生产默认路径）的结果。
 */
function summarize(rows) {
  const groups = {}
  for (const mode of MODES) groups[`channel:${mode}`] = rows.filter(row => row.mode === mode)
  const hybridRows = rows.filter(row => row.mode === 'hybrid')
  groups.all = hybridRows
  for (const split of ['dev', 'holdout']) groups[`split:${split}`] = hybridRows.filter(row => row.split === split)
  for (const mode of ['fulltext', 'semantic', 'hybrid']) {
    groups[`query_mode:${mode}`] = hybridRows.filter(row => row.query_mode === mode)
  }
  const tags = new Set(hybridRows.flatMap(row => row.tags))
  for (const tag of tags) groups[`tag:${tag}`] = hybridRows.filter(row => row.tags.includes(tag))
  const out = {}
  for (const [name, list] of Object.entries(groups)) out[name] = bucketMetrics(list)
  return out
}

async function main() {
  const updateBaseline = process.argv.includes('--update-baseline')
  const queries = loadQueries()
  const dev = queries.filter(q => q.split === 'dev').length
  const holdout = queries.filter(q => q.split === 'holdout').length

  const root = path.join(os.tmpdir(), 'sd-eval-' + Date.now())
  const dataDir = path.join(root, 'Data')
  fs.mkdirSync(dataDir, { recursive: true })
  const corpusDir = path.join(root, 'corpus')

  console.log('== SD 检索评测（D11）==')
  console.log(`数据集  : tests/eval/queries.jsonl（${queries.length} 条：dev ${dev} / holdout ${holdout}）`)
  console.log(`随机种子: SD_VECTOR_SEED=${process.env.SD_VECTOR_SEED}（评测禁用随机性）`)
  console.log(`数据目录: ${root}（临时目录，不碰仓库里的 Data/）`)

  const manifest = await buildCorpus(corpusDir)
  console.log(`语料    : ${manifest.length} 篇 / ${(manifest.reduce((n, m) => n + m.bytes, 0) / 1024).toFixed(1)} KB，格式：${[...new Set(manifest.map(m => m.fileType))].join(',')}`)

  const runtime = await createRuntime(dataDir)
  await runtime.db.updateSettings({ vector_enabled: 'true', ocr_enabled: 'false', chunk_size: '512', chunk_overlap: '50' })
  const imported = await runtime.importFiles(manifest.map(m => path.join(corpusDir, m.fileName)))
  const failed = imported.filter(item => !item.success)
  assert.equal(failed.length, 0, '语料导入失败：' + JSON.stringify(failed))
  await runtime.idle()

  const docs = runtime.db.prepare('SELECT id, file_name, file_type, processing_status, content_text FROM documents').all()
  const notReady = docs.filter(doc => doc.processing_status !== 'ready')
  assert.equal(notReady.length, 0, '有语料未解析成功：' + JSON.stringify(notReady))
  const chunks = runtime.db.prepare('SELECT COUNT(*) AS n FROM chunks').get().n
  const linked = runtime.db.prepare('SELECT COUNT(*) AS n FROM vectors WHERE chunk_id IS NOT NULL').get().n
  const vectors = runtime.db.prepare('SELECT COUNT(*) AS n FROM vectors').get().n
  console.log(`解析    : 文档 ${docs.length} 篇 / 块 ${chunks} 个 / 向量 ${vectors} 条（其中关联到块 ${linked} 条）`)

  const fileNames = new Set(docs.map(doc => doc.file_name))
  for (const query of queries) {
    for (const expected of query.expect_documents) {
      if (!fileNames.has(expected.file)) throw new Error(`题目 ${query.id} 期望的语料不存在：${expected.file}`)
    }
    for (const expected of query.expect_chunks || []) {
      if (!fileNames.has(expected.file)) throw new Error(`题目 ${query.id} 期望的块所在语料不存在：${expected.file}`)
    }
  }

  const rows = []
  const perQueryRank = {}
  for (const query of queries) {
    for (const mode of MODES) {
      const started = Date.now()
      let items = []
      let extra = {}
      if (mode === 'fulltext') items = (await runtime.search.fullTextSearch(query.query, { limit: 10 })).items
      else if (mode === 'semantic') items = (await runtime.search.semanticSearch(query.query, { limit: 10 })).items
      else {
        const set = await runtime.search.hybridSearch(query.query, { limit: 10 })
        items = set.items
        extra = { truncated: set.truncated, truncated_reason: set.truncated_reason ?? null, channels: set.channels }
      }
      const firstMust = rankOfFirstExpected(items, query.expect_documents, 3)
      const first = firstMust || rankOfFirstExpected(items, query.expect_documents, 2)
      const row = {
        id: `${query.id}:${mode}`,
        query_id: query.id,
        query: query.query,
        query_mode: query.mode,
        split: query.split,
        tags: query.tags,
        mode,
        ms: Date.now() - started,
        top: items.slice(0, 10).map(item => ({ file: item.file_name, chunk_index: item.chunk_index ?? null, anchor: item.anchor ?? null })),
        first_relevant_rank: first,
        mrr: first ? 1 / first : 0,
        chunk_hit: chunkHits(items, query.expect_chunks),
        ...extra,
      }
      for (const k of KS) row[`recall@${k}`] = recallAt(items, query.expect_documents, k)
      row['ndcg@10'] = ndcgAt(items, query.expect_documents, 10)
      row['precision@5'] = precisionAt(items, query.expect_documents, 5)
      rows.push(row)
      if (mode === 'hybrid') perQueryRank[query.id] = first
    }
  }

  const report = summarize(rows)
  const evalOutDir = path.join(root, 'eval')
  fs.mkdirSync(evalOutDir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const runPath = path.join(evalOutDir, `run-${stamp}.json`)
  fs.writeFileSync(runPath, JSON.stringify({
    ranAt: new Date().toISOString(),
    seed: process.env.SD_VECTOR_SEED,
    queries: queries.length, splits: { dev, holdout },
    corpus: manifest, metrics: report, rows,
  }, null, 2))
  fs.writeFileSync(path.join(evalOutDir, 'report.md'), renderMarkdown(report, rows, { seed: process.env.SD_VECTOR_SEED, dev, holdout, manifest }))

  printReport(report, rows)

  const baseline = fs.existsSync(BASELINE_PATH) ? JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8')) : null
  const metrics = {
    'split:holdout': report['split:holdout'],
    'split:dev': report['split:dev'],
    'channel:hybrid': report['channel:hybrid'],
    'channel:fulltext': report['channel:fulltext'],
    'channel:semantic': report['channel:semantic'],
  }
  if (!baseline || updateBaseline) {
    fs.writeFileSync(BASELINE_PATH, JSON.stringify({
      updatedAt: new Date().toISOString(),
      seed: process.env.SD_VECTOR_SEED,
      queries: queries.length,
      splits: { dev, holdout },
      corpusSize: manifest.length,
      metrics,
      per_query_rank: perQueryRank,
    }, null, 2))
    console.log(`\n基线已写入 ${path.relative(process.cwd(), BASELINE_PATH)}（${updateBaseline ? '--update-baseline' : '首次运行'}）`)
  } else {
    const regressions = compareBaseline(baseline, metrics)
    if (regressions.length) {
      console.error('\n⚠ 相对基线退化（门槛 %s）：', REGRESSION_THRESHOLD)
      for (const line of regressions) console.error('  -', line)
      runtime.db.close()
      process.exit(1)
    }
    console.log('\n相对基线：holdout 的 recall@5 与 MRR 未退化（门槛 %s）', REGRESSION_THRESHOLD)
  }

  console.log(`\n明细：${runPath}`)
  console.log('EVAL PASS')
  runtime.db.close()
}

/** 只把 holdout 当门槛（dev 允许拿来调参，不进门槛） */
function compareBaseline(baseline, metrics) {
  const regressions = []
  for (const key of ['recall@5', 'mrr']) {
    const before = baseline?.metrics?.['split:holdout']?.[key]
    const after = metrics['split:holdout']?.[key]
    if (typeof before !== 'number' || typeof after !== 'number') continue
    if (before - after > REGRESSION_THRESHOLD) {
      regressions.push(`holdout ${key}: ${before} → ${after}`)
    }
  }
  return regressions
}

function formatBucket(name, metric) {
  if (!metric || !metric.queries) return null
  return [
    name.padEnd(16),
    `n=${String(metric.queries).padStart(3)}`,
    `r@1=${fmt(metric['recall@1'])}`,
    `r@3=${fmt(metric['recall@3'])}`,
    `r@5=${fmt(metric['recall@5'])}`,
    `r@10=${fmt(metric['recall@10'])}`,
    `mrr=${fmt(metric.mrr)}`,
    `ndcg@10=${fmt(metric['ndcg@10'])}`,
    `chunk=${fmt(metric['chunk_hit'])}`,
  ].join('  ')
}

function fmt(value) {
  return (typeof value === 'number' ? value.toFixed(3) : '  -  ')
}

function printReport(report, rows) {
  console.log('\n== 指标 ==')
  console.log('（channel:* 是三个通道各自跑全部题目；其余桶只统计 hybrid，即生产默认路径）')
  const order = [
    'channel:fulltext', 'channel:semantic', 'channel:hybrid',
    'all', 'split:dev', 'split:holdout',
    'query_mode:fulltext', 'query_mode:semantic', 'query_mode:hybrid',
    ...Object.keys(report).filter(key => key.startsWith('tag:')).sort(),
  ]
  for (const name of order) {
    const line = formatBucket(name, report[name])
    if (line) console.log(line)
  }
  const hybridRows = rows.filter(row => row.mode === 'hybrid')
  const failed = hybridRows.filter(row => !row.first_relevant_rank)
  console.log(`\nhybrid 未命中任何期望文档的题目：${failed.length ? failed.map(row => row.query_id).join(', ') : '无'}`)
  const degraded = hybridRows.filter(row => row.channels && row.channels.semantic === false)
  console.log(`语义通道不可用的题目数：${degraded.length}（0 表示两路都在参与融合）`)

  // 三通道 top5 对照（样例题固定取第一条字面题与第一条改写题，便于跨次运行对比）
  const samples = [rows[0]?.query_id, hybridRows.find(row => row.query_mode === 'semantic')?.query_id].filter(Boolean)
  console.log('\n== 三通道 top5 对照（同一题、同一批语料）==')
  for (const id of samples) {
    const first = rows.find(row => row.query_id === id && row.mode === 'hybrid')
    console.log(`\n${id} 「${first?.query}」`)
    for (const mode of MODES) {
      const row = rows.find(item => item.query_id === id && item.mode === mode)
      const top = (row?.top || []).slice(0, 5).map(item => item.file)
      console.log(`  ${mode.padEnd(9)} ${top.length ? top.join(' > ') : '（空）'}   首个相关名次=${row?.first_relevant_rank || '未命中'}`)
    }
  }
}

function renderMarkdown(report, rows, meta) {
  const lines = [
    '# 检索评测报告（自动生成）',
    '',
    `- 运行时间：${new Date().toISOString()}`,
    `- 随机种子：SD_VECTOR_SEED=${meta.seed}`,
    `- 数据集：tests/eval/queries.jsonl（dev ${meta.dev} / holdout ${meta.holdout}）`,
    `- 语料：${meta.manifest.length} 篇（${[...new Set(meta.manifest.map(m => m.fileType))].join(', ')}）`,
    '',
    '## 分桶指标',
    '',
    '| 桶 | n | recall@1 | recall@3 | recall@5 | recall@10 | MRR | nDCG@10 | 块级命中 |',
    '|---|---|---|---|---|---|---|---|---|',
  ]
  for (const [name, metric] of Object.entries(report)) {
    if (!metric || !metric.queries) continue
    lines.push(`| ${name} | ${metric.queries} | ${fmt(metric['recall@1'])} | ${fmt(metric['recall@3'])} | ${fmt(metric['recall@5'])} | ${fmt(metric['recall@10'])} | ${fmt(metric.mrr)} | ${fmt(metric['ndcg@10'])} | ${fmt(metric['chunk_hit'])} |`)
  }
  lines.push('', '## 逐题（hybrid）', '', '| 题目 | 查询 | 首个相关名次 | 截断 | 说明 |', '|---|---|---|---|---|')
  for (const row of rows.filter(item => item.mode === 'hybrid')) {
    lines.push(`| ${row.query_id} | ${row.query} | ${row.first_relevant_rank || '未命中'} | ${row.truncated ? (row.truncated_reason || 'true') : 'false'} | ${row.channels?.semantic ? '' : '语义通道不可用'} |`)
  }
  return lines.join('\n') + '\n'
}

main().catch(error => { console.error('EVAL FAIL:', error); process.exit(1) })
