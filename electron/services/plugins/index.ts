/**
 * 插件子系统出口（ADR-005）。
 *
 * 装配顺序：宿主服务（ProcessingEngine）构造时调用 `initPluginSystem` → 建受限宿主 API →
 * 建装载器 → 扫描 `<Data>/plugins` → 内建插件由 ProcessingEngine 直接注册到 `pluginRegistry`。
 *
 * 之所以用进程内单例：本产品是单进程本地应用，`pluginRegistry` 被 ProcessingEngine、FileService
 * 与 RPC 方法表（plugin.list / plugin.status / …）同时读写，多实例会让「设置页停用解析器」
 * 与「解析时的分发」看到不同的注册表。
 */
import { PluginHost, PluginHostOptions } from './host'
import { PluginLoadReport, PluginLoader } from './loader'
import { pluginRegistry } from './registry'

export * from './types'
export { PluginHost } from './host'
export { PluginLoader } from './loader'
export type { PluginLoadReport, PluginLoadRejection } from './loader'
export { PluginRegistry, pluginRegistry } from './registry'
export type { ParserResolution, PluginRegisterInput } from './registry'

let loader: PluginLoader | null = null

/** 初始化（可重复调用：重复调用等价于重新扫描，内建插件不受影响） */
export function initPluginSystem(opts: PluginHostOptions): PluginLoadReport {
  const host = new PluginHost(opts)
  loader = new PluginLoader(pluginRegistry, { dataDir: opts.dataDir, host })
  return loader.loadAll()
}

/** 重新扫描本地插件；尚未初始化时抛可读错误（`plugin.reload` 直接把它透给调用方） */
export function reloadPluginSystem(): PluginLoadReport {
  if (!loader) throw new Error('插件系统尚未初始化：宿主服务未启动，无法扫描 <Data>/plugins')
  return loader.reload()
}
