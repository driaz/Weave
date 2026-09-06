// Plain-data shapes shared by the pure engagement layer and the I/O shell.

export type EngagementClass = 'breadth' | 'depth' | 'recency'

/** One row of weave_events as the pipeline reads it. */
export type WeaveEventRow = {
  id: string
  event_type: string
  target_id: string | null
  board_id: string
  session_id: string
  timestamp: string
  duration_ms: number | null
  metadata: Record<string, unknown> | null
  user_id: string
  voice_session_id: string | null
}

/** One qualifying voice session with its anchor edge already resolved. */
export type VoiceSessionRow = {
  session_id: string
  anchor_edge_id: string
  ended_at: string
  user_turns: number
  /** `connection:{board_id}:{from}:{to}` synthesized from the edge row. */
  anchor_target: string
  board_id: string
}

/**
 * The single event shape the resolvers see. weave_events rows and voice
 * sessions are both normalized into this before resolution.
 */
export type EngagementEvent = {
  source: 'weave_events' | 'voice_session'
  event_type: string
  target_id: string | null
  board_id: string
  occurred_at: string
  duration_ms: number | null
  user_turns: number | null
  event_id: string | null
  voice_session_id: string | null
}

export type ResolvedEvent = {
  event: EngagementEvent
  class: EngagementClass
  keys: string[]
  w_rule: number
  /** For edge-grain events: the edge identity kept in provenance. */
  edge_id: string | null
}

export type EmbeddingRow = {
  board_id: string
  node_id: string
  node_type: string
  embedding: string // pgvector returns a JSON-parseable string
  content_summary: string | null
  archived_at: string | null
}

export type NodeEntry = {
  compositeKey: string // "board_id:node_id"
  boardId: string
  nodeId: string
  nodeType: string
  embedding: number[]
  contentSummary: string | null
}

export type WeightMap = {
  /** Composite key → accumulated effective weight; keys are the node set. */
  weights: Record<string, number>
  /** Composite keys present in weave_embeddings with archived_at set. */
  archived: Set<string>
}

export type Contribution = {
  event_type: string
  class: EngagementClass
  w_rule: number
  w_eff: number
  age_days: number
  edge_id?: string
  voice_session_id?: string
  user_turns?: number
}

export type PerTypeAttribution = { resolved: number; hit: number; archived: number; absent: number }

export type Attribution = {
  resolved: number
  hit: number
  dropped: { archived: number; absent: number }
  by_type: Record<string, PerTypeAttribution>
  /** Resolved events whose rule weight was <= 0; skipped before the lookup (v1 gate, D7 X4). */
  zero_weight_events: number
}

export type AttributeResult = {
  weights: Record<string, number>
  byClass: Record<string, Record<EngagementClass, number>>
  contributions: Record<string, Contribution[]>
  attribution: Attribution
}

export type PairCounters = {
  opens: number
  closes: number
  paired: number
  orphan_opens: number
  unmatched_closes: number
}

export type PairAsymmetry = { connection: PairCounters; lightbox: PairCounters }

export type ClusterObj = {
  cluster_id: string
  member_node_ids: string[]
  anchor_node_ids: string[]
  theme_description: string
  engagement_weight: number
  size: number
  boards_touched: string[]
}

export type AnchorProvenance = {
  key: string
  board_id: string
  cluster_id: string
  w_total: number
  w_normalized: number
  by_class: Record<EngagementClass, number>
  top_events: Contribution[]
}
