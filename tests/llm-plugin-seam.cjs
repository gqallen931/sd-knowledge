/**
 * ADR-006 模型接入插件化验证（全程不联网）。
 *
 * 断言的是「模型接入是插件扩展点，且默认关闭」这件事本身：
 *   ① 默认状态：没有任何 provider 被注册，聊天抛 LlmNotConfiguredError，看门狗端点 0 次请求；
 *   ② 停用内建模型插件：该插件声明的 provider 类型立刻从 `llm.providers` 消失，
 *      已保存的配置随之失效（状态回到「未接入」），再保存被拒并给出可读原因；
 *   ③ 换一个本地 llm 插件顶上：网关用的是**插件**创建的 provider（不是宿主硬编码的适配器），
 *      且依然不联网；
 *   ④ 恢复内建插件：类型清单与已保存配置的可用性一起回来。
 *
 * 看门狗 HTTP 服务只做计数：整个流程结束必须是 0 次——「默认关闭」不能只是嘴上说说。
 */
const http = require('node:http')
const assert = require('node:assert/strict')
const path = require('node:path')
const { createRuntime } = require('../dist-electron/services/runtime')
const { pluginRegistry } = require('../dist-electron/services/plugins/registry')
const { LlmNotConfiguredError } = require('../dist-electron/services/gateway/llmGateway')

const BUILTIN_LLM = 'sd.llm.openai-compatible'
const BUILTIN_HOSTED = 'sd.llm.hosted'
const FAKE_LLM = 'sd.llm.echo-test'

function startWatchdog() {
  const state = { hits: 0 }
  const server = http.createServer((req, res) => {
    state.hits += 1
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end('{}')
  })
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port
      resolve({ server, state, base: `http://127.0.0.1:${port}/v1` })
    })
  })
}

/** 测试用 llm 插件：把配置原样接住，回答固定文本，绝不联网 */
function registerFakeLlmPlugin(captured) {
  pluginRegistry.registerLlm({
    manifest: {
      id: FAKE_LLM,
      name: '回显模型（测试插件）',
      version: '0.0.1',
      apiVersion: '1.0',
      kind: 'llm',
      runtime: 'inline',
      builtin: false,
      permissions: { fsRead: false, net: false, modelDownload: [] },
      capabilities: { providerTypes: ['local-openai'] },
      description: '只用于验证扩展点：把配置变成固定回答的 provider，不发任何请求。',
    },
    llm: {
      kind: 'llm',
      providerTypes: [
        {
          kind: 'local-openai',
          label: '回显（测试插件）',
          requiresKey: false,
          available: true,
          defaultBaseUrl: 'http://127.0.0.1:1/v1',
          note: '测试插件声明：不联网。',
        },
      ],
      createProvider: (config) => {
        captured.push(config)
        return {
          id: config.providerId,
          label: config.label,
          model: config.model,
          kind: config.kind,
          baseUrl: config.baseUrl,
          available: () => true,
          chat: async () => ({
            model: config.model,
            content: '来自插件的回答',
            toolCalls: [],
            usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
            finishReason: 'stop',
          }),
          listModels: async () => [config.model],
        }
      },
    },
    source: 'local',
    loaded: true,
  })
}

