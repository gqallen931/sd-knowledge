/**
 * 图上的社区检测（ADR-007）：确定性加权标签传播（Label Propagation）。
 *
 * 为什么不用 Louvain：Louvain 的收益在多分辨率与模块度优化，但实现复杂、结果对节点遍历顺序
 * 敏感，还需要额外处理 AGM 式的空社区。标签传播在这个规模（个人库通常 10^3～10^4 实体）
 * 上一轮迭代就是 O(E)，且**只要遍历顺序固定、平局规则固定，结果就完全可复现**——
 * 对「可解释、可重算」优先的个人知识库，确定性比模块度多几个百分点更重要。
 *
 * 两条刻意的工程约束：
 * 1. 只有**孤立点**（度数为 0）保持自身标签，其余节点都参与更新。早期版本把「度数 < 2」也排除在外，
 *    结果是任何树状或链状子图都会被切成碎片（两个互连实体的叶子各自成社），社区检测形同虚设；
 * 2. 迭代结束后做一次标签链压缩：LPA 的标签是「节点 id 的指针」，指针本身可能已经改了标签，
 *    不压缩会出现「社区标签指向别的社区」的悬挂。
 */

export interface CommunityEdge {
  source: number
  target: number
  /** 边权；缺省按 1 计（共现计数可直接作为权重） */
  weight?: number
}

export interface DetectedCommunity {
  /** 社区 id：取社区内最小实体 id，保证同输入同输出 */
  id: number
  members: number[]
  /** 社区内部边权之和 */
  weight: number
  /** 内聚度 = 内部边权 / 社区成员关联的全部边权，落在 (0, 1] */
  cohesion: number
}

export interface CommunityDetectionResult {
  communities: DetectedCommunity[]
  /** 实体 → 社区 id；孤立体也会得到 size=1 的自身社区（不在 communities 列表里） */
  assignment: Map<number, number>
}

export interface CommunityDetectOptions {
  maxRounds?: number
  /** 小于该规模的社区不进入结果（默认 2） */
  minSize?: number
}

const DEFAULT_MAX_ROUNDS = 10
const DEFAULT_MIN_SIZE = 2
const EPSILON = 1e-9

export function detectCommunities(
  nodes: number[],
  edges: CommunityEdge[],
  options: CommunityDetectOptions = {},
): CommunityDetectionResult {
  const maxRounds = options.maxRounds ?? DEFAULT_MAX_ROUNDS
  const minSize = options.minSize ?? DEFAULT_MIN_SIZE

  const adjacency = new Map<number, Map<number, number>>()
  const touch = (id: number): Map<number, number> => {
    let neighbors = adjacency.get(id)
    if (!neighbors) { neighbors = new Map(); adjacency.set(id, neighbors) }
    return neighbors
  }
  for (const node of nodes) touch(node)
  for (const edge of edges) {
    if (!Number.isFinite(edge.source) || !Number.isFinite(edge.target)) continue
    if (edge.source === edge.target) continue
    const weight = edge.weight && edge.weight > 0 ? edge.weight : 1
    const from = touch(edge.source)
    const to = touch(edge.target)
    from.set(edge.target, (from.get(edge.target) ?? 0) + weight)
    to.set(edge.source, (to.get(edge.source) ?? 0) + weight)
  }

  const ids = Array.from(adjacency.keys()).sort((a, b) => a - b)
  const label = new Map<number, number>()
  for (const id of ids) label.set(id, id)

  for (let round = 0; round < maxRounds; round++) {
    let changed = false
    for (const id of ids) {
      const neighbors = adjacency.get(id)
      if (!neighbors || neighbors.size === 0) continue
      const support = new Map<number, number>()
      for (const [neighbor, weight] of neighbors) {
        const community = label.get(neighbor) ?? neighbor
        support.set(community, (support.get(community) ?? 0) + weight)
      }
      let bestLabel = label.get(id) as number
      let bestWeight = -Infinity
      for (const [community, weight] of support) {
        if (weight > bestWeight + EPSILON) { bestLabel = community; bestWeight = weight }
        else if (Math.abs(weight - bestWeight) <= EPSILON && community < bestLabel) { bestLabel = community }
      }
      if (bestLabel !== label.get(id)) { label.set(id, bestLabel); changed = true }
    }
    if (!changed) break
  }

  // 标签链压缩：把「指向已改标签的指针」拉直到最终代表节点
  for (let guard = 0; guard <= ids.length; guard++) {
    let changed = false
    for (const id of ids) {
      const current = label.get(id) as number
      const next = label.get(current) ?? current
      if (next !== current) { label.set(id, next); changed = true }
    }
    if (!changed) break
  }

  const groups = new Map<number, number[]>()
  for (const id of ids) {
    const community = label.get(id) as number
    const members = groups.get(community)
    if (members) members.push(id)
    else groups.set(community, [id])
  }

  const assignment = new Map<number, number>()
  const communities: DetectedCommunity[] = []
  for (const members of groups.values()) {
    members.sort((a, b) => a - b)
    const id = members[0]
    for (const member of members) assignment.set(member, id)
    if (members.length < minSize) continue
    communities.push({ id, members, weight: 0, cohesion: 0 })
  }

  const byId = new Map(communities.map((community) => [community.id, community]))
  const totalWeight = new Map<number, number>()
  for (const edge of edges) {
    if (edge.source === edge.target) continue
    const weight = edge.weight && edge.weight > 0 ? edge.weight : 1
    const sourceCommunity = assignment.get(edge.source)
    const targetCommunity = assignment.get(edge.target)
    if (sourceCommunity === undefined || targetCommunity === undefined) continue
    totalWeight.set(sourceCommunity, (totalWeight.get(sourceCommunity) ?? 0) + weight)
    if (targetCommunity !== sourceCommunity) {
      totalWeight.set(targetCommunity, (totalWeight.get(targetCommunity) ?? 0) + weight)
    } else {
      const community = byId.get(sourceCommunity)
      if (community) community.weight += weight
    }
  }
  for (const community of communities) {
    const total = totalWeight.get(community.id) ?? 0
    community.cohesion = total > 0 ? Number((community.weight / total).toFixed(4)) : 0
  }

  communities.sort((a, b) => b.members.length - a.members.length || a.id - b.id)
  return { communities, assignment }
}
