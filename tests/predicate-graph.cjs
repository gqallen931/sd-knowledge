/**
 * ADR-007：受控谓词边 + 主题社区 —— 测试
 *
 * 覆盖四层：
 * 1. 抽取器（纯函数）：中文正向 / 英文被动反向 / 否定抑制 / 间隔上限 / 长名优先；
 * 2. 社区检测（纯函数）：连通性、确定性、孤立体处理；
 * 3. 落库与重算：解析产出边、带文档溯源、重新解析不叠加、人工边不被误删；
 * 4. 检索侧：社区亲和度进入 score_parts 且不改变既有字段。
 */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { createRuntime } = require('../dist-electron/services/runtime')
const { extractPredicateEdges } = require('../dist-electron/services/predicateRules')
const { detectCommunities } = require('../dist-electron/services/communityDetector')
const { buildCompoundTerms, headWord, isHeadNoun } = require('../dist-electron/services/compoundTerms')

function extractionTests() {
  // —— 中文正向：主谓宾结构 ——
  const chinese = extractPredicateEdges('向量检索依赖嵌入模型。嵌入模型生成向量。', [
    { name: '向量检索', type: 'concept' },
    { name: '嵌入模型', type: 'concept' },
    { name: '向量', type: 'concept' },
  ])
  const depends = chinese.find(edge => edge.relation === 'DEPENDS_ON')
  assert.ok(depends, '应识别「依赖」并成边')
  assert.equal(depends.sourceName, '向量检索')
  assert.equal(depends.targetName, '嵌入模型')
  assert.equal(depends.evidence, '依赖')
  assert.ok(depends.weight >= 0.6, `紧邻谓词应给较高置信度，实际 ${depends.weight}`)
  const produces = chinese.find(edge => edge.relation === 'PRODUCES')
  assert.ok(produces, '应识别「生成」')
  assert.equal(produces.sourceName, '嵌入模型')
  assert.equal(produces.targetName, '向量')

  // —— 否定：不建边（错误边比缺失边更难收拾） ——
  const negated = extractPredicateEdges('知识图谱不依赖大模型。', [
    { name: '知识图谱', type: 'concept' },
    { name: '大模型', type: 'concept' },
  ])
  assert.equal(negated.length, 0, '否定句不应产生关系边')

  // —— 英文被动式：方向要对，不能被字面顺序骗到 ——
  const passive = extractPredicateEdges('FAISS is used by the indexer.', [
    { name: 'FAISS', type: 'concept' },
    { name: 'indexer', type: 'concept' },
  ])
  const uses = passive.find(edge => edge.relation === 'USES')
  assert.ok(uses, '应识别英文被动 "is used by"')
  assert.equal(uses.sourceName, 'indexer')
  assert.equal(uses.targetName, 'FAISS')

  // —— 间隔上限：跨子句不猜 ——
  const tooFar = extractPredicateEdges(`甲方依赖${'填充'.repeat(14)}乙方。`, [
    { name: '甲方', type: 'concept' },
    { name: '乙方', type: 'concept' },
  ])
  assert.equal(tooFar.length, 0, '超出 maxGap 的两实体不应建边')

  // —— 长名优先：不能被更短的子串抢占 ——
  const overlap = extractPredicateEdges('混合检索依赖向量索引。', [
    { name: '检索', type: 'concept' },
    { name: '混合检索', type: 'concept' },
    { name: '向量索引', type: 'concept' },
  ])
  assert.equal(overlap.length, 1)
  assert.equal(overlap[0].sourceName, '混合检索', '「检索」是「混合检索」的子串，不应独立成边')

  // —— 跨句：只在同一句内判定 ——
  const acrossSentence = extractPredicateEdges('甲方依赖乙方。丙方生成丁方。', [
    { name: '乙方', type: 'concept' },
    { name: '丙方', type: 'concept' },
  ])
  assert.equal(acrossSentence.length, 0, '相邻两句的实体之间没有谓词，不应成边')
}

