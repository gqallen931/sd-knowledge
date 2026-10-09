const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { createRuntime } = require('../dist-electron/services/runtime')
const { APIServer } = require('../dist-electron/services/apiServer')
const { splitIntoTextChunks, toEmbeddingVectors } = require('../dist-electron/services/processingEngine')
const { splitTextChunksWithSpans } = require('../dist-electron/services/chunks')
async function run() {
  const root = path.resolve(__dirname, '../.verification', 'run-' + Date.now())
  fs.mkdirSync(path.join(root, 'source-a'), { recursive: true })
  fs.mkdirSync(path.join(root, 'source-b'), { recursive: true })
  const r = await createRuntime(path.join(root, 'Data'))
  await r.db.updateSettings({ vector_enabled: 'false', ocr_enabled: 'false' })
  const first = path.join(root, 'source-a', '知识笔记.md')
  const second = path.join(root, 'source-b', '知识笔记.md')
  const csv = path.join(root, 'source-a', '项目表.csv')
  fs.writeFileSync(first, '# 产品设计计划\n张三负责知识图谱的产品设计。联系 design@example.com，评审日期 2026-09-16。John Smith works in London.\nhttps://example.com/design\n')
  fs.writeFileSync(second, '# 开发进度\n李四负责数据库和中文搜索，联系 dev@example.com。版本测试已经完成。\n')
  fs.writeFileSync(csv, '项目,负责人,进度\n知识图谱,张三,进行中\n全文搜索,李四,已完成\n')
  const imported = await r.importFiles([first, second, csv])
  assert.equal(imported.filter(i => i.success).length, 3)
  await r.idle()
  const files = await r.files.listFiles()
  assert.equal(files.length, 3)
  assert(files.every(f => f.processing_status === 'ready'))
  assert.notEqual(files.find(f => f.id === imported[0].documentId).file_path, files.find(f => f.id === imported[1].documentId).file_path)
  const duplicate = await r.importFiles([first])
  assert.equal(duplicate[0].reason, 'duplicate')
  const found = await r.search.fullTextSearch('知识图谱')
  // ADR-002：检索结果统一为信封 { items, total, limit, truncated, scope }
  assert.equal(found.items.length, 2)
  assert.equal(found.total, 2)
  assert.equal(found.truncated, false)
  assert.equal(found.limit, 20)
  assert.equal(found.scope, null)
  assert.equal((await r.search.fullTextSearch('"')).items.length, 0)
  assert.equal((await r.search.fullTextSearch('%')).items.length, 0)
  assert((await r.files.getFileDetail(imported[0].documentId)).entities.length > 0)
  const before = await r.graph.getEdges({ limit: 10000 })
  await r.processing.processDocument(imported[0].documentId)
  assert.equal((await r.graph.getEdges({ limit: 10000 })).items.length, before.items.length)
  const stats = await r.db.getDashboardStats()
  assert.equal(stats.total_files, 3)
  assert.equal(stats.file_types.reduce((n, v) => n + v.value, 0), 3)
  assert.equal(stats.trend.length, 30)
  assert.equal(stats.trend.reduce((n, v) => n + v.files, 0), 3)
  const insert = r.db.prepare("INSERT INTO documents(title,file_name,file_path,file_type,file_size,processing_status) VALUES(?,?,?,?,?,'ready')")
  for (let i = 0; i < 105; i++) insert.run('统计验证'+i, '统计验证'+i+'.txt', 'fixture', 'txt', 10)
  const allStats = await r.db.getDashboardStats()
  assert.equal(allStats.total_files, 108)
  assert.equal(allStats.file_types.find(d => d.name === 'TXT').value, 105)
  r.db.exec("DELETE FROM documents WHERE file_path='fixture'")
  const context = await r.search.getContext('知识图谱', 100)
  assert(context.token_count <= 100)
  const api = new APIServer(r.db, r.files, r.search, r.graph, r.security, r.processing)
  await api.start(18990)
  assert.equal((await fetch('http://127.0.0.1:18990/api/v1/stats')).status, 200)
  await r.security.setup('test-password-only')
  assert.equal((await fetch('http://127.0.0.1:18990/api/v1/stats')).status, 401)
  const key = await r.security.createApiKey('Integration test', 'reader')
  const authorized = await fetch('http://127.0.0.1:18990/api/v1/stats', { headers: { Authorization: 'Bearer ' + key.key } })
  assert.equal(authorized.status, 200)
  // 实体写接口：reader 密钥被拒，writer 密钥可用
  const readerRename = await fetch('http://127.0.0.1:18990/api/v1/entities/1/rename', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + key.key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: '无权限改名' }),
  })
  assert.equal(readerRename.status, 403)
  const writerKey = await r.security.createApiKey('Integration writer', 'writer')
  const writerAuth = { Authorization: 'Bearer ' + writerKey.key, 'Content-Type': 'application/json' }
  const apiEntities = await (await fetch('http://127.0.0.1:18990/api/v1/entities?limit=1', { headers: writerAuth })).json()
  // S0 契约统一：集合端点一律 ResultSet 封套 { items, total, limit, truncated, scope }
  assert.equal(apiEntities.items.length, 1)
  assert.equal(apiEntities.limit, 1)
  assert(apiEntities.total >= 1)
  assert.equal(typeof apiEntities.truncated, 'boolean')
  assert.equal(apiEntities.scope, null)
  const apiRenamed = await (await fetch(`http://127.0.0.1:18990/api/v1/entities/${apiEntities.items[0].id}/rename`, {
    method: 'POST', headers: writerAuth, body: JSON.stringify({ name: 'API 改名验证' }),
  })).json()
  assert.equal(apiRenamed.success, true)
  assert.equal(apiRenamed.entity.name, 'API 改名验证')
  // 源与目标相同 -> 没有可合并实体
  const apiBadMerge = await fetch('http://127.0.0.1:18990/api/v1/entities/merge', {
    method: 'POST', headers: writerAuth, body: JSON.stringify({ source_ids: [apiEntities.items[0].id], target_id: apiEntities.items[0].id }),
  })
  assert.equal(apiBadMerge.status, 400)

  // —— S0 信封化端点的形状核对（全部走 REST，不再按裸数组解析）——
  const restGet = async (path) => (await fetch('http://127.0.0.1:18990' + path, { headers: writerAuth })).json()
  const restDocs = await restGet('/api/v1/documents')
  assert.equal(restDocs.items.length, 3)
  assert.equal(restDocs.total, 3)
  assert.equal(restDocs.limit, 50)
  assert.equal(restDocs.truncated, false)
  assert.equal(restDocs.scope, null)
  const restTags = await restGet('/api/v1/tags')
  assert(Array.isArray(restTags.items) && Number.isFinite(restTags.total))
  const restProjects = await restGet('/api/v1/projects')
  assert(Array.isArray(restProjects.items) && Number.isFinite(restProjects.total))
  const restEntities = await restGet('/api/v1/entities/search?q=%E5%BC%A0')
  assert(Array.isArray(restEntities.items) && Number.isFinite(restEntities.total))
  assert.equal(restEntities.scope, null)
  // 参数校验失败仍应是 400（错误分级：不把入参问题混进 500）
  assert.equal((await fetch('http://127.0.0.1:18990/api/v1/entities/search', { headers: writerAuth })).status, 400)
  assert.equal((await fetch('http://127.0.0.1:18990/api/v1/search', { headers: writerAuth })).status, 400)
  // 单对象端点保持裸对象（契约「二」）
  const restDetail = await restGet('/api/v1/documents/' + restDocs.items[0].id)
  assert.equal(restDetail.id, restDocs.items[0].id)
  assert.equal(Object.prototype.hasOwnProperty.call(restDetail, 'items'), false)
  await r.security.revokeApiKey(writerKey.id)
  await r.security.revokeApiKey(key.id)
  assert.equal((await fetch('http://127.0.0.1:18990/api/v1/stats', { headers: { Authorization: 'Bearer ' + key.key } })).status, 403)
  await api.stop()
  await r.db.updateSettings({ security_enabled: 'false', api_port: '18990' })
  r.db.close()
  const restarted = await createRuntime(path.join(root, 'Data'))
  assert.equal((await restarted.files.listFiles()).length, 3)
  assert.equal((await restarted.search.fullTextSearch('知识图谱')).items.length, 2)
  await restarted.files.deleteFile(imported[0].documentId)
  assert(fs.existsSync(first))
  assert.equal((await restarted.search.fullTextSearch('design@example.com')).items.length, 0)
  assert.equal((await restarted.graph.getEdges({ limit: 10000 })).items.filter(e => e.source_type === 'document' && e.source_id === imported[0].documentId).length, 0)

  // —— 实体重命名 / 批量合并 ——
  const entityIns = restarted.db.prepare('INSERT INTO entities(name,type,description) VALUES(?,?,?)')
  const relIns = restarted.db.prepare("INSERT INTO relationships(source_type,source_id,target_type,target_id,relation_type,weight) VALUES('entity',?,?,?,?,1)")
  const eTarget = Number(entityIns.run('消歧目标', 'person', null).lastInsertRowid)
  const eA = Number(entityIns.run('消歧源A', 'person', null).lastInsertRowid)
  const eB = Number(entityIns.run('消歧源B', 'org', 'B 的描述').lastInsertRowid)
  const eD = Number(entityIns.run('消歧源D', 'person', null).lastInsertRowid)
  const eX = Number(entityIns.run('消歧邻居X', 'person', null).lastInsertRowid)
  const eY = Number(entityIns.run('消歧邻居Y', 'person', null).lastInsertRowid)
  relIns.run(eA, 'entity', eTarget, 'ALIAS')  // 合并后变自环 -> 删除
  relIns.run(eB, 'entity', eTarget, 'ALIAS')  // 合并后变自环 -> 删除
  relIns.run(eA, 'entity', eX, 'RELATED')     // 转移到 目标->X
  relIns.run(eB, 'entity', eX, 'RELATED')     // 与 目标->X 重复 -> 去重
  relIns.run(eD, 'entity', eY, 'RELATED')     // 转移到 目标->Y

  // 实体检索：只返回实体，空关键词返回空
  assert.equal((await restarted.graph.searchEntities('', 10)).length, 0)
  const hitBatch = await restarted.graph.searchEntities('消歧源A', 10)
  assert.equal(hitBatch.length, 1)
  assert.equal(hitBatch[0].node_type, 'entity')
  assert.equal(hitBatch[0].id, eA)

  // 重命名：关系按 id 关联，改名前后的边数一致
  const edgesBeforeRename = (await restarted.graph.getEdges({ limit: 10000 })).items.length
  const renamedEntity = await restarted.graph.renameEntity(eA, '消歧源A（已改名）')
  assert.equal(renamedEntity.success, true)
  assert.equal(renamedEntity.entity.name, '消歧源A（已改名）')
  assert.equal((await restarted.graph.getEdges({ limit: 10000 })).items.length, edgesBeforeRename)
  assert.equal((await restarted.graph.searchEntities('消歧源A（已改名）', 10)).length, 1)
  await assert.rejects(() => restarted.graph.renameEntity(eA, '   '), /不能为空/)
  await assert.rejects(() => restarted.graph.renameEntity(eD, '消歧源A（已改名）'), /请改用合并/)

  // 批量重命名：单项失败（空名称）不影响其余项
  const batchRenamed = await restarted.graph.batchRenameEntities([
    { id: eD, name: '消歧源D（已改名）' },
    { id: eTarget, name: '' },
  ])
  assert.equal(batchRenamed.success, false)
  assert.equal(batchRenamed.renamed, 1)
  assert.equal(batchRenamed.failed.length, 1)
  assert.equal(batchRenamed.failed[0].id, eTarget)
  assert.equal((await restarted.graph.searchEntities('消歧源D（已改名）', 10)).length, 1)

  // 批量合并：多源并入一个目标，事务内完成
  const mergeSources = [eA, eB, eD]
  const placeholders = mergeSources.map(() => '?').join(',')
  const involvedBefore = restarted.db.prepare(
    `SELECT COUNT(*) AS n FROM relationships
     WHERE (source_type = 'entity' AND source_id IN (${placeholders}))
        OR (target_type = 'entity' AND target_id IN (${placeholders}))`
  ).get(...mergeSources, ...mergeSources).n
  assert.equal(involvedBefore, 5)

  const merged = await restarted.graph.mergeEntitiesBatch(mergeSources, eTarget)
  assert.equal(merged.success, true)
  assert.equal(merged.merged, 3)
  assert.equal(merged.mergedInto.id, eTarget)
  assert.equal(merged.moved + merged.deduped, involvedBefore)
  assert.equal(merged.moved, 2)   // 目标->X、目标->Y
  assert.equal(merged.deduped, 3) // 两条自环 + 一条重复边
  // 源实体已删除，目标保留，且继承了源实体的描述
  assert.equal((await restarted.graph.searchEntities('消歧源A（已改名）', 10)).length, 0)
  assert.equal((await restarted.graph.searchEntities('消歧源B', 10)).length, 0)
  assert.equal((await restarted.graph.searchEntities('消歧源D（已改名）', 10)).length, 0)
  assert.equal((await restarted.graph.searchEntities('消歧目标', 10)).length, 1)
  assert.equal(restarted.db.prepare('SELECT description FROM entities WHERE id = ?').get(eTarget).description, 'B 的描述')
  // 没有任何边再指向已删除的源实体
  assert.equal(restarted.db.prepare(
    `SELECT COUNT(*) AS n FROM relationships
     WHERE (source_type = 'entity' AND source_id IN (${placeholders}))
        OR (target_type = 'entity' AND target_id IN (${placeholders}))`
  ).get(...mergeSources, ...mergeSources).n, 0)
  // 目标实体的出边正好是被转移过来的两条，且没有自环、没有重复边
  const targetOut = restarted.db.prepare(
    "SELECT target_id FROM relationships WHERE source_type = 'entity' AND source_id = ?"
  ).all(eTarget).map(r => r.target_id).sort((a, b) => a - b)
  assert.deepEqual(targetOut, [eX, eY].sort((a, b) => a - b))
  assert.equal(restarted.db.prepare(
    `SELECT COUNT(*) AS n FROM (
       SELECT source_type, source_id, target_type, target_id, relation_type FROM relationships
       WHERE (source_type = 'entity' AND source_id = ?) OR (target_type = 'entity' AND target_id = ?)
       GROUP BY source_type, source_id, target_type, target_id, relation_type HAVING COUNT(*) > 1
     )`
  ).get(eTarget, eTarget).n, 0)
  // 参数校验：空列表与不存在的实体
  await assert.rejects(() => restarted.graph.mergeEntitiesBatch([], eTarget), /至少选择一个/)
  await assert.rejects(() => restarted.graph.mergeEntitiesBatch([999999], eTarget), /不存在/)

  // —— 实体消歧候选建议：只读扫描，不自动合并 ——
  const eSugFull = Number(entityIns.run('星尘科技有限公司', 'org', null).lastInsertRowid)
  const eSugPlain = Number(entityIns.run('星尘科技', 'org', null).lastInsertRowid)
  const eSugTiny = Number(entityIns.run('星尘', 'org', null).lastInsertRowid)
  const eSugTypo = Number(entityIns.run('星尘料技', 'org', null).lastInsertRowid)
  const eSugHuman = Number(entityIns.run('星尘', 'person', null).lastInsertRowid)
  const eSugLatin = Number(entityIns.run('Zenithq Inc', 'org', null).lastInsertRowid)
  const eSugLatinShort = Number(entityIns.run('Zenithq', 'org', null).lastInsertRowid)
  const eSugInsCo = Number(entityIns.run('保险公司', 'org', null).lastInsertRowid)
  const eSugIns = Number(entityIns.run('保险', 'org', null).lastInsertRowid)

  const sug = await restarted.graph.suggestEntityMerges({ limit: 200, minScore: 0.6 })
  const findSugIn = (res, a, b) => res.suggestions.find(
    x => (x.source.id === a && x.target.id === b) || (x.source.id === b && x.target.id === a)
  )
  assert(sug.scanned >= 9)

  // 剥离「有限公司」后同名 → exact（归一化生效）
  const pairSuffix = findSugIn(sug, eSugFull, eSugPlain)
  assert(pairSuffix, 'suggest: 剥离机构后缀后同名应被识别')
  assert.equal(pairSuffix.reason, 'exact')
  assert.equal(pairSuffix.score, 1)

  // 拉丁后缀同样剥离：Zenithq Inc ≈ Zenithq
  const pairLatin = findSugIn(sug, eSugLatin, eSugLatinShort)
  assert(pairLatin, 'suggest: 拉丁后缀应被剥离')
  assert.equal(pairLatin.reason, 'exact')

  // 单字「公司」刻意不剥：保险公司 / 保险 只能是 containment，不能是 exact
  const pairIns = findSugIn(sug, eSugInsCo, eSugIns)
  assert(pairIns, 'suggest: 保险/保险公司 应命中包含关系')
  assert.equal(pairIns.reason, 'containment')

  // 包含关系：短名并入长名，方向固定
  const pairContain = findSugIn(sug, eSugTiny, eSugPlain)
  assert(pairContain, 'suggest: 短名应命中包含关系')
  assert.equal(pairContain.reason, 'containment')
  assert.equal(pairContain.source.id, eSugTiny)
  assert.equal(pairContain.target.id, eSugPlain)
  assert.equal(pairContain.score, 0.8)   // 0.6 + 0.4 * 2/4

  // 同名但类型不同也提示（exact 不限 type）
  const pairCrossType = findSugIn(sug, eSugTiny, eSugHuman)
  assert(pairCrossType, 'suggest: 同名不同类型应提示')
  assert.equal(pairCrossType.reason, 'exact')

  // 拼写相近
  const pairTypo = findSugIn(sug, eSugTypo, eSugPlain)
  assert(pairTypo, 'suggest: 拼写相近应提示')
  assert.equal(pairTypo.reason, 'fuzzy')
  assert.equal(pairTypo.score, 0.75)     // 1 - 1/4

  // 只读：重复调用不改变实体总数
  const entitiesBeforeSuggest = restarted.db.prepare('SELECT COUNT(*) AS n FROM entities').get().n
  await restarted.graph.suggestEntityMerges({ limit: 5 })
  assert.equal(restarted.db.prepare('SELECT COUNT(*) AS n FROM entities').get().n, entitiesBeforeSuggest)

  // minScore 过滤：0.9 以上只剩 exact，containment/fuzzy 被排除
  const strict = await restarted.graph.suggestEntityMerges({ limit: 200, minScore: 0.9 })
  assert(strict.suggestions.every(s => s.score >= 0.9))
  assert.equal(findSugIn(strict, eSugTypo, eSugPlain), undefined)
  assert.equal(findSugIn(strict, eSugTiny, eSugPlain), undefined)
  assert(findSugIn(strict, eSugFull, eSugPlain))

  // limit 生效且按 score 降序，超出部分标记 truncated
  const limited = await restarted.graph.suggestEntityMerges({ limit: 1 })
  assert.equal(limited.suggestions.length, 1)
  assert.equal(limited.truncated, true)
  const topN = await restarted.graph.suggestEntityMerges({ limit: 3 })
  assert.equal(topN.suggestions.length, 3)
  assert.equal(topN.suggestions[0].score, 1)   // 最高分必为 exact
  assert(topN.suggestions[0].score >= topN.suggestions[1].score)
  assert(topN.suggestions[1].score >= topN.suggestions[2].score)

  // 分阶段耗时埋点：默认关闭不落盘，开启后写出阶段明细
  const perfLogDir = path.join(root, 'Data', 'logs')
  assert(!fs.existsSync(perfLogDir) || fs.readdirSync(perfLogDir).filter(f => f.startsWith('perf-')).length === 0)
  await restarted.db.updateSettings({ perf_log_enabled: 'true' })
  const perfSource = path.join(root, 'source-a', '耗时埋点.md')
  fs.writeFileSync(perfSource, '# 性能埋点\n张三负责知识图谱设计，联系 design@example.com。\n'.repeat(20))
  await restarted.importFiles([perfSource])
  await restarted.idle()
  const perfFiles = fs.readdirSync(perfLogDir).filter(f => f.startsWith('perf-'))
  assert.equal(perfFiles.length, 1)
  const perfLine = fs.readFileSync(path.join(perfLogDir, perfFiles[0]), 'utf-8').trim()
  assert(perfLine.includes('[perf] process'))
  assert(perfLine.includes('extract='))
  assert(perfLine.includes('total='))

  // 分块：定长窗口 + 固定重叠，拼接后必须无损还原原文
  const plain = 'a'.repeat(1000)
  const parts = splitIntoTextChunks(plain, 100, 20)
  assert.equal(parts.length, 13)
  assert.equal(parts[0].length, 100)
  for (let i = 1; i < parts.length; i++) {
    assert.equal(parts[i - 1].slice(-20), parts[i].slice(0, 20))
  }
  let rebuilt = parts[0]
  for (let i = 1; i < parts.length; i++) rebuilt += parts[i].slice(20)
  assert.equal(rebuilt, plain)

  // 分块：窗口右界落在句子中间时向后吸附到句号
  const snapText = '甲'.repeat(101) + '。' + '乙'.repeat(300)
  const snapped = splitIntoTextChunks(snapText, 100, 20)
  assert.equal(snapped[0].slice(-1), '。')
  assert(snapped[0].length > 100 && snapped[0].length <= 125)

  // 分块：边界用例（空文本 / 短文本 / 重叠被夹到半窗口，不能死循环）
  assert.deepEqual(splitIntoTextChunks('', 100, 20), [])
  assert.deepEqual(splitIntoTextChunks('   ', 100, 20), [])
  assert.deepEqual(splitIntoTextChunks('短文本', 100, 20), ['短文本'])
  assert.equal(splitIntoTextChunks(plain, 100, 200).length, 19)

  // —— 块级溯源（S0-14 / D8）：迁移落位、块与偏移自洽、锚点不编造 ——
  assert.equal(
    restarted.db.prepare('SELECT name FROM schema_migrations WHERE version = 2').get().name,
    'chunks-and-vector-chunk-link',
  )
  const vectorColumns = restarted.db.prepare('PRAGMA table_info(vectors)').all().map(column => column.name)
  assert(vectorColumns.includes('chunk_id') && vectorColumns.includes('chunk_index'))
  const chunkRows = restarted.db.prepare(`
    SELECT c.*, d.content_text, d.file_name FROM chunks c
    JOIN documents d ON d.id = c.document_id ORDER BY c.document_id, c.chunk_index
  `).all()
  assert(chunkRows.length >= 2)
  for (const row of chunkRows) {
    // 块正文必须等于正文的对应区间：偏移错了这里就会露馅
    assert.equal(row.content, row.content_text.slice(row.char_start, row.char_end))
    assert.equal(row.token_count, Math.ceil(row.content.length / 2))
    assert.equal(row.chunk_size, 512)
    assert.equal(row.chunk_overlap, 50)
    // md/csv 给不出页码/时间这类锚点，按契约保持 NULL——不编造
    assert.equal(row.anchor_kind, null)
    assert(!row.content_text.includes('\r\n'))
  }
  // 每篇文档的块序号从 0 连续，且最后一块覆盖到正文末尾
  for (const docId of new Set(chunkRows.map(row => row.document_id))) {
    const rows = chunkRows.filter(row => row.document_id === docId)
    assert.deepEqual(rows.map(row => row.chunk_index), rows.map((_, index) => index))
    assert.equal(rows[rows.length - 1].char_end, rows[0].content_text.length)
  }
  // 文档被删除时块随之级联清理（不留孤儿块）
  assert.equal(restarted.db.prepare(`
    SELECT COUNT(*) AS n FROM chunks c
    WHERE NOT EXISTS (SELECT 1 FROM documents d WHERE d.id = c.document_id)
  `).get().n, 0)

  // —— 存量回填（P-a 确定性重建）：可重入、幂等、偏移与分块函数逐字一致 ——
  const legacyText = Array.from({ length: 30 }, (_, i) => `第${i}段：存量回填验证文本，用于确认确定性重建与知识图谱引用。`).join('\r\n')
  const legacyId = Number(restarted.db.prepare(`
    INSERT INTO documents (title, file_name, file_path, file_type, file_size, storage_type, content_text, processing_status, is_available)
    VALUES ('存量回填','legacy.md','D:/legacy.md','md',10,'local',?,'ready',1)
  `).run(legacyText).lastInsertRowid)
  await restarted.db.updateSettings({ chunks_backfill_done: 'false' })
  const backfillFirst = await restarted.chunkBackfill.run({ force: true })
  assert(backfillFirst.rebuilt >= 1)
  assert.equal(backfillFirst.failed, 0)
  const legacyChunks = restarted.db.prepare('SELECT * FROM chunks WHERE document_id = ? ORDER BY chunk_index').all(legacyId)
  assert(legacyChunks.length > 0)
  // 存量正文含 \r\n：回填必须先把正文归一化，否则偏移整体错位
  const legacyNormalized = restarted.db.prepare('SELECT content_text FROM documents WHERE id = ?').get(legacyId).content_text
  assert(!legacyNormalized.includes('\r\n'))
  assert.deepEqual(
    legacyChunks.map(row => [row.chunk_index, row.char_start, row.char_end, row.content]),
    splitTextChunksWithSpans(legacyNormalized, 512, 50).map(row => [row.chunk_index, row.char_start, row.char_end, row.content]),
  )
  // 幂等：再跑一次没有可回填的行（全部已有块）
  const backfillSecond = await restarted.chunkBackfill.run()
  assert.equal(backfillSecond.scanned, 0)
  assert.equal(backfillSecond.rebuilt, 0)

  // —— RRF 混合检索（S0-11 / D10）：仍返回 ResultSet 封套，截断如实 ——
  // 此时 vector_enabled=false ⇒ 语义通道不可用，混合检索必须降级但仍给出可用的全文结果
  const hybridNoVector = await restarted.search.hybridSearch('知识图谱', { limit: 1 })
  assert.equal(hybridNoVector.items.length, 1)
  assert(hybridNoVector.total >= 2)
  assert.equal(hybridNoVector.truncated, true)
  assert.equal(hybridNoVector.truncated_reason, 'limit')
  assert.deepEqual(hybridNoVector.channels, { fulltext: true, semantic: false })
  assert.equal(hybridNoVector.total_is_approx, true)
  const hybridTop = hybridNoVector.items[0]
  assert.equal(hybridTop.score_parts.rank_fulltext, 1)
  assert.equal(hybridTop.score_parts.rank_semantic, null)
  assert(hybridTop.matched_chunk.content.includes('知识图谱'))
  // 块级出处随结果回传（锚点为空是这类纯文本的正常形态，不是伪造的页码）
  assert(Number.isInteger(hybridTop.anchor.chunk_id) && hybridTop.anchor.chunk_id > 0)
  assert.equal(hybridTop.anchor.anchor_kind, null)
  assert.equal(hybridTop.search_mode, 'hybrid')
  // getContext 也走同一条混合路径，并保留 token 预算的截断原因
  const hybridContext = await restarted.search.getContext('知识图谱', 100)
  assert(hybridContext.token_count <= 100)
  assert(hybridContext.documents.length >= 1)
  restarted.db.prepare('DELETE FROM documents WHERE id = ?').run(legacyId)

  // 批推理输出解析：单条 / 批量维度识别，不支持批量的形状返回空数组以触发回退
  assert.equal(toEmbeddingVectors({ data: new Float32Array(512), dims: [1, 512] }, 1).length, 1)
  assert.equal(toEmbeddingVectors({ data: new Float32Array(512), dims: [512] }, 1).length, 1)
  assert.equal(toEmbeddingVectors({ data: new Float32Array(3 * 512), dims: [3, 512] }, 3).length, 3)
  assert.equal(toEmbeddingVectors({ data: new Float32Array(512), dims: [512] }, 8).length, 0)
  assert.equal(toEmbeddingVectors({ data: new Float32Array(0), dims: [0] }, 1).length, 0)

  // 标签差异写入：去重 -> 幂等 -> 移除已消失的标签，且不重复建 tag 行
  const tagDoc = imported[1].documentId
  const tagNames = () => restarted.db.prepare(
    'SELECT t.name AS name FROM document_tags dt JOIN tags t ON t.id = dt.tag_id WHERE dt.document_id = ?'
  ).all(tagDoc).map(r => r.name).sort()
  const tagLinks = () => restarted.db.prepare('SELECT COUNT(*) AS n FROM document_tags WHERE document_id = ?').get(tagDoc).n
  const tagRows = () => restarted.db.prepare('SELECT COUNT(*) AS n FROM tags').get().n

  restarted.processing.syncDocumentTags(tagDoc, ['标签甲', '标签乙', '标签甲'], null)
  assert.deepEqual(tagNames(), ['标签甲', '标签乙'].sort())
  assert.equal(tagLinks(), 2)

  const tagRowsAfterFirst = tagRows()
  restarted.processing.syncDocumentTags(tagDoc, ['标签乙', '标签甲'], null)
  assert.deepEqual(tagNames(), ['标签甲', '标签乙'].sort())
  assert.equal(tagLinks(), 2)
  assert.equal(tagRows(), tagRowsAfterFirst)

  restarted.processing.syncDocumentTags(tagDoc, ['标签丙'], null)
  assert.deepEqual(tagNames(), ['标签丙'])
  assert.equal(tagLinks(), 1)

  // —— 目录映射：扫描预览 -> 首轮入库 -> 差集同步 -> 软删除/恢复 -> 参数复用 -> 清理 ——
  const mapRoot = path.join(root, 'mapped')
  fs.mkdirSync(path.join(mapRoot, '子目录'), { recursive: true })
  fs.mkdirSync(path.join(mapRoot, 'node_modules'), { recursive: true })
  fs.writeFileSync(path.join(mapRoot, 'a.md'), '# 映射文档A\n张三负责目录增量同步。\n')
  fs.writeFileSync(path.join(mapRoot, '子目录', 'b.md'), '# 映射文档B\n李四负责向量检索。\n')
  fs.writeFileSync(path.join(mapRoot, 'ignore.log'), 'not a knowledge file')
  fs.writeFileSync(path.join(mapRoot, 'node_modules', 'hidden.md'), '# 依赖目录内的文件应被忽略\n')

  // 预览只统计不写库：.log 不支持、node_modules 按默认规则忽略
  const preview = await restarted.folderSources.previewScan(mapRoot)
  assert.equal(preview.alreadyMapped, false)
  assert.equal(preview.newFiles, 2)
  assert(preview.stats.unsupported >= 1)
  assert(preview.stats.ignored >= 1)
  assert.equal((await restarted.files.listFiles({ search: '映射文档' })).length, 0)

  const created = await restarted.folderSources.createSource({ rootPath: mapRoot, name: '映射验证' })
  assert.equal(created.source.storage_mode, 'reference')
  assert.equal(created.sync.added, 2)
  assert.equal(created.sync.enqueued, 2)
  await restarted.idle()
  const mapped = await restarted.files.listFiles({ source_id: created.source.id })
  assert.equal(mapped.length, 2)
  assert(mapped.every(f => f.processing_status === 'ready' && f.storage_type === 'reference'))
  assert(mapped.some(f => f.relative_path === '子目录/b.md'))
  assert.equal(mapped.find(f => f.relative_path === 'a.md').source_name, '映射验证')
  assert.equal((await restarted.files.getFileDetail(mapped.find(f => f.relative_path === 'a.md').id)).content_text.includes('目录增量同步'), true)
  await assert.rejects(() => restarted.folderSources.createSource({ rootPath: mapRoot }), /已建立映射/)

  // 无变化的二次同步：全部保持不变，不重复入队
  const idleSync = await restarted.folderSources.syncSource(created.source.id)
  assert.equal(idleSync.added, 0)
  assert.equal(idleSync.updated, 0)
  assert.equal(idleSync.unchanged, 2)
  assert.equal(idleSync.enqueued, 0)

  // 差集：内容变更 + 新增 + 消失同时发生
  const aPath = path.join(mapRoot, 'a.md')
  fs.writeFileSync(aPath, '# 映射文档A（已更新）\n张三负责目录增量同步与失效清理。\n')
  fs.writeFileSync(path.join(mapRoot, 'd.txt'), '映射新增文件，王五负责队列并发度。\n')
  fs.rmSync(path.join(mapRoot, '子目录', 'b.md'))
  const delta = await restarted.folderSources.syncSource(created.source.id)
  assert.equal(delta.updated, 1)
  assert.equal(delta.added, 1)
  assert.equal(delta.removed, 1)
  await restarted.idle()

  const aDoc = mapped.find(f => f.relative_path === 'a.md').id
  const aDetail = await restarted.files.getFileDetail(aDoc)
  assert.equal(aDetail.version, 2)
  assert.equal(aDetail.content_text.includes('失效清理'), true)
  assert.equal(aDetail.summary === null || typeof aDetail.summary === 'string', true)

  // 软删除：列表默认隐藏，可显式查看；文件回归后自动恢复
  assert.equal((await restarted.files.listFiles()).filter(f => f.relative_path === '子目录/b.md').length, 0)
  const missing = await restarted.files.listFiles({ availability: 'unavailable', source_id: created.source.id })
  assert.equal(missing.length, 1)
  assert.equal(missing[0].relative_path, '子目录/b.md')
  fs.writeFileSync(path.join(mapRoot, '子目录', 'b.md'), '# 映射文档B\n李四负责向量检索。\n')
  const restored = await restarted.folderSources.syncSource(created.source.id)
  assert.equal(restored.restored, 1)
  assert.equal(restored.added, 0)
  assert.equal(restored.enqueued, 0)

  // 同内容文件复用已解析参数：直接 ready，不进推理队列
  fs.copyFileSync(aPath, path.join(mapRoot, 'a-copy.md'))
  const reuse = await restarted.folderSources.syncSource(created.source.id)
  assert.equal(reuse.added, 1)
  assert.equal(reuse.reused, 1)
  assert.equal(reuse.enqueued, 0)
  const copyDoc = (await restarted.files.listFiles({ search: 'a-copy.md' }))[0]
  assert.equal(copyDoc.processing_status, 'ready')
  assert.equal((await restarted.files.getFileDetail(copyDoc.id)).content_text.includes('失效清理'), true)

  // 失效清理：先软删除，再物理清理解析结果
  fs.rmSync(path.join(mapRoot, 'a-copy.md'))
  const gone = await restarted.folderSources.syncSource(created.source.id)
  assert.equal(gone.removed, 1)
  const afterGone = (await restarted.folderSources.listSources()).find(s => s.id === created.source.id)
  assert.equal(afterGone.missing_count, 1)
  assert.equal(afterGone.doc_count, 3)
  assert.equal((await restarted.folderSources.cleanupUnavailable(created.source.id)).removed, 1)
  assert.equal((await restarted.files.listFiles({ search: 'a-copy.md' })).length, 0)

  // 复制模式：副本落在软件数据目录，与源目录解耦
  const copyRoot = path.join(root, 'mapped-copy')
  fs.mkdirSync(copyRoot, { recursive: true })
  fs.writeFileSync(path.join(copyRoot, 'e.md'), '# 副本模式\n赵六负责备份策略。\n')
  const copySource = await restarted.folderSources.createSource({ rootPath: copyRoot, storageMode: 'copy', excludeGlobs: '*.tmp' })
  await restarted.idle()
  const copyFiles = await restarted.files.listFiles({ source_id: copySource.source.id })
  assert.equal(copyFiles.length, 1)
  assert.equal(copyFiles[0].storage_type, 'local')
  assert.equal(copyFiles[0].file_path.startsWith(path.join(root, 'Data')), true)
  assert.notEqual(copyFiles[0].file_path, path.join(copyRoot, 'e.md'))

  // 移除映射：默认保留解析内容，仅解除归属
  await restarted.folderSources.removeSource(copySource.source.id)
  assert.equal((await restarted.folderSources.listSources()).length, 1)
  const detached = await restarted.files.listFiles({ search: 'e.md' })
  assert.equal(detached.length, 1)
  assert.equal(detached[0].source_id, null)
  assert.equal(detached[0].processing_status, 'ready')

  // 启动同步：syncAllSources 对已启用来源执行差集
  const bulk = await restarted.folderSources.syncAllSources()
  assert.equal(bulk.synced, 1)
  assert.equal(bulk.errors.length, 0)
  await restarted.idle()

  // ==================== ADR-002 第一梯队：统一作用域 ====================
  // 目录树：入库时按 relative_path 派生，计数是递归的（祖先目录包含子目录的文档）
  const tree = await restarted.folderSources.listFolders(created.source.id)
  assert.equal(tree.every(f => f.source_id === created.source.id), true)
  assert.equal(tree.find(f => f.path === '').doc_count, 3)
  assert.equal(tree.find(f => f.path === '子目录').doc_count, 1)
  assert.equal(tree.find(f => f.path === '子目录').parent_id, tree.find(f => f.path === '').id)
  // 全局列表：不传 source 时跨空间汇总
  assert.equal((await restarted.folderSources.listFolders()).length >= tree.length, true)

  // 作用域正交组合：source_id（空间）× folder_path（目录前缀），返回值回带 scope 描述
  const scopedSpace = await restarted.search.fullTextSearch('目录增量同步', { source_id: created.source.id })
  assert.equal(scopedSpace.items.length, 1)
  assert.equal(scopedSpace.scope.source_id, created.source.id)
  assert.equal(scopedSpace.scope.source_name, '映射验证')
  const scopedFolder = await restarted.search.fullTextSearch('目录增量同步', { source_id: created.source.id, folder_path: '子目录' })
  assert.equal(scopedFolder.items.length, 0)
  assert.equal(scopedFolder.scope.folder_path, '子目录')
  // 目录前缀是「包含子目录」而非精确匹配
  assert.equal((await restarted.files.listFiles({ source_id: created.source.id, folder_path: '子目录' })).length, 1)
  assert.equal(await restarted.files.countFiles({ source_id: created.source.id, folder_path: '子目录' }), 1)
  assert.equal(await restarted.files.countFiles({ source_id: created.source.id }), 3)
  // 不带作用域时行为与旧版一致（scope 为 null，不额外过滤）
  assert.equal((await restarted.search.fullTextSearch('目录增量同步')).scope, null)

  // ==================== ADR-002 第二梯队：图谱分级 ====================
  // 再造一个空间，与「映射验证」共享实体，才能验证跨域桥。
  // 共享实体刻意用**邮箱**：它由确定性正则抽取，不依赖 nodejieba 之类的可选 NLP 依赖是否装得上。
  const SHARED_EMAIL = 'shared-bridge@example.com'
  fs.writeFileSync(path.join(mapRoot, 'bridge.md'), `# 桥接来源\n共享联系人 ${SHARED_EMAIL}。\n`)
  await restarted.folderSources.syncSource(created.source.id)
  await restarted.idle()

  const bridgeRoot = path.join(root, 'bridge-root')
  fs.mkdirSync(bridgeRoot, { recursive: true })
  fs.writeFileSync(path.join(bridgeRoot, 'c.md'), `# 桥接文档\n共享联系人 ${SHARED_EMAIL}，另见跨空间的知识图谱梳理。\n`)
  await restarted.folderSources.createSource({ rootPath: bridgeRoot, name: '桥接验证' })
  await restarted.idle()

  // L0：空间折叠总览——节点只有空间，边只表达「两个空间共享了实体」
  const overview = await restarted.graph.getOverview()
  const l0SpaceNodes = overview.nodes.filter(n => !n.unassigned)
  const l0UnassignedNodes = overview.nodes.filter(n => n.unassigned)
  assert.equal(l0SpaceNodes.length, 2)
  assert.equal(overview.nodes.every(n => n.node_type === 'space'), true)
  assert.equal(l0SpaceNodes.every(n => typeof n.space_id === 'number'), true)
  assert.equal(l0SpaceNodes.find(n => n.space_id === created.source.id).doc_count, 4)
  assert.equal(l0SpaceNodes.find(n => n.label === '桥接验证').doc_count, 1)
  assert.equal(overview.truncated, false)

  // 回归：逐份导入（不属于任何映射空间）的文档也必须在 L0 里有落脚点。
  // 漏掉它们时 L0 会渲染成「暂无图谱数据」，而统计面板照常把这批文档计入——
  // 同一份数据，两张页面自相矛盾。此处用「折叠总数 === 统计总数」把不变量钉死。
  const l0Stats = await restarted.graph.getStats()
  assert.equal(overview.nodes.reduce((sum, n) => sum + n.doc_count, 0), l0Stats.documents)
  assert.equal(l0UnassignedNodes.length, 1)
  assert.equal(l0UnassignedNodes[0].label, '未归入空间')
  assert.equal(l0UnassignedNodes[0].space_id, null)
  const unassignedCount = await restarted.files.countFiles({ unassigned: true })
  assert(unassignedCount > 0)
  assert.equal(l0UnassignedNodes[0].doc_count, unassignedCount)

  // 下钻入口：unassigned 作用域只圈「不属于任何空间」的文档，列表与计数口径一致
  const unassignedDocs = await restarted.files.listFiles({ unassigned: true })
  assert.equal(unassignedDocs.length, unassignedCount)
  assert.equal(unassignedDocs.every(d => d.source_id == null), true)
  const unassignedGraph = await restarted.graph.getNodes({ unassigned: true })
  assert.equal(unassignedGraph.items.every(n => n.node_type !== 'space'), true)
  assert.equal(unassignedGraph.items.length > 0, true)
  assert.equal(unassignedGraph.scope.unassigned, true)
  assert.equal(unassignedGraph.scope.source_id, null)
  // 与 source_id 互斥：同时给出时以 unassigned 为准（否则两个条件会互相掐死成空集）
  assert.equal(await restarted.files.countFiles({ source_id: created.source.id, unassigned: true }), unassignedCount)
  // 守卫：作用域描述里 unassigned 必须是布尔，别让 Agent 收到 undefined
  assert.equal((await restarted.graph.getNodes({ source_id: created.source.id })).scope.unassigned, false)
  assert(overview.edges.length >= 1)
  assert.equal(overview.edges.find(e => e.relation_type === 'SHARED_ENTITY').weight, 1)
  assert.equal(overview.edges.every(e => e.relation_type === 'SHARED_ENTITY'), true)
  assert(overview.edges.every(e => e.source.startsWith('s') && e.target.startsWith('s')), true)

  // 跨域桥：本空间与其他空间共享的实体，附「谁提到了它」
  const bridges = await restarted.graph.getBridges({ source_id: created.source.id })
  assert.equal(bridges.items.length, 1)
  assert.equal(bridges.items[0].name, SHARED_EMAIL)
  assert.equal(bridges.items[0].type, 'email')
  assert.equal(bridges.items[0].spaces, 2)
  assert.equal(bridges.items[0].space_refs.length, 2)
  assert.equal(bridges.items[0].space_refs.some(r => r.source_id === created.source.id), true)
  assert.equal(bridges.items[0].space_refs.every(r => r.mentions >= 1), true)
  // 从这个空间出发，桥一定指向别的空间；反向查也能看到自己
  const reverse = await restarted.graph.getBridges({})
  assert.equal(reverse.items.length, 1)
  assert.equal(reverse.items[0].space_refs.length, 2)

  // L1：空间内部的节点/边只包含该空间——这正是「分级」相对「一次性拉全库」的意义
  const spaceNodes = await restarted.graph.getNodes({ source_id: created.source.id })
  const spaceDocs = spaceNodes.items.filter(n => n.node_type === 'document')
  assert.equal(spaceDocs.length, 4)
  assert.equal(spaceDocs.every(n => n.source_id === created.source.id), true)
  const spaceEdges = await restarted.graph.getEdges({ source_id: created.source.id })
  const spaceDocIds = new Set(spaceDocs.map(d => d.id))
  const spaceEntityIds = new Set(spaceNodes.items.filter(n => n.node_type === 'entity').map(e => e.id))
  const spaceTagIds = new Set(spaceNodes.items.filter(n => n.node_type === 'tag').map(t => t.id))
  const inScope = (type, id) =>
    type === 'document' ? spaceDocIds.has(id)
      : type === 'entity' ? spaceEntityIds.has(id)
        : type === 'tag' ? spaceTagIds.has(id)
          : false
  // L1 的边语义是「与这个空间相关」，而不是「两个端点都关在空间里」：
  // 空间内的实体连到空间外的文档，正是 L1 里能看见一部分跨域桥的原因。
  assert.equal(spaceEdges.items.every(e => inScope(e.source_type, e.source_id) || inScope(e.target_type, e.target_id)), true)
  assert.equal(spaceEdges.items.some(e => e.source_type === 'document' && !spaceDocIds.has(e.source_id)), true)
  // 但空间内的文档端点必须全都属于该空间
  assert.equal(spaceEdges.items.filter(e => e.source_type === 'document' && e.target_type === 'entity')
    .every(e => spaceDocIds.has(e.source_id) || spaceEntityIds.has(e.target_id)), true)
  // 目录作用域继续下钻到 L1.5
  const folderNodes = await restarted.graph.getNodes({ source_id: created.source.id, folder_path: '子目录' })
  assert.equal(folderNodes.items.filter(n => n.node_type === 'document').length, 1)

  // 实体作用域：全局实体池按「哪些文档提到过它」反查，范围收窄后总数必须变小
  const allEntities = await restarted.graph.getEntities({ limit: 2000 })
  const spaceEntities = await restarted.graph.getEntities({ source_id: created.source.id, limit: 2000 })
  assert(spaceEntities.total > 0)
  assert(spaceEntities.total < allEntities.total)
  assert.equal(spaceEntities.items.every(e => e.node_type === 'entity'), true)
  assert.equal(spaceEntities.scope.source_id, created.source.id)

  // 截断从「静默丢弃」变为「显式告知」
  const capped = await restarted.graph.getEdges({ limit: 1 })
  assert.equal(capped.items.length, 1)
  assert.equal(capped.truncated, true)
  assert.equal(capped.truncated_reason, 'limit')
  assert(capped.total > 1)
  assert.equal((await restarted.graph.getEdges({ limit: 1 })).limit, 1)
  assert(Number.isFinite(capped.total))

  // 解析队列：并发 N + 优先级出队（长文档推理期间不再让后续小文件干等）
  const { ProcessingQueue, QUEUE_PRIORITY } = require('../dist-electron/services/processingQueue')
  const tick = () => new Promise(resolve => setTimeout(resolve, 0))
  {
    const started = []
    const releases = []
    const queue = new ProcessingQueue({
      concurrency: 1,
      run: id => new Promise(resolve => { started.push(id); releases.push(resolve) }),
    })
    assert.equal(queue.enqueue(1, QUEUE_PRIORITY.import), true)
    queue.enqueue(2, QUEUE_PRIORITY.import)
    queue.enqueue(3, QUEUE_PRIORITY.batch)
    // 已在处理中的同一文档：只提升优先级，不重复执行
    assert.equal(queue.enqueue(1, QUEUE_PRIORITY.manual), false)
    await tick()
    assert.deepEqual(started, [1])
    // 3 号由 batch 提升为 manual，应插到同为 import 的 2 号前面
    assert.equal(queue.enqueue(3, QUEUE_PRIORITY.manual), false)
    releases.shift()()
    await tick()
    assert.deepEqual(started, [1, 3])
    assert.equal(queue.status().waiting, 1)
    releases.shift()()
    await tick()
    assert.deepEqual(started, [1, 3, 2])
    releases.shift()()
    await queue.idle()
    assert.deepEqual(queue.status(), { running: 0, waiting: 0, concurrency: 1 })
  }
  {
    // 并发上限：同时进行中的任务数不超过 concurrency，完成后立即补位
    const pending = new Map()
    const queue = new ProcessingQueue({
      concurrency: 2,
      run: id => new Promise(resolve => pending.set(id, resolve)),
    })
    for (const id of [11, 12, 13, 14]) queue.enqueue(id)
    await tick()
    assert.equal(queue.active, 2)
    assert.equal(queue.status().waiting, 2)
    pending.get(11)()
    await tick()
    assert.equal(queue.active, 2)
    assert.equal(queue.status().waiting, 1)
    pending.get(12)()
    pending.get(13)()
    await tick()
    pending.get(14)()
    await queue.idle()
    assert.equal(queue.active, 0)
  }
  {
    // 持久化：优先级随 processing_queue 落库，断点续传按优先级还原出队顺序
    // 不能用 imported[0]：它已在「删除清理」断言中被物理删除，
    // processing_queue.document_id → documents(id) 外键会拒绝入队（且 markQueued 静默吞错）
    const target = imported[1].documentId
    const other = imported[2].documentId
    restarted.db.unmarkQueued(target)
    restarted.db.unmarkQueued(other)
    restarted.db.markQueued(target, QUEUE_PRIORITY.batch)
    restarted.db.markQueued(other, QUEUE_PRIORITY.manual)
    const tasks = restarted.db.getQueuedTasks()
    assert.deepEqual(tasks.map(t => t.documentId), [other, target])
    assert.equal(tasks[0].priority, QUEUE_PRIORITY.manual)
    // 重复入队只提升优先级，不降级
    restarted.db.markQueued(target, QUEUE_PRIORITY.manual)
    restarted.db.markQueued(target, QUEUE_PRIORITY.batch)
    assert.equal(restarted.db.getQueuedTasks().find(t => t.documentId === target).priority, QUEUE_PRIORITY.manual)
    restarted.db.unmarkQueued(target)
    restarted.db.unmarkQueued(other)
    assert.equal(restarted.db.getQueuedTasks().length, 0)
    // 运行时并发度可调，默认 2（串行 1 为旧行为）
    assert.equal((await restarted.db.getSettings()).queue_concurrency, '2')
    assert.deepEqual(restarted.queueStatus(), { running: 0, waiting: 0, concurrency: 2 })
    restarted.setQueueConcurrency(3)
    assert.equal(restarted.queueStatus().concurrency, 3)
    restarted.setQueueConcurrency(2)
  }

  // ==================== ADR-002 P2：向量索引落盘 ====================
  {
    const { VectorIndex } = require('../dist-electron/services/vectorIndex')
    const SNAP_DIR = path.join(root, 'Data', 'indexes')
    const MODEL = 'snapshot-test-model'
    const DIM = 4
    const vecIds = restarted.db.prepare(
      'SELECT id FROM documents WHERE is_available = 1 ORDER BY id LIMIT 3'
    ).all().map(row => row.id)
    assert.equal(vecIds.length, 3)
    const insertVec = restarted.db.prepare(
      'INSERT INTO vectors (document_id, embedding, model, dimension) VALUES (?, ?, ?, ?)'
    )
    const seeded = [
      Float32Array.from([1, 0, 0, 0]),
      Float32Array.from([0, 1, 0, 0]),
      Float32Array.from([0.9, 0.1, 0, 0]),
    ]
    seeded.forEach((vec, i) => insertVec.run(vecIds[i], Buffer.from(vec.buffer), MODEL, DIM))
    const query = Float32Array.from([1, 0, 0, 0])

    const first = new VectorIndex(restarted.db, path.join(root, 'Data'))
    let hits = first.search(MODEL, query, 3)
    assert.equal(hits.length, 3)
    assert.equal(hits[0].document_id, vecIds[0])
    first.flush()

    // 快照真的落到盘上，且头部记录的维度/条数与实际一致
    const snapFiles = fs.readdirSync(SNAP_DIR).filter(f => f.endsWith('.bin'))
    assert.equal(snapFiles.length, 1)
    const snap = fs.readFileSync(path.join(SNAP_DIR, snapFiles[0]))
    assert.equal(snap.toString('latin1', 0, 4), 'SDVX')
    const snapHeaderLen = snap.readUInt32LE(8)
    const snapHeader = JSON.parse(snap.toString('utf8', 12, 12 + snapHeaderLen).replace(/\u0000+$/, ''))
    assert.equal(snapHeader.model, MODEL)
    assert.equal(snapHeader.dim, DIM)
    assert.equal(snapHeader.n, 3)
    assert.deepEqual(snapHeader.deleted, [])

    // 冷启动命中快照的判别性验证：先把 DB 里那条向量弄坏。
    // 走快照 → 仍能返回 3 条；一旦退化成从 DB 重建 → 坏掉的那条会在解析时被跳过，只剩 2 条。
    restarted.db.prepare('UPDATE vectors SET embedding = ? WHERE document_id = ?')
      .run(Buffer.from([0, 0, 0, 0]), vecIds[1])
    const second = new VectorIndex(restarted.db, path.join(root, 'Data'))
    hits = second.search(MODEL, query, 3)
    assert.equal(hits.length, 3, '冷启动应从快照加载，而不是回退 DB 重建')

    // 快照过期（DB 行数已变）必须丢弃重建，哪怕文件还在——正确性优先于命中率
    restarted.db.prepare('DELETE FROM vectors WHERE document_id = ?').run(vecIds[2])
    const third = new VectorIndex(restarted.db, path.join(root, 'Data'))
    hits = third.search(MODEL, query, 3)
    assert.equal(hits.length, 1, '快照与 DB 行数不一致时应丢弃快照重建')
    assert.equal(hits[0].document_id, vecIds[0])

    restarted.db.prepare('DELETE FROM vectors WHERE model = ?').run(MODEL)
  }

  // ==================== ADR-002 P3：项目内批量迁移 ====================
  {
    const pA = await restarted.files.createProject('批量迁移A', '测试用', '#6366f1')
    const pB = await restarted.files.createProject('批量迁移B', '测试用', '#06b6d4')
    const docA = imported[1].documentId
    const docB = imported[2].documentId

    // 单事务批量指派：updated 就是真正改了归属的行数
    let res = await restarted.files.assignManyToProject([docA, docB], pA)
    assert.deepEqual(res, { updated: 2, skipped: 0, projectId: pA })
    // 重复指派不该被算成更新，否则界面会虚报「迁移了 N 份」
    res = await restarted.files.assignManyToProject([docA, docB], pA)
    assert.equal(res.updated, 0)
    assert.equal(res.skipped, 2)
    // 去重：同一个 id 传两次只算一次
    res = await restarted.files.assignManyToProject([docA, docA, docB], pB)
    assert.equal(res.updated, 2)
    // 不存在的文档计入 skipped 而非抛错——拖到已被删除的行不应该炸掉整次操作
    res = await restarted.files.assignManyToProject([docA, 999999], null)
    assert.equal(res.updated, 1)
    assert.equal(res.skipped, 1)
    // 目标项目不存在必须报错，而不是把文档挂到不存在的项目上
    await assert.rejects(() => restarted.files.assignManyToProject([docA], 999999), /项目不存在/)
    // 空选择明确报错，避免把「没选东西」当成「清空项目」执行
    await assert.rejects(() => restarted.files.assignManyToProject([], pA), /未选择任何文件/)

    res = await restarted.files.assignManyToProject([docA, docB], pA)
    assert.equal(res.updated, 2)
    assert.equal((await restarted.files.listProjects()).find(p => p.id === pA).doc_count, 2)
    assert.equal((await restarted.files.listFiles({ project_id: pA })).length, 2)
    // 删除项目只解除关联，文档本身必须留着
    await restarted.files.deleteProject(pA)
    assert.equal((await restarted.files.listFiles({ project_id: pA })).length, 0)
    assert.equal(restarted.db.prepare('SELECT project_id FROM documents WHERE id = ?').get(docA).project_id, null)
    await restarted.files.deleteProject(pB)
  }

  // ==================== ADR-003：工作台域（与内核域同库融合） ====================
  {
    // ---- 身份：users 表为唯一身份源 ----
    assert.equal(restarted.auth.needsSetup(), true)
    const created = restarted.auth.register('tester', { username: 'tester', password: 'test1234', displayName: '测试员' })
    assert.equal(created.role, 'owner')
    const stored = restarted.db.prepare('SELECT password_hash, salt FROM users WHERE username = ?').get('tester')
    assert(stored.password_hash.length === 128 && !stored.password_hash.includes('test1234'))
    assert(stored.salt.length === 32)
    // 已经初始化过，不允许再次注册（避免第二个 owner 悄悄出现）
    assert.throws(() => restarted.auth.register('other', { username: 'hacker', password: 'test1234' }), /已经初始化/)
    assert.throws(() => restarted.auth.login('other', { username: 'tester', password: 'wrong1234' }), /用户名或密码错误/)
    restarted.auth.logout('tester')
    assert.throws(() => restarted.auth.requireSession('tester'), /AUTH_REQUIRED/)
    assert.equal(restarted.auth.login('tester', { username: 'tester', password: 'test1234' }).displayName, '测试员')

    // ---- RPC 门面：未登录一律 AUTH_REQUIRED ----
    const { createWorkbenchRpc, WORKBENCH_RPC_METHODS } = require('../dist-electron/services/workbench/rpcHandlers')
    const rpc = createWorkbenchRpc({
      workbench: restarted.workbench, tasks: restarted.tasks, auth: restarted.auth,
      reminders: restarted.reminders, dataManager: restarted.dataManager, search: restarted.search, clientId: 'anon',
    })
    assert.equal(rpc['auth.status']().authenticated, false)
    assert.throws(() => rpc['task.list'](), /AUTH_REQUIRED/)
    assert.throws(() => rpc['data.export'](), /AUTH_REQUIRED/)
    restarted.auth.login('anon', { username: 'tester', password: 'test1234' })
    assert.equal(rpc['auth.status']().authenticated, true)
    // 方法表与实现必须一一对应，防止清单里写了却没有实现
    const missing = WORKBENCH_RPC_METHODS.filter(name => typeof rpc[name] !== 'function')
    assert.deepEqual(missing, [])

    // ---- 主链：工作区 → 项目 → 任务 ----
    const groups = restarted.tasks.createGroup({ name: '本周重点', color: 'violet' })
    const task1 = restarted.tasks.createTask({ groupId: groups.id, name: '打通任务与文档', priority: '高', owner: '测试员' })
    // 编号依赖自增 row_id 回填，格式统一为 TK-年-序号
    assert.match(task1.id, /^TK-\d{4}-\d{4}$/)
    assert.equal(restarted.tasks.createTask({ groupId: groups.id, name: '第二个任务' }).status, 'todo')
    assert.equal(restarted.tasks.list().find(g => g.id === groups.id).tasks.length, 2)
    assert.equal(restarted.tasks.flat().length, 2)
    // 校验兜底：空名称 / 非法分组 / 非法优先级都不能落库
    assert.throws(() => restarted.tasks.createTask({ groupId: groups.id, name: '  ' }), /任务名称不能为空/)
    assert.throws(() => restarted.tasks.createTask({ groupId: 99999, name: '野任务' }), /任务分组不存在/)
    assert.throws(() => restarted.tasks.createTask({ groupId: groups.id, name: '优先级错', priority: '超高' }), /任务优先级无效/)

    // ---- 融合核心：同一个项目既能挂文档又能挂任务 ----
    const fusedProject = await restarted.files.createProject('融合项目', '文档与任务共用一行', '#6366f1')
    await restarted.files.assignManyToProject([imported[1].documentId], fusedProject)
    assert.equal(restarted.workbench.assignTask(fusedProject, task1.id), true)
    // 文档侧看得到任务所属项目
    assert.equal((await restarted.files.listFiles({ project_id: fusedProject })).length, 1)
    // 任务侧看得到同一个项目
    assert.deepEqual(restarted.workbench.projectTasks(fusedProject).map(t => t.id), [task1.id])
    assert.throws(() => restarted.workbench.assignTask(fusedProject, 'TK-不存在'), /任务不存在/)
    // 项目进度由任务状态算出来，不需要额外维护字段
    restarted.tasks.completeTask(task1.id)
    const progress = restarted.workbench.listProjects().find(p => p.id === fusedProject)
    assert.equal(progress.taskCount, 1)
    assert.equal(progress.progress, 100)
    // 解绑不删任务：任务仍然存在于看板，只是不再归属项目
    assert.equal(restarted.workbench.unassignTask(task1.id), true)
    assert.equal(restarted.workbench.projectTasks(fusedProject).length, 0)
    assert.equal(restarted.tasks.get(task1.id).projectId, null)

    // 删除项目必须解绑而不是级联删任务，同时不能碰文档项目
    const scratchProject = restarted.workbench.createProject({ name: '临时项目' })
    const scratchTask = restarted.tasks.createTask({ groupId: groups.id, name: '临时任务' })
    restarted.workbench.assignTask(scratchProject.id, scratchTask.id)
    assert.equal(restarted.workbench.deleteProject(scratchProject.id), true)
    assert.equal(restarted.tasks.get(scratchTask.id).projectId, null)
    // 刚才挂过文档的项目仍然能被工作台列出（workspace_id 为空的内核域项目同样可见）
    assert(restarted.workbench.listProjects().some(p => p.id === fusedProject))

    // ---- 标签：与文档标签共用一张表，不能互相冲掉 ----
    const kernelTagCount = restarted.db.prepare('SELECT COUNT(*) AS c FROM tags').get().c
    restarted.workbench.addTag(task1.id, { name: '工作台标签', color: 'green' })
    restarted.workbench.addTag(task1.id, { name: '工作台标签', color: 'green' })
    assert.equal(restarted.db.prepare("SELECT COUNT(*) AS c FROM tags WHERE name = '工作台标签'").get().c, 1)
    assert.equal(restarted.db.prepare("SELECT COUNT(*) AS c FROM task_tags WHERE task_code = ?").get(task1.id).c, 1)
    assert.equal(restarted.db.prepare('SELECT COUNT(*) AS c FROM tags').get().c, kernelTagCount + 1)
    assert.equal(restarted.workbench.listTags(task1.id).length, 1)
    assert.equal(restarted.workbench.removeTag(task1.id, restarted.workbench.listTags(task1.id)[0].id), true)
    assert.equal(restarted.workbench.listTags(task1.id).length, 0)
    // 标签被移除后标签本身还在（文档可能还在用它）
    assert.equal(restarted.db.prepare("SELECT COUNT(*) AS c FROM tags WHERE name = '工作台标签'").get().c, 1)

    // ---- 通知：逾期任务转通知，且不重复堆积 ----
    restarted.db.prepare(`
      INSERT INTO tasks (code, group_id, name, description, priority, status, deadline, owner, participant, position)
      VALUES ('TK-OVERDUE-0001', ?, '逾期任务', '', '高', 'todo', datetime('now','-3 days','localtime'), '', 1, 99)
    `).run(groups.id)
    assert.equal(restarted.workbench.refreshDeadlineNotifications(), 1)
    assert.equal(restarted.workbench.refreshDeadlineNotifications(), 0)
    assert.equal(restarted.workbench.unreadCount(), 1)
    assert.equal(restarted.workbench.notifications()[0].title, '任务已逾期')
    assert.equal(restarted.workbench.markNotificationsRead(), true)
    assert.equal(restarted.workbench.unreadCount(), 0)

    // ---- 提醒：到点领取；重复规则自动顺延下一次 ----
    const once = restarted.reminders.create({ title: '一次性提醒', remindAt: new Date(Date.now() - 60000).toISOString() })
    assert.throws(() => restarted.reminders.create({ title: '坏时间', remindAt: '不是时间' }), /提醒时间无效/)
    assert.throws(() => restarted.reminders.create({ title: '野任务提醒', remindAt: new Date().toISOString(), taskCode: 'TK-不存在' }), /任务不存在/)
    const daily = restarted.reminders.create({ title: '每日提醒', remindAt: new Date(Date.now() - 60000).toISOString(), repeatRule: 'daily' })
    assert.equal(restarted.reminders.claimDue().length, 2)
    assert.equal(restarted.reminders.claimDue().length, 0)
    assert.equal(restarted.reminders.list().find(r => r.id === once.id).status, 'notified')
    const repeated = restarted.reminders.list().find(r => r.id === daily.id)
    assert.equal(repeated.status, 'pending')
    assert(repeated.remindAt > new Date().toISOString())
    assert.equal(restarted.reminders.dismiss(daily.id), true)

    // ---- 设置：工作台设置加前缀，绝不污染内核域设置 ----
    const kernelSettings = restarted.db.prepare("SELECT COUNT(*) AS c FROM settings WHERE key NOT LIKE 'workbench.%'").get().c
    restarted.dataManager.saveSettings({ displayName: '测试员', compactMode: true })
    assert.equal(restarted.dataManager.readSettings().displayName, '测试员')
    assert.equal(restarted.dataManager.readSettings().compactMode, 'true')
    assert.equal(restarted.db.prepare("SELECT key FROM settings WHERE key = 'workbench.displayName'").get().key, 'workbench.displayName')
    assert.equal(restarted.db.prepare("SELECT COUNT(*) AS c FROM settings WHERE key NOT LIKE 'workbench.%'").get().c, kernelSettings)
    assert.equal(restarted.db.prepare("SELECT COUNT(*) AS c FROM settings WHERE key = 'displayName'").get().c, 0)

    // ---- 备份 / 恢复：工作台数据整体往返，内核域资产毫发无伤 ----
    const backup = restarted.dataManager.createBackup('test')
    fs.existsSync(backup.path) || (() => { throw new Error('备份文件未生成') })()
    assert.equal(restarted.dataManager.history().length >= 1, true)

    const beforeRestore = {
      tasks: restarted.tasks.flat().length,
      kernelTags: restarted.db.prepare('SELECT COUNT(*) AS c FROM tags').get().c,
      kernelProjects: restarted.db.prepare('SELECT COUNT(*) AS c FROM projects WHERE workspace_id IS NULL').get().c,
      documents: restarted.db.prepare('SELECT COUNT(*) AS c FROM documents').get().c,
    }
    // 破坏工作台数据，验证恢复确实生效
    restarted.db.prepare('DELETE FROM tasks').run()
    restarted.db.prepare('DELETE FROM task_groups').run()
    assert.equal(restarted.tasks.flat().length, 0)

    const restored = restarted.dataManager.restoreFromFile(backup.name)
    assert.equal(restored.tasks, beforeRestore.tasks)
    assert.equal(restarted.tasks.flat().length, beforeRestore.tasks)
    assert(restored.safetyBackup && restored.safetyBackup.startsWith('workbench-pre-restore'))
    // 恢复不能把文档标签、文档项目、文档本身带走
    assert.equal(restarted.db.prepare('SELECT COUNT(*) AS c FROM tags').get().c >= beforeRestore.kernelTags, true)
    assert.equal(restarted.db.prepare('SELECT COUNT(*) AS c FROM projects WHERE workspace_id IS NULL').get().c, beforeRestore.kernelProjects)
    assert.equal(restarted.db.prepare('SELECT COUNT(*) AS c FROM documents').get().c, beforeRestore.documents)
    // 恢复后工作台设置随备份回来
    assert.equal(restarted.dataManager.readSettings().displayName, '测试员')

    // ---- 工作区视角的统计 ----
    const stats = restarted.workbench.workspaceStats()
    assert(stats.length >= 1)
    assert.equal(stats[0].active, true)
    const dashboard = restarted.workbench.dashboard()
    assert.equal(dashboard.stats.total, restarted.tasks.flat().length)
    assert.equal(dashboard.workspace.id, stats[0].id)
    // 工作台内检索三张表
    const found = restarted.workbench.search('临时')
    assert(found.tasks.some(t => t.name === '临时任务'))
    assert.throws(() => restarted.workbench.search(''), /搜索内容不能为空/)
    const unified = await restarted.workbench.searchAll('知识图谱', restarted.search)
    assert(unified.documents.items.length > 0)
    // S0-11（D10）：文档侧默认走 RRF 混合检索（语义通道未启用时降级但仍报 hybrid 路径）
    assert.equal(unified.documentSearchMode, 'hybrid')

    // ---- 数据管理统计 ----
    const dataStats = restarted.dataManager.statistics()
    assert.equal(dataStats.users, 1)
    assert.equal(dataStats.tasks, restarted.tasks.flat().length)
    assert.equal(dataStats.projects >= 1, true)
  }

  // ==================== ADR-003 续：跨域时间线 / LLM 与摄像头接缝 / MCP 出口 ====================
  {
    const { createWorkbenchRpc } = require('../dist-electron/services/workbench/rpcHandlers')
    const { McpServerService } = require('../dist-electron/services/mcpServer')
    const { LlmGateway } = require('../dist-electron/services/gateway/llmGateway')
    const { CameraService } = require('../dist-electron/services/perception/cameraService')

    const dayKey = (offset = 0) => {
      const date = new Date()
      date.setDate(date.getDate() + offset)
      const pad = (value) => String(value).padStart(2, '0')
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    }
    const baseDeps = {
      workbench: restarted.workbench, tasks: restarted.tasks, auth: restarted.auth,
      reminders: restarted.reminders, dataManager: restarted.dataManager, search: restarted.search, clientId: 'anon',
    }

    // ---- 接缝探针①：「没装配」与「装配了但没注册 provider」必须能区分 ----
    const bareRpc = createWorkbenchRpc(baseDeps)
    assert.equal(bareRpc['gateway.status']().configured, false)
    assert.equal(bareRpc['gateway.status']().providerId, null)
    assert.equal(bareRpc['gateway.status']().reason, '未装配 LLM 网关')
    assert.equal(bareRpc['perception.status']().available, false)
    assert.equal(bareRpc['perception.status']().running, false)
    assert.equal(bareRpc['perception.status']().reason, '未装配摄像头感知层')

    const seamRpc = createWorkbenchRpc({ ...baseDeps, llm: restarted.llm, camera: restarted.camera })
    assert.match(seamRpc['gateway.status']().reason, /尚未注册任何 LlmProvider/)
    assert.match(seamRpc['perception.status']().reason, /尚未注册任何 CameraProvider/)

    // ---- 接缝探针②：注册 provider 后状态翻转，证明接缝本身可用（本阶段不接真厂商）----
    const llm = new LlmGateway()
    await assert.rejects(async () => { await llm.chat({ messages: [{ role: 'user', content: 'hi' }] }) }, /尚未接入大语言模型/)
    llm.register({
      id: 'stub', label: '桩模型', model: 'stub-1',
      available: () => true,
      chat: async () => ({ model: 'stub-1', content: '收到', toolCalls: [], usage: null, finishReason: 'stop' }),
    })
    assert.equal(llm.status().configured, true)
    assert.equal(llm.status().providerId, 'stub')
    assert.equal((await llm.chat({ messages: [] })).content, '收到')
    // provider 没实现 stream 时退化为一次性回放，上层不必关心厂商差异
    const chunks = []
    await llm.stream({ messages: [] }, chunk => chunks.push(chunk))
    assert.deepEqual(chunks, ['收到'])
    // 桩只注册在本地实例上，运行时那枚网关不被污染
    assert.equal(restarted.llm.status().configured, false)

    const camera = new CameraService()
    await assert.rejects(async () => { await camera.start() }, /尚未接入摄像头/)
    const events = []
    camera.register({
      id: 'stub-cam', label: '桩摄像头',
      available: () => true,
      start: async () => {}, stop: async () => {},
      capture: async () => ({ id: 'frame-1', capturedAt: new Date().toISOString(), width: 320, height: 240, source: 'file', data: null }),
      onEvent: (listener) => {
        listener({ type: 'presence', at: new Date().toISOString(), confidence: 0.92, payload: { present: true } })
        return () => {}
      },
    })
    const offEvents = camera.onEvent(event => events.push(event.type))
    assert.equal(camera.isRunning(), false)
    await camera.start()
    assert.equal(camera.isRunning(), true)
    assert.deepEqual(events, ['presence'])
    assert.equal((await camera.capture()).id, 'frame-1')
    await camera.stop()
    assert.equal(camera.isRunning(), false)
    offEvents()
    assert.equal(restarted.camera.status().available, false)

    // ---- 跨域时间线：任务（截止）与文档（入库）汇入同一条流 ----
    const timelineGroup = restarted.tasks.list()[0]
    const futureTask = restarted.tasks.createTask({ groupId: timelineGroup.id, name: '时间线未来任务', deadline: dayKey(5) })
    const undatedTask = restarted.tasks.createTask({ groupId: timelineGroup.id, name: '没有截止日的任务' })

    const timeline = seamRpc['workbench.timeline']({ days: 30, limit: 200 })
    assert(timeline.length > 0)
    assert(timeline.every(e => e.kind === 'task' || e.kind === 'document'))
    assert(timeline.every(e => /^\d{4}-\d{2}-\d{2}$/.test(e.at)))
    assert(timeline.every(e => ['past', 'today', 'upcoming'].includes(e.phase)))
    // 同一条流里越近的日期越靠前（同一日期内任务排在文档前）
    assert.deepEqual(timeline.map(e => e.at), [...timeline.map(e => e.at)].sort().reverse())
    // 3 天前截止的任务落「过去」，5 天后截止的落「将来」，两者出现在同一份结果里
    assert.equal(timeline.find(e => e.id === 'TK-OVERDUE-0001').phase, 'past')
    assert.equal(timeline.find(e => e.id === futureTask.id).phase, 'upcoming')
    // 没有截止日的任务不进时间线
    assert(!timeline.some(e => e.id === undatedTask.id))
    // 文档侧确实入了流，id 带 doc: 前缀，前端据此跳回知识库
    const docEvent = timeline.find(e => e.kind === 'document')
    assert(docEvent && docEvent.id.startsWith('doc:'))
    assert.equal(typeof docEvent.title, 'string')

    // days 是硬边界：窗口外的事件必须消失（逾期任务是 3 天前）
    const narrow = seamRpc['workbench.timeline']({ days: 2, limit: 200 })
    assert(narrow.every(e => e.at >= dayKey(-2)))
    assert(!narrow.some(e => e.id === 'TK-OVERDUE-0001'))
    // limit 生效；非法入参回落默认值而不是抛错
    assert.equal(seamRpc['workbench.timeline']({ days: 30, limit: 1 }).length, 1)
    assert(seamRpc['workbench.timeline']({ days: 'x', limit: -3 }).length > 0)

    // ---- MCP 出口：工作台域单向暴露给 Agent ----
    const mcp = new McpServerService(restarted.db, restarted.files, restarted.search, restarted.graph, {
      workbench: restarted.workbench, tasks: restarted.tasks,
    })
    const toolText = async (name, params) => {
      const result = await mcp.handleToolCall(name, params)
      assert.equal(result.content[0].type, 'text')
      return result.content[0].text
    }
    const toolJson = async (name, params) => JSON.parse(await toolText(name, params))

    const overview = await toolJson('workbench_overview')
    assert.equal(overview.stats.total, restarted.tasks.flat().length)
    assert.equal(overview.workspace.id, restarted.workbench.activeWorkspace().id)
    assert(overview.workspace_stats.length >= 1)

    const workspaceList = await toolJson('list_workspaces')
    assert.equal(workspaceList.total, workspaceList.items.length)
    assert.equal(workspaceList.active_workspace_id, restarted.workbench.activeWorkspace().id)

    const allTasks = await toolJson('list_tasks', {})
    assert.equal(allTasks.total, restarted.tasks.flat().length)
    assert.equal(allTasks.counts.todo + allTasks.counts.doing + allTasks.counts.done, allTasks.total)
    const doneOnly = await toolJson('list_tasks', { status: 'done' })
    assert(doneOnly.counts.todo === 0 && doneOnly.counts.doing === 0)
    assert(doneOnly.groups.flatMap(g => g.tasks).every(t => t.status === 'done'))

    // create_task：group_name 不存在时自动建组（resolveTaskGroupId 的名称分支）
    const createdText = await toolText('create_task', { name: 'MCP 建的任务', deadline: dayKey(1), group_name: 'MCP 收集箱' })
    const createdCode = createdText.match(/TK-\d{4}-\d{4}/)[0]
    assert.equal((await toolJson('get_task', { code: createdCode })).name, 'MCP 建的任务')
    assert(doneOnly.groups.flatMap(g => g.tasks).every(t => t.code !== createdCode))

    const taskTimeline = await toolJson('get_timeline', { days: 30, limit: 50 })
    assert.equal(taskTimeline.counts.tasks + taskTimeline.counts.documents, taskTimeline.items.length)
    // upcoming = 还没过期（含今天），与 phase 的三分法对得上
    assert.equal(taskTimeline.counts.upcoming, taskTimeline.items.filter(e => e.phase !== 'past').length)
    assert(taskTimeline.items.some(e => e.id === futureTask.id))

    const searchAll = await toolJson('search_all', { query: '逾期' })
    assert.equal(searchAll.query, '逾期')
    // 工作台侧的本地命中以 code 作为 id（与内核全文检索的结果形态不同，故分开放在 tasks/files 下）
    assert(searchAll.tasks.some(t => t.id === 'TK-OVERDUE-0001'))
    assert(doneOnly.groups.flatMap(g => g.tasks).every(t => t.code !== 'TK-OVERDUE-0001'))

    // 工作区过滤按「任务 → 项目 → 工作区」的真实归属，而不是当前工作区视角
    const activeWorkspaceId = restarted.workbench.activeWorkspace().id
    const otherWorkspace = restarted.workbench.createWorkspace({ name: 'MCP 工作区' })
    restarted.workbench.switchWorkspace(otherWorkspace.id)
    const otherProject = restarted.workbench.createProject({ name: 'MCP 项目' })
    const otherCode = (await toolText('create_task', { name: '别的工作区的任务', project_id: otherProject.id })).match(/TK-\d{4}-\d{4}/)[0]
    restarted.workbench.switchWorkspace(activeWorkspaceId)
    const activeProject = restarted.workbench.listProjects().find(p => p.workspaceId === activeWorkspaceId)
      || restarted.workbench.createProject({ name: 'MCP 主工作区项目' })
    const activeCode = (await toolText('create_task', { name: '主工作区的任务', project_id: activeProject.id })).match(/TK-\d{4}-\d{4}/)[0]

    // 当前工作区是 A，按 B 过滤依旧能拿到 B 的任务
    const inOther = await toolJson('list_tasks', { workspace_id: otherWorkspace.id })
    assert.equal(inOther.total, 1)
    assert.equal(inOther.groups.flatMap(g => g.tasks)[0].code, otherCode)
    const inActive = await toolJson('list_tasks', { workspace_id: activeWorkspaceId })
    assert(inActive.groups.flatMap(g => g.tasks).some(t => t.code === activeCode))
    assert(!inActive.groups.flatMap(g => g.tasks).some(t => t.code === otherCode))

    // 未装配工作台域时，工作台工具既不在清单里，也不该被当成内核工具执行
    const kernelOnly = new McpServerService(restarted.db, restarted.files, restarted.search, restarted.graph)
    assert.equal((await kernelOnly.handleToolCall('list_tasks', {})).content[0].text, 'Unknown tool: list_tasks')
    assert.equal((await kernelOnly.handleToolCall('list_scopes', {})).content[0].type, 'text')

    // ---- REST 出口：与 /local/rpc 共用同一张方法表，只读白名单放行时间线与探针 ----
    const workbenchRest = new APIServer(restarted.db, restarted.files, restarted.search, restarted.graph, restarted.security, restarted.processing, {
      workbench: restarted.workbench, tasks: restarted.tasks, auth: restarted.auth,
      reminders: restarted.reminders, dataManager: restarted.dataManager, search: restarted.search,
      llm: restarted.llm, camera: restarted.camera,
    })
    await workbenchRest.start(18993)
    const restTimeline = await fetch('http://127.0.0.1:18993/api/v1/workbench/timeline?days=30&limit=5')
    assert.equal(restTimeline.status, 200)
    assert((await restTimeline.json()).length <= 5)
    const restSearch = await fetch('http://127.0.0.1:18993/api/v1/workbench/search?q=%E7%9F%A5%E8%AF%86%E5%9B%BE%E8%B0%B1')
    assert.equal(restSearch.status, 200)
    assert((await restSearch.json()).documents.items.length >= 1)
    const restProbe = await (await fetch('http://127.0.0.1:18993/api/v1/workbench/rpc', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 'gateway.status', args: [] }),
    })).json()
    assert.equal(restProbe.configured, false)
    // reader 密钥可以读时间线，但不能借它写任务
    await restarted.security.setup('integration-seam-password')
    const readerKey = await restarted.security.createApiKey('Seam reader', 'reader')
    const readerAuth = { Authorization: 'Bearer ' + readerKey.key, 'Content-Type': 'application/json' }
    assert.equal((await fetch('http://127.0.0.1:18993/api/v1/workbench/rpc', {
      method: 'POST', headers: readerAuth, body: JSON.stringify({ method: 'workbench.timeline', args: [{ days: 30 }] }),
    })).status, 200)
    assert.equal((await fetch('http://127.0.0.1:18993/api/v1/workbench/rpc', {
      method: 'POST', headers: readerAuth, body: JSON.stringify({ method: 'task.create', args: [{ groupId: timelineGroup.id, name: '越权任务' }] }),
    })).status, 400)
    await restarted.security.revokeApiKey(readerKey.id)
    await workbenchRest.stop()
    await restarted.db.updateSettings({ security_enabled: 'false' })
  }

  // —— 混合检索的语义通道（S0-11）：模型不可用时如实 SKIP，不把集成测试变成联网依赖 ——
  await restarted.db.updateSettings({ vector_enabled: 'true' })
  let embeddingReady = false
  try { embeddingReady = (await restarted.processing.generateQueryEmbedding('探针')) !== null } catch { embeddingReady = false }
  if (embeddingReady) {
    const target = restarted.db.prepare("SELECT id FROM documents WHERE is_available = 1 AND file_type = 'md' ORDER BY id LIMIT 1").get()
    await restarted.processing.processDocument(target.id)
    const linkedVectors = restarted.db.prepare('SELECT COUNT(*) AS total, SUM(chunk_id IS NOT NULL) AS linked FROM vectors WHERE document_id = ?').get(target.id)
    assert(linkedVectors.total > 0 && linkedVectors.total === linkedVectors.linked)
    const linkedChunkIndex = restarted.db.prepare(
      'SELECT COUNT(*) AS n FROM vectors v JOIN chunks c ON c.id = v.chunk_id WHERE v.document_id = ? AND c.chunk_index = v.chunk_index'
    ).get(target.id).n
    assert.equal(linkedChunkIndex, linkedVectors.total)
    // 一次混合检索里同时出现全文命中与语义命中（RRF 两路都在参与）
    const hybrid = await restarted.search.hybridSearch('数据库 中文搜索', { limit: 5 })
    assert.deepEqual(hybrid.channels, { fulltext: true, semantic: true })
    assert(hybrid.items.some(item => item.score_parts.rank_fulltext != null && item.score_parts.rank_semantic != null))
    assert(hybrid.items.every(item => Number.isInteger(item.chunk_id)), '混合结果应带回块级出处')
    // 纯全文 / 纯向量 / 融合三档都能跑通（同一批数据、同一查询）
    assert((await restarted.search.fullTextSearch('数据库')).items.length >= 1)
    assert((await restarted.search.semanticSearch('数据库')).items.length >= 1)
  } else {
    console.log('SKIP: 语义模型不可用，本次未断言混合检索的语义通道（离线环境下属预期）')
  }

  restarted.stopReminders?.()
  restarted.db.close()
  fs.writeFileSync(path.resolve(__dirname, '../.verification/latest.json'), JSON.stringify({ root, dataDir: path.join(root, 'Data') }))
  console.log('PASS: real file import, same-name isolation, deduplication, parsing, Chinese search, graph, retry idempotence, full-dataset charts, API auth/revocation, persistence after restart, deletion cleanup, entity rename/batch-merge, staged perf instrumentation, chunk overlap, batch embedding shapes, incremental tag sync, folder mapping scan/delta-sync/soft-delete/param-reuse/cleanup, queue concurrency/priority-ordering/persistence, cross-domain timeline, LLM/camera seams, MCP workbench tools + REST read-only exit, chunks provenance + P-a backfill + RRF hybrid search')
}
run().catch(e => { console.error(e); process.exit(1) })
