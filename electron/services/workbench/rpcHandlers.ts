import { CameraService } from '../perception/cameraService'
import { LlmGateway } from '../gateway/llmGateway'
import { LlmService } from '../gateway/llmService'
import { AnswerService } from '../answerService'
import { ResourceService } from '../resourceService'
import { GithubRankService } from '../githubRankService'
import { SearchOptions, SearchService } from '../searchService'
import { pluginRegistry, reloadPluginSystem } from '../plugins'
import { AuthService } from './authService'
import { DataManager } from './dataManager'
import { ReminderService } from './reminderService'
import { TaskService } from './taskService'
import { WorkbenchService } from './workbenchService'

export interface WorkbenchRpcDeps {
  workbench: WorkbenchService
  tasks: TaskService
  auth: AuthService
  reminders: ReminderService
  dataManager: DataManager
  /** 内核检索服务：工作台搜索通过它复用 FTS5、作用域和结果封套。 */
  search: SearchService
  /** LLM 接缝（ADR-003 决策 5）：用于上报可用性 */
  llm?: LlmGateway
  /** LLM 网关服务（S1-01）：承载 llm.* 的配置与对话方法 */
  llmService?: LlmService
  /** RAG 问答链路（S1-03）：承载 chat.ask（混合检索 → 上下文 → LLM → 答案 + 引用） */
  answer?: AnswerService
  /** 摄像头接缝（ADR-003 决策 5）：仅用于上报可用性 */
  camera?: CameraService
  /** 开源资源汇：卡片式展示收集的开源模型/技能/工具 */
  resources?: ResourceService
  /** GitHub 每日榜单：缓存每日各领域 star 前 15 项目 */
  githubRank?: GithubRankService
  /** 会话标识：Web 端用本地会话 token，桌面端固定为 desktop */
  clientId: string
  /**
   * 机器调用标记（REST/MCP 侧已用 api_keys 验过身份）。
   * 为 true 时不再要求人工登录会话——机器凭证与人的身份是两套体系（ADR-003）。
   */
  trusted?: boolean
}

/**
 * 工作台域的 RPC 方法表。
 *
 * 抽成独立模块是为了让 Web 入口（/local/rpc）与桌面入口（IPC 单一通道）
 * 共用同一份方法定义——否则两边各写一套，加一个方法就要改两处，迟早走偏。
 */
