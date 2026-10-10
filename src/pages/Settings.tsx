import { useState, useEffect } from 'react'
import { useSearchParams } from 'react-router-dom'
import { isDesktop } from '../api'

type Tab = 'general' | 'ai' | 'security' | 'audit' | 'plugin'

/** 合法 Tab 清单：供 `?tab=` 深链校验（问答页「配置模型 / 数据出域」入口用 `/settings?tab=ai`） */
const TABS: Tab[] = ['general', 'ai', 'security', 'audit', 'plugin']

interface SettingsProps {
  modal?: boolean
  onClose?: () => void
}

/**
 * 插件接口（ADR-005）。
 *
 * 方法由主进程的方法表生成（plugin.list / status / enable / disable / reload），
 * 前端的类型声明本轮未同步（不改 global.d.ts），因此这里做一次窄化。
 * 未暴露时（老版本后端 / 未登录）返回 undefined，由界面显示可读提示而不是崩掉。
 */
function pluginApi() {
  return (window.sd as any).plugin as undefined | {
    list: () => Promise<any[]>
    status: (id: string) => Promise<any>
    enable: (id: string) => Promise<any>
    disable: (id: string) => Promise<any>
    reload: () => Promise<any>
  }
}

/**
 * LLM 网关门面（S1-01）：与 pluginApi 同样做一次窄化，宿主未暴露时返回 undefined，
 * 界面显示可读提示而不是崩掉。方法名与主进程方法表一致（llm.providers / list / save / remove / test）。
 */
function llmApi() {
  return (window.sd as any).llm as undefined | {
    providers: () => Promise<any[]>
    list: () => Promise<any[]>
    save: (payload: any) => Promise<any>
    remove: (payload: any) => Promise<any>
    test: (payload?: any) => Promise<any>
    setEgress: (payload: any) => Promise<any>
    logs: (payload?: any) => Promise<any[]>
  }
}

