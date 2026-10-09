/**
 * S1-04 + S1-05 端到端验证（本地 mock，不联网）。
 *
 * 用真实启动的 Web 后端（`dist-electron/webEntry.js`）+ 一个 OpenAI 兼容 mock SSE 服务，证明：
 *   ① 问答页的真实流式出口 `/local/ask/stream` 逐块到达（**记录每块时间戳，证明是增量而非一次性回放**）；
 *   ② 结果里的引用来自真实 `chunks` 记录（打印 SQL 结果 + 编号映射）；
 *   ③ 每条引用带 `document_id` + 位置锚点 → 可跳到 `#/files?id=<doc>` 并定位（打印跳转目标与位置串）；
 *   ④ 未配置 provider → `retrieval_only` 且带纯检索结果（页面据此显示检索结果而非假问答）；
 *   ⑤ 出域被拒（整库 vs 默认仅当前文档）→ `mode='refused'` 且原因可读（含「设置」指引）；
 *   ⑥ SSE 鉴权：缺 `X-SD-Session` → 403（与 `/local/rpc` 同口径）。
 *
 * 端口用高位空闲端口（19020 mock / 19021 Web，未占用 5173/5174/17890/1899x）。
 * 数据落 `.verification/` 临时目录，**不触碰 Data/ 真实库**。
 */
const http = require('node:http')
const assert = require('node:assert/strict')
const path = require('node:path')
const fs = require('node:fs')
const { spawn } = require('node:child_process')
// 与产品同一套打开逻辑：better-sqlite3 原生模块不可用时自动回退 node:sqlite（见 services/sqlite.ts）
const { openDatabase } = require('../dist-electron/services/sqlite')

const MOCK_PORT = 19020
const WEB_PORT = 19021
const MOCK_BASE = `http://127.0.0.1:${MOCK_PORT}/v1`
const GOOD_KEY = 'sk-ask-0123456789abcdef'
const ROOT = path.resolve(__dirname, '..')
const WEB_BASE = `http://127.0.0.1:${WEB_PORT}`

// mock 流式分片（含引用编号），拼接后即为答案；每片之间延迟 50ms（供时间戳证明增量）
const ANSWER_PIECES = ['向量检索', '使用 RRF 融合', ' [1]', '，', '块级溯源可定位到页码与时间戳 [2]', '。']
const ANSWER = ANSWER_PIECES.join('')
const CHUNK_DELAY_MS = 50

