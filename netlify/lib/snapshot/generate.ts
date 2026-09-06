// Pure generation core. Takes the rows the I/O shell read and returns the
// snapshot row fields plus generation_metadata. No I/O, no clock: generatedAt
// is an input.

import { CLUSTER_SIMILARITY_THRESHOLD, PIPELINE_VERSION, TOP_EVENTS_PER_ANCHOR, ratifiedParameters } from './constants'
import { agglomerativeClustering, nodesFromEmbeddingRows } from './clustering'
import {
  attribute,
  buildWeightMap,
  compositeKey,
  fromVoiceSession,
  fromWeaveEvent,
  pairAsymmetry,
  resolveEvents,
} from './engagement'
import type { ReadGate } from './reads'
import type {
  AnchorProvenance,
  ClusterObj,
  EmbeddingRow,
  EngagementClass,
  NodeEntry,
  VoiceSessionRow,
  WeaveEventRow,
} from './types'

export type NodeSetSpec =
  | { source: 'live' }
  | { source: `pinned:${string}`; keys: string[] }

export type GenerationInput = {
  generatedAt: Date
  anchorCount: number
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

export function generateSnapshot(input: GenerationInput): GenerationOutput {
  const { generatedAt, anchorCount } = input

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
  const { resolved, unmatchedByType, unresolvedByType } = resolveEvents(engagementEvents)
  const attributed = attribute(resolved, map, generatedAt)

  // Normalize: max weight -> 1.0 (unchanged from v1).
  const rawWeights = attributed.weights
  const maxRawWeight = Math.max(...Object.values(rawWeights), 0)
  const normalized: Record<string, number> = {}
  for (const key in rawWeights) {
    normalized[key] = maxRawWeight > 0 ? rawWeights[key] / maxRawWeight : 0
  }

  // Clustering over the node set; singletons dropped.
  const rawClusters = agglomerativeClustering(nodes, CLUSTER_SIMILARITY_THRESHOLD)
  const nonSingletonClusters = rawClusters.filter((c) => c.length > 1)
  const singletonsDropped = rawClusters.length - nonSingletonClusters.length
  nonSingletonClusters.sort((a, b) => b.length - a.length)

  // Anchors: top-N by normalized weight, per cluster, after clustering.
  const anchors: AnchorProvenance[] = []
  const clusters: ClusterObj[] = nonSingletonClusters.map((memberIndices, idx) => {
    const clusterId = `c${idx + 1}`
    const members: NodeEntry[] = memberIndices.map((i) => nodes[i])
    const memberWeights = members.map((m) => ({ key: m.compositeKey, boardId: m.boardId, weight: normalized[m.compositeKey] ?? 0 }))
    memberWeights.sort((a, b) => b.weight - a.weight)

    const n = Math.min(anchorCount, memberWeights.length)
    const top = memberWeights.slice(0, n)
    const engagementWeight = top.length > 0 ? top.reduce((s, m) => s + m.weight, 0) / top.length : 0

    for (const a of top) {
      const contribs = [...(attributed.contributions[a.key] ?? [])]
      contribs.sort((x, y) => y.w_eff - x.w_eff)
      anchors.push({
        key: a.key,
        board_id: a.boardId,
        cluster_id: clusterId,
        w_total: rawWeights[a.key] ?? 0,
        w_normalized: a.weight,
        by_class: attributed.byClass[a.key] ?? emptyByClass(),
        top_events: contribs.slice(0, TOP_EVENTS_PER_ANCHOR),
      })
    }

    const memberKeys = members.map((m) => m.compositeKey)
    return {
      cluster_id: clusterId,
      member_node_ids: memberKeys,
      anchor_node_ids: top.map((m) => m.key),
      theme_description: '', // Filled by later pipeline step
      engagement_weight: Math.round(engagementWeight * 10000) / 10000,
      size: memberKeys.length,
      boards_touched: [...new Set(members.map((m) => m.boardId))],
    }
  })

  const boardIds = [...new Set(nodes.map((n) => n.boardId))]

  const generationMetadata = {
    pipeline_version: PIPELINE_VERSION,
    generated_at: generatedAt.toISOString(),
    parameters: ratifiedParameters(anchorCount),
    node_set: { source: input.nodeSet.source, keys: nodeKeys, count: nodeKeys.length },
    events_read: {
      breadth_from: input.breadthFrom,
      depth_from: input.depthFrom,
      rows_returned: input.eventsGate.rows_returned,
      rows_expected: input.eventsGate.rows_expected,
      by_type: input.eventsByType,
      voice_sessions: { ...input.voiceGate, anchors: input.voiceAnchors },
      embeddings: input.embeddingsGate,
    },
    attribution: attributed.attribution,
    pair_asymmetry: pairAsymmetry(input.events),
    anchors,
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
    },
  }
}