export function createWorkbenchRpc(deps: WorkbenchRpcDeps): Record<string, (...args: any[]) => any> {
  const { workbench, tasks, auth, reminders, dataManager, search, clientId, trusted } = deps
  // 工作台域接口统一要求已登录；未登录抛 AUTH_REQUIRED，由入口层转成 401 / 拒绝
  const guard = <T>(fn: () => T): T => {
    if (!trusted) auth.requireSession(clientId)
    return fn()
  }
  // LLM 网关服务（S1-01）：未装配时给可读错误，而不是 undefined 崩栈
  const requireLlm = (): LlmService => {
    if (!deps.llmService) throw new Error('LLM 网关尚未装配：请确认主进程已创建 LlmService')
    return deps.llmService
  }
  // RAG 问答服务（S1-03）：同上
  const requireAnswer = (): AnswerService => {
    if (!deps.answer) throw new Error('问答服务尚未装配：请确认主进程已创建 AnswerService')
    return deps.answer
  }

  return {
    // 用户身份（users 表为唯一身份源，机器凭证仍归 security.apiKeys）
    'auth.status': () => auth.status(clientId),
    'auth.register': (p: any) => auth.register(clientId, p || {}),
    'auth.login': (p: any) => auth.login(clientId, p || {}),
    'auth.logout': () => auth.logout(clientId),
    'auth.changePassword': (p: any) => auth.changePassword(clientId, p || {}),
    // 验证码（注册 / 找回密码共用）与凭验证码重置密码：未登录即可调用
    'auth.requestCode': (p: any) => auth.requestCode(p || {}),
    'auth.resetPassword': (p: any) => auth.resetPassword(p || {}),

    'workbench.dashboard': () => guard(() => workbench.dashboard()),
    'workbench.timeline': (p: any) => guard(() => workbench.timeline(p || {})),
    'workbench.search': (q: any, options?: SearchOptions) => guard(() => workbench.searchAll(q, search, options || {})),
    'workbench.workspaces': () => guard(() => workbench.listWorkspaces()),
    'workbench.workspace.create': (p: any) => guard(() => workbench.createWorkspace(p || {})),
    'workbench.workspace.switch': (id: any) => guard(() => workbench.switchWorkspace(id)),
    'workbench.workspace.stats': () => guard(() => workbench.workspaceStats()),

    'workbench.project.list': () => guard(() => workbench.listProjects()),
    'workbench.project.create': (p: any) => guard(() => workbench.createProject(p || {})),
    'workbench.project.update': (id: any, p: any) => guard(() => workbench.updateProject(id, p || {})),
    'workbench.project.archive': (id: any) => guard(() => workbench.archiveProject(id)),
    'workbench.project.remove': (id: any) => guard(() => workbench.deleteProject(id)),
    'workbench.project.tasks': (id: any) => guard(() => workbench.projectTasks(id)),
    'workbench.project.assign': (pid: any, code: any) => guard(() => workbench.assignTask(pid, code)),
    'workbench.project.unassign': (code: any) => guard(() => workbench.unassignTask(code)),

    'task.groups': () => guard(() => tasks.list()),
    'task.list': () => guard(() => tasks.flat()),
    'task.detail': (id: any) => guard(() => tasks.get(id)),
    'task.seed': (groups: any) => guard(() => tasks.seed(groups || [])),
    'task.group.create': (p: any) => guard(() => tasks.createGroup(p || {})),
    'task.create': (p: any) => guard(() => tasks.createTask(p || {})),
    'task.update': (id: any, p: any) => guard(() => tasks.updateTask(id, p || {})),
    'task.complete': (id: any) => guard(() => tasks.completeTask(id)),
    'task.archive': (id: any) => guard(() => tasks.archiveTask(id)),
    'task.remove': (id: any) => guard(() => tasks.removeTask(id)),

    'tag.list': (code: any) => guard(() => workbench.listTags(code)),
    'tag.add': (code: any, p: any) => guard(() => workbench.addTag(code, p || {})),
    'tag.remove': (code: any, id: any) => guard(() => workbench.removeTag(code, id)),

    'workbench.file.list': () => guard(() => workbench.listFiles()),
    'workbench.file.add': (files: any) => guard(() => workbench.addFiles(files || [])),
    'workbench.file.remove': (id: any) => guard(() => workbench.removeFile(id)),

    'notification.list': () => guard(() => workbench.notifications()),
    'notification.unread': () => guard(() => workbench.unreadCount()),
    'notification.read': () => guard(() => workbench.markNotificationsRead()),

    'reminder.list': () => guard(() => reminders.list()),
    'reminder.create': (p: any) => guard(() => reminders.create(p || {})),
    'reminder.dismiss': (id: any) => guard(() => reminders.dismiss(id)),
    'reminder.remove': (id: any) => guard(() => reminders.remove(id)),

    'data.stats': () => guard(() => dataManager.statistics()),
    'data.export': () => guard(() => dataManager.exportData()),
    'data.import': (payload: any) => guard(() => dataManager.importData(payload || {})),
    'data.backups': () => guard(() => dataManager.listBackups()),
    'data.backup.create': (kind: any) => guard(() => dataManager.createBackup(kind || 'manual')),
    'data.backup.restore': (name: any) => guard(() => dataManager.restoreFromFile(name)),
    'data.backup.delete': (name: any) => guard(() => dataManager.deleteBackup(name)),
    'data.backup.history': () => guard(() => dataManager.history()),
    'data.settings.get': () => guard(() => dataManager.readSettings()),
    'data.settings.save': (p: any) => guard(() => dataManager.saveSettings(p || {})),

    // 接缝探针：只汇报「接没接上」，不做任何模型/设备调用，因此读接口放开给 REST 只读白名单。
    // 不加会话 guard（与下方 llm.* 一致，见 S1-02 A4 的核对结论）：问答页在未登录时也要据此
    // 判断「已配置 / 未配置」，加 guard 会让未登录用户永远看到「未配置」，与事实不符。
    'gateway.status': () => deps.llm?.status() ?? {
      configured: false, providerId: null, label: '', model: '', reason: '未装配 LLM 网关',
    },
    'perception.status': () => guard(() => ({
      ...(deps.camera?.status() ?? {
        available: false, providerId: null, label: '', reason: '未装配摄像头感知层',
      }),
      running: deps.camera?.isRunning() ?? false,
    })),

    // 开源资源汇（S2 扩展）：只读，不加会话 guard（与 llm.* 一致，属内核域）
    'resource.categories': () => deps.resources?.categories() ?? [],
    'resource.list': (p: any) => deps.resources?.list(p || {}) ?? [],
    'resource.get': (id: any) => deps.resources?.get(Number(id)) ?? null,

    // GitHub 每日榜单（S2 扩展）：只读缓存 + 手动刷新
    'githubRank.categories': () => deps.githubRank?.listCategories() ?? [],
    'githubRank.daily': (p: any) => deps.githubRank?.getDailyRank(p?.category) ?? { date: '', categories: [] },
    'githubRank.refresh': (p: any) => deps.githubRank?.refreshNow(p?.category) ?? { date: '', categories: [] },

    // 插件（ADR-005 D26 的预埋：插件方法统一进方法表，RPC/REST/MCP/桌面 IPC 自动获得，
    // 插件作者不手写协议层）。list/status 以只读后缀命名，因此被 REST 只读白名单覆盖；
    // enable/disable/reload 是写操作，reader 凭证会被拒。
    'plugin.list': () => guard(() => pluginRegistry.list()),
    'plugin.status': (id: any) => guard(() => {
      const status = pluginRegistry.status(String(id))
      if (!status) throw new Error(`插件不存在：${id}`)
      return status
    }),
    'plugin.enable': (id: any) => guard(() => pluginRegistry.enable(String(id))),
    'plugin.disable': (id: any) => guard(() => pluginRegistry.disable(String(id))),
    'plugin.reload': () => guard(() => reloadPluginSystem()),
    // 安装/卸载本轮只注册方法并返回可读的「未实现」，UI 不做安装入口（D27）
    'plugin.install': () => guard(() => {
      throw new Error('插件安装尚未实现：ADR-005 D27 本轮只交付骨架与内建插件，安装能力排在 S2')
    }),
    'plugin.remove': () => guard(() => {
      throw new Error('插件卸载尚未实现：内建插件不可卸载，第三方插件的安装/卸载一并排在 S2')
    }),

    // LLM 网关（S1-01）与 RAG 问答（S1-03）。
    //
    // 域归属：`llm_providers` 是内核域表、`services/gateway/` 是内核域服务，因此 llm.* 属**内核域能力**；
    // 之所以仍登记在这张方法表里，是因为它同时被 RPC/REST/IPC 三端派生、且 REST 的 reader 只读白名单
    // 只在此路由生效（`apiServer.ts` 的 READ_METHOD_SUFFIXES）——放这里一次就拿到四个出口与权限机制。
    //
    // 关于是否加会话 `guard`（S1-02 A4 的核对结论）：**特意不加，与同页的其它设置类方法保持一致**。
    // 既有设置类方法分两组：内核域的 `settings.get/update`（`webEntry.ts` 直接注册）与安全页的 `security.*`
    // / `audit.list` 均**不要求登录会话**（`AuthScreen` 明确提供「先浏览知识库（工作台需登录）」，
    // 知识库设置本就可在未登录时使用）；只有**工作台域**的 `data.settings.*` 要求 `guard`。
    // llm.* 与 answer 属内核域能力（模型配置 / 本地检索问答），归前者，故不加 guard 是**一致**的，
    // 而非「漏加」。安全边界由其它机制守住：REST 侧要求 API Key 且 reader 角色调写方法被拒（见下），
    // RPC 侧要求本地会话 token，IPC 侧只对可信渲染进程开放。
    'llm.providers': () => requireLlm().providers(),
    'llm.list': () => requireLlm().list(),
    'llm.save': (p: any) => requireLlm().save(p || {}),
    'llm.remove': (p: any) => requireLlm().remove(p || {}),
    'llm.test': (p: any) => requireLlm().test(p || {}),
    'llm.chat': (messages: any, options?: any) => requireLlm().chat({ messages: messages || [], ...(options || {}) }),
    'llm.stream': (messages: any, options?: any) => requireLlm().stream({ messages: messages || [], ...(options || {}) }),
    // 出域范围设置（写方法，reader 被拒）与最近出域记录（只读，末段 list 命中只读白名单）
    'llm.setEgress': (p: any) => requireLlm().setEgressScope(p || {}),
    'llm.logs': (p: any) => requireLlm().listEgressLogs(p || {}),
    // RAG 问答：混合检索 → 编号上下文 → LLM 流式 → 答案 + 可验证引用；
    // 未配置模型时返回 retrieval_only（不抛异常，带纯检索结果）。actor 区分人/机器，写进出域审计。
    'chat.ask': (p: any) => requireAnswer().ask({ ...(p || {}), actor: trusted ? 'api' : 'user' }),
  }
}