async function main() {
  const watchdog = await startWatchdog()
  const root = path.resolve(__dirname, '../.verification', 'llm-plugin-run-' + Date.now())
  const dataDir = path.join(root, 'Data')
  process.env.SD_DATA_PATH = dataDir
  const r = await createRuntime(dataDir)

  try {
    // ---- ① 默认关闭 ----
    console.log('\n[①] 默认状态：模型接入未启用')
    assert.equal(r.llm.status().configured, false, '默认不应注册任何 provider')
    const ids = pluginRegistry.llmPlugins().map(p => p.id)
    console.log('  已启用的 llm 插件：' + ids.join(' / '))
    assert(ids.includes(BUILTIN_LLM), '缺少内建 OpenAI 兼容模型插件')
    assert(ids.includes(BUILTIN_HOSTED), '缺少内建「托管模型」占位插件')
    const defaults = r.llmService.providers()
    console.log('  providers() → ' + defaults.map(t => t.kind).join(' / '))
    assert.equal(defaults.length, 3, '类型清单应当完全来自内建 llm 插件（3 项）')
    assert.equal(defaults.find(t => t.kind === 'hosted').available, false, 'hosted 仍不可用')

    let unconfigured = null
    try { await r.llmService.chat({ messages: [{ role: 'user', content: 'hi' }] }) } catch (e) { unconfigured = e }
    assert(unconfigured instanceof LlmNotConfiguredError, '未配置时应当抛 LlmNotConfiguredError')
    console.log(`  ✓ chat 拒绝执行 → ${unconfigured.name}`)

    // ---- 保存一条指向看门狗的配置（默认可用）----
    const saved = r.llmService.save({
      provider_id: 'local-openai',
      base_url: watchdog.base,
      model: 'seam-model',
      is_default: true,
    })
    assert.equal(saved.kind, 'local-openai')
    assert.equal(r.llm.status().configured, true, '保存后应接入（此时用的是内建适配器）')
    console.log('  ✓ 内建插件可用：保存后 configured=true')

    // ---- ② 停用内建模型插件 ----
    console.log('\n[②] 停用内建模型插件')
    pluginRegistry.disable(BUILTIN_LLM)
    r.llmService.reload()
    const afterDisable = r.llmService.providers()
    console.log('  providers() → ' + afterDisable.map(t => t.kind).join(' / '))
    assert.deepEqual(afterDisable.map(t => t.kind), ['hosted'], '停用插件后该类型必须从清单消失')
    assert.equal(r.llm.status().configured, false, '插件停用后应回到「未接入」，而不是崩或继续用旧 provider')
    let disabledChat = null
    try { await r.llmService.chat({ messages: [{ role: 'user', content: 'hi' }] }) } catch (e) { disabledChat = e }
    assert(disabledChat instanceof LlmNotConfiguredError, '停用插件后 chat 应当回到未接入')
    let saveRejected = null
    try { r.llmService.save({ provider_id: 'byo-openai', base_url: watchdog.base, model: 'x', is_default: false }) } catch (e) { saveRejected = e }
    assert(saveRejected, '没有插件声明该类型时保存应当被拒')
    assert.match(String(saveRejected.message), /模型接入插件未启用/, '拒绝理由应说清是「插件未启用」')
    console.log(`  ✓ 保存被拒 → ${saveRejected.message}`)

    // ---- ③ 由本地 llm 插件接管 ----
    console.log('\n[③] 注册本地 llm 插件接管 provider')
    const captured = []
    registerFakeLlmPlugin(captured)
    r.llmService.reload()
    assert.equal(captured.length, 1, '网关应当调用插件的 createProvider')
    assert.equal(captured[0].model, 'seam-model', '插件应拿到解密后的配置（模型名）')
    assert.equal(captured[0].baseUrl, watchdog.base, '插件应拿到配置里的端点')
    assert.equal(r.llm.status().model, 'seam-model')
    assert.equal(r.llm.status().configured, true)
    const fakeCatalog = r.llmService.providers()
    console.log('  providers() → ' + JSON.stringify(fakeCatalog.map(t => `${t.kind}:${t.label}`)))
    // local-openai 已由测试插件接管（hosted 占位插件仍启用，故清单是 2 项）
    assert.equal(fakeCatalog.length, 2, '清单应当只剩当前启用插件声明的类型')
    const localEntry = fakeCatalog.find(t => t.kind === 'local-openai')
    assert(localEntry, 'local-openai 应由测试插件重新声明')
    assert.equal(localEntry.label, '回显（测试插件）', '同类型的标签必须来自接管的插件，而不是内建清单')
    const probed = await r.llmService.test({ provider_id: 'local-openai' })
    console.log('  llm.test → ' + JSON.stringify(probed))
    assert.equal(probed.ok, true, '插件提供的 provider 应当能被探测')
    assert.deepEqual(probed.models, ['seam-model'])

    // ---- ④ 恢复内建插件 ----
    console.log('\n[④] 恢复内建模型插件')
    pluginRegistry.disable(FAKE_LLM)
    pluginRegistry.enable(BUILTIN_LLM)
    r.llmService.reload()
    assert.equal(r.llmService.providers().length, 3, '恢复后类型清单回到 3 项')
    assert.equal(r.llm.status().configured, true, '恢复后已保存的配置应重新可用')

    // ---- 全程零联网 ----
    assert.equal(watchdog.state.hits, 0, `不该发起任何请求，但看门狗收到 ${watchdog.state.hits} 次`)
    console.log('\n  ✓ 看门狗 0 次请求：插件化改造没有引入任何自动联网')
    console.log('\n全部通过：模型接入是插件扩展点，且默认关闭。')
  } finally {
    r.close?.()
    watchdog.server.close()
  }
}

main().catch(error => {
  console.error('\n失败：' + (error?.stack || error))
  process.exit(1)
})