function communityTests() {
  const nodes = [1, 2, 3, 4, 5, 6]
  const edges = [
    { source: 1, target: 2, weight: 2 },
    { source: 2, target: 3, weight: 1 },
    { source: 4, target: 5, weight: 1 },
  ]
  const first = detectCommunities(nodes, edges)
  assert.equal(first.assignment.get(1), first.assignment.get(2), '相连实体应在同一社区')
  assert.equal(first.assignment.get(2), first.assignment.get(3), '链式结构不应被切断')
  assert.notEqual(first.assignment.get(1), first.assignment.get(4), '不相连的两组不应合并')
  assert.equal(first.communities.length, 2, '应得到两个社区（孤立点 6 不计数）')
  for (const community of first.communities) {
    assert.ok(community.cohesion > 0 && community.cohesion <= 1)
    assert.ok(community.members.length >= 2)
  }

  // 确定性：同输入必须同输出（这是「可复算」的底线）
  const second = detectCommunities(nodes, edges)
  assert.deepEqual(first.communities, second.communities)
  assert.deepEqual(Array.from(first.assignment.entries()), Array.from(second.assignment.entries()))

  // 孤立点：保留 size=1 的自身社区，但不进入社区列表
  assert.equal(first.assignment.get(6), 6)
  assert.ok(!first.communities.some(community => community.members.includes(6)))
}

