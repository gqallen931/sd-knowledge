/**
 * 受限宿主 API（ADR-005 §4.4）。
 *
 * **本文件是"能力不发放"这条约束的落点，请勿在这里加 fs / net / child_process 之类的能力。**
 *
 * 当前只暴露三样东西：
 * 1. `getSettings()`——只读设置快照（返回副本，插件改不到宿主状态）；
 * 2. `log(level, message)`——带插件前缀的日志；
 * 3. `scheduleWorker(task)`——worker 调度**占位**，本轮直接抛可读错误（D24：不引入插件进程隔离）。
 *
 * 为什么"只暴露这么点"就够：ADR-005 D23 的强制手段是「声明 + 校验 + 在设置页展示」——
 * manifest 里的 `permissions` 只用来**判断插件能不能被装载**（见 loader.ts 的 validateManifest）
 * 与**告诉了用户什么**（设置页「扩展」卡片展示声明的权限），宿主并不因此发放对应能力。
 * 也就是说：即便插件声明了 `fsRead: true`，它拿到的也只是这份受限 API——真正的沙箱
 * （进程隔离、能力注入）在 S3 评估，不在这批交付里。
 */
export interface PluginHostApi {
  /** 只读设置快照（每次调用返回新副本） */
  getSettings(): Readonly<Record<string, string>>
  /** 日志：宿主自动加 `[plugin:<id>]` 前缀，插件无法伪造宿主身份 */
  log(level: 'info' | 'warn' | 'error', message: string): void
  /** worker 调度占位：本轮未实现，调用即抛可读错误 */
  scheduleWorker(task: { pluginId?: string; payload?: unknown }): Promise<never>
}

export interface PluginHostOptions {
  dataDir: string
  /** 设置读取器（宿主注入，通常是 db.getSettingsSync） */
  getSettings: () => Record<string, string>
  /** 日志出口（默认 console） */
  log?: (level: 'info' | 'warn' | 'error', message: string) => void
}

export class PluginHost {
  /** 交给插件的受限 API；仅此一个出口 */
  readonly api: PluginHostApi

  constructor(private opts: PluginHostOptions) {
    const sink = opts.log || ((level: 'info' | 'warn' | 'error', message: string) => {
      const line = `[plugin] ${message}`
      if (level === 'error') console.error(line)
      else if (level === 'warn') console.warn(line)
      else console.log(line)
    })
    const settingsReader = opts.getSettings
    this.api = {
      getSettings: () => ({ ...settingsReader() }),
      log: (level, message) => sink(level, String(message)),
      scheduleWorker: async () => {
        throw new Error('插件 worker 调度尚未实现（ADR-005 D24：本轮复用宿主队列，不引入插件进程隔离）')
      },
    }
  }
}
