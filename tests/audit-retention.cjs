/**
 * S2-10 审计日志保留与清理：集成测试
 * 覆盖：保留天数缺省 90 / 7–365 校验 / 四舍五入、清理前 JSON 快照落盘、
 * 无过期数据不产快照、省略参数时读设置值。
 */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { createRuntime } = require('../dist-electron/services/runtime')

async function main() {
  const root = path.resolve(__dirname, '../.verification', 'run-' + Date.now() + '-audit')
  fs.mkdirSync(root, { recursive: true })
  const r = await createRuntime(path.join(root, 'Data'))
  await r.db.updateSettings({ vector_enabled: 'false', ocr_enabled: 'false' })

  // —— 保留天数：缺省 90；回环写入/读取；边界校验 ——
  assert.equal(await r.security.getAuditRetentionDays(), 90)
  assert.equal(await r.security.setAuditRetentionDays(30), 30)
  assert.equal(await r.security.getAuditRetentionDays(), 30)
  assert.equal(await r.security.setAuditRetentionDays(30.4), 30, '四舍五入到整数')
  await assert.rejects(() => r.security.setAuditRetentionDays(6), /保留天数需为 7–365 的整数/)
  await assert.rejects(() => r.security.setAuditRetentionDays(366), /保留天数需为 7–365 的整数/)
  await assert.rejects(() => r.security.setAuditRetentionDays(Number.NaN), /保留天数需为 7–365 的整数/)
  await assert.rejects(() => r.security.pruneAuditLogs(0), /保留天数无效/)

  // —— 清理：3 条过期日志 + 1 条新鲜日志 ——
  const stale = r.db.prepare("INSERT INTO audit_logs (actor_type, actor_name, action, status, created_at) VALUES ('user', 'user', 'fixture-stale', 'success', datetime('now', '-100 days'))")
  stale.run()
  stale.run()
  stale.run()
  r.db.prepare("INSERT INTO audit_logs (actor_type, actor_name, action, status) VALUES ('user', 'user', 'fixture-fresh', 'success')").run()

  const before = r.db.prepare('SELECT COUNT(*) AS n FROM audit_logs').get().n
  const result = await r.security.pruneAuditLogs(30)
  assert.equal(result.removed, 3)
  assert.equal(result.remaining, before - 3)
  assert.ok(result.snapshot, '清理前应落 JSON 快照')
  assert.ok(fs.existsSync(result.snapshot), '快照文件应真实存在')
  const snapshot = JSON.parse(fs.readFileSync(result.snapshot, 'utf8'))
  assert.equal(snapshot.count, 3)
  assert.equal(snapshot.retention_days, 30)
  assert.equal(snapshot.rows.length, 3)
  assert.ok(snapshot.rows.every(row => row.action === 'fixture-stale'))

  // —— 无过期数据：不产出快照 ——
  const again = await r.security.pruneAuditLogs(30)
  assert.equal(again.removed, 0)
  assert.equal(again.snapshot, null)

  // —— 省略参数时读取设置值（当前为 30） ——
  r.db.prepare("INSERT INTO audit_logs (action, created_at) VALUES ('fixture-60d', datetime('now', '-60 days'))").run()
  const viaSettings = await r.security.pruneAuditLogs()
  assert.equal(viaSettings.removed, 1, '省略参数应按设置的保留天数清理')
  assert.ok(viaSettings.snapshot)

  console.log('audit-retention 集成测试通过')
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1) })