function startMockServer() {
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
        if (parsed.stream) {
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
          let i = 0
          const send = () => {
            if (res.writableEnded) return
            if (i < ANSWER_PIECES.length) {
              res.write(`data: ${JSON.stringify({ model: 'mock-model', choices: [{ delta: { content: ANSWER_PIECES[i] } }] })}\n\n`)
              i++
              setTimeout(send, CHUNK_DELAY_MS)
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
  return new Promise(resolve => server.listen(MOCK_PORT, '127.0.0.1', () => resolve(server)))
}

function startWebServer(dataDir) {
  const child = spawn(process.execPath, [path.join('dist-electron', 'webEntry.js')], {
    cwd: ROOT,
    env: { ...process.env, SD_DATA_PATH: dataDir, SD_WEB_PORT: String(WEB_PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let log = ''
  child.stdout.on('data', d => { log += d.toString() })
  child.stderr.on('data', d => { log += d.toString() })
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 30000
    const poll = async () => {
      try {
        const res = await fetch(`${WEB_BASE}/local/session`)
        if (res.ok) return resolve({ child, getLog: () => log })
      } catch { /* 还没起来 */ }
      if (Date.now() > deadline) return reject(new Error('Web 后端启动超时：\n' + log))
      setTimeout(poll, 250)
    }
    poll()
  })
}

async function sessionToken() {
  const res = await fetch(`${WEB_BASE}/local/session`)
  return (await res.json()).token
}

async function rpc(token, method, args = []) {
  const res = await fetch(`${WEB_BASE}/local/rpc`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-SD-Session': token },
    body: JSON.stringify({ method, args }),
  })
  const text = await res.text()
  const json = text ? JSON.parse(text) : null
  if (!res.ok) throw new Error(json?.error || `HTTP ${res.status}`)
  return json
}

/** 读 SSE：记录每块到达时间戳，返回 { pieces, firstMs, events } */
async function readAskStream(token, payload) {
  const res = await fetch(`${WEB_BASE}/local/ask/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-SD-Session': token },
    body: JSON.stringify(payload),
  })
  assert.equal(res.status, 200, 'SSE 端点应返回 200')
  assert.match(res.headers.get('content-type') || '', /text\/event-stream/, 'SSE Content-Type')
  const started = Date.now()
  const arrivals = []
  const pieces = []
  let result = null
  let error = null
  let buffer = ''
  const decoder = new TextDecoder()
  for await (const buf of res.body) {
    // undici 的 body 分块是 Uint8Array（不是 Buffer），必须用 TextDecoder 解码
    buffer += decoder.decode(buf, { stream: true })
    let sep
    while ((sep = buffer.indexOf('\n\n')) !== -1) {
      const raw = buffer.slice(0, sep)
      buffer = buffer.slice(sep + 2)
      for (const line of raw.split('\n')) {
        if (!line.startsWith('data:')) continue
        const data = line.slice(5).trim()
        if (!data) continue
        const event = JSON.parse(data)
        if (event.type === 'chunk') { arrivals.push(Date.now() - started); pieces.push(event.chunk) }
        else if (event.type === 'result') result = event.result
        else if (event.type === 'error') error = event
      }
    }
  }
  return { pieces, arrivals, result, error }
}

/** 与前端 `anchorLabel` 同口径（用于断言「位置」串） */
function anchorLabel(anchor) {
  const kind = anchor?.anchor_kind
  if (!kind) return ''
  if (kind === 'time') {
    const ms = anchor?.time_start_ms
    if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return ''
    const s = Math.floor(ms / 1000)
    return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
  }
  const i = anchor?.anchor_index
  if (typeof i !== 'number' || i < 1) return ''
  return { page: `第 ${i} 页`, slide: `第 ${i} 张幻灯片`, chapter: `第 ${i} 章`, sheet: `第 ${i} 个工作表` }[kind] || ''
}

function seedCorpus(db) {
  const c0 = '向量检索使用 RRF 融合全文与语义结果'
  const c1 = '块级溯源可定位到页码与时间戳'
  const content = `${c0}，${c1}。`
  const doc = db.prepare(`
    INSERT INTO documents (title, file_name, file_path, file_type, content_text, storage_type, is_available, processing_status)
    VALUES (?, ?, ?, ?, ?, 'local', 1, 'ready')
  `).run('混合检索设计', 'hybrid-search.md', '/tmp/hybrid-search.md', 'md', content)
  const documentId = Number(doc.lastInsertRowid)
  const insert = db.prepare(`
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
  const mock = await startMockServer()
  const root = path.resolve(ROOT, '.verification', 'ask-stream-' + Date.now())
  const dataDir = path.join(root, 'Data')
  fs.mkdirSync(dataDir, { recursive: true })
  const web = await startWebServer(dataDir)
  const token = await sessionToken()
  // 第二个连接：直接查库做证据（与后端同文件；只读查询）
  const db = openDatabase(path.join(dataDir, 'sd.db'))

  try {
    const corpus = seedCorpus(db)
    console.log(`\n[语料] 文档 #${corpus.documentId}（page 锚点=第 7 页 / time 锚点=750s→12:30），块 [${corpus.chunkIds.join(', ')}]`)

    // ---- 配置 provider ----
    await rpc(token, 'llm.save', [{ provider_id: 'byo-openai', base_url: MOCK_BASE, model: 'mock-model', api_key: GOOD_KEY, is_default: true }])
    console.log(`[配置] provider=byo-openai base=${MOCK_BASE}（默认出域范围 = 仅当前文档）`)

    // ================= ① 真流式：逐块到达 + 时间戳 =================
    console.log('\n[①] 流式出口 /local/ask/stream：记录每块到达时间戳（mock 每片间隔 50ms）')
    const streamed = await readAskStream(token, { query: 'RRF 融合', document_id: corpus.documentId, egress_scope: 'current_document' })
    assert(!streamed.error, `不该有 error 事件：${JSON.stringify(streamed.error)}`)
    if (!streamed.result) { console.log('  调试：SSE 收到 =', JSON.stringify(streamed)); console.log('  服务端日志：\n' + web.getLog()) }
    assert(streamed.result, '应收到 result 事件')
    console.log('  块序列（按到达顺序）：' + JSON.stringify(streamed.pieces))
    console.log('  各块到达时刻(ms)：   ' + JSON.stringify(streamed.arrivals))
    assert.deepEqual(streamed.pieces, ANSWER_PIECES, '逐块内容与顺序应与 provider 分片一致')
    const spans = streamed.arrivals
    const spread = spans[spans.length - 1] - spans[0]
    const distinct = new Set(spans).size
    console.log(`  首块→末块跨度=${spread}ms，不同到达时刻数=${distinct}/${spans.length}`)
    assert(streamed.pieces.length >= 5, '应有多个增量块（不是一次性回放）')
    assert(distinct >= 4, '各块到达时刻应互不相同 → 分时到达')
    assert(spread >= CHUNK_DELAY_MS * 3, `块间应有时间间隔（跨度 ${spread}ms 应 ≥ ${CHUNK_DELAY_MS * 3}ms），证明是增量而非一次性`)

    const result = streamed.result
    assert.equal(result.mode, 'answer', '已配置模型应返回答案')
    assert.equal(result.answer, ANSWER, '最终答案文本 = 增量拼接')
    console.log(`  result.mode=${result.mode} answer=${JSON.stringify(result.answer)}`)

    // ================= ②③ 引用来自真实 chunks + 可跳转定位 =================
    console.log('\n[②③] 引用 → 真实 chunks 记录（SQL）→ 跳转目标')
    assert.equal(result.citations_unverified, false, '答案有 [1][2] 且都合法 → 不应标未核验')
    assert.deepEqual(result.cited_indexes, [1, 2])
    assert.deepEqual(result.invalid_indexes, [])
    assert.equal(result.citations.length, 2)
    for (const citation of result.citations) {
      const row = db.prepare('SELECT id, document_id, chunk_index, content, anchor_kind, anchor_index, time_start_ms FROM chunks WHERE id = ?').get(citation.chunk_id)
      assert(row, `引用块 #${citation.chunk_id} 不存在`)
      assert.equal(row.document_id, citation.document_id)
      assert.equal(row.content, citation.quote, '引用片段原文必须与库内一致')
      const position = anchorLabel(citation.anchor)
      const jump = `#/files?id=${citation.document_id}`
      console.log(`  引用[${citation.index}] SQL → ${JSON.stringify({ id: row.id, document_id: row.document_id, anchor: `${row.anchor_kind ?? 'null'}:${row.anchor_index ?? ''}`, time_start_ms: row.time_start_ms ?? null, content: row.content })}`)
      console.log(`         位置=${position || '（无锚点，仅文件名+片段）'}  跳转=${jump}`)
      assert.equal(citation.document_id, corpus.documentId, '跳转目标文档正确')
      assert(position, '本条引用应有可读位置')
    }
    assert.equal(anchorLabel(result.citations[0].anchor), '第 7 页')
    assert.equal(anchorLabel(result.citations[1].anchor), '12:30')

    // ================= ⑥ SSE 鉴权：缺会话 → 403 =================
    const noSession = await fetch(`${WEB_BASE}/local/ask/stream`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query: 'x' }),
    })
    console.log(`\n[⑥] 缺 X-SD-Session 访问流式出口 → HTTP ${noSession.status}`)
    assert.equal(noSession.status, 403, '会话缺失应与 /local/rpc 一样被拒')

    // ================= ⑤ 出域被拒（整库 vs 默认仅当前文档）=================
    console.log('\n[⑤] 出域闸门：默认策略下请求整库范围')
    const refused = await readAskStream(token, { query: 'RRF 融合', egress_scope: 'whole_library' })
    assert(refused.result, '被拒也应有 result')
    console.log(`  mode=${refused.result.mode}`)
    console.log(`  message=${JSON.stringify(refused.result.message)}`)
    console.log(`  egress=${JSON.stringify(refused.result.egress)} retrieval.items=${refused.result.retrieval.items.length}`)
    assert.equal(refused.result.mode, 'refused', '超范围应被拒（不静默上云）')
    assert.match(refused.result.message, /整库/)
    assert.match(refused.result.message, /仅当前文档/)
    assert.match(refused.result.message, /设置/, '应给出可操作指引（设置 → AI 引擎 → 数据出域）')
    assert(refused.result.retrieval.items.length >= 1, '被拒时仍应带纯检索结果')

    // ================= ④ 未配置 → retrieval_only（检索页而非假问答）=================
    console.log('\n[④] 清空 provider → 未配置降级')
    await rpc(token, 'llm.remove', [{ provider_id: 'byo-openai' }])
    const degrade = await readAskStream(token, { query: 'RRF 融合', document_id: corpus.documentId, egress_scope: 'current_document' })
    assert(degrade.result, '降级也应有 result')
    console.log(`  mode=${degrade.result.mode} answer=${JSON.stringify(degrade.result.answer)} meta.reason=${degrade.result.meta.reason}`)
    console.log(`  message=${JSON.stringify(degrade.result.message)}`)
    console.log(`  retrieval: total=${degrade.result.retrieval.total} returned=${degrade.result.retrieval.items.length}`)
    assert.equal(degrade.result.mode, 'retrieval_only', '未配置应降级为纯检索，不抛异常')
    assert.equal(degrade.result.answer, null, '未配置不产生假答案')
    assert.equal(degrade.pieces.length, 0, '未配置时不应有任何假流式块')
    assert(degrade.result.retrieval.items.length >= 1, '降级必须带纯检索结果（页面据此展示检索结果）')

    console.log('\nPASS: S1-04 + S1-05（真增量流式 / 引用可回查 chunks / 引用可跳转定位 / 未配置降级为检索 / 出域被拒可读 / SSE 鉴权）')
  } finally {
    try { db.close() } catch {}
    try { web.child.kill() } catch {}
    await new Promise(resolve => mock.close(resolve))
  }
}

main().catch(e => { console.error(e); process.exit(1) })
