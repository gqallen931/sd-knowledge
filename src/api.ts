let session: Promise<string> | null = null
const token = () => session ||= fetch('/local/session').then(async r => {
  if (!r.ok) throw new Error('无法连接本地服务，请使用启动脚本打开软件')
  return (await r.json()).token
}).catch((error) => {
  // 失败就清掉缓存的 Promise：否则一次失败会让后续所有请求都复用一个已 rejected 的会话
  session = null
  throw error
})

/**
 * 页面是否正在卸载。
 *
 * 卸载时浏览器会中断在途请求（控制台出现 `net::ERR_ABORTED /local/rpc`），
 * 这类失败不是真错误：此时不抛出、不记日志。正常状态下的失败仍照常抛出，不会吞掉真错误。
 */
let unloading = false
if (typeof window !== 'undefined') {
  const markUnloading = () => { unloading = true }
  window.addEventListener('pagehide', markUnloading)
  window.addEventListener('beforeunload', markUnloading)
  // 从 bfcache 返回时复位，避免之后把真错误也当成卸载中断
  window.addEventListener('pageshow', () => { unloading = false })
}

/** 带错误码的 RPC 异常：401 需要前端跳登录，其余按普通错误提示 */
function rpcError(message: string, code: 'AUTH_REQUIRED' | 'RPC_FAILED') {
  const error = new Error(message) as Error & { code: string }
  error.code = code
  return error
}

export const isAuthRequired = (error: any) => error?.code === 'AUTH_REQUIRED' || /请先登录|AUTH_REQUIRED/.test(String(error?.message || ''))

