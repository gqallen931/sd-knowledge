/**
 * 内建嵌入模型插件（ADR-005 S1 项、本轮一并交付）。
 *
 * 把改造前写死在 `processingEngine` 里的 transformers.js `feature-extraction` 路径
 * （默认 `Xenova/bge-small-zh-v1.5`）包装成 `EmbeddingPlugin`：
 * - 插件 `id` 就是写入 `vectors.model` 的值（宿主据此分片、拒绝跨模型混算）；
 * - 量化、single-flight 加载、错误文案与改造前一致；
 * - 批量推理不可用时返回空数组（`toEmbeddingVectors` 的既有语义），由宿主回退逐条推理。
 */
import { EmbeddingDescriptor, EmbeddingPlugin, PluginManifest } from '../types'
import { toEmbeddingVectors } from './embeddingVectors'
import { builtinEmbeddingManifest } from './manifests'
import { applyModelEnv, applyOnnxThreadOptions, importModule } from './transformersEnv'

export interface BuiltinEmbeddingSpec {
  /** 必须与 vectors.model 写入值一致 */
  id: string
  /** 设置页显示名（与原硬编码下拉项文案保持一致） */
  name: string
  dimension: number
  descriptor: EmbeddingDescriptor
  description: string
}

/**
 * 内建嵌入模型清单。
 *
 * 与改造前 `Settings.tsx` 硬编码的 4 个下拉选项一一对应（**保留全部选项，不删项**）；
 * 非默认的 3 个是「备选模型」：可用，但未随默认路径实测，故在 `descriptor.note` 里标注，
 * 由设置页如实展示（而不是假装它们都被验证过）。
 */
export const BUILTIN_EMBEDDING_SPECS: BuiltinEmbeddingSpec[] = [
  {
    id: 'Xenova/bge-small-zh-v1.5',
    name: 'BGE-small-zh（中文，推荐）',
    dimension: 512,
    descriptor: { quantized: true, source: 'transformers.js · HuggingFace Hub' },
    description: '默认中文嵌入模型（量化 ONNX，本地推理）',
  },
  {
    id: 'Xenova/bge-base-zh-v1.5',
    name: 'BGE-base-zh（中文，更大）',
    dimension: 768,
    descriptor: { quantized: true, source: 'transformers.js · HuggingFace Hub', note: '备选模型：体积与耗时约为 small 的数倍，未随默认路径实测' },
    description: '中文备选嵌入模型（更大、更慢）',
  },
  {
    id: 'Xenova/all-MiniLM-L6-v2',
    name: 'MiniLM-L6（英文，轻量）',
    dimension: 384,
    descriptor: { quantized: true, source: 'transformers.js · HuggingFace Hub', note: '备选模型：英文语料为主，中文效果未实测' },
    description: '英文轻量嵌入模型',
  },
  {
    id: 'Xenova/multilingual-e5-small',
    name: 'Multilingual-E5-small（多语言）',
    dimension: 384,
    descriptor: { quantized: true, source: 'transformers.js · HuggingFace Hub', note: '备选模型：多语言，未随默认路径实测' },
    description: '多语言备选嵌入模型',
  },
]

/** 模型下载白名单：net 为 true 时必须声明，宿主拒绝对未声明地址发起请求（M 的补充约束） */
const MODEL_HOSTS = ['https://huggingface.co', 'https://hf-mirror.com']

let pipelineFn: any = null
let loadedModel = ''
/**
 * 加载中的模型句柄：并发调用共享同一个 Promise。
 *
 * 解析队列默认并发度为 2，若两个文档同时冷启动，二者都会看到缓存为空并各自 `pipeline()` 一次，
 * 实测其中一个会退化到约 30s。这里做 single-flight，保证同一模型名同时只加载一次（与改造前一致）。
 */
let loading: { name: string; promise: Promise<any> } | null = null

async function getEmbeddingPipeline(modelName: string): Promise<any> {
  if (pipelineFn && loadedModel === modelName) return pipelineFn
  if (loading && loading.name === modelName) return loading.promise
  const promise = (async () => {
    const { pipeline, env } = await importModule('@xenova/transformers')
    applyModelEnv(env)
    await applyOnnxThreadOptions()
    pipelineFn = await pipeline('feature-extraction', modelName, { quantized: true })
    loadedModel = modelName
    return pipelineFn
  })()
  loading = { name: modelName, promise }
  try {
    return await promise
  } catch (e) {
    console.error('Failed to load embedding model:', e)
    throw new Error('语义模型加载失败，请检查网络或本地模型缓存后重试')
  } finally {
    if (loading?.promise === promise) loading = null
  }
}

/** 一次前向推理：单条与批量走不同入参形态（与改造前 embedOne / 批推理的调用方式逐字一致） */
async function runEmbedding(modelId: string, texts: string[]): Promise<Float32Array[]> {
  if (!texts.length) return []
  const pipeline = await getEmbeddingPipeline(modelId)
  const output = texts.length > 1
    ? await pipeline(texts, { pooling: 'mean', normalize: true })
    : await pipeline(texts[0], { pooling: 'mean', normalize: true })
  return toEmbeddingVectors(output, texts.length)
}

/** 由规格构造一个内建嵌入插件（宿主只依赖 EmbeddingPlugin 接口，不认「哪个是内建」） */
export function createEmbeddingPlugin(spec: BuiltinEmbeddingSpec): EmbeddingPlugin {
  return {
    kind: 'embedding',
    id: spec.id,
    dimension: spec.dimension,
    descriptor: spec.descriptor,
    async ensureReady(): Promise<void> {
      await getEmbeddingPipeline(spec.id)
    },
    embed: (texts: string[]) => runEmbedding(spec.id, texts),
  }
}

/**
 * 未登记模型名的临时适配器（宿主兼容历史设置值用）。
 *
 * 行为与改造前「按设置里的模型名直接加载」完全一致：同一 single-flight 加载、同一量化、
 * 同一批推理与回退路径；它不会被注册进注册表，因此不会出现在设置页可选清单里。
 */
export function createAdHocEmbedding(modelId: string): Pick<EmbeddingPlugin, 'embed' | 'ensureReady'> {
  return {
    ensureReady: () => getEmbeddingPipeline(modelId).then(() => undefined),
    embed: (texts: string[]) => runEmbedding(modelId, texts),
  }
}

export interface BuiltinEmbeddingRegistration {
  manifest: PluginManifest
  plugin: EmbeddingPlugin
}

export function buildBuiltinEmbeddings(): BuiltinEmbeddingRegistration[] {
  return BUILTIN_EMBEDDING_SPECS.map(spec => ({
    manifest: builtinEmbeddingManifest({
      id: spec.id,
      name: spec.name,
      dimension: spec.dimension,
      description: spec.description,
      modelDownload: MODEL_HOSTS,
      descriptor: spec.descriptor,
    }),
    plugin: createEmbeddingPlugin(spec),
  }))
}
