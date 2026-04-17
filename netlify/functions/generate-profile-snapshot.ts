// SCOPE ASSUMPTION: This function treats `weave_embeddings` as the
// canonical source of "nodes that exist." Boards live in localStorage
// on the client; there is no server-side `weave_nodes` table. A node
// that exists in a browser's localStorage but does not have a row in
// `weave_embeddings` (because the async embedding pipeline hasn't run
// yet, or failed) is invisible to this function. This is acceptable
// today because the embedding backfill is reliable. When the
// persistence layer moves off localStorage (multi-device support),
// this assumption should be revisited.

import { createClient } from '@supabase/supabase-js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type WeaveEvent = {
  id: string
  event_type: string
  target_id: string | null
  board_id: string
  session_id: string
  timestamp: string
  duration_ms: number | null
  metadata: Record<string, unknown> | null
}

type EmbeddingRow = {
  board_id: string
  node_id: string
  node_type: string
  embedding: string // pgvector returns a JSON-parseable string
  content_summary: string | null
}

type NodeEntry = {
  compositeKey: string // "board_id:node_id"
  boardId: string
  nodeId: string
  nodeType: string
  embedding: number[]
  contentSummary: string | null
}

type ClusterObj = {
  cluster_id: string
  member_node_ids: string[]
  anchor_node_ids: string[]
  theme_description: string
  engagement_weight: number
  size: number
  boards_touched: string[]
}

type EventResolver = (event: WeaveEvent) => string[]
// Returns the list of composite "board_id:node_id" keys that this
// event attributes engagement to. May return 1, 2, or N keys.

type EngagementRule = {
  weight: number
  resolve: EventResolver
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CLUSTER_SIMILARITY_THRESHOLD = 0.55

// ---------------------------------------------------------------------------
// Engagement rules
// ---------------------------------------------------------------------------

// To add a new engagement signal: add one entry to this table.
// - weight is the contribution per attributed node (after normalization,
//   the max weight in the snapshot will be 1.0)
// - resolve returns the composite "board_id:node_id" keys this event
//   attributes engagement to. Single-node events return [oneKey].
//   Multi-node events return [keyA, keyB, ...]
//
// Future events to add as the product evolves:
//   node_opened (single node, weight ~0.6)
//   voice_question_asked (single or multi node, weight ~0.8)
//   reflection_opened (no node attribution, would not go here)

let unparseableConnectionEvents = 0

const ENGAGEMENT_RULES: Record<string, EngagementRule> = {
  connection_label_clicked: {
    weight: 1.0,
    resolve: (e) => resolveConnectionToBothNodes(e),
  },
  connection_description_closed: {
    weight: 0.3,
    resolve: (e) => resolveConnectionToBothNodes(e),
  },
  item_added: {
    weight: 0.2,
    resolve: (e) => {
      if (!e.target_id) return []
      // item_added target_id is already "board_id:node_id"
      return [e.target_id]
    },
  },
}

// ---------------------------------------------------------------------------
// TEMPORARY DEFENSIVE PARSER — TO BE REMOVED
//
// Edge IDs currently use the format "weave-{fromNodeId}-{toNodeId}",
// which is ambiguous if node IDs ever contain hyphens. Today's node
// IDs are simple numeric strings, so this works — but the format itself
// is a latent bug.
//
// This parser is intentionally paranoid: it fails loudly (via the
// unparseable_connection_events counter in generation_metadata) rather
// than silently producing wrong attributions, so any future drift in
// ID generation will be visible in snapshot metadata immediately.
//
// The proper fix is to change the edge ID delimiter to a character
// node IDs cannot contain. That work will be done in a follow-up branch
// immediately after this function ships and the first snapshots are
// validated, BEFORE prompt 3 (theme extraction) builds on these weights.
// When that work lands, this entire defensive block collapses to a
// simple parse with no error handling needed.
// ---------------------------------------------------------------------------

function resolveConnectionToBothNodes(event: WeaveEvent): string[] {
  const targetId = event.target_id
  if (!targetId) {
    console.warn(
      `[Snapshot] Connection event has no target_id, skipping. event_type=${event.event_type} id=${event.id}`,
    )
    unparseableConnectionEvents++
    return []
  }

  if (!targetId.startsWith('weave-')) {
    console.warn(
      `[Snapshot] Connection target_id missing "weave-" prefix: "${targetId}". event_type=${event.event_type} id=${event.id}`,
    )
    unparseableConnectionEvents++
    return []
  }

  const remainder = targetId.slice('weave-'.length)
  const parts = remainder.split('-')

  if (parts.length !== 2) {
    console.warn(
      `[Snapshot] Connection target_id has unexpected format (expected 2 parts after "weave-", got ${parts.length}): "${targetId}". event_type=${event.event_type} id=${event.id}`,
    )
    unparseableConnectionEvents++
    return []
  }

  const [fromNodeId, toNodeId] = parts
  return [
    `${event.board_id}:${fromNodeId}`,
    `${event.board_id}:${toNodeId}`,
  ]
}

// ---------------------------------------------------------------------------
// Math helpers
// ---------------------------------------------------------------------------

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB)
  return denom === 0 ? 0 : dot / denom
}

