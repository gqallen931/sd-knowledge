/**
 * S2-07 保存的检索：集成测试
 * 覆盖：保存校验（空名/空词）、保存即跑指纹、入库后变更通知（notify_on_change 开/关）、
 * 手动重跑不发通知、重跑不存在的检索报错、删除。
 */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { createRuntime } = require('../dist-electron/services/runtime')

async function main() {
  const root = path.resolve(__dirname, '../.verification', 'run-' + Date.now() + '-saved-search')
  fs.mkdirSync(root, { recursive: true })
  const r = await createRuntime(path.join(root, 'Data'))
  await r.db.updateSettings({ vector_enabled: 'false', ocr_enabled: 'false' })

  const dirA = path.join(root, 'source-a')
  const dirB = path.join(root, 'source-b')
  fs.mkdirSync(dirA, { recursive: true })
  fs.mkdirSync(dirB, { recursive: true })
  const docA = path.join(dirA, '图谱笔记.md')
  fs.writeFileSync(docA, '# 知识图谱\n知识图谱把实体与关系连成网络。\n')
  const importedA = await r.importFiles([docA])
  assert.equal(importedA[0].success, true)
  await r.idle()

  // —— 校验：名称/查询为空是表单应拦下的事，服务层再兜一道底 ——
  await assert.rejects(() => r.search.saveSearch({ name: '  ', query: '知识图谱' }), /请给这条检索起个名字/)
  await assert.rejects(() => r.search.saveSearch({ name: '榜单', query: '' }), /检索词不能为空/)

  // —— 保存即跑一次：指纹与计数就绪，首次保存不算变化（无通知） ——
  const saved = await r.search.saveSearch({ name: '图谱榜单', query: '知识图谱' })
  assert.ok(saved.id)
  assert.ok(saved.result_hash, '保存后应已生成结果指纹')
  assert.equal(saved.last_result_count, 1)
  assert.ok(saved.last_run_at)

  // notify_on_change=false 的对照组
  const quiet = await r.search.saveSearch({ name: '安静榜单', query: '知识图谱', notify_on_change: false })
  assert.equal(quiet.notify_on_change, 0)
  assert.equal(r.db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE title = '保存的检索有更新'").get().n, 0)

  // —— 新文档入库后 checkSavedSearches：notify=1 的发通知，notify=0 的不发 ——
  const docB = path.join(dirB, '图谱实践.md')
  fs.writeFileSync(docB, '# 知识图谱实践\n用知识图谱做归档检索的联动分析。\n')
  const importedB = await r.importFiles([docB])
  assert.equal(importedB[0].success, true)
  await r.idle()
  await r.search.checkSavedSearches()

  const notes = r.db.prepare("SELECT title, message FROM notifications WHERE title = '保存的检索有更新'").all()
  assert.equal(notes.length, 1, '仅 notify_on_change 的保存检索应触发通知')
  assert.match(notes[0].message, /「图谱榜单」/)
  assert.match(notes[0].message, /约 2 条/)

  const refreshed = r.db.prepare('SELECT * FROM saved_searches WHERE id = ?').get(saved.id)
  assert.equal(refreshed.last_result_count, 2)

  // —— 手动重跑：更新指纹但不重复发通知 ——
  const rerun = await r.search.rerunSavedSearch(saved.id)
  assert.equal(rerun.last_result_count, 2)
  assert.ok(rerun.result_hash)
  assert.equal(
    r.db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE title = '保存的检索有更新'").get().n,
    1,
    '手动重跑不应再次通知',
  )

  await assert.rejects(() => r.search.rerunSavedSearch(99999), /保存的检索不存在或已被删除/)

  // —— 删除 ——
  assert.equal(r.search.removeSavedSearch(quiet.id), true)
  assert.equal(r.search.removeSavedSearch(99999), false)
  const list = r.search.listSavedSearches()
  assert.equal(list.length, 1)
  assert.equal(list[0].id, saved.id)

  console.log('saved-search 集成测试通过')
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1) })
