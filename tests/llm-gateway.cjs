/**
 * S1-01 LLM 网关端到端验证（本地 mock，不联网）。
 *
 * 用一个 OpenAI 兼容的 mock HTTP 服务，证明：
 *   ① llm.stream 逐块收到内容并按序拼接；
 *   ② llm.test 能探测成功（连通性 + 极短 prompt 实测）；
 *   ③ 非流式 llm.chat 正常；
 *   ④ 401/403/404/429/5xx/超时/连接失败 各自的中文错误文案正确；
 *   ⑤ 未配置时抛 LlmNotConfiguredError 而不是崩；
 *   ⑥ llm.list / llm.save 响应里没有明文 key（掩码），且直接读库看到的是密文；
 *   ⑦ reader 凭证调 llm 写方法被 REST 拒绝，调只读方法放行。
 *
 * 端口用高位空闲端口（18996 REST / 18997 mock / 18998 用来验证「连接失败」），跑完关闭。
 * 数据落在 .verification 临时目录，不触碰 Data/ 下的真实库。
 */
const http = require('node:http')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { createRuntime } = require('../dist-electron/services/runtime')
const { APIServer } = require('../dist-electron/services/apiServer')
const { OpenAiCompatibleProvider } = require('../dist-electron/services/gateway/openaiProvider')
const { LlmNotConfiguredError } = require('../dist-electron/services/gateway/llmGateway')

const MOCK_PORT = 18997
const DEAD_PORT = 18998
const REST_PORT = 18996
const MOCK_BASE = `http://127.0.0.1:${MOCK_PORT}/v1`
const GOOD_KEY = 'sk-good-1234567890abcd'
const SSE_PIECES = ['你', '好', '，', '世界']

function startMockServer() {
  const server = http.createServer((req, res) => {
    const key = String(req.headers.authorization || '').replace(/^Bearer\s+/, '')
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
        if (key === 'sk-401') { res.writeHead(401, { 'Content-Type': 'application/json' }); res.end('{"error":{"message":"bad key"}}'); return }
        if (key === 'sk-403') { res.writeHead(403, { 'Content-Type': 'application/json' }); res.end('{}'); return }
        if (key === 'sk-404') { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end('{}'); return }
        if (key === 'sk-429') { res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '1' }); res.end('{}'); return }
        if (key === 'sk-500') { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end('{}'); return }
        if (key === 'sk-timeout') { return } // 不回包，让客户端超时
        if (parsed.stream) {
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
          let i = 0
          const send = () => {
            if (i < SSE_PIECES.length) {
              res.write(`data: ${JSON.stringify({ model: 'mock-model', choices: [{ delta: { content: SSE_PIECES[i] } }] })}\n\n`)
              i++
              setTimeout(send, 15)
            } else {
              res.write(`data: ${JSON.stringify({ model: 'mock-model', choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 } })}\n\n`)
              res.write('data: [DONE]\n\n')
              res.end()
            }
          }
          send()
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ model: 'mock-model', choices: [{ message: { role: 'assistant', content: 'pong' }, finish_reason: 'stop' }], usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } }))
        }
      })
      return
    }
    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end('{}')
  })
  return new Promise(resolve => server.listen(MOCK_PORT, '127.0.0.1', () => resolve(server)))
}

async function expectError(run, pattern, expectedCode, label) {
  let caught = null
  try { await run() } catch (e) { caught = e }
  assert(caught, `${label}：应当抛错但没有`)
  assert.match(String(caught.message), pattern, `${label}：文案不符 → ${caught.message}`)
  if (expectedCode) assert.equal(caught.code, expectedCode, `${label}：code 不符 → ${caught.code}`)
  console.log(`  ✓ ${label} → [${caught.code}] ${caught.message}`)
}