// ---------------------------------------------------------------------------
// Embedding parsing
// ---------------------------------------------------------------------------

function parseEmbedding(raw: unknown): number[] | null {
  // Primary format: pgvector returns a JSON-parseable string like "[-0.004,0.017,...]"
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed)) return parsed as number[]
    } catch {
      // fall through to other formats
    }
    console.warn('[Snapshot] Embedding string was not JSON-parseable, skipping node')
    return null
  }

  // Defensive fallback: if supabase-js ever returns a native array
  if (Array.isArray(raw)) {
    console.warn('[Snapshot] Embedding returned as native array (unexpected — expected string). Using it, but investigate format drift.')
    return raw as number[]
  }

  console.warn('[Snapshot] Embedding has unexpected type:', typeof raw)
  return null
}

// ---------------------------------------------------------------------------
// Agglomerative clustering (average linkage)
// ---------------------------------------------------------------------------

// PERFORMANCE NOTE: This is O(n³) in the worst case — each merge
// step scans all remaining cluster pairs and computes average linkage
// by iterating all member-pairs. Acceptable up to ~500 nodes; will
// need optimization (Lance-Williams update formula, or switching to a
// proper library like ml-hclust) above that. For Weave's current data
// size (~100 nodes), this completes in well under a second.
function agglomerativeClustering(
  nodes: NodeEntry[],
  threshold: number,
): number[][] {
  const n = nodes.length
  if (n === 0) return []

  // Precompute pairwise similarity matrix (upper triangle)
  const sim: number[][] = Array.from({ length: n }, () => new Array(n).fill(0))
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const s = cosineSimilarity(nodes[i].embedding, nodes[j].embedding)
      sim[i][j] = s
      sim[j][i] = s
    }
  }

  // Each node starts as its own cluster (array of original indices)
  let clusters: number[][] = nodes.map((_, i) => [i])

  while (clusters.length > 1) {
    // Find the pair of clusters with highest average linkage similarity
    let bestSim = -Infinity
    let bestI = -1
    let bestJ = -1

    for (let i = 0; i < clusters.length; i++) {
      for (let j = i + 1; j < clusters.length; j++) {
        // Average linkage: mean similarity across all pairs
        let total = 0
        for (const a of clusters[i]) {
          for (const b of clusters[j]) {
            total += sim[a][b]
          }
        }
        const avg = total / (clusters[i].length * clusters[j].length)
        if (avg > bestSim) {
          bestSim = avg
          bestI = i
          bestJ = j
        }
      }
    }

    // Stop if best pair is below threshold
    if (bestSim < threshold) break

    // Merge bestJ into bestI, remove bestJ
    clusters[bestI] = clusters[bestI].concat(clusters[bestJ])
    clusters.splice(bestJ, 1)
  }

  return clusters
}

// ---------------------------------------------------------------------------
// Timing helper
// ---------------------------------------------------------------------------

