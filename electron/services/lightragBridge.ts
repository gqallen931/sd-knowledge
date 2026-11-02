/**
 * LightRAG 的唯一 TypeScript 接缝。
 *
 * SD 的 SQLite 始终是业务真源；本服务只访问本机 LightRAG 桥接进程中的可再生成索引。
 * 不可用、超时或响应不合法时必须返回可读状态，绝不把异常抛给工作台页面。
 */

export type LightRagState = 'disabled' | 'ready' | 'unavailable' | 'misconfigured'

export interface LightRagStatus {
  state: LightRagState
  enabled: boolean
  endpoint: string
  latencyMs: number | null
  message: string
  version?: string | null
  model?: string | null
}

export interface LightRagBridgeOptions {
  enabled?: boolean | string
  endpoint?: string
  timeoutMs?: number | string
}

const DEFAULT_ENDPOINT = 'http://127.0.0.1:9621'
const DEFAULT_TIMEOUT_MS = 5_000

function toEnabled(value: LightRagBridgeOptions['enabled']): boolean {
  return value === true || value === 'true'
}

function toTimeout(value: LightRagBridgeOptions['timeoutMs']): number {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed >= 500 && parsed <= 30_000 ? parsed : DEFAULT_TIMEOUT_MS
}

/** 仅接受回环 HTTP 地址，避免在未经过出域授权时传走本地文档。 */
export function normalizeLightRagEndpoint(value?: string): { endpoint: string; error: string | null } {
  const raw = String(value || DEFAULT_ENDPOINT).trim()
  try {
    const url = new URL(raw)
    const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '::1'
    if (url.protocol !== 'http:' || !loopback || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
      return { endpoint: raw, error: 'LightRAG 服务地址只能是本机回环 HTTP 根地址' }
    }
    return { endpoint: url.toString().replace(/\/$/, ''), error: null }
  } catch {
    return { endpoint: raw, error: 'LightRAG 服务地址格式无效' }
  }
}

export class LightRagBridge {
  readonly enabled: boolean
  readonly endpoint: string
  readonly timeoutMs: number
  private readonly endpointError: string | null

  constructor(options: LightRagBridgeOptions = {}) {
    this.enabled = toEnabled(options.enabled)
    const normalized = normalizeLightRagEndpoint(options.endpoint)
    this.endpoint = normalized.endpoint
    this.endpointError = normalized.error
    this.timeoutMs = toTimeout(options.timeoutMs)
  }

  static fromSettings(settings: Record<string, unknown>): LightRagBridge {
    return new LightRagBridge({
      enabled: settings.lightrag_enabled as string | undefined,
      endpoint: settings.lightrag_endpoint as string | undefined,
      timeoutMs: settings.lightrag_timeout_ms as string | undefined,
    })
  }

  async status(): Promise<LightRagStatus> {
    if (!this.enabled) {
      return this.result('disabled', 'LightRAG 尚未启用；SD 正在使用现有本地检索。')
    }
    if (this.endpointError) return this.result('misconfigured', this.endpointError)

    const startedAt = Date.now()
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const response = await fetch(`${this.endpoint}/health`, { signal: controller.signal })
      if (!response.ok) return this.result('unavailable', `LightRAG 服务返回 HTTP ${response.status}`, Date.now() - startedAt)
      const payload = await response.json() as Record<string, unknown>
      // 官方 lightrag-server 返回 `healthy`；SD 自建桥接实现可返回 `ok`。
      if (payload.status !== 'ok' && payload.status !== 'healthy') {
        return this.result('unavailable', 'LightRAG 服务尚未就绪', Date.now() - startedAt)
      }
      return {
        ...this.result('ready', 'LightRAG 本地知识引擎已就绪。', Date.now() - startedAt),
        version: typeof payload.version === 'string' ? payload.version : null,
        model: typeof payload.model === 'string' ? payload.model : null,
      }
    } catch (error: any) {
      const message = error?.name === 'AbortError'
        ? `连接 LightRAG 超时（${this.timeoutMs}ms）`
        : '无法连接到本机 LightRAG 服务'
      return this.result('unavailable', message, Date.now() - startedAt)
    } finally {
      clearTimeout(timer)
    }
  }

  private result(state: LightRagState, message: string, latencyMs: number | null = null): LightRagStatus {
    return { state, enabled: this.enabled, endpoint: this.endpoint, latencyMs, message, version: null, model: null }
  }
}
