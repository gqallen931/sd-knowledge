import DatabaseService from '../database'
import * as path from 'path'
import type { LlmProvider, LlmProviderKind, LlmRequest, LlmResponse, LlmTestResult } from './types'
import { LlmGateway } from './llmGateway'
import { OpenAiCompatibleProvider } from './openaiProvider'
import { KeyVault, maskHint } from './keyVault'
import { createEgressGuard, EGRESS_SCOPE_LABELS, EGRESS_SCOPE_MODES, normalizeEgressMode, readEgressPolicy } from './egress'
import { pluginRegistry } from '../plugins/registry'
import { builtinLlmManifest } from '../plugins/builtin/manifests'

/**
 * LLM 服务（S1-01，ADR-004）。
 *
 * 职责：把 `llm_providers` 表的配置翻译成一个可用的 `LlmProvider` 注册进 `LlmGateway`，
 * 并对外提供 `llm.*` 的一组方法。**密钥只在本进程内存中出现**：
 * - 读取类方法（`providers/list`）只回「是否已配置 + 掩码」，绝不回明文；
 * - 写入类方法（`save`）只接受新密钥，加密落库后立即丢弃变量；
 * - `api_key_enc/iv/tag` 只在 `buildProvider()` 里被解出来喂给 provider，不进入任何返回值。
 *
 * 出域闸门（S1-02 的接入点）在这里装配：`gateway.setEgressGuard(createDefaultEgressGuard(db))`。
 */

/** 三类 provider 的契约（ADR-004 决策 1）：`hosted` 本轮 available=false，不可选 */
export interface LlmProviderType {
  kind: LlmProviderKind
  label: string
  requires_key: boolean
  available: boolean
  default_base_url: string
  note: string
}

export interface LlmProviderInfo {
  id: number | null
  provider_id: string
  kind: LlmProviderKind
  label: string
  base_url: string
  model: string
  has_key: boolean
  /** `sk-abc123…` 形式；永不含完整明文 */
  key_mask: string
  egress_policy: Record<string, unknown>
  timeout_ms: number
  is_default: boolean
  enabled: boolean
  last_check_at: string | null
  last_check_ok: boolean | null
}

export interface LlmSaveInput {
  provider_id?: string
  kind?: string
  label?: string
  base_url?: string
  model?: string
  /** 仅写入：留空表示「不更换现有密钥」 */
  api_key?: string
  is_default?: boolean
  timeout_ms?: number | string
  max_retries?: number | string
  temperature?: number | string | null
  max_tokens?: number | string | null
  /** 出域范围档位（S1-02）：current_document | selected_scope | whole_library；缺省沿用/最小档 */
  egress_scope?: string
}

/** 内建模型接入插件 id（ADR-006）：OpenAI 兼容协议的薄适配器，不带任何默认端点/密钥 */
const BUILTIN_LLM_PLUGIN_ID = 'sd.llm.openai-compatible'

/** 内建「托管模型」占位插件 id：available=false，只用于把「尚未提供」这件事也放进插件清单 */
const BUILTIN_LLM_HOSTED_ID = 'sd.llm.hosted'

/**
 * 注册内建模型接入插件（ADR-006）。
 *
 * 与解析器/嵌入插件一样走 `pluginRegistry.registerLlm(...)`，因此：
 * - 设置页的类型清单来自注册表，**停用插件即类型消失**；
 * - 宿主自身不再持有 `PROVIDER_TYPES` 常量，也没有任何厂商 SDK / 默认密钥；
 * - 这里只登记「怎么把配置变成 provider」，**不注册 provider、不联网**——默认即未接入。
 */
