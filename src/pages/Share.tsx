import { useCallback, useEffect, useState } from 'react'
import type { SDBackupFile, SDShareSnapshotResult } from '../types/global'
import { errorMessage, isAuthError } from '../workbench/useWorkbench'

/**
 * 共享与导出（S2-05）：
 * - 共享快照：把「可共享」的库内容导出为自包含 JSON（Data/exports/snapshot-*.json），
 *   密钥类配置、文档正文、向量、审计与出域日志一律不出本机；
 * - 工作台备份：工作台域（任务/分组/项目/提醒等）的 JSON 备份管理。
 *
 * 快照导出属内核域能力（不要求登录）；工作台备份走 data.* 要求登录，未登录时给引导文案而非红错。
 */

function fmtSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value < 10 && unit > 0 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`
}

function fmtTime(value: string | undefined): string {
  return String(value || '').slice(0, 19).replace('T', ' ')
}

/** counts 的键名翻成人话，按固定顺序展示 */
const COUNT_LABELS: Array<[string, string]> = [
  ['documents', '文档'], ['chunks', '分块'], ['folders', '目录'], ['folderSources', '目录来源'],
  ['entities', '实体'], ['entityAliases', '别名'], ['relationships', '关系'], ['savedSearches', '保存的检索'],
  ['tasks', '任务'], ['projects', '项目'],
]

const ROW_STYLE = { padding: '8px 10px', borderRadius: 'var(--radius-m)', border: '1px solid var(--card-border)', background: 'var(--card-bg)' } as const

export default function Share() {
  const [backups, setBackups] = useState<SDBackupFile[]>([])
  const [loading, setLoading] = useState(true)
  const [authRequired, setAuthRequired] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState('')
  const [exporting, setExporting] = useState(false)
  const [snapshot, setSnapshot] = useState<SDShareSnapshotResult | null>(null)

  const load = useCallback(async () => {
    try {
      setBackups(await window.sd.data.backups())
      setAuthRequired(false)
      setError('')
    } catch (e) {
      if (isAuthError(e)) {
        setAuthRequired(true)
        setBackups([])
        setError('')
      } else {
        setError(errorMessage(e))
      }
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  /** 备份写操作的统一出口：成功后刷新列表并提示 */
  const run = async (key: string, task: () => Promise<unknown>, successMessage: string) => {
    setBusy(key)
    setError('')
    setNotice('')
    try {
      await task()
      setNotice(successMessage)
      await load()
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy('')
    }
  }

  const exportSnapshot = async () => {
    setExporting(true)
    setError('')
    setNotice('')
    try {
      const result = await window.sd.share.exportSnapshot()
      setSnapshot(result)
      setNotice(`快照已导出：${result.fileName}（${fmtSize(result.size)}）`)
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setExporting(false)
    }
  }

  const create = () => void run('create', () => window.sd.data.backup.create('manual'), '备份已创建')

  const restore = (file: SDBackupFile) => {
    // 恢复是覆盖性操作：显式确认，且导入前服务端会自动生成安全备份
    if (!window.confirm(`恢复备份将覆盖当前工作台数据（导入前会自动生成安全备份）。\n确定恢复「${file.name}」吗？`)) return
    void run(`restore-${file.name}`, () => window.sd.data.backup.restore(file.name), `已恢复备份「${file.name}」`)
  }

  const remove = (file: SDBackupFile) => {
    if (!window.confirm(`确定删除备份「${file.name}」吗？删除后不可恢复。`)) return
    void run(`delete-${file.name}`, () => window.sd.data.backup.delete(file.name), `已删除备份「${file.name}」`)
  }

  return (
    <div className="page-scroll" style={{ padding: '22px 26px 26px' }}>
      <div className="page-heading">
        <div>
          <div className="eyebrow">SHARE</div>
          <h1>共享与导出<span className="heading-dot">.</span></h1>
          <p>快照外发与工作台备份 · 敏感信息不出本机</p>
        </div>
      </div>

      {error && <div className="notice" role="alert" style={{ borderColor: 'var(--danger)' }}>{error}</div>}
      {notice && <div className="notice" role="status">{notice}</div>}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        {/* 共享快照导出 */}
        <div className="panel">
          <div className="panel-heading">
            <div>
              <h2>共享快照</h2>
              <p>自包含 JSON · 文档目录 / 分块锚点 / 实体关系 / 工作台数据</p>
            </div>
            <button className="button" disabled={exporting} onClick={() => void exportSnapshot()}>
              {exporting ? '导出中…' : '导出快照'}
            </button>
          </div>
          <p style={{ fontSize: 12, color: 'var(--text-secondary)', margin: '0 0 10px' }}>
            快照落在本机 Data/exports/ 目录；密钥类配置、文档正文、向量、审计与出域日志一律不包含，可安全外发。
          </p>
          {snapshot ? (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
              <span className="pill" title={snapshot.path}>{snapshot.fileName}</span>
              <span className="pill">{fmtSize(snapshot.size)}</span>
              {COUNT_LABELS.filter(([key]) => snapshot.counts[key] != null).map(([key, label]) => (
                <span key={key} className="pill">{label} {snapshot.counts[key]}</span>
              ))}
            </div>
          ) : (
            <div className="empty-state" style={{ minHeight: 90 }}>
              <span className="empty-symbol">✧</span>
              <p>还没有导出过快照</p>
            </div>
          )}
        </div>

        {/* 工作台备份管理 */}
        <div className="panel">
          <div className="panel-heading">
            <div>
              <h2>工作台备份</h2>
              <p>任务 / 分组 / 项目 / 提醒等 JSON 备份</p>
            </div>
            <button className="button secondary" disabled={authRequired || busy === 'create'} title={authRequired ? '登录后可创建备份' : '创建一份工作台备份'} onClick={create}>
              {busy === 'create' ? '备份中…' : '立即备份'}
            </button>
          </div>
          {authRequired ? (
            <div className="empty-state" style={{ minHeight: 120 }}>
              <span className="empty-symbol">✧</span>
              <p>工作台备份需登录后使用：请在左侧栏底部登录</p>
            </div>
          ) : loading ? (
            <div className="empty-state" style={{ minHeight: 120 }}>
              <span className="empty-symbol">◔</span>
              <p>正在加载备份列表…</p>
            </div>
          ) : backups.length ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 420, overflowY: 'auto' }}>
              {backups.map((file) => (
                <div key={file.name} className="flex items-center gap-2" style={ROW_STYLE}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 12.5, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{file.name}</div>
                    <div style={{ fontSize: 11, color: 'var(--text-note)', marginTop: 2 }}>{fmtSize(file.size)} · {fmtTime(file.createdAt)}</div>
                  </div>
                  <button
                    className="button secondary"
                    style={{ padding: '3px 10px', fontSize: 11, flexShrink: 0 }}
                    disabled={busy === `restore-${file.name}`}
                    onClick={() => restore(file)}
                  >{busy === `restore-${file.name}` ? '…' : '恢复'}</button>
                  <button
                    className="button secondary"
                    style={{ padding: '3px 10px', fontSize: 11, color: 'var(--danger)', flexShrink: 0 }}
                    disabled={busy === `delete-${file.name}`}
                    onClick={() => remove(file)}
                  >{busy === `delete-${file.name}` ? '…' : '删除'}</button>
                </div>
              ))}
            </div>
          ) : (
            <div className="empty-state" style={{ minHeight: 120 }}>
              <span className="empty-symbol">✧</span>
              <p>还没有工作台备份，点击「立即备份」创建第一份</p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
