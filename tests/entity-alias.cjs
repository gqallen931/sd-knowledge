/**
 * S2-08 实体别名 / 合并 / 消歧建议：集成测试
 * 覆盖：addAlias 校验（空/超长/跨实体占用/同实体幂等）、合并的关系转移与去重、
 * 合并别名与历史、建议扫描与「不再提示」忽略记忆、removeAlias。
 */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { createRuntime } = require('../dist-electron/services/runtime')

async function main() {
  const root = path.resolve(__dirname, '../.verification', 'run-' + Date.now() + '-entity-alias')
  fs.mkdirSync(root, { recursive: true })
  const r = await createRuntime(path.join(root, 'Data'))
  await r.db.updateSettings({ vector_enabled: 'false', ocr_enabled: 'false' })

  const insEntity = r.db.prepare('INSERT INTO entities (name, type, description) VALUES (?, ?, ?)')
  const e1 = Number(insEntity.run('OpenAI', 'org', '人工智能研究机构').lastInsertRowid)
  const e2 = Number(insEntity.run('OpenAI公司', 'org', null).lastInsertRowid)
  const e3 = Number(insEntity.run('AlphaGo', 'product', '围棋 AI').lastInsertRowid)
  const e4 = Number(insEntity.run('AlphaGo1', 'product', null).lastInsertRowid)

  // —— addAlias 校验 ——
  assert.throws(() => r.graph.addAlias(99999, '不存在'), /实体不存在/)
  assert.throws(() => r.graph.addAlias(e1, '   '), /别名不能为空/)
  assert.throws(() => r.graph.addAlias(e1, 'x'.repeat(201)), /别名不能超过 200 个字符/)
  const added = r.graph.addAlias(e1, '  Open AI  ')
  assert.equal(added.success, true)
  assert.equal(added.alias, 'openai', '别名应做强归一化（全角转半角、小写、去空白）')
  // 同实体重复添加：幂等
  assert.deepEqual(r.graph.addAlias(e1, 'openai'), { success: true, unchanged: true, alias: 'openai' })
  // 跨实体重名（归一化后同名）：拒绝而不是静默丢弃
  assert.throws(() => r.graph.addAlias(e2, 'Open AI'), /已被实体「OpenAI」占用/)

  const aliases = r.graph.listAliases(e1)
  assert.equal(aliases.length, 1)
  assert.equal(aliases[0].source, 'manual')
  assert.equal(aliases[0].entity_name, 'OpenAI')
  assert.ok(r.graph.listAliases().every(a => 'entity_name' in a), '全量列表应附实体名')

  // —— 消歧建议（先于合并：合并会删掉 e1） ——
  const before = await r.graph.suggestEntityMerges()
  assert.equal(before.scanned, 4)
  assert.equal(before.suggestions.length, 2, '应给出 OpenAI/OpenAI公司 与 AlphaGo/AlphaGo1 两组建议')
  const pair = before.suggestions.find(s => s.source.id === e1 && s.target.id === e2)
  assert.ok(pair, '建议方向：短名并入更具体的长名')
  assert.ok(pair.score >= 0.6)

  // 忽略记忆：键序归一 + 大小写不敏感；重复忽略不产生第二行
  const ignored = r.graph.ignoreMergeSuggestion('OpenAI公司', 'openai')
  assert.equal(ignored.success, true)
  assert.throws(() => r.graph.ignoreMergeSuggestion('OpenAI', 'OpenAI'), /两个名称相同/)
  assert.throws(() => r.graph.ignoreMergeSuggestion(' ', 'x'), /实体名称不能为空/)
  const after = await r.graph.suggestEntityMerges()
  assert.equal(after.suggestions.length, 1, '被忽略的组合不应再出现')
  assert.ok(after.suggestions[0].source.id === e3 || after.suggestions[0].target.id === e3)
  assert.equal(r.graph.listIgnoredMergePairs().length, 1)

  // —— 合并：关系转移 + 去重 + merge 别名 + 历史 ——
  const insRel = r.db.prepare("INSERT INTO relationships (source_type, source_id, target_type, target_id, relation_type) VALUES ('entity', ?, 'entity', ?, 'cooperates')")
  insRel.run(e1, e3) // 转移后与既有 (e2→e3) 同形 → 去重
  insRel.run(e2, e3)
  insRel.run(e3, e1) // 转移为 (e3→e2)

  await assert.rejects(() => r.graph.mergeEntities(e2, e2), /不能合并同一实体/)
  await assert.rejects(() => r.graph.mergeEntities(99999, e2), /源实体不存在/)
  const merged = await r.graph.mergeEntities(e1, e2)
  assert.equal(merged.success, true)
  assert.equal(merged.moved, 1)
  assert.equal(merged.deduped, 1)
  assert.equal(merged.mergedInto.id, e2)

  assert.equal(r.db.prepare('SELECT COUNT(*) AS n FROM entities WHERE id = ?').get(e1).n, 0, '源实体应被删除')
  assert.equal(
    r.db.prepare("SELECT COUNT(*) AS n FROM relationships WHERE (source_type='entity' AND source_id=?) OR (target_type='entity' AND target_id=?)").get(e1, e1).n,
    0,
    '源实体的边应全部转移或去重',
  )
  const mergeAlias = r.db.prepare('SELECT alias, source FROM entity_aliases WHERE entity_id = ?').all(e2)
  assert.ok(mergeAlias.some(a => a.alias === 'OpenAI' && a.source === 'merge'), '被并实体名应留作 merge 别名')
  assert.equal(r.graph.listAliases(e1).length, 0, '挂在源实体上的手动别名应随级联删除')

  const history = r.graph.listMergeHistory(10)
  assert.equal(history.length, 1)
  assert.equal(history[0].merged_id, e1)
  assert.equal(history[0].merged_name, 'OpenAI')
  assert.equal(history[0].survivor_id, e2)
  assert.equal(history[0].survivor_name, 'OpenAI公司')
  assert.equal(history[0].edges_relocated, 1)

  // —— removeAlias ——
  const manual = r.graph.addAlias(e3, '阿尔法狗')
  assert.equal(manual.success, true)
  const aliasId = r.graph.listAliases(e3)[0].id
  assert.equal(r.graph.removeAlias(aliasId), true)
  assert.equal(r.graph.removeAlias(99999), false)
  assert.equal(r.graph.listAliases(e3).length, 0)

  console.log('entity-alias 集成测试通过')
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1) })