export function registerBuiltinLlmPlugins(): void {
  const openAiTypes = [
    {
      kind: 'byo-openai',
      label: '自带密钥（OpenAI 兼容）',
      requiresKey: true,
      available: true,
      defaultBaseUrl: 'https://api.openai.com/v1',
      note: '填写你自己的 API Key 与模型名；请求直接发往该端点，密钥只保存在本机、只在本进程解密。',
    },
    {
      kind: 'local-openai',
      label: '本地端点（OpenAI 兼容）',
      requiresKey: false,
      available: true,
      defaultBaseUrl: 'http://127.0.0.1:11434/v1',
      note: '指向本机或内网的 Ollama / vLLM / LM Studio 等 OpenAI 兼容服务；通常无需密钥，内容不出域。',
    },
  ]

  pluginRegistry.registerLlm({
    manifest: builtinLlmManifest({
      id: BUILTIN_LLM_PLUGIN_ID,
      name: 'OpenAI 兼容模型接入',
      providerTypes: openAiTypes.map(t => t.kind),
      description: '把用户配置的端点 / 模型名 / 密钥变成 LlmProvider（流式与非流式共用一套实现）；不含默认端点，未配置时不联网。',
    }),
    llm: {
      kind: 'llm',
      providerTypes: openAiTypes,
      createProvider: (config) => new OpenAiCompatibleProvider({
        id: config.providerId,
        kind: config.kind as LlmProviderKind,
        label: config.label,
        baseUrl: config.baseUrl,
        model: config.model,
        apiKey: config.apiKey,
        timeoutMs: config.timeoutMs,
        maxRetries: config.maxRetries,
        temperature: config.temperature,
        maxTokens: config.maxTokens,
      }),
    },
    source: 'builtin',
  })

  // 托管模型：仍然只有契约（ADR-004 决策 3），但「没有实现」这件事现在也以插件形态呈现，
  // 用户能在设置页看到它是谁、为什么不可用，而不是一个硬编码在下拉里的幽灵选项。
  pluginRegistry.registerLlm({
    manifest: builtinLlmManifest({
      id: BUILTIN_LLM_HOSTED_ID,
      name: '托管模型（占位）',
      providerTypes: ['hosted'],
      description: '尚未提供：只预留接口（ADR-004 决策 3），接入需先有服务端；当前不会发起任何请求。',
      net: false,
    }),
    llm: {
      kind: 'llm',
      providerTypes: [
        {
          kind: 'hosted',
          label: '托管模型',
          requiresKey: false,
          available: false,
          defaultBaseUrl: '',
          note: '尚未提供：本轮只预留接口（ADR-004 决策 3），接入需先有服务端。',
        },
      ],
      createProvider: () => {
        throw new Error('托管模型尚未提供：本轮只预留接口（ADR-004 决策 3），请在设置中选择「自带密钥」或「本地端点」。')
      },
    },
    source: 'builtin',
  })
}

export class LlmService {
  private vault: KeyVault

  constructor(private db: DatabaseService, dataDir: string, private gateway: LlmGateway) {
    this.vault = new KeyVault(path.join(dataDir, '.keys', 'platform.key'))
    // 出域范围闸门 + 审计（S1-02）：默认最小档，超范围拒绝并留痕
    this.gateway.setEgressGuard(createEgressGuard(db))
    // 模型接入是插件扩展点（ADR-006）：先有插件，才谈得上「接入模型」
    registerBuiltinLlmPlugins()
    this.reload()
  }

  /** 当前 provider 可用性（未配置 / 已配置 / 连不上），供上层决定是否降级为纯检索 */
  status() {
    return this.gateway.status()
  }

  /**
   * 可选 provider 类型（只读）。
   *
   * 清单完全来自**已启用的 `llm` 插件**（ADR-006）：插件被停用 → 对应类型从设置页消失；
   * 所有模型插件都停用 → 返回空数组，界面应当显示「模型接入已关闭」而不是给出一个选不了的选项。
   */
  providers(): LlmProviderType[] {
    return pluginRegistry.llmProviderTypes().map(spec => ({
      kind: spec.kind as LlmProviderKind,
      label: spec.label,
      requires_key: spec.requiresKey,
      available: spec.available,
      default_base_url: spec.defaultBaseUrl,
      note: spec.note,
    }))
  }

  /** 已配置的 provider 列表（掩码，绝不回明文密钥） */
  list(): LlmProviderInfo[] {
    const defaultId = this.getDefaultProviderId()
    return this.getRows().map(row => this.toInfo(row, defaultId))
  }

