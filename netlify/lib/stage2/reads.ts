// Stage-2 content read: node content for a set of composite keys, from
// weave_embeddings (live rows) and nodes, both range-paged and count-gated.

import type { SupabaseClient } from '@supabase/supabase-js'
import { READ_PAGE_SIZE } from '../snapshot/constants'
import { assertGate, pageAll, type ReadGate } from '../snapshot/reads'
import type { NodeContent } from './content'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Client = SupabaseClient<any, any, any>

type EmbRow = { board_id: string; node_id: string; node_type: string; content_summary: string | null }
type NodeRow = {
  id: string
  board_id: string
  card_type: string | null
  link_type: string | null
  title: string | null
  data: Record<string, unknown> | null
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim().length > 0 ? v : null
}

/** weave_embeddings.node_id is the bare client id, which hydration reads from nodes.data._clientNodeId (else the row uuid). */
export function clientIdOf(n: NodeRow): string {
  const cid = n.data?._clientNodeId
  return typeof cid === 'string' ? cid : n.id
}

export type ContentRead = {
  byKey: Map<string, NodeContent>
  gates: { embeddings: ReadGate; nodes: ReadGate }
  /** Requested keys with no live weave_embeddings row. */
  missing: string[]
}

/**
 * Read content for `keys`. PostgREST cannot OR composite pairs, so both reads
 * are predicated on the keys' board ids and filtered client-side; each read is
 * gated against a count(*) on that identical predicate.
 */
export async function readNodeContent(
  supabase: Client,
  keys: string[],
  pageSize: number = READ_PAGE_SIZE,
): Promise<ContentRead> {
  const wanted = new Set(keys)
  const boardIds = [...new Set(keys.map((k) => k.slice(0, k.indexOf(':'))))]
  if (boardIds.length === 0) {
    return { byKey: new Map(), gates: { embeddings: { rows_returned: 0, rows_expected: 0 }, nodes: { rows_returned: 0, rows_expected: 0 } }, missing: [] }
  }

  // Archived rows (node deleted or vector superseded) never serve; same semantics as stage 1's map.
  const embRows = await pageAll<EmbRow>(
    () => supabase.from('weave_embeddings').select('board_id, node_id, node_type, content_summary').in('board_id', boardIds).is('archived_at', null),
    ['board_id', 'node_id'],
    pageSize,
  )
  const embCount = await supabase.from('weave_embeddings').select('*', { count: 'exact', head: true }).in('board_id', boardIds).is('archived_at', null)
  if (embCount.error) throw new Error(`[Stage2] embeddings count failed: ${embCount.error.message}`)
  const embGate = { rows_returned: embRows.length, rows_expected: embCount.count ?? -1 }
  assertGate('stage2 weave_embeddings', embGate)

  const nodeRows = await pageAll<NodeRow>(
    () => supabase.from('nodes').select('id, board_id, card_type, link_type, title, data').in('board_id', boardIds),
    ['board_id', 'id'],
    pageSize,
  )
  const nodeCount = await supabase.from('nodes').select('*', { count: 'exact', head: true }).in('board_id', boardIds)
  if (nodeCount.error) throw new Error(`[Stage2] nodes count failed: ${nodeCount.error.message}`)
  const nodeGate = { rows_returned: nodeRows.length, rows_expected: nodeCount.count ?? -1 }
  assertGate('stage2 nodes', nodeGate)

  const nodeByKey = new Map<string, NodeRow>()
  for (const n of nodeRows) nodeByKey.set(`${n.board_id}:${clientIdOf(n)}`, n)

  const byKey = new Map<string, NodeContent>()
  for (const e of embRows) {
    const key = `${e.board_id}:${e.node_id}`
    if (!wanted.has(key)) continue
    const n = nodeByKey.get(key)
    const d = n?.data ?? {}
    byKey.set(key, {
      key,
      boardId: e.board_id,
      nodeType: e.node_type,
      cardType: n?.card_type ?? null,
      linkType: n?.link_type ?? null,
      title: str(n?.title) ?? str(d.title),
      authorName: str(d.authorName),
      authorHandle: str(d.authorHandle),
      tweetText: str(d.tweetText),
      contentSummary: e.content_summary,
    })
  }
  const missing = keys.filter((k) => !byKey.has(k))
  return { byKey, gates: { embeddings: embGate, nodes: nodeGate }, missing }
}