async function integrationTests() {
  const root = path.resolve(__dirname, '../.verification', 'run-' + Date.now() + '-predicate-graph')
  fs.mkdirSync(root, { recursive: true })
  const runtime = await createRuntime(path.join(root, 'Data'))
  await runtime.db.updateSettings({ vector_enabled: 'false', ocr_enabled: 'false' })

  const docPath = path.join(root, '知识笔记.md')
  fs.writeFileSync(docPath, [
    '# 向量检索设计',
    '向量检索依赖嵌入模型。嵌入模型生成向量。',
    '向量检索使用向量索引。向量索引依赖嵌入模型。',
    '知识图谱不依赖大模型。',
  ].join('\n'), 'utf8')

  const imported = await runtime.importFiles([docPath])
  assert.equal(imported.filter(item => item.success).length, 1, '文档应导入成功')
  await runtime.idle()
  const docId = imported[0].documentId

  const selectEdges = () => runtime.db.prepare(`
    SELECT r.source_id, r.target_id, r.relation_type, r.weight, r.source_doc_id, r.metadata,
           s.name AS source_name, t.name AS target_name
    FROM relationships r
    JOIN entities s ON s.id = r.source_id
    JOIN entities t ON t.id = r.target_id
    WHERE r.source_type = 'entity' AND r.target_type = 'entity'
    ORDER BY r.id
  `).all()

  const edges = selectEdges()
  assert.ok(edges.length >= 2, `解析应产出实体—实体边，实际 ${edges.length}`)

  // 端到端断言按「句子 + 谓词」定位，而不是写死实体名：
  // 实体粒度由分词器决定（不同版本的 jieba 可能给出「向量检索」或「向量」「检索」），
  // 写死名字会让测试变成对分词器的断言，而不是对关系抽取的断言。
  const depends = edges.find(edge =>
    edge.relation_type === 'DEPENDS_ON' &&
    String(JSON.parse(edge.metadata).sentence).includes('向量检索依赖嵌入模型'))
  assert.ok(depends, '应落库「向量检索依赖嵌入模型」的 DEPENDS_ON，实际：' + JSON.stringify(edges, null, 2))
  assert.equal(Number(depends.source_doc_id), Number(docId), '规则边必须带文档溯源')
  const meta = JSON.parse(depends.metadata)
  assert.equal(meta.origin, 'predicate-rule')
  assert.equal(meta.evidence, '依赖')

  // 中间夹着实体的伪边必须不存在（这是真实语料里最容易出现的错误类型）
  const spurious = edges.find(edge =>
    edge.relation_type === 'DEPENDS_ON' &&
    String(JSON.parse(edge.metadata).sentence).includes('向量检索依赖嵌入模型') &&
    (edge.source_name === '向量' && edge.target_name === '模型'))
  assert.ok(!spurious, '跨越中间实体的伪边不应落库')

  assert.ok(!edges.some(edge => edge.relation_type === 'DEPENDS_ON' && edge.source_name === '知识图谱'),
    '否定句的边不应落库')

  // —— 重算幂等：同一文档反复解析不应叠加边 ——
  const before = selectEdges().length
  await runtime.processing.processDocument(docId)
  await runtime.processing.processDocument(docId)
  assert.equal(selectEdges().length, before, '重新解析应整体替换本文档的规则边，而不是追加')

  // —— 人工边保护：人工创建的关系没有 source_doc_id，重解析不得误删 ——
  const source = { id: Number(depends.source_id) }
  const target = { id: Number(depends.target_id) }
  assert.ok(source.id && target.id, '关键词实体应已落库（ADR-007 前置条件）')
  runtime.db.prepare(`
    INSERT INTO relationships (source_type, source_id, target_type, target_id, relation_type, weight)
    VALUES ('entity', ?, 'entity', ?, 'RELATES_TO', 0.9)
  `).run(source.id, target.id)
  await runtime.processing.processDocument(docId)
  const manual = runtime.db.prepare(
    "SELECT COUNT(*) AS n FROM relationships WHERE relation_type = 'RELATES_TO' AND source_doc_id IS NULL",
  ).get()
  assert.equal(Number(manual.n), 1, '人工边必须保留')

  // —— 社区：落库、可查、可重算 ——
  const detected = await runtime.graph.detectCommunities()
  assert.ok(detected.communities >= 1, '应至少检出 1 个社区')
  assert.ok(detected.entities >= 2, '社区检测应覆盖全部实体')
  const list = await runtime.graph.getCommunities({ limit: 10 })
  assert.ok(list.length >= 1)
  assert.ok(Array.isArray(list[0].top_entities), '代表实体应回填为数组')
  assert.equal(list[0].top_entities.length, Math.min(5, list[0].size))

  const membership = await runtime.graph.getEntityCommunity(Number(source.id))
  assert.ok(membership, '实体应有归属社区')
  assert.ok(
    membership.members.some(member => Number(member.id) === Number(depends.target_id)),
    '同社区应包含该边的另一端',
  )

  const snapshot = JSON.stringify(list)
  await runtime.graph.detectCommunities()
  assert.equal(JSON.stringify(await runtime.graph.getCommunities({ limit: 10 })), snapshot, '社区重算应完全确定')

  // —— 检索侧：社区亲和度进入 score_parts，且不破坏既有字段 ——
  const found = await runtime.search.hybridSearch('向量检索', { limit: 5 })
  assert.ok(found.items.length >= 1)
  const parts = found.items[0].score_parts
  assert.ok(parts && 'community_affinity' in parts, 'score_parts 应包含社区亲和度')
  assert.ok(parts.community_affinity >= 0 && parts.community_affinity <= 1)
  assert.ok('entity_overlap' in parts && 'rrf' in parts, '既有评分项保持兼容')

  const stats = await runtime.graph.getStats()
  assert.equal(Number(stats.communities), list.length)
  assert.ok(Number(stats.predicate_edges) >= 2, '统计应反映规则边数量')

  await runtime.close?.()
}