/** 声明式方法清单：前端两种运行模式据此生成一致的 window.sd 门面 */
export const WORKBENCH_RPC_METHODS: string[] = [
  'auth.status', 'auth.register', 'auth.login', 'auth.logout', 'auth.changePassword',
  'auth.requestCode', 'auth.resetPassword',
  'workbench.dashboard', 'workbench.timeline', 'workbench.search', 'workbench.workspaces',
  'workbench.workspace.create', 'workbench.workspace.switch', 'workbench.workspace.stats',
  'workbench.project.list', 'workbench.project.create', 'workbench.project.update',
  'workbench.project.archive', 'workbench.project.remove', 'workbench.project.tasks',
  'workbench.project.assign', 'workbench.project.unassign',
  'task.groups', 'task.list', 'task.detail', 'task.seed', 'task.group.create',
  'task.create', 'task.update', 'task.complete', 'task.archive', 'task.remove',
  'tag.list', 'tag.add', 'tag.remove',
  'workbench.file.list', 'workbench.file.add', 'workbench.file.remove',
  'notification.list', 'notification.unread', 'notification.read',
  'reminder.list', 'reminder.create', 'reminder.dismiss', 'reminder.remove',
  'data.stats', 'data.export', 'data.import', 'data.backups', 'data.backup.create',
  'data.backup.restore', 'data.backup.delete', 'data.backup.history',
  'data.settings.get', 'data.settings.save',
  'gateway.status', 'perception.status',
  // 插件骨架（ADR-005）：方法名即唯一真相源，四端出口由此自动生成
  'plugin.list', 'plugin.status', 'plugin.enable', 'plugin.disable', 'plugin.reload',
  'plugin.install', 'plugin.remove',
  // LLM 网关（S1-01）：list/providers 只读；save/remove/test/chat/stream 写方法
  'llm.providers', 'llm.list', 'llm.save', 'llm.remove', 'llm.test', 'llm.chat', 'llm.stream',
  // 出域范围与审计（S1-02）：logs 只读；setEgress 写方法
  'llm.setEgress', 'llm.logs',
  // RAG 问答（S1-03）
  'chat.ask',
  // 开源资源汇（S2 扩展）
  'resource.categories', 'resource.list', 'resource.get',
  // GitHub 每日榜单（S2 扩展）
  'githubRank.categories', 'githubRank.daily', 'githubRank.refresh',
]