  /**
   * 新增 / 更新配置。
   * 注意：这是 `llm.*` 里唯一接受明文密钥的入口，只接收、不返回。
   */
  save(input: LlmSaveInput): LlmProviderInfo {
    const kind = normalizeKind(input.provider_id || input.kind)
    if (kind === 'hosted') {
      throw new Error('托管模型尚未提供：本轮只预留接口（ADR-004 决策 3），请在设置中选择「自带密钥」或「本地端点」。')
    }
    const baseUrl = validateBaseUrl(input.base_url)
    const model = String(input.model || '').trim()
    if (!model) throw new Error('模型名不能为空')

    const existing = this.getRow(kind)
    // 标签模板同样来自插件：没有插件声明这个类型就不允许保存（否则会写进一条永远用不了的配置）
    const template = this.providers().find(t => t.kind === kind)
    if (!template) {
      throw new Error(`模型接入插件未启用：当前没有已启用的插件声明 ${kind} 类型（可在 设置 → 扩展 中启用模型插件）`)
    }
    const label = String(input.label || existing?.label || template.label).trim() || template.label
    // 出域范围：优先用本次传入的，否则沿用既有，再否则**最小档**（写错等于默认把库上云）
    const requestedScope = normalizeEgressMode(input.egress_scope)
    const egressMode = requestedScope
      ?? (existing ? readEgressPolicy(this.db, kind) : 'current_document')
    const egressPolicy = JSON.stringify({ mode: egressMode })
    const timeoutMs = clampInt(input.timeout_ms, 1000, 600000, existing?.timeout_ms ?? 60000)
    const maxRetries = clampInt(input.max_retries, 0, 5, existing?.max_retries ?? 0)
    const temperature = input.temperature == null ? (existing?.temperature ?? null) : Number(input.temperature)
    const maxTokens = input.max_tokens == null ? (existing?.max_tokens ?? null) : Number(input.max_tokens)

    // 密钥：有新的就加密替换，没有就沿用旧密文（绝不解密回写、绝不落明文）
    let key = {
      enc: existing?.api_key_enc ?? null,
      iv: existing?.api_key_iv ?? null,
      tag: existing?.api_key_tag ?? null,
      hint: existing?.api_key_hint ?? null,
    }
    const providedKey = typeof input.api_key === 'string' ? input.api_key.trim() : ''
    if (providedKey) {
      const secret = this.vault.encrypt(providedKey)
      key = { enc: secret.enc, iv: secret.iv, tag: secret.tag, hint: secret.hint }
    }

    this.db.prepare(`
      INSERT INTO llm_providers
        (provider_id, label, base_url, model, api_key_enc, api_key_iv, api_key_tag, api_key_hint,
         egress_policy, timeout_ms, max_retries, temperature, max_tokens, enabled, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, CURRENT_TIMESTAMP)
      ON CONFLICT(provider_id) DO UPDATE SET
        label = excluded.label, base_url = excluded.base_url, model = excluded.model,
        api_key_enc = excluded.api_key_enc, api_key_iv = excluded.api_key_iv,
        api_key_tag = excluded.api_key_tag, api_key_hint = excluded.api_key_hint,
        egress_policy = excluded.egress_policy, timeout_ms = excluded.timeout_ms,
        max_retries = excluded.max_retries, temperature = excluded.temperature,
        max_tokens = excluded.max_tokens, enabled = 1, updated_at = CURRENT_TIMESTAMP
    `).run(kind, label, baseUrl, model, key.enc, key.iv, key.tag, key.hint, egressPolicy, timeoutMs, maxRetries, temperature, maxTokens)

    const defaultId = this.getDefaultProviderId()
    if (input.is_default === true) this.setDefaultProviderId(kind)
    else if (input.is_default === false) { if (defaultId === kind) this.setDefaultProviderId('') }
    else if (!defaultId) this.setDefaultProviderId(kind)

    this.reload()
    return this.toInfo(this.getRow(kind), this.getDefaultProviderId())
  }

  /** 删除配置；若删的是默认项则清空默认标记 */
  remove(input: { provider_id?: string; kind?: string }): { success: boolean } {
    const kind = normalizeKind(input?.provider_id || input?.kind)
    this.db.prepare('DELETE FROM llm_providers WHERE provider_id = ?').run(kind)
    if (this.getDefaultProviderId() === kind) this.setDefaultProviderId('')
    this.reload()
    return { success: true }
  }