function timer(): () => number {
  const start = performance.now()
  return () => Math.round(performance.now() - start)
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export default async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204 })
  }

  if (req.method !== 'POST') {
    return Response.json({ error: 'Method not allowed' }, { status: 405 })
  }

  const supabaseUrl = process.env.SUPABASE_URL
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (!supabaseUrl || !supabaseKey) {
    return Response.json(
      { error: 'SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not configured' },
      { status: 500 },
    )
  }

  const supabase = createClient(supabaseUrl, supabaseKey)

  // Reset module-level counter for this invocation
  unparseableConnectionEvents = 0

  try {
    // Parse request body
    let boardIds: string[] | null = null
    let triggerReason = 'manual'

    try {
      const body = await req.json()
      if (body.board_ids && Array.isArray(body.board_ids)) {
        boardIds = body.board_ids
      }
      if (body.trigger_reason && typeof body.trigger_reason === 'string') {
        triggerReason = body.trigger_reason
      }
    } catch {
      // Empty body is fine — defaults apply
    }

    // ------------------------------------------------------------------
    // Step 1: Determine in-scope boards
    // ------------------------------------------------------------------
    const tFetchNodes = timer()

    if (!boardIds) {
      const { data: boardRows, error: boardErr } = await supabase
        .from('weave_embeddings')
        .select('board_id')

      if (boardErr) {
        return Response.json({ error: `Failed to fetch boards: ${boardErr.message}` }, { status: 500 })
      }

      boardIds = [...new Set((boardRows ?? []).map((r: { board_id: string }) => r.board_id))]
    }

    if (boardIds.length === 0) {
      return Response.json({ error: 'No boards found' }, { status: 404 })
    }

    // ------------------------------------------------------------------
    // Step 2: Fetch embeddings for all in-scope nodes
    // ------------------------------------------------------------------
    const tFetchEmbeddings = timer()

    const { data: embeddingRows, error: embErr } = await supabase
      .from('weave_embeddings')
      .select('board_id, node_id, node_type, embedding, content_summary')
      .in('board_id', boardIds)

    const fetchNodesTiming = tFetchNodes()

    if (embErr) {
      return Response.json({ error: `Failed to fetch embeddings: ${embErr.message}` }, { status: 500 })
    }

    // Parse embeddings, excluding nodes with missing/unparseable embeddings
    const nodes: NodeEntry[] = []
    let nodesExcludedNoEmbedding = 0

    for (const row of (embeddingRows ?? []) as EmbeddingRow[]) {
      const embedding = parseEmbedding(row.embedding)
      if (!embedding) {
        console.warn(`[Snapshot] Excluding node ${row.board_id}:${row.node_id} — missing or unparseable embedding`)
        nodesExcludedNoEmbedding++
        continue
      }
      nodes.push({
        compositeKey: `${row.board_id}:${row.node_id}`,
        boardId: row.board_id,
        nodeId: row.node_id,
        nodeType: row.node_type,
        embedding,
        contentSummary: row.content_summary,
      })
    }

    const fetchEmbeddingsTiming = tFetchEmbeddings()

    // ------------------------------------------------------------------
    // Step 3: Fetch events for in-scope boards
    // ------------------------------------------------------------------
    const tFetchEvents = timer()

    const { data: eventRows, error: evtErr } = await supabase
      .from('weave_events')
      .select('*')
      .in('board_id', boardIds)

    const fetchEventsTiming = tFetchEvents()

    if (evtErr) {
      return Response.json({ error: `Failed to fetch events: ${evtErr.message}` }, { status: 500 })
    }

    const events = (eventRows ?? []) as WeaveEvent[]

    // ------------------------------------------------------------------
    // Step 4: Compute per-node engagement weights
    // ------------------------------------------------------------------
    const tComputeWeights = timer()

    const weightMap: Record<string, number> = {}
    // Initialize all nodes to 0
    for (const node of nodes) {
      weightMap[node.compositeKey] = 0
    }

    const rulesApplied = new Set<string>()
    const eventsUnmatchedByType: Record<string, number> = {}

    for (const event of events) {
      const rule = ENGAGEMENT_RULES[event.event_type]
      if (!rule) {
        eventsUnmatchedByType[event.event_type] =
          (eventsUnmatchedByType[event.event_type] ?? 0) + 1
        continue
      }

      const attributedKeys = rule.resolve(event)
      if (attributedKeys.length === 0) continue

      let contributed = false
      for (const key of attributedKeys) {
        if (key in weightMap) {
          weightMap[key] += rule.weight
          contributed = true
        }
        // If key not in weightMap, the node had no embedding — already excluded
      }

      if (contributed) {
        rulesApplied.add(event.event_type)
      }
    }

    // Normalize: max weight → 1.0
    const maxRawWeight = Math.max(...Object.values(weightMap), 0)
    if (maxRawWeight > 0) {
      for (const key in weightMap) {
        weightMap[key] = weightMap[key] / maxRawWeight
      }
    }

    const computeWeightsTiming = tComputeWeights()

    // ------------------------------------------------------------------
    // Step 5: Agglomerative clustering
    // ------------------------------------------------------------------
    const tCluster = timer()

    const rawClusters = agglomerativeClustering(nodes, CLUSTER_SIMILARITY_THRESHOLD)

    // Filter out singletons
    const nonSingletonClusters = rawClusters.filter((c) => c.length > 1)
    const singletonsDropped = rawClusters.length - nonSingletonClusters.length

    // Sort by size descending for stable cluster_id assignment
    nonSingletonClusters.sort((a, b) => b.length - a.length)

    // Build cluster objects
    const clusters: ClusterObj[] = nonSingletonClusters.map((memberIndices, idx) => {
      const memberKeys = memberIndices.map((i) => nodes[i].compositeKey)

      // Get weights for all members
      const memberWeights = memberKeys.map((key) => ({
        key,
        weight: weightMap[key] ?? 0,
      }))

      // Sort by weight descending for anchor selection
      memberWeights.sort((a, b) => b.weight - a.weight)

      // Anchor nodes: top 3 by weight
      const anchorCount = Math.min(3, memberWeights.length)
      const anchorNodeIds = memberWeights.slice(0, anchorCount).map((m) => m.key)

      // Engagement weight: mean of top 3 (or fewer)
      const topWeights = memberWeights.slice(0, anchorCount).map((m) => m.weight)
      const engagementWeight =
        topWeights.length > 0
          ? topWeights.reduce((sum, w) => sum + w, 0) / topWeights.length
          : 0

      // Distinct boards touched
      const boardsTouched = [
        ...new Set(memberKeys.map((key) => key.split(':')[0])),
      ]

      return {
        cluster_id: `c${idx + 1}`,
        member_node_ids: memberKeys,
        anchor_node_ids: anchorNodeIds,
        theme_description: '', // Filled by later pipeline step
        engagement_weight: Math.round(engagementWeight * 10000) / 10000,
        size: memberKeys.length,
        boards_touched: boardsTouched,
      }
    })

    const clusterTiming = tCluster()

    // ------------------------------------------------------------------
    // Step 6: Insert snapshot row
    // ------------------------------------------------------------------
    const generationMetadata = {
      timing_ms: {
        fetch_nodes: fetchNodesTiming,
        fetch_embeddings: fetchEmbeddingsTiming,
        fetch_events: fetchEventsTiming,
        compute_weights: computeWeightsTiming,
        cluster: clusterTiming,
      },
      cluster_threshold_used: CLUSTER_SIMILARITY_THRESHOLD,
      singletons_dropped: singletonsDropped,
      nodes_excluded_no_embedding: nodesExcludedNoEmbedding,
      max_raw_weight_before_normalization: maxRawWeight,
      total_clusters: clusters.length,
      rules_applied: [...rulesApplied],
      events_unmatched_by_type: eventsUnmatchedByType,
      unparseable_connection_events: unparseableConnectionEvents,
    }

    const snapshotRow = {
      board_ids: boardIds,
      node_count: nodes.length,
      event_count: events.length,
      clusters: clusters,
      bridges: null, // Filled by next pipeline step
      narrative: null, // Filled by later pipeline step
      trigger_reason: triggerReason,
      generation_metadata: generationMetadata,
    }

    const { data: inserted, error: insertErr } = await supabase
      .from('weave_profile_snapshots')
      .insert(snapshotRow)
      .select('id')
      .single()

    if (insertErr) {
      return Response.json(
        { error: `Failed to insert snapshot: ${insertErr.message}` },
        { status: 500 },
      )
    }

    // ------------------------------------------------------------------
    // Step 7: Return summary
    // ------------------------------------------------------------------
    const crossBoardClusterCount = clusters.filter(
      (c) => c.boards_touched.length > 1,
    ).length

    const avgClusterSize =
      clusters.length > 0
        ? Math.round(
            (clusters.reduce((sum, c) => sum + c.size, 0) / clusters.length) * 100,
          ) / 100
        : 0

    const maxClusterSize =
      clusters.length > 0 ? Math.max(...clusters.map((c) => c.size)) : 0

    return Response.json({
      snapshot_id: inserted.id,
      summary: {
        cluster_count: clusters.length,
        avg_cluster_size: avgClusterSize,
        cross_board_cluster_count: crossBoardClusterCount,
        max_cluster_size: maxClusterSize,
        singletons_dropped: singletonsDropped,
        nodes_excluded: nodesExcludedNoEmbedding,
      },
    })
  } catch (error) {
    console.error('[Snapshot] Unexpected error:', error)
    return Response.json(
      { error: 'Internal server error' },
      { status: 500 },
    )
  }
}

export const config = {
  path: '/api/generate-profile-snapshot',
}
