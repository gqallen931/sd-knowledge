/**
 * transformers.js 运行环境与 ONNX 线程设置。
 *
 * 从 `processingEngine.ts` 抽出，原因是内建插件（嵌入模型、音视频解析）需要独立加载模型，
 * 若把这段留在 processingEngine 里会形成 `plugins → processingEngine → plugins` 的循环依赖。
 * 逻辑与抽出前逐行一致，`processingEngine` 仍以同名再导出，外部引用不受影响。
 */

/** 动态 import：绕开 CommonJS 编译产物对 ESM-only 包的限制 */
export const importModule = new Function('specifier', 'return import(specifier)') as (s: string) => Promise<any>

/**
 * 统一 transformers.js 的模型加载环境。
 * 默认从 Hugging Face Hub 拉取；当 huggingface.co 不可达时，可用 HF_ENDPOINT 指向镜像
 * （例如 https://hf-mirror.com/）。模型会缓存在包内 .cache 目录，命中缓存后不再联网。
 */
export function applyModelEnv(env: any): void {
  env.allowRemoteModels = true
  env.allowLocalModels = true
  const endpoint = process.env.HF_ENDPOINT
  if (endpoint) {
    env.remoteHost = endpoint.endsWith('/') ? endpoint : `${endpoint}/`
  }
}

/**
 * ONNX Runtime intra-op 线程数。0 表示不干预，沿用 ORT 默认（物理核数）。
 * 取值由 microbenchmark（tests/perf-thread-bench.cjs）实测决定，见 docs/bugs/perf-benchmark-noise-and-deferred-tuning.md。
 */
export const DEFAULT_ONNX_THREADS = 0

export function clampInt(raw: unknown, fallback: number, min: number, max: number): number {
  const n = parseInt(String(raw ?? ''), 10)
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, Math.floor(n)))
}

/**
 * 给 ONNX session 注入 `intraOpNumThreads`。
 *
 * 为什么要绕：`@xenova/transformers@2.17.2` 的 `constructSession`（src/models.js:126）把 session options
 * 写死成 `{ executionProviders }`，没有公开入口透传线程数。但 ORT 层本身支持
 * （`onnxruntime-common` 的 `SessionOptions`），且 `onnxruntime-node` 的原生后端把整个 options
 * 原样交给绑定、不做过滤——所以卡点只在 transformers.js 那一层。
 *
 * 做法：`InferenceSession` 是 onnxruntime-node 导出的类，transformers.js 只持有一份引用，
 * 在其上包一层静态 `create` 即可注入，无需改动 node_modules。幂等，进程内只包一次。
 */
let onnxThreadsPatched = false

export async function applyOnnxThreadOptions(): Promise<void> {
  if (onnxThreadsPatched) return
  const threads = clampInt(process.env.ONNX_NUM_THREADS, DEFAULT_ONNX_THREADS, 0, 64)
  if (threads < 1) return
  try {
    const mod: any = await importModule('onnxruntime-node')
    const session: any = mod?.InferenceSession ?? mod?.default?.InferenceSession
    if (!session || typeof session.create !== 'function') return
    const originalCreate = session.create.bind(session)
    session.create = (buffer: any, options: any = {}) =>
      originalCreate(buffer, { ...options, intraOpNumThreads: threads })
    onnxThreadsPatched = true
  } catch {
    // 浏览器形态没有 onnxruntime-node：静默跳过
  }
}
