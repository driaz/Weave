// Pure generation core. Takes the rows the I/O shell read and returns the
// snapshot row fields plus generation_metadata. No I/O, no clock: generatedAt
// is an input.

import { CLUSTER_SIMILARITY_THRESHOLD, PIPELINE_VERSION, TOP_EVENTS_PER_ANCHOR, ratifiedParameters, type RunOptions } from './constants'
import { agglomerativeClustering, nodesFromEmbeddingRows } from './clustering'
import { attentionFor, turnsFor } from './attention'
import {
  attribute,
  buildWeightMap,
  compositeKey,
  fromVoiceSession,
  fromWeaveEvent,
  pairAsymmetry,
  resolveEdgeTarget,
  resolveEvents,
} from './engagement'
import type { ReadGate } from './reads'
import type {
  AnchorProvenance,
  AttributeResult,
  BoardName,
  ClusterObj,
  Conversation,
  ConversationPlacement,
  EmbeddingRow,
  EngagementClass,
  NodeEntry,
  UnclusteredAttended,
  VoiceSessionRow,
  WeaveEventRow,
} from './types'

export type NodeSetSpec =
  | { source: 'live' }
  | { source: `pinned:${string}`; keys: string[] }

export type GenerationInput = {
  generatedAt: Date
  options: RunOptions
  nodeSet: NodeSetSpec
  embeddingRows: EmbeddingRow[]
  embeddingsGate: ReadGate
  events: WeaveEventRow[]
  eventsGate: ReadGate
  eventsByType: Record<string, number>
  breadthFrom: string
  voiceSessions: VoiceSessionRow[]
  voiceGate: ReadGate
  depthFrom: string
  voiceAnchors: Record<string, number>
  /** id -> name for the boards in the node set; a board absent from `boards` is simply not listed. */
  boards: BoardName[]
  boardsGate: ReadGate
}

export type GenerationOutput = {
  boardIds: string[]
  nodeCount: number
  eventCount: number
  clusters: ClusterObj[]
  generationMetadata: Record<string, unknown>
  summary: {
    cluster_count: number
    avg_cluster_size: number
    cross_board_cluster_count: number
    max_cluster_size: number
    singletons_dropped: number
    nodes_excluded: number
    anchor_count: number
    unclustered_attended_count: number
    conversation_count: number
  }
}

function emptyByClass(): Record<EngagementClass, number> {
  return { breadth: 0, depth: 0, recency: 0 }
}

/** Select the rows that form the node set: live rows, or exactly the pinned keys (any archival state). */
function selectNodeRows(rows: EmbeddingRow[], spec: NodeSetSpec): EmbeddingRow[] {
  if (spec.source === 'live') return rows.filter((r) => r.archived_at === null)
  const byKey = new Map(rows.map((r) => [compositeKey(r), r]))
  const missing = spec.keys.filter((k) => !byKey.has(k))
  if (missing.length > 0) {
    throw new Error(`[Snapshot] pinned node set has ${missing.length} key(s) with no weave_embeddings row: ${missing.slice(0, 5).join(', ')}`)
  }
  return spec.keys.map((k) => byKey.get(k) as EmbeddingRow)
}

/** Anchor-shaped provenance for one node: raw and normalized weight, class split, attention, top events. */
function provenanceFor(
  key: string,
  boardId: string,
  attributed: AttributeResult,
  normalized: Record<string, number>,
): Omit<AnchorProvenance, 'cluster_id'> {
  const contribs = [...(attributed.contributions[key] ?? [])]
  contribs.sort((x, y) => y.w_eff - x.w_eff)
  const byClass = attributed.byClass[key] ?? emptyByClass()
  const attention = attentionFor(byClass)
  const out: Omit<AnchorProvenance, 'cluster_id'> = {
    key,
    board_id: boardId,
    w_total: attributed.weights[key] ?? 0,
    w_normalized: normalized[key] ?? 0,
    by_class: byClass,
    attention,
    top_events: contribs.slice(0, TOP_EVENTS_PER_ANCHOR),
  }
  if (attention === 'discussed') out.turns = turnsFor(contribs)
  return out
}