  /**
   * 设置某 provider 的出域范围档位（S1-02，ADR-004/D5）。
   *
   * `whole_library` 是**整库出域**，必须由用户显式确认（`confirm === true`，设置页有风险提示与二次确认），
   * 防误点。切换到更宽的范围时写一条 `audit_logs(action='egress_policy_change')`。
   */
  setEgressScope(input: { provider_id?: string; kind?: string; scope?: string; confirm?: boolean }): LlmProviderInfo {
    const kind = normalizeKind(input?.provider_id || input?.kind)
    const row = this.getRow(kind)
    if (!row) throw new Error(`尚未配置该模型（${kind}）：请先在设置中保存端点与模型名。`)
    const scope = normalizeEgressMode(input?.scope)
    if (!scope) throw new Error('出域范围取值无效：应为 current_document / selected_scope / whole_library')
    if (scope === 'whole_library' && input?.confirm !== true) {
      throw new Error('整库出域需显式确认：请先阅读风险提示并勾选确认，再保存。')
    }

    const previous = readEgressPolicy(this.db, kind)
    this.db.prepare("UPDATE llm_providers SET egress_policy = ?, updated_at = CURRENT_TIMESTAMP WHERE provider_id = ?")
      .run(JSON.stringify({ mode: scope }), kind)
    if (previous !== scope) {
      try {
        this.db.prepare(`
          INSERT INTO audit_logs (actor_type, actor_name, action, resource_type, details, status)
          VALUES ('user', 'settings', 'egress_policy_change', 'llm', ?, 'success')
        `).run(JSON.stringify({ provider_id: kind, from: previous, to: scope }))
      } catch { /* 审计失败不影响设置本身 */ }
    }
    return this.toInfo(this.getRow(kind), this.getDefaultProviderId())
  }

  /** 出域范围档位元数据（设置页下拉用）：值、可读名、是否高风险 */
  egressScopes(): Array<{ value: string; label: string; risky: boolean }> {
    return EGRESS_SCOPE_MODES.map(value => ({
      value,
      label: EGRESS_SCOPE_LABELS[value],
      risky: value === 'whole_library',
    }))
  }

  /** 最近出域记录（设置页「数据出域」回看；只回元信息，绝无正文与密钥） */
  listEgressLogs(input: { limit?: number | string } = {}): any[] {
    const limit = clampInt(input?.limit, 1, 200, 20)
    const rows = this.db.prepare(`
      SELECT id, provider_id, model, target_host, scope_mode, scope_json,
             document_ids, chunk_ids, document_count, chunk_count,
             prompt_chars, completion_chars, status, error_code, latency_ms, actor, created_at
      FROM llm_egress_logs ORDER BY id DESC LIMIT ?
    `).all(limit) as any[]
    return rows.map(row => ({
      id: row.id,
      provider_id: row.provider_id,
      model: row.model,
      target_host: row.target_host ?? '',
      scope_mode: row.scope_mode ?? safeJson(row.scope_json, {} as any)?.declared ?? 'current_document',
      document_count: row.document_count ?? 0,
      chunk_count: row.chunk_count ?? 0,
      prompt_chars: row.prompt_chars ?? 0,
      completion_chars: row.completion_chars ?? 0,
      status: row.status,
      error_code: row.error_code ?? null,
      latency_ms: row.latency_ms ?? 0,
      actor: row.actor ?? '',
      created_at: row.created_at,
    }))
  }