async function main() {
  const mock = await startMockServer()
  const root = path.resolve(__dirname, '../.verification', 'llm-run-' + Date.now())
  const dataDir = path.join(root, 'Data')
  process.env.SD_DATA_PATH = dataDir
  const r = await createRuntime(dataDir)

  try {
    // ---- ⑤ 未配置：抛 LlmNotConfiguredError，而不是崩 ----
    console.log('\n[⑤] 未配置时')
    assert.equal(r.llm.status().configured, false)
    let unconfigured = null
    try { await r.llmService.chat({ messages: [{ role: 'user', content: 'hi' }] }) } catch (e) { unconfigured = e }
    assert(unconfigured instanceof LlmNotConfiguredError, '未配置应抛 LlmNotConfiguredError')
    console.log(`  ✓ chat 抛出 ${unconfigured.name} code=${unconfigured.code} :: ${unconfigured.message}`)

    // ---- provider 契约 ----
    console.log('\n[provider 契约] providers()')
    const types = r.llmService.providers()
    console.log('  ' + JSON.stringify(types))
    assert.equal(types.length, 3)
    assert.equal(types.find(t => t.kind === 'hosted').available, false, 'hosted 本轮不可用')
    assert.equal(types.find(t => t.kind === 'local-openai').requires_key, false)

    // ---- 保存配置（掩码）----
    console.log('\n[⑥] 保存配置（携带明文，返回掩码、无明文）')
    const saved = r.llmService.save({ provider_id: 'byo-openai', base_url: MOCK_BASE, model: 'mock-model', api_key: GOOD_KEY, is_default: true })
    const saveJson = JSON.stringify(saved)
    console.log('  llm.save → ' + saveJson)
    assert.equal(saved.key_mask, 'sk-good-…')
    assert(!saveJson.includes(GOOD_KEY), 'llm.save 响应泄露了明文 key！')
    assert(!/api_key_enc|"api_key"/.test(saveJson), 'llm.save 响应不应带密文字段')

    const listJson = JSON.stringify(r.llmService.list())
    console.log('  llm.list → ' + listJson)
    assert(!listJson.includes(GOOD_KEY), 'llm.list 响应泄露了明文 key！')
    assert.equal(r.llmService.list().length, 1)
    assert.equal(r.llm.status().configured, true)

    // 密钥加密落库：直接读库看到的是密文
    const row = r.db.prepare("SELECT api_key_enc, api_key_iv, api_key_tag, api_key_hint FROM llm_providers WHERE provider_id='byo-openai'").get()
    const cipherText = Buffer.from(row.api_key_enc).toString('utf8')
    console.log(`  库内 api_key_hint=${row.api_key_hint} · enc=${Buffer.from(row.api_key_enc).toString('hex').slice(0, 32)}… · iv=${Buffer.from(row.api_key_iv).toString('hex')} · tag=${Buffer.from(row.api_key_tag).toString('hex').slice(0, 16)}…`)
    assert(!cipherText.includes(GOOD_KEY), '库内明文未加密！')
    assert(fs.existsSync(path.join(dataDir, '.keys', 'platform.key')), '缺少平台级密钥文件')
    console.log('  ✓ 明文 key 不在库中；平台密钥文件已生成于 ' + path.join(dataDir, '.keys', 'platform.key'))

    // ---- ② llm.test 探测成功 ----
    console.log('\n[②] llm.test 连通性 + 极短 prompt')
    const testOk = await r.llmService.test({ provider_id: 'byo-openai' })
    console.log('  ' + JSON.stringify(testOk))
    assert.equal(testOk.ok, true)
    assert.equal(testOk.model, 'mock-model')
    assert(testOk.latencyMs >= 0)
    assert(testOk.models.includes('mock-model'))
    assert.equal(testOk.echo, 'pong')

    // ---- ③ 非流式 chat ----
    console.log('\n[③] 非流式 llm.chat')
    const chatRes = await r.llmService.chat({ messages: [{ role: 'user', content: 'ping' }] })
    console.log('  ' + JSON.stringify(chatRes))
    assert.equal(chatRes.content, 'pong')
    assert.equal(chatRes.model, 'mock-model')

    // ---- ① 流式 llm.stream 逐块 + 顺序 ----
    console.log('\n[①] 流式 llm.stream 逐块拼接')
    const seen = []
    const streamRes = await r.llmService.stream({
      messages: [{ role: 'user', content: 'ping' }],
      // 通过 provider 级回调观察「逐块到达」（网关出口本身是一次性返回）
    })
    // 直接用 provider 观察逐块回调顺序
    const provider = new OpenAiCompatibleProvider({ id: 'probe', kind: 'byo-openai', label: 'probe', baseUrl: MOCK_BASE, model: 'mock-model', apiKey: GOOD_KEY, timeoutMs: 5000, maxRetries: 0 })
    const providerRes = await provider.stream({ messages: [{ role: 'user', content: 'ping' }] }, c => seen.push(c))
    console.log('  provider.onChunk 逐块 = ' + JSON.stringify(seen))
    console.log('  llm.stream chunks   = ' + JSON.stringify(streamRes.chunks))
    console.log('  llm.stream content  = ' + JSON.stringify(streamRes.content))
    assert.deepEqual(seen, SSE_PIECES, '逐块回调应按序收到 mock 分片')
    assert(streamRes.chunks.length > 1, '流式应产生多个 chunk')
    assert.equal(streamRes.chunks.join(''), '你好，世界')
    assert.equal(providerRes.chunks.join(''), providerRes.content)

    // ---- 出域钩子已接线：chat/stream 应写入 llm_egress_logs ----
    const egressCount = r.db.prepare("SELECT COUNT(*) AS n FROM llm_egress_logs WHERE provider_id='byo-openai'").get().n
    console.log(`\n[出域审计] llm_egress_logs 行数 = ${egressCount}`)
    assert(egressCount >= 2, 'chat/stream 应各写一条出域审计')

    // ---- ④ 错误映射 ----
    console.log('\n[④] 错误映射（中文文案）')
    const mk = (apiKey, baseUrl = MOCK_BASE, timeoutMs = 4000) => new OpenAiCompatibleProvider({ id: 't', kind: 'byo-openai', label: 't', baseUrl, model: 'mock-model', apiKey, timeoutMs, maxRetries: 0 })
    const msg = [{ role: 'user', content: 'ping' }]
    await expectError(() => mk('sk-401').chat({ messages: msg }), /密钥无效或无权访问/, 'NOT_CONFIGURED', '401')
    await expectError(() => mk('sk-403').chat({ messages: msg }), /密钥无权访问/, 'NOT_CONFIGURED', '403')
    await expectError(() => mk('sk-404').chat({ messages: msg }), /端点或模型名不正确/, 'NOT_CONFIGURED', '404')
    await expectError(() => mk('sk-429').chat({ messages: msg }), /触发上游限流/, 'RATE_LIMITED', '429')
    await expectError(() => mk('sk-500').chat({ messages: msg }), /上游服务暂时不可用/, 'UNAVAILABLE', '500')
    await expectError(() => mk('sk-timeout', MOCK_BASE, 300).chat({ messages: msg }), /请求超时/, 'UNAVAILABLE', '超时')
    await expectError(() => mk(GOOD_KEY, `http://127.0.0.1:${DEAD_PORT}/v1`).chat({ messages: msg }), /端点不可达/, 'UNAVAILABLE', '连接失败')

    // ---- ⑦ REST reader 权限实测 ----
    console.log('\n[⑦] REST：reader 凭证的读写边界')
    const api = new APIServer(r.db, r.files, r.search, r.graph, r.security, r.processing, {
      workbench: r.workbench, tasks: r.tasks, auth: r.auth, reminders: r.reminders,
      dataManager: r.dataManager, search: r.search, llm: r.llm, llmService: r.llmService, camera: r.camera,
    })
    await api.start(REST_PORT)
    try {
      await r.security.setup('llm-seam-password')
      const readerKey = await r.security.createApiKey('LLM reader', 'reader')
      const auth = { Authorization: 'Bearer ' + readerKey.key, 'Content-Type': 'application/json' }
      const rpc = (method, args) => fetch(`http://127.0.0.1:${REST_PORT}/api/v1/workbench/rpc`, { method: 'POST', headers: auth, body: JSON.stringify({ method, args }) })

      assert.equal((await rpc('llm.list', [])).status, 200, 'reader 应能调 llm.list')
      assert.equal((await rpc('llm.providers', [])).status, 200, 'reader 应能调 llm.providers')
      assert.equal((await rpc('llm.save', [{ provider_id: 'local-openai', base_url: MOCK_BASE, model: 'mock-model' }])).status, 400, 'reader 调 llm.save 应被拒')
      assert.equal((await rpc('llm.test', [{ provider_id: 'byo-openai' }])).status, 400, 'reader 调 llm.test 应被拒')
      assert.equal((await rpc('llm.remove', [{ provider_id: 'byo-openai' }])).status, 400, 'reader 调 llm.remove 应被拒')
      console.log('  ✓ llm.list / llm.providers → 200；llm.save / llm.test / llm.remove → 400（此密钥没有写入权限）')
      await r.security.revokeApiKey(readerKey.id)
    } finally {
      await api.stop()
    }

    console.log('\nPASS: S1-01 LLM 网关（mock SSE 逐块/顺序、非流式、test 探测、错误映射、未配置降级、密钥掩码与密文落库、出域审计、REST reader 权限）')
  } finally {
    r.db.close()
    // sk-timeout 用例会留下一个未响应的连接，显式关闭后再关服务器，避免 close 挂起
    if (typeof mock.closeAllConnections === 'function') mock.closeAllConnections()
    await new Promise(resolve => mock.close(resolve))
  }
}

main().catch(e => { console.error(e); process.exit(1) })