/** Placement of a conversation from the cluster membership of its two endpoints. */
export function placementFor(
  endpoints: [string, string],
  clusterOf: Map<string, string>,
): ConversationPlacement {
  const a = clusterOf.get(endpoints[0])
  const b = clusterOf.get(endpoints[1])
  if (a && b) return a === b ? `same_cluster:${a}` : `cross_cluster:${a},${b}`
  if (a) return `cluster_and_singleton:${a}`
  if (b) return `cluster_and_singleton:${b}`
  return 'both_singletons'
}

/**
 * One entry per voice session in window. Throws if the count differs from the
 * voice read's rows_returned, or if an anchor target does not resolve to two keys.
 */
export function buildConversations(
  voiceSessions: VoiceSessionRow[],
  clusterOf: Map<string, string>,
  rowsReturned: number,
): Conversation[] {
  const out: Conversation[] = voiceSessions.map((v) => {
    const keys = resolveEdgeTarget(v.anchor_target)
    if (keys.length !== 2) {
      throw new Error(`[Snapshot] voice session ${v.session_id}: anchor target ${v.anchor_target} does not resolve to two endpoints`)
    }
    const endpoints: [string, string] = [keys[0], keys[1]]
    return {
      voice_session_id: v.session_id,
      edge_id: v.anchor_target,
      anchor_edge_id: v.anchor_edge_id,
      ended_at: v.ended_at,
      user_turns: v.user_turns,
      endpoints,
      placement: placementFor(endpoints, clusterOf),
    }
  })
  if (out.length !== rowsReturned) {
    throw new Error(`[Snapshot] conversations cardinality failed: ${out.length} entries != voice_sessions.rows_returned ${rowsReturned}`)
  }
  return out
}