async function rpc(method: string, ...args: any[]) {
  try {
    const response = await fetch('/local/rpc', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-SD-Session': await token() }, body: JSON.stringify({ method, args }) })
    // 先取文本再解析：服务端异常时可能返回非 JSON，直接 .json() 会抛出难懂的语法错误
    const text = await response.text()
    let result: any = null
    try { result = text ? JSON.parse(text) : null } catch { result = null }
    if (!response.ok) throw rpcError(result?.error || `请求失败（HTTP ${response.status}）`, response.status === 401 ? 'AUTH_REQUIRED' : 'RPC_FAILED')
    return result
  } catch (error) {
    // 卸载期间的失败（请求被中断）静默返回，避免控制台出现未处理的 promise 拒绝
    if (unloading) return null
    throw error
  }
}

export async function uploadFiles(files: File[]) {
  const data = new FormData()
  files.forEach(f => data.append('files', f))
  const response = await fetch('/local/upload', { method: 'POST', headers: { 'X-SD-Session': await token() }, body: data })
  const result = await response.json()
  if (!response.ok) throw new Error(result.error || '导入失败')
  return result
}

export const isDesktop = !!window.sd
if (!window.sd) {
  const group = (prefix: string, methods: string[]) => Object.fromEntries(methods.map(m => [m, (...args: any[]) => rpc(`${prefix}.${m}`, ...args)]))
  window.sd = {
    file: group('file', ['list', 'detail', 'delete', 'process']),
    folder: {
      ...group('folder', ['list', 'update', 'remove', 'sync', 'syncAll', 'cleanup', 'listFolders']),
      select: async () => { throw new Error('浏览器模式无法读取本地目录，请在桌面版中映射文件夹') },
      preview: async () => { throw new Error('浏览器模式无法读取本地目录，请在桌面版中映射文件夹') },
      create: async () => { throw new Error('浏览器模式无法读取本地目录，请在桌面版中映射文件夹') },
    },
    dashboard: group('dashboard', ['stats', 'recent']),
    queue: group('queue', ['status']),
    project: group('project', ['list', 'create', 'update', 'remove', 'assign', 'assignMany']),
    graph: group('graph', ['nodes', 'edges', 'entity', 'stats', 'addRelationship', 'deleteRelationship', 'mergeEntities', 'mergeEntitiesBatch', 'renameEntity', 'batchRenameEntities', 'searchNodes', 'searchEntities', 'suggestEntityMerges', 'overview', 'bridges', 'entities', 'listAliases', 'addAlias', 'removeAlias', 'listMergeHistory', 'ignoreMergeSuggestion', 'listIgnoredMergePairs']),
    search: group('search', ['fulltext', 'semantic']),
    settings: group('settings', ['get', 'update']),
    security: { ...group('security', ['status', 'setup', 'verify']), apiKeys: group('security.apiKeys', ['list', 'create', 'revoke']) },
    audit: group('audit', ['list', 'retentionGet', 'retentionSet', 'prune']),
    analytics: group('analytics', ['overview']),
    share: group('share', ['exportSnapshot']),
    shell: { openPath: async () => { throw new Error('请在桌面版中打开本地文件') }, showInFolder: async () => { throw new Error('请在桌面版中打开文件夹') } },
    on: () => () => {},
  } as any
}

/**
 * 工作台域门面（ADR-003）。
 *
 * 方法名恰好就是 `组.方法` 的形式（workbench.project.list、data.backup.create……），
 * 所以内层用 Proxy 按需生成即可：新增一个工作台接口只改主进程的方法表，
 * 前端一个字都不用动——这是把「三处同步」压成「一处定义」的关键。
 *
 * `plugin` 组由 ADR-005 的插件方法表提供（plugin.list / status / enable / disable / reload）。
 */
const WORKBENCH_GROUPS = ['auth', 'workbench', 'task', 'tag', 'notification', 'reminder', 'data', 'gateway', 'perception', 'plugin', 'llm', 'chat', 'resource', 'githubRank'] as const

function bindWorkbench(call: (method: string, ...args: any[]) => Promise<any>) {
  WORKBENCH_GROUPS.forEach(prefix => {
    ;(window.sd as any)[prefix] = new Proxy({}, {
      get: (_target, method: string | symbol) => (typeof method === 'string' ? (...args: any[]) => call(`${prefix}.${method}`, ...args) : undefined),
    })
  })
}

const bridge = (window.sd as any).__workbenchRpc
bindWorkbench(isDesktop && bridge ? (method, ...args) => bridge(method, ...args) : rpc)

/** 问答流式的统一入参（与 `chat.ask` 同形，额外由前端带上 `stream`） */
export interface AskStreamPayload {
  query: string
  document_id?: number | null
  scope?: { source_id?: number | null; folder_path?: string | null; project_id?: number | null; unassigned?: boolean }
  egress_scope?: 'current_document' | 'selected_scope' | 'whole_library'
  limit?: number
  max_tokens?: number
}

export interface AskStreamHandlers {
  /** 每块增量（真流式：随时间陆续到达，不是一次性回放） */
  onChunk: (chunk: string) => void
  /** 取消信号：离开页面或再次提问时 abort，前一个请求随即中止 */
  signal?: AbortSignal
}

let askSeq = 0

/**
 * 问答流式请求（S1-05 的统一前端入口）。
 *
 * 按运行形态分流，但**入参与返回体完全一致**，页面不需要关心跑在哪：
 *   - 桌面：`window.sd.askStream`（preload → 主进程 IPC 事件逐块推送），取消走 `askStreamCancel`；
 *   - Web：`POST /local/ask/stream`（SSE，与 `/local/rpc` 同一会话鉴权），取消走 fetch 的 `signal`。
 * 返回最终 `SDAnswerResult`；流式过程中的错误（超时 / 401 / 被拒）在此抛出可读原因。
 */
export async function askStream(payload: AskStreamPayload, handlers: AskStreamHandlers): Promise<any> {
  const { onChunk, signal } = handlers
  const desktopAskStream = (window.sd as any)?.askStream
  if (isDesktop && typeof desktopAskStream === 'function') {
    const requestId = `ask-${Date.now()}-${++askSeq}`
    const cancel = () => { void (window.sd as any).askStreamCancel?.(requestId) }
    signal?.addEventListener('abort', cancel, { once: true })
    try {
      return await desktopAskStream(requestId, payload, onChunk)
    } finally {
      signal?.removeEventListener('abort', cancel)
    }
  }

  try {
    // 开发态直连后端端口：经 Vite 代理的 SSE 响应即使完整收完，Chromium 也会记一条 net::ERR_ABORTED。
    // VITE_RPC_ORIGIN 由 vite.config 注入；生产 Web 构建同源（webEntry 托管静态文件），保持相对路径。
    const rpcOrigin: string = import.meta.env.DEV ? (import.meta.env.VITE_RPC_ORIGIN || '') : ''
    const response = await fetch(`${rpcOrigin}/local/ask/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-SD-Session': await token() },
      body: JSON.stringify(payload),
      signal,
    })
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      throw rpcError(text || `请求失败（HTTP ${response.status}）`, response.status === 401 ? 'AUTH_REQUIRED' : 'RPC_FAILED')
    }
    if (!response.body) throw new Error('当前浏览器不支持流式读取，请使用桌面版')
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let result: any = null
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let sep: number
      // SSE 事件以空行分隔；跨 chunk 的半行留在 buffer 里等下一批
      while ((sep = buffer.indexOf('\n\n')) !== -1) {
        const raw = buffer.slice(0, sep)
        buffer = buffer.slice(sep + 2)
        for (const line of raw.split('\n')) {
          if (!line.startsWith('data:')) continue
          const data = line.slice(5).trim()
          if (!data) continue
          let event: any
          try { event = JSON.parse(data) } catch { continue }
          if (event.type === 'chunk') onChunk(String(event.chunk ?? ''))
          else if (event.type === 'result') result = event.result
          else if (event.type === 'error') throw rpcError(event.message || '问答失败', event.code === 'AUTH_REQUIRED' ? 'AUTH_REQUIRED' : 'RPC_FAILED')
        }
      }
      // 不在 result 处提前 break：继续读到服务端 FIN 自然收尾。
      // 提前 break / reader.cancel() 都会被 Chromium 视为「中止请求」，控制台必记一条 net::ERR_ABORTED；
      // 服务端发完 result 就 res.end()，多读一次 FIN 的等待几乎为零。
    }
    if (!result) throw new Error('问答未返回结果，请重试')
    return result
  } catch (error) {
    // 卸载期间的失败（请求被中断）静默返回，与 rpc 一致
    if (unloading) return null
    // 结果已完整收到后，收尾阶段的 AbortError/连接中断不再视为错误
    if ((error as any)?.name === 'AbortError') return null
    throw error
  }
}
