// I/O shell for the snapshot pipeline: every read is range-paged and gated by
// a count(*) on the identical predicate. A mismatch throws.

import type { SupabaseClient } from '@supabase/supabase-js'
import {
  BREADTH_HORIZON_DAYS,
  DEPTH_HORIZON_DAYS,
  MS_PER_DAY,
  READ_PAGE_SIZE,
} from './constants'
import { PAIR_EVENT_TYPES, ROSTER_EVENT_TYPES } from './engagement'
import type { EmbeddingRow, VoiceSessionRow, WeaveEventRow } from './types'

// The service-role client is untyped here on purpose: the generated Database
// type has no row for the synthesized voice join, and the pipeline reads
// columns by name and validates shape below.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Client = SupabaseClient<any, any, any>

export type ReadGate = { rows_returned: number; rows_expected: number }

export function horizonStart(generatedAt: Date, days: number): string {
  return new Date(generatedAt.getTime() - days * MS_PER_DAY).toISOString()
}

function assertGate(what: string, gate: ReadGate): void {
  if (gate.rows_returned !== gate.rows_expected) {
    throw new Error(
      `[Snapshot] ${what}: read returned ${gate.rows_returned} rows but count(*) on the identical predicate is ${gate.rows_expected}`,
    )
  }
}

/**
 * Page a PostgREST query in READ_PAGE_SIZE blocks until a short page returns.
 * `build` must apply the identical predicate every call; ordering is fixed so
 * pages do not overlap.
 */
async function pageAll<T>(
  build: () => {
    order: (col: string, opts?: { ascending?: boolean }) => unknown
  },
  orderBy: string[],
): Promise<T[]> {
  const out: T[] = []
  for (let from = 0; ; from += READ_PAGE_SIZE) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let q: any = build()
    for (const col of orderBy) q = q.order(col, { ascending: true })
    const { data, error } = await q.range(from, from + READ_PAGE_SIZE - 1)
    if (error) throw new Error(`[Snapshot] paged read failed: ${error.message}`)
    const page = (data ?? []) as T[]
    out.push(...page)
    if (page.length < READ_PAGE_SIZE) break
  }
  return out
}

// ---------------------------------------------------------------------------
// weave_embeddings — every row, archived included (the map builder classifies)
// ---------------------------------------------------------------------------

export async function readEmbeddings(
  supabase: Client,
): Promise<{ rows: EmbeddingRow[]; gate: ReadGate }> {
  const cols = 'board_id, node_id, node_type, embedding, content_summary, archived_at'
  const rows = await pageAll<EmbeddingRow>(
    () => supabase.from('weave_embeddings').select(cols),
    ['created_at', 'board_id', 'node_id'],
  )
  const { count, error } = await supabase
    .from('weave_embeddings')
    .select('*', { count: 'exact', head: true })
  if (error) throw new Error(`[Snapshot] embeddings count failed: ${error.message}`)
  const gate = { rows_returned: rows.length, rows_expected: count ?? -1 }
  assertGate('weave_embeddings', gate)
  return { rows, gate }
}

// ---------------------------------------------------------------------------
// weave_events — global (no board predicate), roster + pair types, breadth horizon
// ---------------------------------------------------------------------------

export const EVENT_TYPES_READ = [...new Set([...ROSTER_EVENT_TYPES, ...PAIR_EVENT_TYPES])]

export async function readEvents(
  supabase: Client,
  generatedAt: Date,
): Promise<{ rows: WeaveEventRow[]; gate: ReadGate; breadth_from: string; by_type: Record<string, number> }> {
  const breadthFrom = horizonStart(generatedAt, BREADTH_HORIZON_DAYS)
  const predicate = (q: ReturnType<Client['from']>) =>
    q.select('*').in('event_type', EVENT_TYPES_READ).gte('timestamp', breadthFrom)

  const rows = await pageAll<WeaveEventRow>(
    () => predicate(supabase.from('weave_events')),
    ['timestamp', 'id'],
  )
  const { count, error } = await supabase
    .from('weave_events')
    .select('*', { count: 'exact', head: true })
    .in('event_type', EVENT_TYPES_READ)
    .gte('timestamp', breadthFrom)
  if (error) throw new Error(`[Snapshot] events count failed: ${error.message}`)

  const gate = { rows_returned: rows.length, rows_expected: count ?? -1 }
  assertGate('weave_events', gate)

  const by_type: Record<string, number> = {}
  for (const r of rows) by_type[r.event_type] = (by_type[r.event_type] ?? 0) + 1
  return { rows, gate, breadth_from: breadthFrom, by_type }
}

// ---------------------------------------------------------------------------
// voice_sessions — system-layer predicates in the query, joined to utterances
// ---------------------------------------------------------------------------

type RawVoiceRow = {
  id: string
  anchor_edge_id: string
  ended_at: string
  voice_utterances: { speaker: string }[] | null
}

