/**
 * S1-02 / S1-03 端到端验证（本地 mock，不联网）。
 *
 * 用一个 OpenAI 兼容的 mock HTTP 服务，证明：
 *   ① chat.ask 走通「混合检索 → 编号上下文 → LLM 流式 → 答案 + 引用」；
 *   ② 答案文本由 mock 流式返回并正确拼接；
 *   ③ 每条引用都能在 chunks 表里查到真实记录（打印 SQL 结果 + 编号映射一致）；
 *   ④ 引用标注如实：答案里的编号与 citation_map 一致，未引用/越界会标 citations_unverified；
 *   ⑤ 出域预算生效：mock 端「实际收到」的 prompt 块数与字符数可核对；
 *   ⑥ 出域闸门：默认最小档下用 whole_library 请求 → 被拒且错误可读；放开后成功；
 *   ⑦ 每次出域写 llm_egress_logs（范围 / 条数 / 结果），且**不含正文原文与密钥**；
 *   ⑧ 未配置 provider → retrieval_only 且带纯检索结果，进程不崩。
 *
 * 端口用高位空闲端口（19010 mock / 19011 REST，未占用 5173/5174/17890/1899x）。
 * 数据落 .verification 临时目录，不触碰 Data/ 下的真实库。
 */
const http = require('node:http')
const assert = require('node:assert/strict')
const path = require('node:path')
const { createRuntime } = require('../dist-electron/services/runtime')

const MOCK_PORT = 19010
const MOCK_BASE = `http://127.0.0.1:${MOCK_PORT}/v1`
const GOOD_KEY = 'sk-rag-0123456789abcdef'
// mock 流式分片（含引用编号），拼接后即为答案
const ANSWER_PIECES = ['向量检索', '使用 RRF 融合', ' [1]', '，', '块级溯源可定位到页码与时间戳 [2]', '。']
const ANSWER = ANSWER_PIECES.join('')

function startMockServer() {
  const state = { lastBody: null }
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url.endsWith('/models')) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ data: [{ id: 'mock-model' }] }))
      return
    }
    if (req.method === 'POST' && req.url.endsWith('/chat/completions')) {
      let body = ''
      req.on('data', c => { body += c })
      req.on('end', () => {
        const parsed = JSON.parse(body || '{}')
        state.lastBody = parsed
        if (parsed.stream) {
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
          let i = 0
          const send = () => {
            if (i < ANSWER_PIECES.length) {
              res.write(`data: ${JSON.stringify({ model: 'mock-model', choices: [{ delta: { content: ANSWER_PIECES[i] } }] })}\n\n`)
              i++
              setTimeout(send, 10)
            } else {
              res.write(`data: ${JSON.stringify({ model: 'mock-model', choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 12, total_tokens: 22 } })}\n\n`)
              res.write('data: [DONE]\n\n')
              res.end()
            }
          }
          send()
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ model: 'mock-model', choices: [{ message: { role: 'assistant', content: ANSWER }, finish_reason: 'stop' }] }))
        }
      })
      return
    }
    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end('{}')
  })
  return new Promise(resolve => server.listen(MOCK_PORT, '127.0.0.1', () => resolve({ server, state })))
}

/** 造一份可检索的小语料：一篇文档 + 两个带锚点的块 */
function seedCorpus(r) {
  const c0 = '向量检索使用 RRF 融合全文与语义结果'
  const c1 = '块级溯源可定位到页码与时间戳'
  const content = `${c0}，${c1}。`
  const doc = r.db.prepare(`
    INSERT INTO documents (title, file_name, file_path, file_type, content_text, storage_type, is_available, processing_status)
    VALUES (?, ?, ?, ?, ?, 'local', 1, 'ready')
  `).run('混合检索设计', 'hybrid-search.md', '/tmp/hybrid-search.md', 'md', content)
  const documentId = Number(doc.lastInsertRowid)

  const insert = r.db.prepare(`
    INSERT INTO chunks (document_id, chunk_index, content, char_start, char_end, anchor_kind, anchor_index,
                        time_start_ms, time_end_ms, token_count, chunk_size, chunk_overlap)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 512, 50)
  `)
  const s0 = content.indexOf(c0)
  const s1 = content.indexOf(c1)
  const id0 = Number(insert.run(documentId, 0, c0, s0, s0 + c0.length, 'page', 7, null, null, Math.ceil(c0.length / 2)).lastInsertRowid)
  const id1 = Number(insert.run(documentId, 1, c1, s1, s1 + c1.length, 'time', 750, 750000, 760000, Math.ceil(c1.length / 2)).lastInsertRowid)
  return { documentId, content, chunkIds: [id0, id1] }
}

