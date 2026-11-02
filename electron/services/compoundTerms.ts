/**
 * 复合词归并与中心词判定（ADR-007 的精度补丁）。
 *
 * 背景：分词器会把「向量索引」切成「向量 + 索引」。这两个碎片各自成为 concept 实体后，
 * 语义边就很容易落在修饰语上（`检索 → 向量`），而真正的中心语（`索引`）被丢掉。
 *
 * 口径（与 ADR-007「宁可漏，不可错」一致）：
 * - 只在**能判定中心词**时才合并：合并结果必须以中心词结尾，否则不合并（`快速 + 运行` 不成词）。
 * - 只合并**正文里真的紧邻**的关键词（中间隔着「的 / 与 / 是」或空格就不算），不做任何远端联想。
 * - 中英文方向不同：中文中心词在右（`向量索引 → 索引`），英文中心词也在末尾（`vector index → index`），
 *   但这里的「在右」指语法中心语，修饰语恒在其左。
 * - 纯函数、无模型、无状态：同样的关键词与正文必然得到同样的合并结果。
 */

/**
 * 中心词表（中文，按后缀匹配）。
 *
 * 只收「能当名词短语中心语」的词：`索引 / 模型 / 引擎 / 服务` 这类。
 * 刻意不收「依赖 / 生成 / 使用」这类谓词——它们由 `predicateRules` 的触发词表管辖，
 * 归并阶段必须绕开，否则会把谓词吃进实体名里（ADR-007 里真实踩过的坑）。
 */
export const HEAD_NOUNS: readonly string[] = [
  // 软件与系统
  '索引', '模型', '引擎', '系统', '服务', '数据库', '接口', '框架', '算法', '组件',
  '模块', '插件', '进程', '线程', '集群', '网关', '协议', '通道', '管道', '容器',
  '缓存', '队列', '事务', '迁移', '配置', '脚本', '函数', '变量', '参数', '字段',
  // 文档与检索
  '文档', '文件', '目录', '路径', '块', '向量', '检索', '排序', '图谱', '视图',
  '表格', '日志', '报告', '看板', '面板', '页面', '词表', '召回', '精度',
  // 组织与流程
  '任务', '流程', '规则', '策略', '方案', '方法', '工具', '指标', '权限', '角色',
  '账户', '测试', '平台', '中心', '能力', '机制', '结构', '门槛', '阈值', '权重',
  '需求', '目标', '场景', '计划', '标准', '规范', '约束', '边界', '结论', '原因',
  // 英文（同样按「末尾是中心语」处理）
  'index', 'model', 'engine', 'system', 'service', 'database', 'api', 'framework',
  'algorithm', 'document', 'file', 'task', 'pipeline', 'module', 'plugin', 'cache',
  'queue', 'schema', 'table', 'graph', 'vector', 'server', 'client', 'gateway',
  'cluster', 'token', 'chunk', 'retriever', 'store', 'layer', 'worker',
]

const HEAD_SET = new Set(HEAD_NOUNS)

export interface CompoundTerm {
  /** 合并后的词面（取自正文原文，保留原始大小写与空格） */
  name: string
  /** 中心词（判定依据） */
  head: string
  /** 修饰语（中心词左侧的碎片） */
  modifiers: string[]
  /** 在正文中的出现次数 */
  count: number
}

export interface CompoundOptions {
  /** 合并结果在正文里至少出现几次才算数，默认 2（与关键词实体化同门槛） */
  minOccurrences?: number
  /** 合并结果的最大长度（字符），默认 16 */
  maxLength?: number
  /** 最多合并几个碎片，默认 3（`向量 + 检索 + 引擎`） */
  maxParts?: number
  /** 每个碎片的最小长度，默认 2 */
  minPartLength?: number
  /** 最多返回多少条，默认 8 */
  limit?: number
  /** 停用词 / 谓词触发词判定：命中即不参与合并 */
  isBlocked?: (term: string) => boolean
}

const isAscii = (s: string) => /^[\x20-\x7E]+$/.test(s)

/**
 * 判定中心词。
 *
 * 中文：取「最长且在表内」的后缀，且必须是**真后缀**（整词等于中心词时返回 ''，
 * 因为那已经不是复合词了）。英文：取最后一个词（`vector index` → `index`）。
 */
export function headWord(term: string): string {
  const t = String(term || '').trim()
  if (!t) return ''
  if (isAscii(t)) {
    const parts = t.split(/[\s\-_./]+/).filter(Boolean)
    const last = parts.length > 1 ? parts[parts.length - 1] : ''
    return last.toLowerCase()
  }
  let best = ''
  for (const head of HEAD_NOUNS) {
    if (t.length > head.length && t.endsWith(head) && head.length > best.length) best = head
  }
  return best
}

