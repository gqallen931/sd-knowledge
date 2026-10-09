/**
 * S1-05 流式链路契约测试（纯 Node，不依赖原生模块 / 不需要数据库）。
 *
 * 直接驱动编译产物 `dist-electron/services/answerService.js`（它只 require 纯 JS 模块），
 * 用桩替换 `SearchService` 与 `LlmService`，验证「真流式」与「引用解析」的业务契约：
 *   ① `ask({stream:true, onChunk})` 把 provider 的增量**逐块、按序、实时**转出（onChunk 在 provider 每产一块时即被调用）；
 *   ② 最终 `AnswerResult` 形态不变：answer = 增量拼接，citations/anchor/quote 与块一致；
 *   ③ 越界编号 / 无引用 → `citations_unverified` 如实标注；
 *   ④ 未配置 provider → `retrieval_only`（且**不产生任何假流式块**）；
 *   ⑤ 出域被拒（FORBIDDEN）→ `refused` + 可读 message；其它失败 → `error`。
 *
 * 说明：完整 HTTP/SSE 端到端见 `tests/ask-stream.cjs`（需先有 **Node ABI 的 better-sqlite3**，
 * 见该文件与开发日志的「验证限制」说明）。
 */
const assert = require('node:assert/strict')
const { AnswerService } = require('../dist-electron/services/answerService')

const delay = ms => new Promise(r => setTimeout(r, ms))

function blocks() {
  return [
    { index: 1, document_id: 7, chunk_id: 101, title: '混合检索设计', file_name: 'hybrid-search.md', anchor: { anchor_kind: 'page', anchor_index: 7, time_start_ms: null }, content: '向量检索使用 RRF 融合全文与语义结果', tokens: 12 },
    { index: 2, document_id: 7, chunk_id: 102, title: '混合检索设计', file_name: 'hybrid-search.md', anchor: { anchor_kind: 'time', anchor_index: 750, time_start_ms: 750000 }, content: '块级溯源可定位到页码与时间戳', tokens: 10 },
  ]
}

function makeSearch() {
  return {
    buildAnswerContext: async () => ({ blocks: blocks(), retrieval: { items: [{ id: 7 }], total: 1, truncated: false }, token_count: 22, truncated: false, truncated_reason: null }),
  }
}

/** 桩 provider：每产一块「真等 40ms」，用来证明 onChunk 是随 provider 实时转出，而非最后一次性回放 */
function makeLlm(pieces, options = {}) {
  const calls = { chunks: 0, streamCalls: 0 }
  return {
    calls,
    status: () => options.configured === false
      ? { configured: false, providerId: null, model: '', label: '', reason: '尚未接入大语言模型' }
      : { configured: true, providerId: 'byo-openai', model: 'mock-model', label: '自带密钥' },
    stream: async (_request, onChunk) => {
      calls.streamCalls++
      if (options.fail) { const e = new Error(options.fail.message); e.code = options.fail.code; throw e }
      // 与真实 LlmService.stream 一致：未提供回调时按空实现处理（不影响最终结果）
      const emit = typeof onChunk === 'function' ? onChunk : () => {}
      for (const piece of pieces) { emit(piece); calls.chunks++; await delay(40) }
      return { model: 'mock-model', content: pieces.join(''), toolCalls: [], usage: null, finishReason: 'stop', chunks: [...pieces] }
    },
  }
}