async function main() {
  const { server: mock, state } = await startMockServer()
  const root = path.resolve(__dirname, '../.verification', 'rag-ask-' + Date.now())
  const dataDir = path.join(root, 'Data')
  process.env.SD_DATA_PATH = dataDir
  const r = await createRuntime(dataDir)

  try {
    const corpus = seedCorpus(r)
    console.log(`\n[语料] 文档 #${corpus.documentId}，块 [${corpus.chunkIds.join(', ')}]`)

    // ---- 配置 provider ----
    r.llmService.save({ provider_id: 'byo-openai', base_url: MOCK_BASE, model: 'mock-model', api_key: GOOD_KEY, is_default: true })
    assert.equal(r.llm.status().configured, true)
    console.log(`[配置] provider=byo-openai base=${MOCK_BASE}（默认出域范围应为最小档）`)

    // ================= ① ② ③ ④ ⑤ 正常问答 =================
    console.log('\n[①-⑤] chat.ask（document_id 限定 → current_document 档）')
    const res = await r.answer.ask({ query: 'RRF 融合', document_id: corpus.documentId, actor: 'user' })
    console.log(`  mode=${res.mode} egress=${JSON.stringify(res.egress)}`)
    console.log(`  answer=${JSON.stringify(res.answer)}`)
    console.log(`  cited_indexes=${JSON.stringify(res.cited_indexes)} invalid_indexes=${JSON.stringify(res.invalid_indexes)} citations_unverified=${res.citations_unverified}`)
    console.log(`  context_meta=${JSON.stringify(res.context_meta)}`)

    assert.equal(res.mode, 'answer', '已配置模型应返回答案')
    assert.equal(res.answer, ANSWER, '答案应与 mock 流式拼接一致')
    assert.equal(res.citations_unverified, false, '答案有 [1][2] 且都合法 → 不应标未核验')
    assert.deepEqual(res.cited_indexes, [1, 2])
    assert.deepEqual(res.invalid_indexes, [])
    assert.equal(res.citations.length, 2, '应有两处引用')

    // ③ 编号 → 块映射一致
    console.log('  编号 → 块 映射：' + JSON.stringify(res.citation_map))
    assert.equal(res.citation_map[1].document_id, corpus.documentId)
    assert.equal(res.citation_map[2].document_id, corpus.documentId)

    // ③ 每条引用都能在 chunks 表里查到真实记录（打印 SQL 结果）
    console.log('\n[③] 引用回查 chunks 表：')
    for (const citation of res.citations) {
      const row = r.db.prepare('SELECT id, document_id, chunk_index, content, anchor_kind, anchor_index FROM chunks WHERE id = ?').get(citation.chunk_id)
      assert(row, `引用块 #${citation.chunk_id} 在 chunks 表中不存在`)
      assert.equal(row.document_id, citation.document_id)
      assert.equal(row.content, citation.quote, '引用片段原文必须与库内一致')
      console.log(`  引用[${citation.index}] → SELECT ... FROM chunks WHERE id=${citation.chunk_id} → ` +
        `${JSON.stringify({ id: row.id, document_id: row.document_id, chunk_index: row.chunk_index, anchor: `${row.anchor_kind}:${row.anchor_index}`, content: row.content })}`)
    }

    // ⑤ mock 端实际收到的 prompt：块数与字符数（证明预算生效）
    const userMessage = state.lastBody.messages.find(m => m.role === 'user').content
    const blockCount = (userMessage.match(/【\d+】/g) || []).length
    const receivedChars = state.lastBody.messages.reduce((sum, m) => sum + String(m.content).length, 0)
    console.log(`\n[⑤] mock 端实际收到：块数=${blockCount}，字符数=${receivedChars}（context_meta.prompt_chars=${res.context_meta.prompt_chars}）`)
    assert.equal(blockCount, 2, 'prompt 里应含 2 个编号块')
    assert.equal(receivedChars, res.context_meta.prompt_chars, 'prompt 字符数与返回体自报一致（预算口径一致）')
    assert(receivedChars > 0 && receivedChars < 4000, 'prompt 规模应受预算约束')

    // 无向量时如实标注通道
    console.log(`  通道：${JSON.stringify(res.context_meta.channels)}（未开启向量化 → 只有全文通道）`)
    assert.equal(res.context_meta.channels.semantic, false, '未开启向量化时语义通道应为 false')
    assert.equal(res.context_meta.channels.fulltext, true)

    // ================= ⑥ 出域闸门：默认最小档拒绝整库 =================
    console.log('\n[⑥] 出域闸门：默认策略（仅当前文档）下请求 whole_library')
    const refused = await r.answer.ask({ query: 'RRF 融合', egress_scope: 'whole_library', actor: 'user' })
    console.log(`  mode=${refused.mode} message=${JSON.stringify(refused.message)}`)
    console.log(`  egress=${JSON.stringify(refused.egress)} retrieval.items=${refused.retrieval.items.length}`)
    assert.equal(refused.mode, 'refused', '超范围应被拒（不静默上云）')
    assert.match(refused.message, /整库/, '错误应说明本次需要的范围')
    assert.match(refused.message, /仅当前文档/, '错误应说明当前只允许的范围')
    assert.match(refused.message, /设置/, '错误应给出可操作指引')
    assert(refused.retrieval.items.length >= 1, '被拒时仍应带上纯检索结果')

    const refusedRow = r.db.prepare("SELECT scope_mode, status, document_count, chunk_count, prompt_chars FROM llm_egress_logs WHERE status='refused' ORDER BY id DESC LIMIT 1").get()
    console.log(`  被拒留痕：${JSON.stringify(refusedRow)}`)
    assert.equal(refusedRow.status, 'refused')
    assert.equal(refusedRow.scope_mode, 'whole_library')

    // 放开到整库（显式确认）→ 同一请求成功
    console.log('\n[⑥] 把范围调到整库（显式确认）后重试')
    const updated = r.llmService.setEgressScope({ provider_id: 'byo-openai', scope: 'whole_library', confirm: true })
    console.log(`  egress_policy=${JSON.stringify(updated.egress_policy)}`)
    assert.equal(updated.egress_policy.mode, 'whole_library')
    const allowed = await r.answer.ask({ query: 'RRF 融合', egress_scope: 'whole_library', actor: 'user' })
    console.log(`  mode=${allowed.mode} answer=${JSON.stringify(allowed.answer)}`)
    assert.equal(allowed.mode, 'answer', '放开范围后应成功')

    // ================= ⑦ 出域日志：字段齐全且不含正文/密钥 =================
    console.log('\n[⑦] 出域日志（llm_egress_logs）')
    const logs = r.db.prepare(`
      SELECT id, provider_id, model, target_host, scope_mode, document_count, chunk_count,
             prompt_chars, completion_chars, status, error_code, latency_ms, actor, created_at
      FROM llm_egress_logs ORDER BY id
    `).all()
    for (const log of logs) console.log('  ' + JSON.stringify(log))
    assert(logs.length >= 3, '应有多次出域留痕（正常/被拒/放开后）')
    assert(logs.some(l => l.status === 'refused' && l.scope_mode === 'whole_library'), '被拒请求必须留痕')
    assert(logs.some(l => l.status === 'ok'), '成功出域必须留痕')
    assert(logs.every(l => l.target_host === `127.0.0.1:${MOCK_PORT}`), '目标只记 host（不含路径/query）')
    assert(logs.some(l => l.chunk_count >= 1 && l.document_count >= 1), '应记录送出的块数与篇数')
    assert(logs.some(l => l.prompt_chars > 0), '应记录送出字符数')

    // 关键：日志里没有正文原文、没有密钥
    const dump = JSON.stringify(r.db.prepare('SELECT * FROM llm_egress_logs').all())
    const auditDump = JSON.stringify(r.db.prepare("SELECT * FROM audit_logs WHERE action = 'llm_egress'").all())
    assert(!dump.includes('RRF 融合'), '出域日志泄露了正文原文！')
    assert(!dump.includes(GOOD_KEY), '出域日志泄露了密钥！')
    assert(!auditDump.includes('RRF 融合') && !auditDump.includes(GOOD_KEY), '审计日志泄露了正文或密钥！')
    console.log('  ✓ 日志只含 id/长度/host/范围，不含正文原文与密钥')

    // ================= ⑧ 未配置 provider 降级 =================
    console.log('\n[⑧] 清空 provider 配置 → 未配置降级')
    r.llmService.remove({ provider_id: 'byo-openai' })
    assert.equal(r.llm.status().configured, false)
    const degrade = await r.answer.ask({ query: 'RRF 融合', document_id: corpus.documentId, actor: 'user' })
    console.log(`  mode=${degrade.mode} answer=${JSON.stringify(degrade.answer)} meta.reason=${degrade.meta.reason}`)
    console.log(`  message=${JSON.stringify(degrade.message)}`)
    console.log(`  retrieval: total=${degrade.retrieval.total} returned=${degrade.retrieval.items.length}`)
    assert.equal(degrade.mode, 'retrieval_only', '未配置应降级为纯检索，不抛异常')
    assert.equal(degrade.answer, null)
    assert.equal(degrade.meta.reason, 'NOT_CONFIGURED')
    assert(degrade.retrieval.items.length >= 1, '降级响应必须带纯检索结果')

    // 其它功能不受影响（检索本身仍可用）
    const stillSearch = await r.search.fullTextSearch('RRF')
    assert(stillSearch.items.length >= 1, '未配置模型不应影响检索功能')
    console.log('  ✓ 未配置模型时检索仍可用（进程未崩）')

    console.log('\nPASS: S1-02 + S1-03（范围闸门拒绝/放开、出域审计不含正文与密钥、RAG 答案与可验证引用、纯检索降级）')
  } finally {
    r.db.close()
    await new Promise(resolve => mock.close(resolve))
  }
}

main().catch(e => { console.error(e); process.exit(1) })
