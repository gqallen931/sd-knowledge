const assert = require('assert')
const http = require('http')
const { LightRagBridge, normalizeLightRagEndpoint } = require('../dist-electron/services/lightragBridge.js')

async function withServer(handler, run) {
  const server = http.createServer(handler)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try { await run(`http://127.0.0.1:${server.address().port}`) }
  finally { await new Promise(resolve => server.close(resolve)) }
}

async function main() {
  assert.equal(normalizeLightRagEndpoint('https://example.com').error, 'LightRAG 服务地址只能是本机回环 HTTP 根地址')
  assert.equal(normalizeLightRagEndpoint('http://127.0.0.1:9621').error, null)

  const disabled = await new LightRagBridge().status()
  assert.equal(disabled.state, 'disabled')

  await withServer((_req, res) => {
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ status: 'ok', version: 'test', model: 'local-test' }))
  }, async endpoint => {
    const status = await new LightRagBridge({ enabled: true, endpoint }).status()
    assert.equal(status.state, 'ready')
    assert.equal(status.version, 'test')
    assert.equal(status.model, 'local-test')
  })

  const unavailable = await new LightRagBridge({ enabled: true, endpoint: 'http://127.0.0.1:1', timeoutMs: 500 }).status()
  assert.equal(unavailable.state, 'unavailable')
  console.log('lightrag bridge: OK')
}

main().catch(error => { console.error(error); process.exit(1) })