export function generateSnapshot(input: GenerationInput): GenerationOutput {
  const { generatedAt, options } = input
  const anchorCount = options.anchorCount

  // Node set and clustering input. The map is keyed on exactly these nodes.
  const nodeRows = selectNodeRows(input.embeddingRows, input.nodeSet)
  const { nodes, nodesExcludedNoEmbedding } = nodesFromEmbeddingRows(nodeRows)
  const nodeKeys = nodes.map((n) => n.compositeKey)
  const map = buildWeightMap(input.embeddingRows, nodeKeys)

  // Global read: every event on any board resolves against the whole map.
  const engagementEvents = [
    ...input.events.map(fromWeaveEvent),
    ...input.voiceSessions.map(fromVoiceSession),
  ]
  const { resolved, unmatchedByType, unresolvedByType } = resolveEvents(engagementEvents, {
    uniformWeights: options.uniformWeights,
  })
  const attributed = attribute(resolved, map, generatedAt)

  // Normalize: max weight -> 1.0 (unchanged from v1).
  const rawWeights = attributed.weights
  const maxRawWeight = Math.max(...Object.values(rawWeights), 0)
  const normalized: Record<string, number> = {}
  for (const key in rawWeights) {
    normalized[key] = maxRawWeight > 0 ? rawWeights[key] / maxRawWeight : 0
  }

  // Clustering over the node set; singletons dropped from clusters.
  const rawClusters = agglomerativeClustering(nodes, CLUSTER_SIMILARITY_THRESHOLD)
  const nonSingletonClusters = rawClusters.filter((c) => c.length > 1)
  const singletonsDropped = rawClusters.length - nonSingletonClusters.length
  nonSingletonClusters.sort((a, b) => b.length - a.length)

  // Decision A: anchors are the top-N members with w_total > 0; a cluster may have none.
  const anchors: AnchorProvenance[] = []
  const clusterOf = new Map<string, string>()
  const clusters: ClusterObj[] = nonSingletonClusters.map((memberIndices, idx) => {
    const clusterId = `c${idx + 1}`
    const members: NodeEntry[] = memberIndices.map((i) => nodes[i])
    for (const m of members) clusterOf.set(m.compositeKey, clusterId)

    const engaged = members
      .map((m) => ({ key: m.compositeKey, boardId: m.boardId, wTotal: rawWeights[m.compositeKey] ?? 0 }))
      .filter((m) => m.wTotal > 0)
      .sort((a, b) => b.wTotal - a.wTotal)
    const top = engaged.slice(0, Math.min(anchorCount, members.length))
    const engagementWeight = top.length > 0 ? top.reduce((s, m) => s + (normalized[m.key] ?? 0), 0) / top.length : 0

    for (const a of top) {
      anchors.push({ ...provenanceFor(a.key, a.boardId, attributed, normalized), cluster_id: clusterId })
    }

    const memberKeys = members.map((m) => m.compositeKey)
    return {
      cluster_id: clusterId,
      member_node_ids: memberKeys,
      anchor_node_ids: top.map((m) => m.key),
      theme_description: '', // Filled by stage 2a
      engagement_weight: Math.round(engagementWeight * 10000) / 10000,
      size: memberKeys.length,
      boards_touched: [...new Set(members.map((m) => m.boardId))],
    }
  })

  // Decision B: singletons with w_total > 0, ranked, anchor-shaped.
  const unclusteredAttended: UnclusteredAttended[] = nodes
    .filter((n) => !clusterOf.has(n.compositeKey) && (rawWeights[n.compositeKey] ?? 0) > 0)
    .map((n) => provenanceFor(n.compositeKey, n.boardId, attributed, normalized))
    .sort((a, b) => b.w_total - a.w_total)

  const conversations = buildConversations(input.voiceSessions, clusterOf, input.voiceGate.rows_returned)

  const boardIds = [...new Set(nodes.map((n) => n.boardId))]

  const generationMetadata = {
    pipeline_version: PIPELINE_VERSION,
    generated_at: generatedAt.toISOString(),
    parameters: ratifiedParameters(options),
    node_set: { source: input.nodeSet.source, keys: nodeKeys, count: nodeKeys.length },
    events_read: {
      breadth_from: input.breadthFrom,
      depth_from: input.depthFrom,
      rows_returned: input.eventsGate.rows_returned,
      rows_expected: input.eventsGate.rows_expected,
      by_type: input.eventsByType,
      voice_sessions: { ...input.voiceGate, anchors: input.voiceAnchors },
      embeddings: input.embeddingsGate,
      boards: input.boardsGate,
    },
    attribution: attributed.attribution,
    pair_asymmetry: pairAsymmetry(input.events),
    anchors,
    unclustered_attended: unclusteredAttended,
    conversations,
    boards: input.boards,
    // Diagnostics kept from v1.
    events_unmatched_by_type: unmatchedByType,
    events_unresolved_by_type: unresolvedByType,
    nodes_excluded_no_embedding: nodesExcludedNoEmbedding,
    max_raw_weight_before_normalization: maxRawWeight,
    singletons_dropped: singletonsDropped,
    total_clusters: clusters.length,
  }

  const crossBoardClusterCount = clusters.filter((c) => c.boards_touched.length > 1).length
  const avgClusterSize =
    clusters.length > 0 ? Math.round((clusters.reduce((s, c) => s + c.size, 0) / clusters.length) * 100) / 100 : 0
  const maxClusterSize = clusters.length > 0 ? Math.max(...clusters.map((c) => c.size)) : 0

  return {
    boardIds,
    nodeCount: nodes.length,
    eventCount: input.events.length + input.voiceSessions.length,
    clusters,
    generationMetadata,
    summary: {
      cluster_count: clusters.length,
      avg_cluster_size: avgClusterSize,
      cross_board_cluster_count: crossBoardClusterCount,
      max_cluster_size: maxClusterSize,
      singletons_dropped: singletonsDropped,
      nodes_excluded: nodesExcludedNoEmbedding,
      anchor_count: anchors.length,
      unclustered_attended_count: unclusteredAttended.length,
      conversation_count: conversations.length,
    },
  }
}