export default function Settings({ modal = false, onClose }: SettingsProps) {
  // 深链定位初始 Tab：/settings?tab=ai（问答页的「配置模型 / 数据出域」入口）
  const [params] = useSearchParams()
  const requestedTab = params.get('tab') as Tab | null
  const [tab, setTab] = useState<Tab>(requestedTab && TABS.includes(requestedTab) ? requestedTab : 'general')
  const [settings, setSettings] = useState<Record<string, string>>({})
  const [securityStatus, setSecurityStatus] = useState<any>(null)
  const [apiKeys, setApiKeys] = useState<any[]>([])
  const [auditLogs, setAuditLogs] = useState<any[]>([])
  const [plugins, setPlugins] = useState<any[]>([])
  const [pluginError, setPluginError] = useState('')
  const [pluginBusy, setPluginBusy] = useState('')
  const [saving, setSaving] = useState(false)
  const [feedback, setFeedback] = useState('')
  const [loadError, setLoadError] = useState('')

  useEffect(() => { loadAll() }, [])

  const loadAll = async () => {
    setLoadError('')
    try {
      const [s, sec] = await Promise.all([
        window.sd.settings.get(),
        window.sd.security.status(),
      ])
      setSettings(s)
      setSecurityStatus(sec)
      {
        const [keys, logs] = await Promise.all([
          window.sd.security.apiKeys.list(),
          window.sd.audit.list({ limit: 20 }),
        ])
        setApiKeys(keys)
        setAuditLogs(logs)
      }
    } catch (e) {
      console.error('Settings load error:', e)
      setLoadError('设置数据加载失败，部分面板可能不完整，请重试')
    }
    await loadPlugins()
  }

  const loadPlugins = async () => {
    const api = pluginApi()
    if (!api) { setPlugins([]); setPluginError('当前运行模式未暴露插件接口，请确认宿主服务已启动'); return }
    try {
      setPlugins(await api.list())
      setPluginError('')
    } catch (e: any) {
      setPlugins([])
      setPluginError(e?.message || String(e))
    }
  }

  /** 启停插件：成功后整表刷新，让「状态 / 错误原因 / 覆盖格式」立即反映停用结果 */
  const togglePlugin = async (id: string, nextEnabled: boolean) => {
    const api = pluginApi()
    if (!api) return
    setPluginBusy(id)
    try {
      await (nextEnabled ? api.enable(id) : api.disable(id))
      await loadPlugins()
      // 支持格式随插件启停变化：通知文件页等正在挂载的页面刷新（设置是模态，不会重挂载它们）
      window.dispatchEvent(new CustomEvent('sd:plugins-changed'))
      setFeedback(nextEnabled ? `已启用插件「${id}」` : `已停用插件「${id}」，其覆盖格式暂不支持`)
    } catch (e: any) {
      setFeedback('插件操作失败：' + (e?.message || String(e)))
    } finally { setPluginBusy('') }
  }

  const reloadPlugins = async () => {
    const api = pluginApi()
    if (!api) return
    setPluginBusy('__reload__')
    try {
      const report = await api.reload()
      await loadPlugins()
      window.dispatchEvent(new CustomEvent('sd:plugins-changed'))
      setFeedback(`插件目录已重新扫描：装载 ${report?.loaded?.length ?? 0} 个，拒绝 ${report?.rejected?.length ?? 0} 个`)
    } catch (e: any) {
      setFeedback('重新扫描失败：' + (e?.message || String(e)))
    } finally { setPluginBusy('') }
  }

  const handleSave = async (updates: Record<string, string>) => {
    setSaving(true)
    try {
      await window.sd.settings.update(updates)
      setSettings(prev => ({ ...prev, ...updates }))
      setFeedback('设置已保存并生效')
    } catch (e: any) { setFeedback('保存失败：' + e.message) }
    finally { setSaving(false) }
  }

  const tabs: { key: Tab; label: string; icon: string }[] = [
    { key: 'general', label: '通用', icon: 'G' },
    { key: 'ai', label: 'AI 引擎', icon: 'A' },
    { key: 'plugin', label: '扩展', icon: 'P' },
    { key: 'security', label: '安全', icon: 'S' },
    { key: 'audit', label: '审计日志', icon: 'L' },
  ]

  return (
    <div className={modal ? 'settings-modal__backdrop' : ''} role={modal ? 'presentation' : undefined} onMouseDown={modal ? onClose : undefined}>
      <section className={modal ? 'settings-modal__dialog' : 'h-full overflow-y-auto'} style={modal ? undefined : { padding: '32px 38px 60px' }} onMouseDown={modal ? (event) => event.stopPropagation() : undefined} role={modal ? 'dialog' : undefined} aria-modal={modal || undefined} aria-label={modal ? '系统设置' : undefined}>
      <div className="settings-modal__titlebar">
        <h1 style={{ fontSize: '24px', fontWeight: 800, color: 'var(--text)', marginBottom: modal ? 0 : '20px' }}>系统设置</h1>
        {modal && <button className="settings-modal__close" onClick={onClose} aria-label="关闭设置">×</button>}
      </div>
      {loadError && (
        <div className="error-banner" role="alert">
          {loadError}
          <button onClick={() => void loadAll()}>重试</button>
        </div>
      )}

      {feedback && <div className="notice" role="status">{feedback}</div>}
      {/* Tab bar */}
      <div className="flex gap-1 mb-6" style={{ borderBottom: '1px solid var(--card-border)', paddingBottom: '0' }}>
        {tabs.map(t => (
          <button key={t.key}
            onClick={() => setTab(t.key)}
            className="flex items-center gap-2 transition-all"
            style={{
              padding: '8px 16px',
              fontSize: '13px',
              fontWeight: 600,
              color: tab === t.key ? 'var(--primary)' : 'var(--text-secondary)',
              // 只用 border-* 长写：与 `border` 简写同对象混用会触发 React 的重渲染样式警告
              borderTop: 'none',
              borderLeft: 'none',
              borderRight: 'none',
              borderBottom: tab === t.key ? '2px solid var(--primary)' : '2px solid transparent',
              background: 'transparent',
              cursor: 'pointer',
              marginBottom: '-1px',
            }}>
            <span style={{
              width: '20px', height: '20px', borderRadius: '4px',
              background: tab === t.key ? 'var(--primary-light)' : 'var(--card-bg-hover)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: '10px', fontWeight: 700,
            }}>{t.icon}</span>
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'general' && <GeneralTab settings={settings} onSave={handleSave} saving={saving} />}
      {tab === 'ai' && <AITab settings={settings} onSave={handleSave} saving={saving} embeddingPlugins={plugins.filter(p => p.kind === 'embedding')} />}
      {tab === 'plugin' && (
        <PluginTab
          plugins={plugins}
          error={pluginError}
          busy={pluginBusy}
          onToggle={togglePlugin}
          onReload={reloadPlugins}
          onRefresh={loadPlugins}
        />
      )}
      {tab === 'security' && <SecurityTab status={securityStatus} apiKeys={apiKeys} onRefresh={loadAll} />}
      {tab === 'audit' && <AuditTab logs={auditLogs} onRefresh={loadAll} />}
      </section>
    </div>
  )
}

function GeneralTab({ settings, onSave, saving }: { settings: Record<string, string>; onSave: (s: Record<string, string>) => void; saving: boolean }) {
  const [apiPort, setApiPort] = useState(settings.api_port || '17890')
  const [apiEnabled, setApiEnabled] = useState(settings.api_enabled === 'true')
  const [autoStart, setAutoStart] = useState(settings.auto_start === 'true')
  const [minimizeToTray, setMinimizeToTray] = useState(settings.minimize_to_tray === 'true')
  const [maxFileSize, setMaxFileSize] = useState(settings.max_file_size || '500')
  const [backupInterval, setBackupInterval] = useState(settings.backup_interval || '24')
  const [backupCount, setBackupCount] = useState(settings.backup_count || '7')
  const [versionControl, setVersionControl] = useState(settings.version_control === 'true')
  const [maxVersions, setMaxVersions] = useState(settings.max_versions || '10')
  const [folderSyncOnStart, setFolderSyncOnStart] = useState(settings.folder_sync_on_start !== 'false')
  const [folderSyncLimit, setFolderSyncLimit] = useState(settings.folder_sync_limit || '200')
  const [queueConcurrency, setQueueConcurrency] = useState(settings.queue_concurrency || '2')
  const [queueStatus, setQueueStatus] = useState<{ running: number; waiting: number; concurrency: number } | null>(null)

  useEffect(() => {
    setApiPort(settings.api_port || '17890')
    setApiEnabled(settings.api_enabled === 'true')
    setAutoStart(settings.auto_start === 'true')
    setMinimizeToTray(settings.minimize_to_tray === 'true')
    setMaxFileSize(settings.max_file_size || '500')
    setBackupInterval(settings.backup_interval || '24')
    setBackupCount(settings.backup_count || '7')
    setVersionControl(settings.version_control === 'true')
    setMaxVersions(settings.max_versions || '10')
    setFolderSyncOnStart(settings.folder_sync_on_start !== 'false')
    setFolderSyncLimit(settings.folder_sync_limit || '200')
    setQueueConcurrency(settings.queue_concurrency || '2')
  }, [settings])

  // 队列状态轮询：让「并发度调多大、有没有积压」直接可见，不必翻日志
  useEffect(() => {
    let alive = true
    const tick = async () => {
      try {
        const status = await window.sd.queue.status()
        if (alive) setQueueStatus(status)
      } catch { /* 接口不可用时静默 */ }
    }
    tick()
    const timer = setInterval(tick, 2000)
    return () => { alive = false; clearInterval(timer) }
  }, [])

  return (
    <div style={{ maxWidth: '640px' }}>
      <Card title="API 服务">
        <Row label="启用 API 服务">
          <Toggle checked={apiEnabled} onChange={setApiEnabled} />
        </Row>
        <Row label="API 端口">
          <input type="number" value={apiPort} onChange={e => setApiPort(e.target.value)}
            style={inputStyle} />
        </Row>
        <Row label="速率限制（请求/分钟）">
          <input type="number" value={settings.rate_limit || '100'} onChange={e => onSave({ rate_limit: e.target.value })}
            style={inputStyle} />
        </Row>
      </Card>

      {isDesktop && <Card title="系统">
        <Row label="开机自启">
          <Toggle checked={autoStart} onChange={setAutoStart} />
        </Row>
        <Row label="最小化到系统托盘">
          <Toggle checked={minimizeToTray} onChange={setMinimizeToTray} />
        </Row>
      </Card>

      }
      <Card title="文件处理">
        <Row label="最大文件大小（MB）">
          <input type="number" value={maxFileSize} onChange={e => setMaxFileSize(e.target.value)}
            style={inputStyle} />
        </Row>
      </Card>

      <Card title="映射同步">
        <Row label="启动时同步映射目录">
          <Toggle checked={folderSyncOnStart} onChange={setFolderSyncOnStart} />
        </Row>
        <Row label="单次同步入队上限（份）">
          <input type="number" value={folderSyncLimit} onChange={e => setFolderSyncLimit(e.target.value)}
            style={inputStyle} />
        </Row>
        <div style={{ fontSize: '12px', color: 'var(--text-dim)', marginTop: '4px' }}>
          映射文件夹后，软件启动时会自动比对目录变化，只解析新增与内容变更的文件；超出上限的部分留待下次同步继续。
        </div>
      </Card>

      <Card title="解析队列">
        <Row label="并发度">
          <input type="number" min={1} max={32} value={queueConcurrency} onChange={e => setQueueConcurrency(e.target.value)}
            style={inputStyle} />
        </Row>
        <Row label="当前状态">
          <span style={{ fontSize: '13px', color: 'var(--text)' }}>
            解析中 {queueStatus?.running ?? 0} · 排队 {queueStatus?.waiting ?? 0} · 并发 {queueStatus?.concurrency ?? '—'}
          </span>
        </Row>
        <div style={{ fontSize: '12px', color: 'var(--text-dim)', marginTop: '4px' }}>
          并发度 1 为严格串行；调大后长文档解析期间，其它文件可并行完成解析与写库。出队优先级：手动重新解析 &gt; 导入 &gt; 断点恢复 &gt; 目录映射批量。建议不超过 CPU 核心数的一半。
        </div>
      </Card>

      <Card title="数据安全">
        <Row label="启用版本控制">
          <Toggle checked={versionControl} onChange={setVersionControl} />
        </Row>
        <Row label="最大版本数（每文件）">
          <input type="number" value={maxVersions} onChange={e => setMaxVersions(e.target.value)}
            style={inputStyle} />
        </Row>
        <Row label="自动备份间隔（小时，0 关闭）">
          <input type="number" value={backupInterval} onChange={e => setBackupInterval(e.target.value)}
            style={inputStyle} />
        </Row>
        <Row label="备份保留数量">
          <input type="number" value={backupCount} onChange={e => setBackupCount(e.target.value)}
            style={inputStyle} />
        </Row>
        <div style={{ fontSize: '12px', color: 'var(--text-dim)', marginTop: '4px' }}>
          自动备份将数据库快照保存到 Data/backups，按间隔定时执行；版本控制记录文件的导入与外部引用变更历史。
        </div>
      </Card>

      <SaveButton saving={saving} onClick={() => onSave({
        api_port: apiPort,
        api_enabled: String(apiEnabled),
        auto_start: String(autoStart),
        minimize_to_tray: String(minimizeToTray),
        max_file_size: maxFileSize,
        folder_sync_on_start: String(folderSyncOnStart),
        folder_sync_limit: folderSyncLimit,
        queue_concurrency: queueConcurrency,
        version_control: String(versionControl),
        max_versions: maxVersions,
        backup_interval: backupInterval,
        backup_count: backupCount,
      })} />
    </div>
  )
}

function AITab({ settings, onSave, saving, embeddingPlugins }: { settings: Record<string, string>; onSave: (s: Record<string, string>) => void; saving: boolean; embeddingPlugins: any[] }) {
  const [ocrEnabled, setOcrEnabled] = useState(settings.ocr_enabled === 'true')
  const [vectorEnabled, setVectorEnabled] = useState(settings.vector_enabled === 'true')
  const [embeddingModel, setEmbeddingModel] = useState(settings.embedding_model || DEFAULT_EMBEDDING)
  const [chunkSize, setChunkSize] = useState(settings.chunk_size || '512')
  const [chunkOverlap, setChunkOverlap] = useState(settings.chunk_overlap || '50')
  const [embedBatch, setEmbedBatch] = useState(settings.embed_batch_size || '2')
  const [perfLogEnabled, setPerfLogEnabled] = useState(settings.perf_log_enabled === 'true')
  const [deepNerEnabled, setDeepNerEnabled] = useState(settings.deep_ner_enabled === 'true')
  const [nerModel, setNerModel] = useState(settings.ner_model || 'Xenova/bert-base-NER')

  useEffect(() => {
    setOcrEnabled(settings.ocr_enabled === 'true')
    setVectorEnabled(settings.vector_enabled === 'true')
    setEmbeddingModel(settings.embedding_model || DEFAULT_EMBEDDING)
    setChunkSize(settings.chunk_size || '512')
    setChunkOverlap(settings.chunk_overlap || '50')
    setEmbedBatch(settings.embed_batch_size || '2')
    setPerfLogEnabled(settings.perf_log_enabled === 'true')
    setDeepNerEnabled(settings.deep_ner_enabled === 'true')
    setNerModel(settings.ner_model || 'Xenova/bert-base-NER')
  }, [settings])

  /**
   * 可选嵌入模型来自插件注册表（原来这 4 项是硬编码的，现在由内建 embedding 插件声明）。
   * 已停用的模型仍列出并标注，避免出现「下拉里悄悄少了一项」；当前设置值若不在注册表中
   * （例如手工改过库的自定义模型名）也保留一项，防止下拉变成空值。
   */
  const modelOptions: Array<{ value: string; label: string; note?: string; disabled?: boolean }> = embeddingPlugins.map(p => ({
    value: p.id,
    label: p.name + (p.enabled ? '' : '（已停用）'),
    note: p.capabilities?.note,
    disabled: !p.enabled,
  }))
  if (!modelOptions.some(o => o.value === embeddingModel)) {
    modelOptions.unshift({ value: embeddingModel, label: `${embeddingModel}（未在注册表中）` })
  }
  const selectedNote = modelOptions.find(o => o.value === embeddingModel)?.note

  return (
    <div style={{ maxWidth: '640px' }}>
      <LlmConfigCard />
      <EgressCard />
      <Card title="OCR 文字识别">
        <Row label="启用 OCR（扫描版 PDF / 图片）">
          <Toggle checked={ocrEnabled} onChange={setOcrEnabled} />
        </Row>
        <div style={{ fontSize: '12px', color: 'var(--text-dim)', lineHeight: 1.6, padding: '8px 0' }}>
          使用 tesseract.js 在本地进行 OCR 识别，支持中英文。识别结果会自动提取文字并加入知识图谱。
        </div>
      </Card>

      <Card title="向量化引擎">
        <Row label="启用语义向量化">
          <Toggle checked={vectorEnabled} onChange={setVectorEnabled} />
        </Row>
        <Row label="Embedding 模型">
          <select value={embeddingModel} onChange={e => setEmbeddingModel(e.target.value)} style={inputStyle}>
            {modelOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </Row>
        {selectedNote && (
          <div style={{ fontSize: '11px', color: 'var(--text-dim)', padding: '2px 0 0' }}>{selectedNote}</div>
        )}
        <Row label="分块大小（字符）">
          <input type="number" min={64} max={8000} step={64} value={chunkSize}
            onChange={e => setChunkSize(e.target.value)} style={{ ...inputStyle, width: '110px' }} />
        </Row>
        <Row label="分块重叠（字符）">
          <input type="number" min={0} max={2000} step={10} value={chunkOverlap}
            onChange={e => setChunkOverlap(e.target.value)} style={{ ...inputStyle, width: '110px' }} />
        </Row>
        <Row label="批推理大小">
          <input type="number" min={1} max={32} step={1} value={embedBatch}
            onChange={e => setEmbedBatch(e.target.value)} style={{ ...inputStyle, width: '110px' }} />
        </Row>
        <div style={{ fontSize: '12px', color: 'var(--text-dim)', lineHeight: 1.6, padding: '8px 0' }}>
          使用 transformers.js 在本地运行 ONNX 量化模型，将向量持久化到本地 SQLite。首次使用会自动下载模型。
          <br />
          长文档按「分块大小」切开、相邻块重叠「分块重叠」个字符（重叠可避免答案正好落在切缝上），
          窗口右界若落在句子中间会自动吸附到最近的句号/换行。
          <br />
          「批推理大小」表示一次 forward 同时处理多少块：实测在 CPU 上 2 与串行耗时持平、但写库事务数减半，
          而 8 反而比串行慢约 20%（批 GEMM 效率下降），因此默认 2，调大前建议先用「性能采集」对比。
          模型不支持批量输入时会自动回退逐条推理。修改这三项后需对文档重新解析才会生效。
        </div>
      </Card>

      <Card title="实体识别">
        <div style={{ fontSize: '12px', color: 'var(--text-dim)', lineHeight: 1.8, padding: '4px 0' }}>
          <div>· nodejieba - 中文分词与关键词提取</div>
          <div>· compromise - 英文实体识别（人名/地名/机构）</div>
          <div>· 正则模式 - 日期/邮箱/URL</div>
        </div>
      </Card>

      <Card title="深度实体识别（NER）">
        <Row label="启用 transformers.js 深度 NER">
          <Toggle checked={deepNerEnabled} onChange={setDeepNerEnabled} />
        </Row>
        <Row label="NER 模型">
          <input value={nerModel} onChange={e => setNerModel(e.target.value)} placeholder="Xenova/bert-base-NER"
            style={{ ...inputStyle, width: '260px' }} />
        </Row>
        <div style={{ fontSize: '12px', color: 'var(--text-dim)', lineHeight: 1.6, padding: '8px 0' }}>
          开启后，解析时会在本地运行 transformers.js 的 token-classification 模型做深度实体识别，
          结果与上方规则层抽取自动合并去重。
          <br />
          首次开启会自动下载模型（默认 Xenova/bert-base-NER），因此首次解析会明显变慢，模型缓存后不再联网。
          修改开关或模型名后，需对文档重新解析才会生效。
        </div>
      </Card>

      <Card title="多模态解析">
        <div style={{ fontSize: '12px', color: 'var(--text-dim)', lineHeight: 1.8, padding: '4px 0' }}>
          <div>· PDF - 文本型 PDF 内容提取（扫描件请转为图片后 OCR）</div>
          <div>· Word - mammoth 文本提取</div>
          <div>· Excel - exceljs 表格解析</div>
          <div>· 图片 - tesseract.js 中英文 OCR</div>
          <div>· 视频 - fluent-ffmpeg 关键帧提取</div>
          <div>· 音频 - whisper-tiny 语音转文字</div>
        </div>
      </Card>

      <Card title="性能诊断">
        <Row label="记录解析分阶段耗时">
          <Toggle checked={perfLogEnabled} onChange={setPerfLogEnabled} />
        </Row>
        <div style={{ fontSize: '12px', color: 'var(--text-dim)', lineHeight: 1.6, padding: '8px 0' }}>
          开启后，每个文档的解析会记录各阶段耗时（读取 / 格式解析 / OCR / 摘要 / 实体 / 向量化 / 写库），用于定位性能瓶颈。
          桌面版写入 logs/main-*.log，网页版与 MCP 写入 logs/perf-*.log，日志保留 7 天。关闭时不产生额外开销。
        </div>
      </Card>

      <SaveButton saving={saving} onClick={() => onSave({
        ocr_enabled: String(ocrEnabled),
        vector_enabled: String(vectorEnabled),
        embedding_model: embeddingModel,
        chunk_size: chunkSize,
        chunk_overlap: chunkOverlap,
        embed_batch_size: embedBatch,
        perf_log_enabled: String(perfLogEnabled),
        deep_ner_enabled: String(deepNerEnabled),
        ner_model: nerModel,
      })} />
    </div>
  )
}

/**
 * LLM 配置区（S1-01，ADR-004 决策 1/2/5）。
 *
 * 只配置「模型端点与密钥」，**不做**出域范围选项（那是 S1-02）。
 * 硬性约束：已配置时输入框绝不回填明文密钥，只显示掩码 + 「更换」；保存/测试都只把新密钥发出去。
 * 未配置时给出可操作的引导（一键填入本地端点默认值），不留死按钮。
 */
function LlmConfigCard() {
  const [catalog, setCatalog] = useState<any[]>([])
  const [configs, setConfigs] = useState<any[]>([])
  const [kind, setKind] = useState('local-openai')
  const [baseUrl, setBaseUrl] = useState('')
  const [model, setModel] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [isDefault, setIsDefault] = useState(true)
  const [changingKey, setChangingKey] = useState(false)
  const [busy, setBusy] = useState('')
  const [feedback, setFeedback] = useState<{ ok: boolean; text: string } | null>(null)
  const [error, setError] = useState('')
  const [loaded, setLoaded] = useState(false)

  useEffect(() => { void loadConfig() }, [])

  const loadConfig = async () => {
    const api = llmApi()
    if (!api) { setLoaded(true); return }
    try {
      const [types, list] = await Promise.all([api.providers(), api.list()])
      setCatalog(types || [])
      setConfigs(list || [])
      const active = (list || []).find((c: any) => c.is_default) || (list || [])[0]
      if (active) {
        setKind(active.kind); setBaseUrl(active.base_url); setModel(active.model)
        setIsDefault(active.is_default); setChangingKey(false)
      } else {
        const local = (types || []).find((t: any) => t.kind === 'local-openai')
        setKind('local-openai')
        setBaseUrl(local?.default_base_url || 'http://127.0.0.1:11434/v1')
        setIsDefault(true)
      }
      setApiKey('')
      setError('')
    } catch (e: any) {
      setError(e?.message || String(e))
    } finally {
      setLoaded(true)
    }
  }

  const currentConfig = configs.find(c => c.kind === kind)
  const catalogEntry = catalog.find(c => c.kind === kind)
  const keyInputVisible = !currentConfig?.has_key || changingKey

  /** 切换类型：已配置则回填该类型；未配置则填内置默认端点 */
  const applyKind = (next: string) => {
    setKind(next); setApiKey(''); setChangingKey(false); setFeedback(null); setError('')
    const cfg = configs.find(c => c.kind === next)
    if (cfg) { setBaseUrl(cfg.base_url); setModel(cfg.model); setIsDefault(cfg.is_default) }
    else {
      const entry = catalog.find(c => c.kind === next)
      setBaseUrl(entry?.default_base_url || '')
      setModel('')
      setIsDefault(configs.length === 0)
      setChangingKey(true)
    }
  }

  /** 未配置时的引导：一键填入本地端点默认值 */
  const fillLocalDefault = () => {
    const local = catalog.find(c => c.kind === 'local-openai')
    setKind('local-openai')
    setBaseUrl(local?.default_base_url || 'http://127.0.0.1:11434/v1')
    setModel(prev => prev || 'qwen2.5:7b')
    setIsDefault(configs.length === 0)
    setChangingKey(true)
    setApiKey('')
    setFeedback(null); setError('')
  }

  const payload = () => ({
    provider_id: kind,
    base_url: baseUrl.trim(),
    model: model.trim(),
    is_default: isDefault,
    ...(apiKey.trim() ? { api_key: apiKey.trim() } : {}),
  })

  const handleSave = async () => {
    const api = llmApi(); if (!api) return
    setBusy('save'); setFeedback(null); setError('')
    try {
      const saved = await api.save(payload())
      setApiKey(''); setChangingKey(false)
      setConfigs(prev => [...prev.filter(c => c.kind !== kind), saved])
      setFeedback({ ok: true, text: `已保存「${saved.label}」；密钥显示为 ${saved.key_mask || '未设置'}` })
    } catch (e: any) { setError(e?.message || String(e)) } finally { setBusy('') }
  }

  const handleTest = async () => {
    const api = llmApi(); if (!api) return
    setBusy('test'); setFeedback(null); setError('')
    try {
      // 先保存：保证「测试的就是表单里填的端点」，也避免「未保存时点了没反应」
      await api.save(payload())
      setApiKey(''); setChangingKey(false)
      const res = await api.test({ provider_id: kind })
      if (res.ok) {
        setFeedback({ ok: true, text: `连接成功 · 模型 ${res.model} · 耗时 ${res.latencyMs}ms${res.echo ? ` · 回显「${res.echo}」` : ''}` })
      } else {
        setFeedback({ ok: false, text: `连接失败：${res.error?.message || '未知错误'}（耗时 ${res.latencyMs}ms）` })
      }
      await loadConfig()
    } catch (e: any) { setError(e?.message || String(e)) } finally { setBusy('') }
  }

  const handleRemove = async () => {
    const api = llmApi(); if (!api) return
    if (!confirm(`确认移除「${currentConfig?.label || kind}」的配置？`)) return
    setBusy('remove'); setFeedback(null); setError('')
    try {
      await api.remove({ provider_id: kind })
      await loadConfig()
      setFeedback({ ok: true, text: '已移除该模型配置' })
    } catch (e: any) { setError(e?.message || String(e)) } finally { setBusy('') }
  }

  return (
    <Card title="模型">
      {!loaded ? (
        <div style={{ fontSize: '13px', color: 'var(--text-dim)', padding: '8px 0' }}>正在读取模型配置…</div>
      ) : (
        <>
          {!llmApi() && (
            <div className="notice" role="status">当前运行模式未暴露模型接口，请确认宿主服务已启动。</div>
          )}
          {/* 未配置引导态：给一句人能看懂的话 + 可点的下一步，不留死按钮 */}
          {configs.length === 0 && (
            <div style={{ padding: '12px', borderRadius: '8px', background: 'var(--bg)', border: '1px solid var(--card-border)', marginBottom: '12px' }}>
              <div style={{ fontSize: '13px', color: 'var(--text)', lineHeight: 1.6 }}>
                还没有配置模型。配置后可获得带出处的答案；未配置时检索与图谱仍完整可用。
              </div>
              <div className="flex gap-2" style={{ marginTop: '10px' }}>
                <button onClick={fillLocalDefault} style={{ ...btnStyle, background: 'var(--primary)', color: 'white', border: 'none' }}>填入本地端点</button>
                <button onClick={() => applyKind('byo-openai')} style={btnStyle}>使用自带密钥</button>
              </div>
            </div>
          )}

          <Row label="模型类型">
            <select value={kind} onChange={e => applyKind(e.target.value)} style={{ ...inputStyle, width: '240px' }}>
              {catalog.map(t => (
                <option key={t.kind} value={t.kind} disabled={!t.available}>{t.label}{t.available ? '' : '（尚未提供）'}</option>
              ))}
            </select>
          </Row>
          <Row label="端点地址（base_url）">
            <input value={baseUrl} onChange={e => setBaseUrl(e.target.value)} placeholder="http://127.0.0.1:11434/v1" style={{ ...inputStyle, width: '300px' }} />
          </Row>
          <Row label="模型名">
            <input value={model} onChange={e => setModel(e.target.value)} placeholder="例如 qwen2.5:7b" style={{ ...inputStyle, width: '300px' }} />
          </Row>
          <Row label="API Key">
            {keyInputVisible ? (
              <input type="password" value={apiKey} onChange={e => setApiKey(e.target.value)}
                placeholder={catalogEntry?.requires_key ? 'sk-...' : '本地端点通常无需密钥'} style={{ ...inputStyle, width: '300px' }} />
            ) : (
              <div className="flex items-center gap-2">
                <span style={{ fontSize: '13px', color: 'var(--text)' }}>{currentConfig?.key_mask || '已配置'}</span>
                <button onClick={() => { setChangingKey(true); setApiKey('') }} style={{ ...btnStyle, fontSize: '11px', padding: '4px 10px' }}>更换</button>
              </div>
            )}
          </Row>
          <Row label="设为默认">
            <Toggle checked={isDefault} onChange={setIsDefault} />
          </Row>

          {catalogEntry?.note && (
            <div style={{ fontSize: '12px', color: 'var(--text-dim)', lineHeight: 1.6, padding: '6px 0' }}>{catalogEntry.note}</div>
          )}

          {(feedback || error) && (
            <div className="notice" role="status" style={error ? { color: 'var(--danger)' } : undefined}>
              {error || feedback?.text}
            </div>
          )}

          <div className="flex items-center gap-2" style={{ marginTop: '10px' }}>
            <button onClick={handleSave} disabled={busy !== ''} style={{ ...btnStyle, background: 'var(--primary)', color: 'white', border: 'none', opacity: busy ? 0.6 : 1 }}>
              {busy === 'save' ? '保存中…' : '保存配置'}
            </button>
            <button onClick={handleTest} disabled={busy !== '' || !baseUrl.trim() || !model.trim()} style={{ ...btnStyle, opacity: (busy || !baseUrl.trim() || !model.trim()) ? 0.6 : 1 }}>
              {busy === 'test' ? '测试中…' : '测试连接'}
            </button>
            {currentConfig && (
              <button onClick={handleRemove} disabled={busy !== ''} style={{ ...btnStyle, color: 'var(--danger)' }}>
                {busy === 'remove' ? '移除中…' : '移除配置'}
              </button>
            )}
          </div>
          <div style={{ fontSize: '12px', color: 'var(--text-dim)', lineHeight: 1.6, paddingTop: '8px' }}>
            密钥只保存在本机、只在本进程解密，界面与接口都只回显掩码。「测试连接」会先保存当前表单再探测端点。
          </div>
        </>
      )}
    </Card>
  )
}

/**
 * 数据出域（S1-02）：范围档位 + 最近出域记录。
 *
 * 三档：仅当前文档（默认）/ 当前作用域 / 整库。整库是高风险，必须显式勾选风险确认才可保存。
 * 记录只展示元信息（时间 / 目标 host / 范围 / 条数 / 结果）——正文与密钥绝不进入界面与日志。
 */
function EgressCard() {
  const [scope, setScope] = useState<string>('current_document')
  const [providerId, setProviderId] = useState('')
  const [providerLabel, setProviderLabel] = useState('')
  const [configured, setConfigured] = useState(false)
  const [confirmWhole, setConfirmWhole] = useState(false)
  const [logs, setLogs] = useState<any[]>([])
  const [busy, setBusy] = useState(false)
  const [feedback, setFeedback] = useState<{ ok: boolean; text: string } | null>(null)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => { void load() }, [])

  const load = async () => {
    const api = llmApi()
    if (!api) { setLoaded(true); return }
    try {
      const list = await api.list()
      const active = (list || []).find((c: any) => c.is_default) || (list || [])[0]
      if (active) {
        setProviderId(active.provider_id)
        setProviderLabel(active.label)
        setScope(active.egress_policy?.mode || 'current_document')
        setConfigured(true)
      } else {
        setConfigured(false)
      }
      setLogs((await api.logs({ limit: 20 })) || [])
    } catch (e: any) {
      setFeedback({ ok: false, text: e?.message || String(e) })
    } finally { setLoaded(true) }
  }

  const save = async () => {
    const api = llmApi(); if (!api || !providerId) return
    if (scope === 'whole_library' && !confirmWhole) {
      setFeedback({ ok: false, text: '整库出域需先勾选风险确认' })
      return
    }
    setBusy(true); setFeedback(null)
    try {
      await api.setEgress({ provider_id: providerId, scope, confirm: scope === 'whole_library' })
      setFeedback({ ok: true, text: '出域范围已保存并立即生效' })
      await load()
    } catch (e: any) { setFeedback({ ok: false, text: e?.message || String(e) }) }
    finally { setBusy(false) }
  }

  const scopeLabels: Record<string, string> = { current_document: '仅当前文档', selected_scope: '当前作用域', whole_library: '整库' }
  const statusLabels: Record<string, string> = { ok: '成功', error: '失败', timeout: '超时', refused: '被拒' }

  return (
    <Card title="数据出域">
      {!loaded ? (
        <div style={{ fontSize: '13px', color: 'var(--text-dim)', padding: '8px 0' }}>正在读取出域设置…</div>
      ) : !configured ? (
        <div style={{ fontSize: '13px', color: 'var(--text-dim)', lineHeight: 1.6, padding: '4px 0' }}>
          尚未配置模型，暂无可出域内容。配置模型后，可在此限定「允许送往远端的范围」。
        </div>
      ) : (
        <>
          <Row label="允许出域范围">
            <select value={scope} onChange={e => { setScope(e.target.value); setConfirmWhole(false); setFeedback(null) }} style={{ ...inputStyle, width: '260px' }}>
              <option value="current_document">仅当前文档（推荐，默认）</option>
              <option value="selected_scope">当前作用域（项目 / 文件夹 / 来源）</option>
              <option value="whole_library">整库（高风险）</option>
            </select>
          </Row>

          {scope === 'whole_library' && (
            <div className="notice" role="alert" style={{ color: 'var(--danger)', lineHeight: 1.6 }}>
              整库出域：检索命中的**任意**文档片段都可能被发送到「{providerLabel}」。请确认该端点可信——
              误开等于把整库交给远端，且每次出域都会留痕。
            </div>
          )}
          {scope === 'selected_scope' && (
            <div style={{ fontSize: '12px', color: 'var(--text-dim)', lineHeight: 1.6, padding: '4px 0' }}>
              仅发送落在当前项目 / 文件夹 / 来源范围内的命中片段。
            </div>
          )}

          <div style={{ fontSize: '12px', color: 'var(--text-dim)', lineHeight: 1.6, padding: '4px 0' }}>
            目标模型：{providerLabel}（{providerId}）。默认「仅当前文档」——写错等于默认把整库上云。
            每次出域都会写入审计（时间 / 目标 host / 范围 / 块数与篇数 / 结果，绝不记正文与密钥）。
          </div>

          {scope === 'whole_library' && (
            <Row label="我已了解风险并确认开启整库出域">
              <Toggle checked={confirmWhole} onChange={setConfirmWhole} />
            </Row>
          )}

          {feedback && <div className="notice" role="status" style={feedback.ok ? undefined : { color: 'var(--danger)' }}>{feedback.text}</div>}

          <div className="flex items-center gap-2" style={{ marginTop: '10px' }}>
            <button onClick={save} disabled={busy} style={{ ...btnStyle, background: 'var(--primary)', color: 'white', border: 'none', opacity: busy ? 0.6 : 1 }}>
              {busy ? '保存中…' : '保存出域范围'}
            </button>
          </div>

          <div style={{ marginTop: '16px' }}>
            <div style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text)', marginBottom: '6px' }}>最近出域记录</div>
            {logs.length === 0 ? (
              <div style={{ fontSize: '12px', color: 'var(--text-dim)' }}>暂无出域记录。</div>
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px' }}>
                  <thead>
                    <tr style={{ color: 'var(--text-dim)', textAlign: 'left' }}>
                      <th style={{ padding: '4px 6px' }}>时间</th>
                      <th style={{ padding: '4px 6px' }}>目标</th>
                      <th style={{ padding: '4px 6px' }}>范围</th>
                      <th style={{ padding: '4px 6px' }}>条数</th>
                      <th style={{ padding: '4px 6px' }}>结果</th>
                    </tr>
                  </thead>
                  <tbody>
                    {logs.map((log: any) => (
                      <tr key={log.id} style={{ borderTop: '1px solid var(--card-border)' }}>
                        <td style={{ padding: '4px 6px', whiteSpace: 'nowrap' }}>{String(log.created_at || '').replace('T', ' ').slice(0, 19)}</td>
                        <td style={{ padding: '4px 6px' }}>{log.target_host || '—'}</td>
                        <td style={{ padding: '4px 6px' }}>{scopeLabels[log.scope_mode] || log.scope_mode}</td>
                        <td style={{ padding: '4px 6px' }}>{log.chunk_count || 0} 块 / {log.document_count || 0} 篇</td>
                        <td style={{ padding: '4px 6px', color: log.status === 'ok' ? 'var(--success)' : 'var(--danger)' }}>
                          {statusLabels[log.status] || log.status}{log.error_code ? `（${log.error_code}）` : ''}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}
    </Card>
  )
}

function SecurityTab({ status, apiKeys, onRefresh }: { status: any; apiKeys: any[]; onRefresh: () => void }) {
  const [password, setPassword] = useState('')
  const [showPwd, setShowPwd] = useState(false)
  const [newKeyName, setNewKeyName] = useState('')
  const [newKeyRole, setNewKeyRole] = useState('reader')
  const [createdKey, setCreatedKey] = useState('')

  const handleSetup = async () => {
    if (!password || password.length < 6) { alert('密码至少 6 位'); return }
    try {
      await window.sd.security.setup(password)
      setPassword('')
      onRefresh()
    } catch (e) { alert('设置失败: ' + e) }
  }

  const handleCreateKey = async () => {
    if (!newKeyName.trim()) return
    try {
      const result = await window.sd.security.apiKeys.create(newKeyName, newKeyRole)
      setCreatedKey(result.key)
      setNewKeyName('')
      onRefresh()
    } catch (e) { alert('创建失败: ' + e) }
  }

  const handleRevoke = async (id: number) => {
    if (!confirm('确认吊销此 API Key？')) return
    try {
      await window.sd.security.apiKeys.revoke(id)
      onRefresh()
    } catch (e) { alert('吊销失败: ' + e) }
  }

  return (
    <div style={{ maxWidth: '640px' }}>
      <Card title="访问保护">
        {status?.enabled ? (
          <div style={{ padding: '12px', borderRadius: '8px', background: 'var(--success-light)', border: '1px solid var(--success)', fontSize: '13px', color: 'var(--success)' }}>
            已启用密码保护
          </div>
        ) : (
          <>
            <div style={{ fontSize: '12px', color: 'var(--text-dim)', marginBottom: '12px', lineHeight: 1.6 }}>
              设置访问密码后，所有 API 请求需携带有效 API Key。未设置时，本地访问不受限制。
            </div>
            <div className="flex gap-2">
              <input type={showPwd ? 'text' : 'password'} value={password} onChange={e => setPassword(e.target.value)}
                placeholder="设置访问密码（至少 6 位）" style={{ ...inputStyle, flex: 1 }} />
              <button onClick={() => setShowPwd(!showPwd)} style={{ ...btnStyle, width: '40px' }}>{showPwd ? '隐' : '显'}</button>
              <button onClick={handleSetup} style={{ ...btnStyle, background: 'var(--primary)', color: 'white', border: 'none' }}>设置</button>
            </div>
          </>
        )}
      </Card>

      {status?.enabled && (
        <Card title="API Keys">
          {createdKey && <div className="notice">请立即保存，此密钥仅显示一次：<input aria-label="新 API 密钥" readOnly value={createdKey} style={{ ...inputStyle, width: "100%", marginTop: 10 }} onFocus={e => e.target.select()} /></div>}
          <div className="flex gap-2 mb-4">
            <input type="text" value={newKeyName} onChange={e => setNewKeyName(e.target.value)}
              placeholder="Key 名称" style={{ ...inputStyle, flex: 1 }} />
            <select value={newKeyRole} onChange={e => setNewKeyRole(e.target.value)} style={{ ...inputStyle, width: '120px' }}>
              <option value="reader">只读</option>
              <option value="writer">读写</option>
              <option value="admin">管理员</option>
            </select>
            <button onClick={handleCreateKey} style={{ ...btnStyle, background: 'var(--primary)', color: 'white', border: 'none' }}>创建</button>
          </div>

          {apiKeys.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '24px', fontSize: '13px', color: 'var(--text-dim)' }}>暂无 API Key</div>
          ) : (
            <div className="space-y-2">
              {apiKeys.map((key: any) => (
                <div key={key.id} className="flex items-center gap-3 rounded-lg"
                  style={{ padding: '10px 14px', background: 'var(--bg)', border: '1px solid var(--card-border)' }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: '13px', color: 'var(--text)' }}>{key.name}</div>
                    <div style={{ fontSize: '11px', color: 'var(--text-dim)' }}>{key.key_prefix}... · {key.role}</div>
                  </div>
                  <span style={{ fontSize: '11px', padding: '2px 8px', borderRadius: '8px', background: key.is_active ? 'var(--success-light)' : 'var(--danger-light)', color: key.is_active ? 'var(--success)' : 'var(--danger)' }}>
                    {key.is_active ? '活跃' : '已吊销'}
                  </span>
                  {key.is_active && (
                    <button onClick={() => handleRevoke(key.id)} style={{ fontSize: '11px', color: 'var(--danger)', background: 'transparent', border: 'none', cursor: 'pointer' }}>吊销</button>
                  )}
                </div>
              ))}
            </div>
          )}
        </Card>
      )}
    </div>
  )
}

/** 默认嵌入模型（与后端内建 embedding 插件的默认项一致；下拉缺省值用，真实清单来自注册表） */
const DEFAULT_EMBEDDING = 'Xenova/bge-small-zh-v1.5'

/** 插件界面用词：插件 / 扩展（术语表 §6.1 要求，不用「模块」） */
const PLUGIN_KIND_LABEL: Record<string, string> = {
  parser: '解析器',
  embedding: '嵌入模型',
  rerank: '重排',
  method: '方法',
  panel: '面板',
  unknown: '未知（清单不完整）',
}

/**
 * 「扩展」卡片：插件列表 + 启停 + 状态 + 错误原因（ADR-005 D27）。
 *
 * 内建插件允许停用但不可卸载（本轮也没有安装/卸载入口）。停用某解析器插件后，
 * 该插件声明的扩展名立刻从「支持格式」里消失：文件页/导入会按「不支持」处理，
 * 目录映射扫描也不再收集该格式——列表里那一行同时会显示「已停用」与覆盖格式。
 */
function PluginTab({ plugins, error, busy, onToggle, onReload, onRefresh }: {
  plugins: any[]
  error: string
  busy: string
  onToggle: (id: string, nextEnabled: boolean) => void
  onReload: () => void
  onRefresh: () => void
}) {
  const statusOf = (p: any) => {
    if (!p.loaded) return { text: '加载失败', color: 'var(--danger)', bg: 'var(--danger-light)' }
    if (!p.enabled) return { text: '已停用', color: 'var(--text-secondary)', bg: 'var(--card-bg-hover)' }
    return { text: '已启用', color: 'var(--success)', bg: 'var(--success-light)' }
  }

  return (
    <div style={{ maxWidth: '720px' }}>
      <Card title="插件">
        <div style={{ fontSize: '12px', color: 'var(--text-dim)', lineHeight: 1.7, marginBottom: '10px' }}>
          插件声明式地扩展解析格式与嵌入模型，内建能力同样走插件路径。内建插件随应用分发，
          <strong style={{ color: 'var(--text-secondary)' }}>可停用但不可卸载</strong>；
          停用某个解析器后，它覆盖的格式会被当作「不支持」。
          权限只做声明与校验：宿主不向插件发放文件系统或网络能力（未声明的能力一律不提供）。
        </div>

        {error && <div className="notice" role="status">插件接口不可用：{error}</div>}
        {!error && plugins.length === 0 && (
          <div style={{ textAlign: 'center', padding: '24px', fontSize: '13px', color: 'var(--text-dim)' }}>暂无插件</div>
        )}

        {plugins.map((p, i) => {
          const st = statusOf(p)
          return (
            <div key={p.id} className="flex items-start gap-3"
              style={{ padding: '10px 0', borderTop: i === 0 ? 'none' : '1px solid var(--card-border)' }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text)' }}>
                  {p.name}
                  <span style={{ marginLeft: '8px', fontSize: '11px', fontWeight: 500, color: 'var(--text-dim)' }}>{p.id}</span>
                </div>
                <div style={{ fontSize: '11px', color: 'var(--text-dim)', marginTop: '4px' }}>
                  {PLUGIN_KIND_LABEL[p.kind] || p.kind} · v{p.version} · {p.builtin ? '内建' : '本地'}
                  {p.kind === 'parser' && p.capabilities?.extensions?.length ? ` · 覆盖格式：${p.capabilities.extensions.join(' / ')}` : ''}
                  {p.kind === 'embedding' && p.capabilities?.dimension ? ` · 维度 ${p.capabilities.dimension}` : ''}
                </div>
                <div style={{ fontSize: '11px', color: 'var(--text-dim)', marginTop: '2px' }}>
                  权限：读取文件 {p.permissions?.fsRead ? '✓' : '✗'} · 联网 {p.permissions?.net ? '✓' : '✗'}
                  {p.permissions?.modelDownload?.length ? `（下载白名单 ${p.permissions.modelDownload.length} 项）` : ''}
                </div>
                {p.error && (
                  <div style={{ fontSize: '11px', color: 'var(--danger)', marginTop: '4px', lineHeight: 1.6 }}>
                    错误原因：{p.error}
                  </div>
                )}
              </div>
              <div className="flex items-center gap-3" style={{ paddingTop: '2px' }}>
                <span style={{ fontSize: '11px', padding: '2px 8px', borderRadius: '8px', background: st.bg, color: st.color }}>
                  {st.text}
                </span>
                <button
                  onClick={() => onToggle(p.id, !p.enabled)}
                  disabled={!p.loaded || busy === p.id}
                  style={{
                    ...btnStyle,
                    fontSize: '11px',
                    padding: '4px 10px',
                    cursor: (!p.loaded || busy === p.id) ? 'not-allowed' : 'pointer',
                    opacity: (!p.loaded || busy === p.id) ? 0.5 : 1,
                  }}>
                  {busy === p.id ? '处理中…' : (p.enabled ? '停用' : '启用')}
                </button>
              </div>
            </div>
          )
        })}
      </Card>

      <Card title="本地插件">
        <div style={{ fontSize: '12px', color: 'var(--text-dim)', lineHeight: 1.7 }}>
          把插件目录放到 <code>&lt;Data&gt;/plugins/&lt;插件 id&gt;/</code>（含 manifest.json 与入口文件）后点「重新扫描」即可加载；
          清单缺字段、apiVersion 不匹配或入口加载失败都会在上方列表里给出可读原因，不会影响其它插件。
          安装 / 卸载界面排在 S2，本轮不提供。
        </div>
        <div className="flex items-center gap-2" style={{ marginTop: '10px' }}>
          <button onClick={onReload} disabled={busy === '__reload__'} style={{ ...btnStyle, opacity: busy === '__reload__' ? 0.6 : 1 }}>
            {busy === '__reload__' ? '扫描中…' : '重新扫描'}
          </button>
          <button onClick={onRefresh} style={btnStyle}>刷新状态</button>
        </div>
      </Card>
    </div>
  )
}

function AuditTab({ logs, onRefresh }: { logs: any[]; onRefresh: () => void }) {
  const [retentionDays, setRetentionDays] = useState('')
  const [retentionError, setRetentionError] = useState('')
  const [retentionBusy, setRetentionBusy] = useState(false)
  const [pruneBusy, setPruneBusy] = useState(false)
  const [pruneResult, setPruneResult] = useState<{ removed: number; remaining: number; snapshot: string | null } | null>(null)
  const [pruneError, setPruneError] = useState('')
  const [apiMissing, setApiMissing] = useState(false)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const days = await window.sd.audit.retentionGet()
        if (!cancelled) setRetentionDays(String(days))
      } catch (e: any) {
        // 宿主未暴露审计接口（老版本后端 / 未登录）：给出可读提示而不是崩掉
        if (!cancelled) setApiMissing(true)
      }
    })()
    return () => { cancelled = true }
  }, [])

  const saveRetention = async () => {
    const n = Number(retentionDays)
    if (!Number.isInteger(n) || n < 7 || n > 365) {
      setRetentionError('保留天数需为 7–365 之间的整数')
      return
    }
    setRetentionBusy(true)
    try {
      const saved = await window.sd.audit.retentionSet(n)
      setRetentionDays(String(saved))
      setRetentionError('')
    } catch (e: any) {
      setRetentionError('保存失败：' + (e?.message || String(e)))
    } finally { setRetentionBusy(false) }
  }

  const prune = async () => {
    if (!confirm('将清理超过保留天数的审计日志，清理前会自动生成快照备份（失败则中止清理）。确定继续？')) return
    setPruneBusy(true)
    setPruneError('')
    setPruneResult(null)
    try {
      const result = await window.sd.audit.prune()
      setPruneResult(result)
      onRefresh()
    } catch (e: any) {
      setPruneError(e?.message || String(e))
    } finally { setPruneBusy(false) }
  }

  const fmtTime = (t: string) => {
    if (!t) return '-'
    const d = new Date(t)
    return d.toLocaleString('zh-CN')
  }

  return (
    <div style={{ maxWidth: '800px' }}>
      <Card title="日志保留策略">
        {apiMissing ? (
          <div style={{ fontSize: '12px', color: 'var(--text-dim)', lineHeight: 1.7 }}>
            当前运行模式未暴露审计接口，保留策略与手动清理暂不可用。
          </div>
        ) : (
          <>
            <div className="flex items-center gap-2">
              <span style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>审计日志保留</span>
              <input
                value={retentionDays}
                onChange={e => { setRetentionDays(e.target.value); setRetentionError('') }}
                disabled={retentionBusy}
                inputMode="numeric"
                placeholder="90"
                aria-label="审计日志保留天数"
                style={{ ...inputStyle, width: '80px', padding: '6px 10px' }}
              />
              <span style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>天（7–365）</span>
              <button
                onClick={saveRetention}
                disabled={retentionBusy || !retentionDays}
                style={{
                  ...btnStyle,
                  fontSize: '12px',
                  padding: '6px 14px',
                  cursor: (retentionBusy || !retentionDays) ? 'not-allowed' : 'pointer',
                  opacity: (retentionBusy || !retentionDays) ? 0.6 : 1,
                }}>
                {retentionBusy ? '保存中…' : '保存'}
              </button>
            </div>
            {retentionError && <div style={{ fontSize: '12px', color: 'var(--danger)', marginTop: '8px' }} role="alert">{retentionError}</div>}
            <div className="flex items-center gap-2" style={{ marginTop: '12px' }}>
              <button
                onClick={prune}
                disabled={pruneBusy || apiMissing}
                style={{
                  ...btnStyle,
                  fontSize: '12px',
                  padding: '6px 14px',
                  cursor: pruneBusy ? 'not-allowed' : 'pointer',
                  opacity: pruneBusy ? 0.6 : 1,
                }}>
                {pruneBusy ? '清理中…' : '清理过期日志'}
              </button>
              <span style={{ fontSize: '11px', color: 'var(--text-dim)' }}>清理前自动快照到备份目录，失败则中止</span>
            </div>
            {pruneResult && (
              <div className="notice" role="status" style={{ marginTop: '10px' }}>
                已清理 {pruneResult.removed} 条，剩余 {pruneResult.remaining} 条
                {pruneResult.snapshot ? `，快照：${pruneResult.snapshot}` : ''}
              </div>
            )}
            {pruneError && (
              <div style={{ fontSize: '12px', color: 'var(--danger)', marginTop: '8px' }} role="alert">
                清理失败：{pruneError}
              </div>
            )}
          </>
        )}
      </Card>
      <div className="rounded-xl overflow-hidden" style={{ border: '1px solid var(--card-border)' }}>
        <div className="flex items-center px-4" style={{ height: '36px', background: 'var(--card-bg)', borderBottom: '1px solid var(--card-border)', fontSize: '12px', fontWeight: 600, color: 'var(--text-secondary)' }}>
          <span style={{ flex: 1 }}>操作</span>
          <span style={{ width: '100px' }}>资源</span>
          <span style={{ width: '80px' }}>状态</span>
          <span style={{ width: '150px' }}>时间</span>
        </div>
        {logs.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '32px', fontSize: '13px', color: 'var(--text-dim)' }}>暂无审计日志</div>
        ) : logs.map((log, i) => (
          <div key={i} className="flex items-center px-4"
            style={{ height: '36px', borderBottom: i < logs.length - 1 ? '1px solid var(--card-border)' : 'none', fontSize: '12px' }}>
            <span style={{ flex: 1, color: 'var(--text)' }}>{log.action}</span>
            <span style={{ width: '100px', color: 'var(--text-secondary)' }}>{log.resource_type || '-'}</span>
            <span style={{ width: '80px' }}>
              <span style={{ fontSize: '11px', padding: '1px 6px', borderRadius: '8px', background: log.status === 'success' ? 'var(--success-light)' : 'var(--danger-light)', color: log.status === 'success' ? 'var(--success)' : 'var(--danger)' }}>
                {log.status || '-'}
              </span>
            </span>
            <span style={{ width: '150px', color: 'var(--text-dim)' }}>{fmtTime(log.created_at)}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

const inputStyle: React.CSSProperties = {
  background: 'var(--bg)',
  border: '1px solid var(--card-border)',
  borderRadius: '8px',
  padding: '8px 12px',
  fontSize: '13px',
  color: 'var(--text)',
  outline: 'none',
}

const btnStyle: React.CSSProperties = {
  padding: '8px 16px',
  borderRadius: '8px',
  fontSize: '13px',
  fontWeight: 500,
  cursor: 'pointer',
  border: '1px solid var(--card-border)',
  background: 'var(--card-bg)',
  color: 'var(--text)',
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl mb-4" style={{ background: 'var(--card-bg)', border: '1px solid var(--card-border)', padding: '16px 20px' }}>
      <div style={{ fontSize: '14px', fontWeight: 600, color: 'var(--text)', marginBottom: '12px' }}>{title}</div>
      {children}
    </div>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between" style={{ padding: '6px 0' }}>
      <span style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>{label}</span>
      {children}
    </div>
  )
}

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div onClick={() => onChange(!checked)} className="cursor-pointer"
      style={{
        width: '40px', height: '22px', borderRadius: '11px',
        background: checked ? 'var(--primary)' : 'var(--card-border)',
        position: 'relative', transition: 'background 0.2s',
      }}>
      <div style={{
        position: 'absolute', top: '2px', left: checked ? '20px' : '2px',
        width: '18px', height: '18px', borderRadius: '50%',
        background: 'white', transition: 'left 0.2s',
      }} />
    </div>
  )
}

function SaveButton({ saving, onClick }: { saving: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick} disabled={saving}
      className="rounded-lg transition-all"
      style={{
        padding: '10px 24px', fontSize: '13px', fontWeight: 600,
        background: 'var(--primary)', color: 'white', border: 'none',
        cursor: saving ? 'not-allowed' : 'pointer', opacity: saving ? 0.6 : 1,
      }}>
      {saving ? '保存中...' : '保存设置'}
    </button>
  )
}