type EdgeRow = { id: string; board_id: string; source_node_id: string; target_node_id: string }
type NodeRow = { id: string; board_id: string; data: Record<string, unknown> | null }

/**
 * weave_embeddings.node_id stores the bare client id, which hydration reads
 * from nodes.data._clientNodeId (falling back to the row uuid). Mirror that
 * exactly so the synthesized connection target matches the map's keys.
 */
export function clientNodeId(node: NodeRow): string {
  const blob = node.data ?? {}
  const cid = blob._clientNodeId
  return typeof cid === 'string' ? cid : node.id
}

export async function readVoiceSessions(
  supabase: Client,
  generatedAt: Date,
): Promise<{
  rows: VoiceSessionRow[]
  gate: ReadGate
  depth_from: string
  anchors: { edges_requested: number; edges_found: number; nodes_requested: number; nodes_found: number }
}> {
  const depthFrom = horizonStart(generatedAt, DEPTH_HORIZON_DAYS)

  // Single read: session predicates and the utterance speaker filter are all
  // in the query; the client only takes the length of the joined array.
  const predicate = (q: ReturnType<Client['from']>) =>
    q
      .select('id, anchor_edge_id, ended_at, voice_utterances(speaker)')
      .eq('session_kind', 'real')
      .not('ended_at', 'is', null)
      .not('anchor_edge_id', 'is', null)
      .gte('ended_at', depthFrom)
      .eq('voice_utterances.speaker', 'user')

  const raw = await pageAll<RawVoiceRow>(
    () => predicate(supabase.from('voice_sessions')),
    ['ended_at', 'id'],
  )
  const { count, error } = await supabase
    .from('voice_sessions')
    .select('*', { count: 'exact', head: true })
    .eq('session_kind', 'real')
    .not('ended_at', 'is', null)
    .not('anchor_edge_id', 'is', null)
    .gte('ended_at', depthFrom)
  if (error) throw new Error(`[Snapshot] voice_sessions count failed: ${error.message}`)
  const gate = { rows_returned: raw.length, rows_expected: count ?? -1 }
  assertGate('voice_sessions', gate)

  // anchor_edge_id → edges row → node uuids → client ids → connection target.
  const edgeIds = [...new Set(raw.map((r) => r.anchor_edge_id))]
  const edges = edgeIds.length
    ? await pageAll<EdgeRow>(
        () => supabase.from('edges').select('id, board_id, source_node_id, target_node_id').in('id', edgeIds),
        ['id'],
      )
    : []
  const edgeById = new Map(edges.map((e) => [e.id, e]))
  const nodeIds = [...new Set(edges.flatMap((e) => [e.source_node_id, e.target_node_id]))]
  const nodes = nodeIds.length
    ? await pageAll<NodeRow>(
        () => supabase.from('nodes').select('id, board_id, data').in('id', nodeIds),
        ['id'],
      )
    : []
  const nodeById = new Map(nodes.map((n) => [n.id, n]))

  const rows: VoiceSessionRow[] = []
  for (const r of raw) {
    const edge = edgeById.get(r.anchor_edge_id)
    if (!edge) {
      throw new Error(`[Snapshot] voice session ${r.id}: anchor edge ${r.anchor_edge_id} has no edges row`)
    }
    const from = nodeById.get(edge.source_node_id)
    const to = nodeById.get(edge.target_node_id)
    if (!from || !to) {
      throw new Error(`[Snapshot] voice session ${r.id}: anchor edge ${edge.id} endpoint node missing`)
    }
    rows.push({
      session_id: r.id,
      anchor_edge_id: r.anchor_edge_id,
      ended_at: r.ended_at,
      user_turns: (r.voice_utterances ?? []).length,
      anchor_target: `connection:${edge.board_id}:${clientNodeId(from)}:${clientNodeId(to)}`,
      board_id: edge.board_id,
    })
  }

  return {
    rows,
    gate,
    depth_from: depthFrom,
    anchors: {
      edges_requested: edgeIds.length,
      edges_found: edges.length,
      nodes_requested: nodeIds.length,
      nodes_found: nodes.length,
    },
  }
}

// ---------------------------------------------------------------------------
// pinned node set
// ---------------------------------------------------------------------------

export async function readPinnedNodeSet(
  supabase: Client,
  snapshotId: string,
): Promise<string[]> {
  const { data, error } = await supabase
    .from('weave_profile_snapshots')
    .select('generation_metadata')
    .eq('id', snapshotId)
    .single()
  if (error || !data) throw new Error(`[Snapshot] pinned snapshot ${snapshotId} not found`)
  const meta = data.generation_metadata as { node_set?: { keys?: unknown } } | null
  const keys = meta?.node_set?.keys
  if (!Array.isArray(keys) || keys.some((k) => typeof k !== 'string')) {
    throw new Error(`[Snapshot] pinned snapshot ${snapshotId} carries no node_set.keys`)
  }
  return keys as string[]
}
