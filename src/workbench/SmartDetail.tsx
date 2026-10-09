import { useEffect, useMemo, useState } from 'react'
import type { SDTask, SDTaskGroup, SDWorkbenchProject } from '../types/global'
import {
  IconAlertCircle,
  IconCalendar,
  IconCheck,
  IconClose,
  IconDots,
  IconEdit,
  IconLayers,
  IconPlus,
  IconSearch,
  IconSpark,
} from './icons'
import { daysUntil, priorityMeta, statusMeta, STATUS_ORDER } from './motion'

interface Props {
  task: SDTask | null
  tasks: SDTask[]
  groups: SDTaskGroup[]
  projects: SDWorkbenchProject[]
  /** ≤1200px 时右栏是抽屉，由移动端悬浮按钮控制开合 */
  open?: boolean
  onClose: () => void
  onPatch: (id: string, patch: Record<string, unknown>) => Promise<void>
  onAssignProject: (taskId: string, projectId: number | null) => Promise<void>
  onComplete: (id: string) => Promise<void>
  onArchive: (id: string) => Promise<void>
  onRemove: (id: string) => Promise<void>
  /** 「重新检查本机数据」：重取任务列表，提示随之刷新 */
  onRefresh: () => Promise<void>
}

/** `<input type="datetime-local">` 与库里 `YYYY-MM-DD HH:MM:SS` 的互转。
 *  库里可能只有日期（`2026-09-01`），直接塞给 datetime-local 会被判非法而清空，故补 00:00。 */
const toInput = (value?: string | null) => {
  if (!value) return ''
  const iso = value.replace(' ', 'T')
  return iso.length >= 16 ? iso.slice(0, 16) : `${iso.slice(0, 10)}T00:00`
}
const fromInput = (value: string) => (value ? `${value.replace('T', ' ')}:00` : null)

/**
 * 右侧「智能详情」：参照稿 `.wb-detail` 的 1:1 复刻。
 *
 * 参照稿的六行字段（负责人 / 所属项目 / 截止时间 / 当前状态 / 优先级 / 标签）全部保留；
 * 状态与优先级保持参照稿的点+文案形态，点击即轮换到下一档，避免换成下拉后丢掉那个圆点。
 * 「AI 助手建议」区块的内容由本机数据派生（逾期、未排期、关联文档、分组余量），不写死文案。
 */