async function main() {
  // ===== ① ② 真流式 + 引用一致 =====
  {
    const pieces = ['向量检索', '使用 RRF 融合', ' [1]', '，', '块级溯源可定位到页码与时间戳 [2]', '。']
    const llm = makeLlm(pieces)
    const service = new AnswerService(makeSearch(), llm)
    const arrivals = []
    const seen = []
    const started = Date.now()
    const result = await service.ask({
      query: 'RRF 融合', document_id: 7, stream: true,
      onChunk: chunk => { arrivals.push(Date.now() - started); seen.push(chunk) },
    })
    console.log('[①] 增量（按到达顺序）：' + JSON.stringify(seen))
    console.log('    到达时刻(ms)：     ' + JSON.stringify(arrivals))
    const spread = arrivals[arrivals.length - 1] - arrivals[0]
    assert.deepEqual(seen, pieces, '逐块内容与顺序应与 provider 产出一致')
    assert.equal(new Set(arrivals).size >= 4, true, '各块到达时刻不同 → 实时转出')
    assert(spread >= 40 * 3, `块间应有时间间隔（跨度 ${spread}ms ≥ 120ms）→ 真增量而非一次性`)

    console.log(`[②] mode=${result.mode} answer=${JSON.stringify(result.answer)}`)
    assert.equal(result.mode, 'answer')
    assert.equal(result.answer, pieces.join(''), 'answer = 增量拼接')
    assert.deepEqual(result.cited_indexes, [1, 2])
    assert.deepEqual(result.invalid_indexes, [])
    assert.equal(result.citations_unverified, false)
    assert.equal(result.citations.length, 2)
    assert.equal(result.citations[0].chunk_id, 101)
    assert.equal(result.citations[0].quote, blocks()[0].content, '引用片段原文 = 块正文')
    assert.equal(result.citations[0].anchor.anchor_kind, 'page')
    assert.equal(result.citations[1].anchor.time_start_ms, 750000)
    assert.equal(result.citation_map[1].chunk_id, 101)
    assert.equal(result.citation_map[2].document_id, 7)
    console.log('    引用[1] → ' + JSON.stringify({ chunk_id: result.citations[0].chunk_id, document_id: result.citations[0].document_id, anchor: 'page:7' }))
    console.log('    引用[2] → ' + JSON.stringify({ chunk_id: result.citations[1].chunk_id, document_id: result.citations[1].document_id, anchor: 'time:750000ms' }))
  }

  // ===== ③ 越界编号 / 无引用 =====
  {
    const service = new AnswerService(makeSearch(), makeLlm(['结论 [9]。']))
    const result = await service.ask({ query: 'q', document_id: 7, stream: true, onChunk: () => {} })
    console.log(`\n[③] 越界编号：invalid_indexes=${JSON.stringify(result.invalid_indexes)} citations_unverified=${result.citations_unverified}`)
    console.log(`    message=${JSON.stringify(result.message)}`)
    assert.deepEqual(result.invalid_indexes, [9])
    assert.equal(result.citations_unverified, true, '越界编号 → 如实标注未核实')

    const noCite = await new AnswerService(makeSearch(), makeLlm(['没有编号的答案。'])).ask({ query: 'q', document_id: 7, stream: true, onChunk: () => {} })
    console.log(`    无引用：cited_indexes=${JSON.stringify(noCite.cited_indexes)} citations_unverified=${noCite.citations_unverified}`)
    assert.equal(noCite.citations_unverified, true, '没有任何引用 → 如实标注')
  }

  // ===== ④ 未配置 → retrieval_only，且不产生假流式 =====
  {
    const llm = makeLlm([], { configured: false })
    let chunkCount = 0
    const result = await new AnswerService(makeSearch(), llm).ask({ query: 'q', document_id: 7, stream: true, onChunk: () => { chunkCount++ } })
    console.log(`\n[④] 未配置：mode=${result.mode} answer=${JSON.stringify(result.answer)} 假流式块数=${chunkCount} retrieval.items=${result.retrieval.items.length}`)
    assert.equal(result.mode, 'retrieval_only')
    assert.equal(result.answer, null)
    assert.equal(chunkCount, 0, '未配置时不得有任何流式块（不伪造）')
    assert(result.retrieval.items.length >= 1, '降级必须带纯检索结果')
    assert.equal(llm.calls.streamCalls, 0, '未配置时不应调用模型')
  }

  // ===== ⑤ 出域被拒 / 其它失败 =====
  {
    const refused = await new AnswerService(makeSearch(), makeLlm([], { fail: { code: 'FORBIDDEN', message: '本次请求需要出域范围「整库」，当前设置只允许「仅当前文档」，请在「设置 → AI 引擎 → 数据出域」中调整后再试。' } }))
      .ask({ query: 'q', stream: true, onChunk: () => {} })
    console.log(`\n[⑤] 被拒：mode=${refused.mode} egress=${JSON.stringify(refused.egress)}`)
    console.log(`    message=${JSON.stringify(refused.message)}`)
    assert.equal(refused.mode, 'refused')
    assert.equal(refused.egress.allowed, false)
    assert.match(refused.message, /设置/)

    const errored = await new AnswerService(makeSearch(), makeLlm([], { fail: { code: 'UNAVAILABLE', message: '端点不可达' } })).ask({ query: 'q', stream: true, onChunk: () => {} })
    console.log(`    失败：mode=${errored.mode} message=${JSON.stringify(errored.message)}`)
    assert.equal(errored.mode, 'error')
    assert.match(errored.message, /端点不可达/)
  }

  // ===== 回归：stream 缺省（false）时行为不变 =====
  {
    const result = await new AnswerService(makeSearch(), makeLlm(['答案 [1]。'])).ask({ query: 'q', document_id: 7 })
    console.log(`\n[回归] stream 缺省：mode=${result.mode} answer=${JSON.stringify(result.answer)}`)
    assert.equal(result.mode, 'answer')
    assert.equal(result.answer, '答案 [1]。')
  }

  console.log('\nPASS: 流式契约（增量实时转出 / 引用与块一致 / 越界与无引用如实标注 / 未配置降级不伪造 / 被拒与失败可读）')
}

main().catch(e => { console.error(e); process.exit(1) })