  /**
   * 连通性 + 极短 prompt 实测（含耗时与模型回显）。
   * 这是一次带副作用的探测（会真的发一次请求），因此 REST 侧按写方法处理（见 apiServer 只读白名单）。
   * 不发用户内容，只发固定 ping，故不写入 llm_egress_logs。
   */
  async test(input: { provider_id?: string; kind?: string } = {}): Promise<LlmTestResult> {
    const kind = normalizeKind(input?.provider_id || input?.kind)
    const row = this.getRow(kind)
    if (!row) throw new Error(`尚未配置该模型（${kind}）：请先在设置中保存端点与模型名。`)
    const provider = this.buildProvider(row)
    const started = Date.now()
    let models: string[] = []
    try {
      try { models = await provider.listModels() } catch { models = [] }
      const response = await provider.chat({ messages: [{ role: 'user', content: '你好，请只回复“pong”。' }], maxTokens: 8 })
      this.recordCheck(kind, 1)
      return {
        ok: true,
        providerId: kind,
        kind,
        model: response.model,
        latencyMs: Date.now() - started,
        models,
        echo: String(response.content || '').slice(0, 200) || null,
        error: null,
      }
    } catch (error: any) {
      this.recordCheck(kind, 0)
      return {
        ok: false,
        providerId: kind,
        kind,
        model: row.model,
        latencyMs: Date.now() - started,
        models,
        echo: null,
        error: { code: error?.code || 'UNAVAILABLE', message: error?.message || String(error) },
      }
    }
  }

  /**
   * 非流式对话。消息数组由上层（S1-03 的上下文组装）给出，本层不做检索。
   * 未配置 provider 时由网关抛 `LlmNotConfiguredError`（不在这里吞掉）。
   */
  async chat(request: LlmRequest): Promise<LlmResponse> {
    this.reload()
    return this.gateway.chat(request)
  }

  /**
   * 流式对话。
   *
   * 逐块回调由 provider 驱动并原样透传给调用方（S1-05 的真增量推送）：`answerService.ask`
   * 传入 `onChunk`，出口层（Web SSE / 桌面 IPC）逐块转发给前端，**不再把增量吞进 `response.chunks` 一次性返回**。
   * 未传 `onChunk` 时（如 `llm.stream` 直接调用）保持原行为：只回完整响应，增量在 `response.chunks`。
   */
  async stream(request: LlmRequest, onChunk?: (chunk: string) => void): Promise<LlmResponse> {
    this.reload()
    return this.gateway.stream(request, onChunk ?? (() => { /* 未提供回调：只回完整响应 */ }))
  }

  /**
   * 依据库中配置重建并注册「默认 provider」——配置变更 / 启动时调用。
   *
   * **默认关闭**：没有配置行、或声明该类型的插件被停用，都只注册 `null`（网关进入「未配置」，
   * 上层降级为纯检索），不抛错、不崩主进程。
   */
  reload(): void {
    const row = this.resolveDefaultRow()
    if (!row) { this.gateway.register(null); return }
    try {
      this.gateway.register(this.buildProvider(row))
    } catch (error: any) {
      console.warn(`[llm] provider ${row.provider_id} 装载失败，按「未接入模型」处理：${error?.message || error}`)
      this.gateway.register(null)
    }
  }

  private resolveDefaultRow(): any | null {
    const rows = this.getRows().filter(r => r.enabled !== 0)
    if (!rows.length) return null
    const defaultId = this.getDefaultProviderId()
    return rows.find(r => r.provider_id === defaultId) || rows[0]
  }

  /**
   * 把一行配置交给**插件**变成 provider（ADR-006）。
   *
   * 宿主在这里不再认识任何具体协议：找不到插件 → 说清「缺少插件」；插件被停用 → 说清「插件已停用」；
   * 插件标注类型不可用 → 直接拒绝。三种情况都是可读错误，而不是 `undefined.chat` 之类的崩溃。
   */
  private buildProvider(row: any): LlmProvider {
    const kind = normalizeKind(row.provider_id)
    const resolved = pluginRegistry.resolveLlm(kind)
    if (!resolved) {
      throw new Error(`模型接入插件缺失：没有任何插件声明 ${kind} 类型（模型接入是插件扩展点，可在 设置 → 扩展 中启用）`)
    }
    if (!resolved.enabled || !resolved.plugin) {
      throw new Error(`模型接入插件「${resolved.name}」已停用，暂时无法使用 ${kind}（可在 设置 → 扩展 中启用）`)
    }
    const spec = resolved.plugin.providerTypes.find(t => t.kind === kind)
    if (spec && spec.available === false) {
      throw new Error(`${spec.label}尚未提供：${spec.note || '插件标注为不可用'}`)
    }
    return resolved.plugin.createProvider({
      providerId: row.provider_id,
      kind,
      label: row.label,
      baseUrl: row.base_url,
      model: row.model,
      apiKey: this.decryptKey(row),
      timeoutMs: row.timeout_ms,
      maxRetries: row.max_retries,
      temperature: row.temperature ?? undefined,
      maxTokens: row.max_tokens ?? undefined,
    })
  }