export default function SmartDetail({
  task,
  tasks,
  groups,
  projects,
  open = false,
  onClose,
  onPatch,
  onAssignProject,
  onComplete,
  onArchive,
  onRemove,
  onRefresh,
}: Props) {
  const [tags, setTags] = useState<Array<{ id: number; name: string; color?: string }>>([])
  const [tagDraft, setTagDraft] = useState('')
  const [addingTag, setAddingTag] = useState(false)
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [menuOpen, setMenuOpen] = useState(false)
  const [allInsights, setAllInsights] = useState(false)

  const taskId = task?.id ?? null

  useEffect(() => {
    setEditing(false)
    setMenuOpen(false)
    setAllInsights(false)
    setName(task?.name ?? '')
    setDescription(task?.description ?? '')
    if (!taskId) { setTags([]); return }
    let alive = true
    window.sd.tag.list(taskId).then((list: any) => { if (alive) setTags(list ?? []) }).catch(() => { if (alive) setTags([]) })
    return () => { alive = false }
  }, [taskId, task?.name, task?.description])

  const project = projects.find((item) => item.id === task?.projectId) ?? null
  const group = groups.find((item) => item.id === task?.groupId) ?? null

  /** 本机数据派生出的洞察：每一条都能在库里对上，不写死文案 */
  const insights = useMemo(() => {
    if (!task) return []
    const list: string[] = []
    const left = daysUntil(task.deadline)

    if (left !== null && left < 0 && task.status !== 'done') {
      list.push(`已逾期 ${-left} 天，建议重新排期或调低优先级。`)
    }
    if (left === 0 && task.status !== 'done') list.push('今天到期，建议优先处理。')
    if (left !== null && left > 0 && left <= 2 && task.status !== 'done') list.push(`${left} 天后到期，已进入收尾窗口。`)
    if (!task.deadline) list.push('还没有截止时间，因此不会出现在项目时间线上。')
    if (!task.owner) list.push('还没有指定负责人。')

    if (project) {
      list.push(`所属项目「${project.name}」关联 ${project.docCount} 份文档，完成度 ${project.progress}%。`)
    }
    if (group) {
      const rest = tasks.filter((item) => item.groupId === group.id && item.status !== 'done' && item.id !== task.id).length
      list.push(`分组「${group.name}」还有 ${rest} 项未完成。`)
    }
    if (task.priority === '高' && left !== null && left <= 3 && task.status !== 'done') {
      list.push('高优先级且临近截止，建议确认依赖是否齐备。')
    }
    return list
  }, [task, project, group, tasks])

  const cycleStatus = () => {
    if (!task) return
    const index = STATUS_ORDER.indexOf(task.status)
    const next = STATUS_ORDER[(index + 1) % STATUS_ORDER.length]
    void onPatch(task.id, { status: next })
  }

  const cyclePriority = () => {
    if (!task) return
    const order = ['高', '中', '低'] as const
    const index = order.indexOf(task.priority)
    void onPatch(task.id, { priority: order[(index + 1) % order.length] })
  }

  const addTag = async () => {
    const name_ = tagDraft.trim()
    if (!task || !name_) { setAddingTag(false); setTagDraft(''); return }
    try {
      await window.sd.tag.add(task.id, { name: name_ })
      setTags((await window.sd.tag.list(task.id)) ?? [])
    } catch { /* 失败时保持原列表 */ }
    setTagDraft('')
    setAddingTag(false)
  }

  const removeTag = async (tagId: number) => {
    if (!task) return
    try {
      await window.sd.tag.remove(task.id, tagId)
      setTags((await window.sd.tag.list(task.id)) ?? [])
    } catch { /* 失败时保持原列表 */ }
  }

  return (
    <aside className={`wb-detail${open ? ' wb-detail--open' : ''}`}>
      <div className="wb-detail__card">
        <div className="wb-detail__head">
          <span className="wb-detail__spark"><IconSpark /></span>
          <span className="wb-detail__title">智能详情</span>
          <div className="wb-detail__headtools">
            {/* 提示不足 4 条时这个开关切了也没有任何渲染差异，直接不渲染，避免成为"点了没反应"的按钮 */}
            {insights.length > 3 && (
              <button
                className="wb-iconbtn"
                title={allInsights ? '收起扩展提示' : '展开全部本机提示'}
                onClick={() => setAllInsights((value) => !value)}
              >
                <IconSearch />
              </button>
            )}
            <button className="wb-iconbtn" title="关闭" onClick={onClose}>
              <IconClose />
            </button>
          </div>
        </div>

        {!task ? (
          <div className="wb-detail__empty">
            <IconSpark />
            <h3>还没有选中任务</h3>
            <p>在左侧任务列表或时间线上点一条任务，这里会显示它的完整字段与本机数据派生的提示。</p>
          </div>
        ) : (
          <>
            <div className="wb-detail__body">
              <div>
                <div className="wb-detail__id">{task.id}</div>
                {editing ? (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 6 }}>
                    <input
                      className="wb-tag-input"
                      style={{ width: '100%', borderRadius: 8, padding: '8px 10px', fontSize: 13 }}
                      value={name}
                      onChange={(event) => setName(event.target.value)}
                      onBlur={() => name.trim() && name !== task.name && void onPatch(task.id, { name: name.trim() })}
                      placeholder="任务名称"
                    />
                    <textarea
                      style={{
                        width: '100%', minHeight: 76, resize: 'vertical', fontSize: 12, lineHeight: 1.7,
                        background: 'var(--wb-card-bg-hover)', border: '1px solid var(--wb-border)',
                        color: 'var(--wb-text-1)', borderRadius: 8, padding: '9px 10px', outline: 'none',
                      }}
                      value={description}
                      onChange={(event) => setDescription(event.target.value)}
                      onBlur={() => description !== task.description && void onPatch(task.id, { description })}
                      placeholder="补充描述"
                    />
                  </div>
                ) : (
                  <>
                    <div className="wb-detail__namerow" style={{ marginTop: 6 }}>
                      <span className="wb-detail__name">{task.name}</span>
                      <span className={`wb-detail__prio${task.priority === '高' ? '' : task.priority === '中' ? ' wb-detail__prio--mid' : ' wb-detail__prio--low'}`}>
                        {priorityMeta(task.priority).label}优先级
                      </span>
                    </div>
                    <p className="wb-detail__desc" style={{ marginTop: 8 }}>
                      {task.description || '还没有描述。'}
                    </p>
                  </>
                )}
              </div>

              <div className="wb-fields">
                <div className="wb-field">
                  <span className="wb-field__label">负责人</span>
                  <span className="wb-field__value">
                    <span className="wb-field__avatar">{(task.owner || '·').slice(0, 1).toUpperCase()}</span>
                    <input
                      defaultValue={task.owner}
                      key={`owner-${task.id}-${task.owner}`}
                      placeholder="未指派"
                      onBlur={(event) => event.target.value !== task.owner && void onPatch(task.id, { owner: event.target.value })}
                      onKeyDown={(event) => { if (event.key === 'Enter') (event.target as HTMLInputElement).blur() }}
                    />
                  </span>
                </div>

                <div className="wb-field">
                  <span className="wb-field__label">所属项目</span>
                  <span className="wb-field__value">
                    <IconLayers />
                    <select
                      value={task.projectId ?? ''}
                      onChange={(event) => void onAssignProject(task.id, event.target.value ? Number(event.target.value) : null)}
                    >
                      <option value="">未归属</option>
                      {projects.map((item) => (
                        <option key={item.id} value={item.id}>{item.name}</option>
                      ))}
                    </select>
                  </span>
                </div>

                <div className="wb-field">
                  <span className="wb-field__label">截止时间</span>
                  <span className="wb-field__value">
                    <IconCalendar />
                    <input
                      type="datetime-local"
                      value={toInput(task.deadline)}
                      onChange={(event) => void onPatch(task.id, { deadline: fromInput(event.target.value) })}
                    />
                  </span>
                </div>

                <div className="wb-field">
                  <span className="wb-field__label">当前状态</span>
                  <span className="wb-field__value">
                    <button
                      className={`wb-field__status${task.status === 'doing' ? '' : ` wb-field__status--${task.status}`}`}
                      title="点击切换到下一档状态"
                      onClick={cycleStatus}
                    >
                      {statusMeta(task.status).label}
                    </button>
                  </span>
                </div>

                <div className="wb-field">
                  <span className="wb-field__label">优先级</span>
                  <span className="wb-field__value">
                    <button
                      className={`wb-field__danger${task.priority === '高' ? '' : ' wb-field__muted'}`}
                      title="点击轮换优先级"
                      onClick={cyclePriority}
                    >
                      {priorityMeta(task.priority).label}
                    </button>
                  </span>
                </div>

                <div className="wb-field">
                  <span className="wb-field__label">标签</span>
                  <span className="wb-tags">
                    {tags.map((tag) => (
                      <span
                        key={tag.id}
                        className="wb-tag"
                        title="点击移除"
                        style={{ cursor: 'pointer' }}
                        onClick={() => void removeTag(tag.id)}
                      >
                        {tag.name}
                      </span>
                    ))}
                    {addingTag ? (
                      <input
                        className="wb-tag-input"
                        autoFocus
                        value={tagDraft}
                        onChange={(event) => setTagDraft(event.target.value)}
                        onBlur={() => void addTag()}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') void addTag()
                          if (event.key === 'Escape') { setAddingTag(false); setTagDraft('') }
                        }}
                        placeholder="标签名"
                      />
                    ) : (
                      <button className="wb-tag wb-tag--add" title="添加标签" onClick={() => setAddingTag(true)}>
                        <IconPlus sw={2.4} />
                      </button>
                    )}
                  </span>
                </div>
              </div>

              <div className="wb-ai">
                <div className="wb-ai__head">
                  <IconSpark />
                  <span className="wb-ai__title">本机数据提示</span>
                </div>
                <div className="wb-ai__list">
                  {insights.length === 0 && <div className="wb-ai__item">这条任务暂时没有可提示的异常。</div>}
                  {(allInsights ? insights : insights.slice(0, 3)).map((text) => (
                    <div className="wb-ai__item" key={text}>{text}</div>
                  ))}
                </div>
                {insights.length > 3 ? (
                  <button className="wb-ai__btn" onClick={() => setAllInsights((value) => !value)}>
                    {allInsights ? '收起提示' : `查看全部 ${insights.length} 条提示`}
                  </button>
                ) : (
                  <button className="wb-ai__btn" onClick={() => void onRefresh()}>
                    重新检查本机数据
                  </button>
                )}
              </div>
            </div>

            <div className="wb-detail__footer">
              <button className="wb-btn wb-btn--ghost" onClick={() => setEditing((value) => !value)}>
                <IconEdit />
                {editing ? '完成编辑' : '编辑任务'}
              </button>
              <button
                className={`wb-btn wb-btn--done${task.status === 'done' ? ' is-done' : ''}`}
                disabled={task.status === 'done'}
                title={task.status === 'done' ? '这条任务已完成' : '标记为已完成'}
                onClick={() => void onComplete(task.id)}
              >
                <IconCheck />
                {task.status === 'done' ? '已完成' : '完成任务'}
              </button>
              {/* 不加 wb-account--down：页脚在卡片底部，向下展开会被 .wb-detail__card 的
                  overflow:hidden 裁掉并溢出视口，必须向上展开 */}
              <div className="wb-account">
                <button className="wb-btn wb-btn--more" title="更多" onClick={() => setMenuOpen((value) => !value)}>
                  <IconDots />
                </button>
                {menuOpen && (
                  <div className="wb-account__menu">
                    <button className="wb-account__item" onClick={() => { setMenuOpen(false); void onArchive(task.id) }}>
                      <IconCheck />
                      归档任务
                    </button>
                    <button className="wb-account__item" onClick={() => { setMenuOpen(false); void onRemove(task.id) }}>
                      <IconAlertCircle />
                      删除任务
                    </button>
                  </div>
                )}
              </div>
            </div>
          </>
        )}
      </div>
    </aside>
  )
}
