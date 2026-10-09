/**
 * 摄像头感知层的共享类型（ADR-003 决策 5：本阶段只定接口不实现）。
 *
 * 拆成「帧」与「事件」两层是有意的：
 * - PerceptionFrame 是原始画面，体积大、生命周期短，只用于当下的推理；
 * - PerceptionEvent 是识别结论，体积小、可入库，适合和任务/通知放在一条时间线上。
 *
 * 将来摄像头接进来后，「看到人离开工位 → 自动记录一次中断」这类规则
 * 只需订阅事件流，不需要碰采集细节。
 */

export type CameraSource = 'webcam' | 'file' | 'rtsp'

export interface PerceptionFrame {
  id: string
  capturedAt: string
  width: number
  height: number
  source: CameraSource
  /** Base64 编码的 JPEG；未采集到画面时为 null */
  data: string | null
}

export type PerceptionEventType = 'presence' | 'face' | 'gesture' | 'motion' | 'custom'

export interface PerceptionEvent {
  type: PerceptionEventType
  at: string
  /** 置信度 0~1 */
  confidence: number
  /** 识别细节，结构随 type 变化（如 presence 带 present: true） */
  payload: Record<string, unknown>
}

export interface CameraProvider {
  readonly id: string
  readonly label: string
  available(): boolean
  start(): Promise<void>
  stop(): Promise<void>
  capture(): Promise<PerceptionFrame>
  /** 订阅感知事件，返回取消订阅函数 */
  onEvent?(listener: (event: PerceptionEvent) => void): () => void
}

export interface PerceptionStatus {
  available: boolean
  providerId: string | null
  label: string
  reason: string
}
