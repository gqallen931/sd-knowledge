/**
 * S2-09 智能分析概览：集成测试
 * 覆盖：空库样本不足口径、窗口天数夹取（7–60 / 0 视为缺省 14）、
 * totals / queries 聚合与均值舍入、trend 逐日结构与当日计数。
 */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { createRuntime } = require('../dist-electron/services/runtime')

async function main() {
  const root = path.resolve(__dirname, '../.verification', 'run-' + Date.now() + '-analytics')
  fs.mkdirSync(root, { recursive: true })
  const r = await createRuntime(path.join(root, 'Data'))
  await r.db.updateSettings({ vector_enabled: 'false', ocr_enabled: 'false' })

  // —— 空库：样本不足，不给趋势结论 ——
  const empty = await r.db.getAnalyticsOverview(7)
  assert.equal(empty.windowDays, 7)
  assert.equal(empty.queries.total, 0)
  assert.equal(empty.sample.sufficient, false)
  assert.match(empty.sample.note, /样本不足/)
  assert.equal(empty.queries.avgResults, null)
  assert.equal(empty.queries.avgLatencyMs, null)
  assert.equal(empty.queries.lastAt, null)
  assert.equal(empty.trend.length, 7)
  assert.ok(empty.trend.every(row => row.queries === 0 && row.documents === 0))

  // —— 窗口夹取 ——
  assert.equal((await r.db.getAnalyticsOverview(3)).windowDays, 7)
  assert.equal((await r.db.getAnalyticsOverview(100)).windowDays, 60)
  assert.equal((await r.db.getAnalyticsOverview(0)).windowDays, 14, '0 视为未传')
  assert.equal((await r.db.getAnalyticsOverview(undefined)).windowDays, 14)

  // —— 造数：2 个文档 + 12 次问答日志（≥10 视为样本充分） ——
  const insDoc = r.db.prepare("INSERT INTO documents (title, file_name, file_path, file_type, file_size, processing_status) VALUES (?, ?, 'fixture-analytics', 'txt', 10, 'ready')")
  insDoc.run('分析文档一', '一.txt')
  insDoc.run('分析文档二', '二.txt')
  const insLog = r.db.prepare('INSERT INTO agent_query_logs (session_id, query_type, result_count, response_time_ms) VALUES (NULL, ?, ?, ?)')
  for (let i = 0; i < 12; i++) insLog.run('search', (i % 4) + 1, 100 + (i % 4) * 50) // 结果 1..4 均值 2.5；延迟 100..250 均值 175

  const overview = await r.db.getAnalyticsOverview(7)
  assert.equal(overview.queries.total, 12)
  assert.equal(overview.sample.sufficient, true)
  assert.equal(overview.sample.note, null)
  assert.equal(overview.queries.avgResults, 2.5)
  assert.equal(overview.queries.avgLatencyMs, 175)
  assert.ok(overview.queries.lastAt, '最近一次问答时间应非空')
  assert.equal(overview.totals.documents, 2)
  assert.equal(overview.trend.length, 7)

  const today = overview.trend[overview.trend.length - 1]
  assert.equal(today.queries, 12)
  assert.equal(today.documents, 2)
  assert.equal(today.avgResults, 2.5)
  assert.equal(today.avgLatencyMs, 175)

  for (const row of overview.trend) {
    assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(row.date), '趋势日期应为 YYYY-MM-DD')
    assert.equal(typeof row.documents, 'number')
    assert.equal(typeof row.queries, 'number')
  }

  // —— 清理造数不影响口径：窗口与样本判断基于日志而非文档 ——
  r.db.exec("DELETE FROM documents WHERE file_path='fixture-analytics'")
  assert.equal((await r.db.getAnalyticsOverview(7)).totals.documents, 0)
  assert.equal((await r.db.getAnalyticsOverview(7)).sample.sufficient, true)

  console.log('analytics-logs 集成测试通过')
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1) })
