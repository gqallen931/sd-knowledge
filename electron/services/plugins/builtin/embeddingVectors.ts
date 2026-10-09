/**
 * transformers.js `feature-extraction` 输出 → 逐条向量。
 *
 * 从 `processingEngine.ts` 原样搬出（内建嵌入插件解码输出时使用），
 * `processingEngine` 仍以同名再导出，`tests/integration.cjs` 的既有断言不受影响。
 */

/**
 * 把 transformers.js feature-extraction 的输出拆成逐条向量。
 *
 * 单条输入返回 dims=[dim]，批量输入返回 dims=[batch, dim]（data 为扁平 Float32Array）。
 * 批量推理不被支持时（返回 1 维 dims）返回空数组，由调用方回退为逐条推理。
 */
export function toEmbeddingVectors(output: any, expected: number): Float32Array[] {
  const raw = output?.data
  if (!raw || !raw.length) return []
  const data: Float32Array = raw instanceof Float32Array ? raw : Float32Array.from(raw)
  const dims = Array.isArray(output?.dims) ? (output.dims as number[]) : []
  const batchDims = expected > 1 && dims.length >= 2
  const tail = dims.length ? dims[dims.length - 1] : 0

  let dim = 0
  if (expected > 1) {
    if (!batchDims) return []
    dim = tail
  } else {
    dim = dims.length >= 2 ? tail : data.length
  }
  if (!Number.isFinite(dim) || dim <= 0 || data.length % dim !== 0) return []

  const vectors: Float32Array[] = []
  for (let i = 0; i + dim <= data.length; i += dim) {
    vectors.push(new Float32Array(data.subarray(i, i + dim)))
  }
  return vectors
}
