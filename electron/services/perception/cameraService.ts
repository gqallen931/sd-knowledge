import { CameraProvider, PerceptionEvent, PerceptionFrame, PerceptionStatus } from './types'

/** 没有可用摄像头时抛出，code 供 IPC / REST / MCP 出口稳定翻译 */
export class CameraUnavailableError extends Error {
  readonly code = 'CAMERA_UNAVAILABLE'

  constructor(reason = '尚未接入摄像头') {
    super(reason)
    this.name = 'CameraUnavailableError'
  }
}

/**
 * 摄像头感知层（ADR-003 决策 5）。
 *
 * 与 LlmGateway 同构：这里只做 provider 注册表 + 可用性探针，不含任何采集实现。
 * 运行期状态（是否在采集、最近一帧）都不落库——感知是瞬时的，
 * 值得留存的是事件，而事件由调用方决定是否写进时间线。
 */
export class CameraService {
  private provider: CameraProvider | null = null
  private listeners = new Set<(event: PerceptionEvent) => void>()
  private unsubscribe: (() => void) | null = null
  private running = false

  register(provider: CameraProvider | null): void {
    this.detach()
    this.provider = provider
  }

  current(): CameraProvider | null {
    return this.provider
  }

  status(): PerceptionStatus {
    if (!this.provider) {
      return { available: false, providerId: null, label: '', reason: '尚未注册任何 CameraProvider' }
    }
    const available = this.provider.available()
    return {
      available,
      providerId: this.provider.id,
      label: this.provider.label,
      reason: available ? '' : `${this.provider.label} 当前不可用（设备未连接或未授权）`,
    }
  }

  isRunning(): boolean {
    return this.running
  }

  async start(): Promise<void> {
    const provider = this.requireProvider()
    if (this.running) return
    await provider.start()
    this.running = true
    this.attach()
  }

  async stop(): Promise<void> {
    if (!this.provider || !this.running) return
    this.detach()
    await this.provider.stop()
    this.running = false
  }

  async capture(): Promise<PerceptionFrame> {
    const provider = this.requireProvider()
    return provider.capture()
  }

  /** 订阅感知事件；provider 未实现事件流时静默忽略（记下即可，不阻断） */
  onEvent(listener: (event: PerceptionEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private attach(): void {
    if (!this.provider?.onEvent) return
    this.unsubscribe = this.provider.onEvent((event) => {
      this.listeners.forEach((listener) => listener(event))
    })
  }

  private detach(): void {
    this.unsubscribe?.()
    this.unsubscribe = null
  }

  private requireProvider(): CameraProvider {
    if (!this.provider) throw new CameraUnavailableError('尚未接入摄像头：请先注册一个 CameraProvider')
    if (!this.provider.available()) throw new CameraUnavailableError(this.status().reason)
    return this.provider
  }
}