/** 该词本身是不是中心词（词表精确命中，英文忽略大小写） */
export function isHeadNoun(term: string): boolean {
  const t = String(term || '').trim()
  if (!t) return false
  return HEAD_SET.has(t) || HEAD_SET.has(t.toLowerCase())
}

/** 统计 needle 在 text 中的出现位置（最多 cap 个，避免长文里退化成全量扫描） */
function occurrences(text: string, needle: string, cap = 200): number[] {
  const out: number[] = []
  if (!needle) return out
  let from = 0
  while (out.length < cap) {
    const at = text.indexOf(needle, from)
    if (at < 0) break
    out.push(at)
    from = at + needle.length
  }
  return out
}

/**
 * 从关键词里长出复合词。
 *
 * 只沿「正文中紧邻的关键词」向右延伸，每延伸一步就检查当前末位是不是中心词：
 * 是则记一条候选（`向量+索引` → `向量索引`），但仍继续延伸（`索引+模型` → `向量索引模型`），
 * 让更长的词面在实体定位时天然胜出。
 */
export function buildCompoundTerms(
  terms: string[],
  text: string,
  options: CompoundOptions = {},
): CompoundTerm[] {
  const minOccurrences = Math.max(1, options.minOccurrences ?? 2)
  const maxLength = Math.max(4, options.maxLength ?? 16)
  const maxParts = Math.max(2, options.maxParts ?? 3)
  const minPartLength = Math.max(1, options.minPartLength ?? 2)
  const limit = Math.max(1, options.limit ?? 8)
  const blocked = options.isBlocked || (() => false)
  if (!text || !Array.isArray(terms) || terms.length < 2) return []

  // 碎片集：去重、按长度降序（同一位置优先吃更长的词，避免「索引」把「索引模型」的前缀占掉）
  const parts: string[] = Array.from(new Set(
    terms
      .map(t => String(t || '').trim())
      .filter(t => t.length >= minPartLength && t.length <= maxLength && !/^[\d\s.\-/:年月日]+$/.test(t)),
  )).sort((a, b) => b.length - a.length)

  const byFirstChar = new Map<string, string[]>()
  for (const part of parts) {
    const key = part[0].toLowerCase()
    const bucket = byFirstChar.get(key)
    if (bucket) bucket.push(part)
    else byFirstChar.set(key, [part])
  }

  const nextAt = (idx: number): { part: string; at: number } | null => {
    if (idx >= text.length) return null
    // 英文复合词之间允许**一个**空格（`vector index`）。必须先跳过空白再查首字母桶：
    // 早先的写法是「先按 text[idx] 查桶、查不到才试 idx+1」，而空格永远查不到桶，
    // 于是这条分支从未被执行过，英文复合词一条也合不出来。
    let at = idx
    while (at < text.length && (text[at] === ' ' || text[at] === '\t')) at++
    if (at >= text.length) return null
    if (at - idx > 1) return null
    const bucket = byFirstChar.get(text[at].toLowerCase())
    if (!bucket) return null
    for (const part of bucket) {
      if (text.startsWith(part, at)) return { part, at }
    }
    return null
  }

  const candidates = new Map<string, CompoundTerm>()
  for (const first of parts) {
    if (blocked(first)) continue
    for (const start of occurrences(text, first)) {
      let end = start + first.length
      const chain: string[] = [first]
      for (let depth = 1; depth < maxParts; depth++) {
        const hit = nextAt(end)
        if (!hit || blocked(hit.part)) break
        chain.push(hit.part)
        end = hit.at + hit.part.length
        const tail = chain[chain.length - 1]
        if (!isHeadNoun(tail)) continue
        const name = text.slice(start, end).replace(/\s+/g, ' ').trim()
        if (name.length > maxLength || name.length <= chain[0].length) continue
        const existing = candidates.get(name)
        if (existing) {
          existing.count += 1
          continue
        }
        candidates.set(name, {
          name,
          head: headWord(name) || tail,
          modifiers: chain.slice(0, -1),
          count: 1,
        })
      }
    }
  }

  // 出现次数以「合并词面在正文里的真实出现次数」为准：上面按起点计的是上限，这里做一次校正
  const result: CompoundTerm[] = []
  for (const cand of candidates.values()) {
    const count = occurrences(text, cand.name, 200).length
    if (count < minOccurrences) continue
    result.push({ ...cand, count })
  }

  return result
    .sort((a, b) => b.count - a.count || b.name.length - a.name.length || a.name.localeCompare(b.name))
    .slice(0, limit)
}