function compoundTests() {
  // —— 中心词判定：中文在右、英文在末尾；单词本身不算复合 ——
  assert.equal(headWord('向量索引'), '索引')
  assert.equal(headWord('嵌入模型'), '模型')
  assert.equal(headWord('vector index'), 'index')
  assert.equal(headWord('索引'), '', '整词等于中心词时不应再切出中心词')
  assert.ok(isHeadNoun('索引') && isHeadNoun('index'))
  assert.ok(!isHeadNoun('依赖'), '谓词不是中心词')

  // —— 归并：只在正文真的紧邻时合成，且必须以中心词结尾 ——
  const merged = buildCompoundTerms(
    ['向量', '索引', '检索'],
    '向量索引依赖嵌入模型。向量索引是核心组件。',
    { minOccurrences: 2 },
  )
  const vectorIndex = merged.find(item => item.name === '向量索引')
  assert.ok(vectorIndex, `应归并出「向量索引」，实际 ${merged.map(i => i.name).join(',')}`)
  assert.equal(vectorIndex.head, '索引')
  assert.deepEqual(vectorIndex.modifiers, ['向量'])
  assert.equal(vectorIndex.count, 2)

  // 「的 / 与 / 是」等分隔符不跨越
  assert.equal(
    buildCompoundTerms(['向量', '索引'], '向量的索引，向量的索引。', { minOccurrences: 2 }).length,
    0,
    '隔着实词的不应归并',
  )
  // 谓词不参与（否则会把动词吃进实体名，正是 ADR-007 踩过的坑）
  assert.equal(
    buildCompoundTerms(['依赖', '模型'], '依赖模型，依赖模型。', { minOccurrences: 2, isBlocked: t => t === '依赖' }).length,
    0,
    '被屏蔽的碎片不应参与归并',
  )
  // 尾部不是中心词 → 不成词，不归并
  assert.equal(
    buildCompoundTerms(['快速', '运行'], '快速运行，快速运行。', { minOccurrences: 2 }).length,
    0,
    '尾部非中心词不应归并',
  )
  // 链式：向量 + 索引 + 模型 → 中心词取最右
  const chained = buildCompoundTerms(['向量', '索引', '模型'], '向量索引模型，向量索引模型。', { minOccurrences: 2 })
  const longest = chained.find(item => item.name === '向量索引模型')
  assert.ok(longest, `三段链应归并，实际 ${chained.map(i => i.name).join(',')}`)
  assert.equal(longest.head, '模型')
  // 英文复合词允许一个空格（中心词仍在末尾）
  const english = buildCompoundTerms(['vector', 'index'], 'The vector index beats the vector index.', { minOccurrences: 2 })
  const englishTerm = english.find(item => /vector\s+index/i.test(item.name))
  assert.ok(englishTerm, `英文复合词应归并，实际 ${english.map(i => i.name).join(',')}`)
  assert.equal(englishTerm.head, 'index')
}

/**
 * 前端镜像的系数必须与后端常量一致。
 *
 * 渲染进程不引 electron 目录，默认值只能在 Settings.tsx 里手抄一份；
 * 抄错不会报错、只会让「设置页显示的数字」与「实际生效的数字」不一致——这类静默漂移最难发现。
 */
function rerankMirrorTests() {
  const service = fs.readFileSync(path.resolve(__dirname, '../electron/services/searchService.ts'), 'utf8')
  const page = fs.readFileSync(path.resolve(__dirname, '../src/pages/Settings.tsx'), 'utf8')
  const keys = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta']
  const pick = (source, label) => {
    const out = {}
    for (const key of keys) {
      const hit = source.match(new RegExp(`${key}:\\s*([0-9.]+)`))
      assert.ok(hit, `${label} 应包含 ${key} 的默认值`)
      out[key] = Number(hit[1])
    }
    return out
  }
  assert.deepEqual(pick(page, 'Settings.tsx'), pick(service, 'searchService.ts'), '前后端重排默认系数必须一致')
  assert.ok(/RERANK_ALPHA_MAX\s*=\s*0\.2/.test(service) && /RERANK_ALPHA_MAX\s*=\s*0\.2/.test(page), 'α 上限应同为 0.2')
}

async function main() {
  extractionTests()
  communityTests()
  compoundTests()
  rerankMirrorTests()
  await integrationTests()
  console.log('predicate-graph: ok')
}

main().catch(error => {
  console.error('predicate-graph: FAIL')
  console.error(error)
  process.exit(1)
})
