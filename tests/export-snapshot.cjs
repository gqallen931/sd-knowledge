/**
 * S2-05 共享与导出（快照导出）：集成测试
 * 覆盖：快照落位与命名、counts 统计、文档脱敏（不含正文与本机路径）、
 * 分块锚点保留溯源、settings 敏感键剥离、密钥/哈希不外发、工作台域随行。
 */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { createRuntime } = require('../dist-electron/services/runtime')

async function main() {
  const root = path.resolve(__dirname, '../.verification', 'run-' + Date.now() + '-export')
  fs.mkdirSync(root, { recursive: true })
  const r = await createRuntime(path.join(root, 'Data'))
  await r.db.updateSettings({ vector_enabled: 'false', ocr_enabled: 'false' })

  const dirA = path.join(root, 'source-a')
  fs.mkdirSync(dirA, { recursive: true })
  const docA = path.join(dirA, '导出文档.md')
  fs.writeFileSync(docA, '# 导出冒烟\n这是用于快照导出冒烟的正文内容。\n')
  const imported = await r.importFiles([docA])
  assert.equal(imported[0].success, true)
  await r.idle()

  // 敏感设置 / 密钥类数据 / 向量：均不应随快照外发
  r.db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('llm.api_key_test', 'sk-SHOULD-NOT-LEAK')").run()
  r.db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('theme', 'dark')").run()
  r.db.prepare("INSERT INTO api_keys (key_hash, key_prefix, name) VALUES ('hash-SHOULD-NOT-LEAK', 'sk_abc', '冒烟密钥')").run()
  r.db.prepare('INSERT INTO vectors (document_id, model, dimension) VALUES (?, ?, ?)').run(imported[0].documentId, 'fake-model', 4)

  // 保存的检索与工作台域数据
  await r.search.saveSearch({ name: '导出榜单', query: '导出冒烟' })
  const groupId = Number(r.db.prepare("INSERT INTO task_groups (name) VALUES ('导出分组')").run().lastInsertRowid)
  r.db.prepare("INSERT INTO tasks (code, group_id, name) VALUES ('T-2001', ?, '导出任务')").run(groupId)

  const result = r.backup.exportSnapshot(r.dataManager)
  assert.ok(result.path.startsWith(path.join(root, 'Data', 'exports')), '快照应落在 Data/exports 下')
  assert.match(result.fileName, /^snapshot-\d{8}-\d{6}\.json$/)
  assert.ok(result.size > 0)
  assert.ok(!Number.isNaN(Date.parse(result.exportedAt)))

  const payload = JSON.parse(fs.readFileSync(result.path, 'utf8'))
  assert.equal(payload.format, 'zhixu-snapshot')
  assert.equal(payload.version, 1)
  assert.equal(payload.counts.documents, 1)
  assert.ok(payload.counts.chunks >= 1)
  assert.equal(payload.counts.savedSearches, 1)
  assert.equal(payload.counts.tasks, 1)

  // 文档脱敏：不含正文与原始绝对路径
  assert.equal(payload.documents.length, 1)
  assert.ok(!('content_text' in payload.documents[0]), '文档正文不应外发')
  assert.ok(!('file_path' in payload.documents[0]), '本机原始路径不应外发')

  // 分块保留锚点（溯源能力）
  assert.ok(payload.chunks.length >= 1)
  for (const chunk of payload.chunks) {
    assert.ok('anchor_kind' in chunk && 'char_start' in chunk && 'char_end' in chunk)
  }

  // settings 剥离敏感键、保留普通键
  assert.ok(!('llm.api_key_test' in payload.settings), '密钥类设置不应外发')
  assert.equal(payload.settings.theme, 'dark')

  // 密钥 / 哈希不外发（文件级断言）
  const raw = fs.readFileSync(result.path, 'utf8')
  assert.ok(!raw.includes('sk-SHOULD-NOT-LEAK'))
  assert.ok(!raw.includes('hash-SHOULD-NOT-LEAK'))
  assert.ok(!('vectors' in payload), '向量数据不外发')

  // 保存的检索：不带指纹与运行状态
  assert.ok(!('result_hash' in payload.savedSearches[0]))
  assert.ok(!('last_run_at' in payload.savedSearches[0]))
  assert.equal(payload.savedSearches[0].query, '导出冒烟')

  // 工作台域随行
  assert.ok(payload.workbench)
  assert.equal(payload.workbench.tasks.length, 1)
  assert.equal(payload.workbench.tasks[0].code, 'T-2001')
  assert.equal(payload.workbench.taskGroups.length, 1)

  console.log('export-snapshot 集成测试通过')
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1) })