  /** 只有这里碰密文；解密失败按「未配置密钥」处理并告警，不崩、不外泄 */
  private decryptKey(row: any): string | null {
    if (!row.api_key_enc) return null
    try {
      return this.vault.decrypt(Buffer.from(row.api_key_enc), Buffer.from(row.api_key_iv), Buffer.from(row.api_key_tag))
    } catch {
      console.warn(`[llm] provider ${row.provider_id} 的密钥解密失败（密钥文件可能已更换），请重新填写`)
      return null
    }
  }

  private toInfo(row: any, defaultId: string | null): LlmProviderInfo {
    // 显式白名单：只挑可展示字段，api_key_enc/iv/tag 永不进入返回值
    return {
      id: row.id,
      provider_id: row.provider_id,
      kind: normalizeKind(row.provider_id),
      label: row.label,
      base_url: row.base_url,
      model: row.model,
      has_key: Boolean(row.api_key_enc),
      key_mask: maskHint(row.api_key_hint),
      // 归一化出域范围：旧口径（selection/scope）在此翻译为新的三档名
      egress_policy: { mode: readEgressPolicy(this.db, row.provider_id) },
      timeout_ms: row.timeout_ms,
      is_default: row.provider_id === defaultId,
      enabled: row.enabled !== 0,
      last_check_at: row.last_check_at || null,
      last_check_ok: row.last_check_ok == null ? null : Boolean(row.last_check_ok),
    }
  }

  private recordCheck(kind: string, ok: number): void {
    try {
      this.db.prepare('UPDATE llm_providers SET last_check_at = CURRENT_TIMESTAMP, last_check_ok = ? WHERE provider_id = ?').run(ok, kind)
    } catch { /* 记录探测结果失败不影响返回 */ }
  }

  private getRows(): any[] {
    return this.db.prepare('SELECT * FROM llm_providers ORDER BY id').all() as any[]
  }

  private getRow(providerId: string): any | null {
    return (this.db.prepare('SELECT * FROM llm_providers WHERE provider_id = ?').get(providerId) as any) || null
  }

  private getDefaultProviderId(): string | null {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = 'llm.default_provider'").get() as any
    const value = row?.value ? String(row.value) : ''
    return value || null
  }

  private setDefaultProviderId(id: string): void {
    this.db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('llm.default_provider', ?, CURRENT_TIMESTAMP)").run(id || '')
  }
}

function normalizeKind(value: unknown): LlmProviderKind {
  const v = String(value || '').trim()
  if (v === 'byo-openai' || v === 'local-openai' || v === 'hosted') return v
  // 兼容架构文档 §3.2.2 里提到的等价别名
  if (v === 'local' || v === 'local-http' || v === 'ollama') return 'local-openai'
  if (v === 'openai' || v === 'openai-compatible' || v === 'openai-compatible-streaming') return 'byo-openai'
  return 'byo-openai'
}

function validateBaseUrl(value: unknown): string {
  const url = String(value || '').trim().replace(/\/+$/, '')
  if (!url) throw new Error('端点地址（base_url）不能为空')
  let parsed: URL
  try { parsed = new URL(url) } catch { throw new Error('端点地址不是合法的 URL，请填写形如 http://127.0.0.1:11434/v1 的地址') }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('端点地址必须以 http:// 或 https:// 开头')
  return url
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  if (value == null || value === '') return fallback
  const num = Number(value)
  if (!Number.isFinite(num)) return fallback
  return Math.min(max, Math.max(min, Math.round(num)))
}

function safeJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string' || !value) return fallback
  try { return JSON.parse(value) as T } catch { return fallback }
}
