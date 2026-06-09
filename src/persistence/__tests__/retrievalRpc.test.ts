import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { requireClient } from '../session'
import { createTestUser, hasServiceRole, type TestUser } from './setup'

/**
 * Integration test for the node-only retrieval RPC (migration 034).
 *
 * Everything is deterministic: we insert hand-built halfvec vectors so cosine
 * similarity is known exactly, with no Gemini call. The query vector is the
 * basis vector e0, so a row's similarity to it is fully determined by how it
 * projects onto e0:
 *   - e0            → similarity 1.0
 *   - e0 + e1       → similarity 1/sqrt(2) ≈ 0.707
 *   - e1 (orthogonal) → similarity 0.0
 *
 * v1 is node-only: the utterance corpus, session exclusion, and speaker filter
 * were removed (see migration 034). The new axis under test is orphan-drop via
 * the caller-supplied p_live_node_ids membership array.
 */

const DIM = 3072

function vec(entries: Record<number, number>): string {
  const v = new Array(DIM).fill(0)
  for (const [i, val] of Object.entries(entries)) v[Number(i)] = val
  // pgvector accepts a JSON-array literal for halfvec input.
  return JSON.stringify(v)
}

const Q = vec({ 0: 1 }) // query: basis vector e0
const HIGH = vec({ 0: 1 }) // similarity ≈ 1.0
const MID = vec({ 0: 1, 1: 1 }) // similarity ≈ 0.707
const ZERO = vec({ 1: 1 }) // similarity ≈ 0.0
const ORTHO = vec({ 500: 1 }) // orthogonal to the query → similarity 0.0

const LONG = 'content long enough to clear the thin-summary guard'

// Every live board node id (everything except the orphan, whose embedding row
// has no live node behind it). Used as the default p_live_node_ids.
const LIVE = ['na', 'nb', 'nc', 'nthin', 'nexc']

describe.skipIf(!hasServiceRole())('match_retrieval_context RPC (integration)', () => {
  let user: TestUser
  let other: TestUser
  let boardId: string

  beforeAll(async () => {
    user = await createTestUser('retrieval-rpc')
    const client = requireClient()

    const board = await client
      .from('boards')
      .insert({ name: 'retrieval-rpc-board' })
      .select('id')
      .single()
    if (board.error) throw board.error
    boardId = board.data.id

    // --- node corpus (weave_embeddings) ---
    const nodeRows = [
      { node_id: 'na', node_type: 'textCard', embedding: HIGH, content_summary: `Alpha — ${LONG}` },
      { node_id: 'nb', node_type: 'textCard', embedding: MID, content_summary: `Beta — ${LONG}` },
      { node_id: 'nc', node_type: 'textCard', embedding: ZERO, content_summary: `Gamma — ${LONG}` },
      // thin summary (filename) — matches on vector but must be guarded out
      { node_id: 'nthin', node_type: 'imageCard', embedding: HIGH, content_summary: 'img.png' },
      // high similarity but excluded by the client-supplied exclusion array
      { node_id: 'nexc', node_type: 'textCard', embedding: HIGH, content_summary: `Excluded — ${LONG}` },
      // high similarity but NOT a live board member → orphan-dropped unless
      // orphan-drop is disabled (null live array)
      { node_id: 'norphan', node_type: 'textCard', embedding: HIGH, content_summary: `Orphan — ${LONG}` },
    ].map((r) => ({ ...r, board_id: boardId }))
    const nodesIns = await client.from('weave_embeddings').insert(nodeRows)
    if (nodesIns.error) throw nodesIns.error
  })

  afterAll(async () => {
    await user?.cleanup()
    await other?.cleanup()
  })

  async function call(opts: {
    query?: string
    threshold?: number
    totalCap?: number
    excluded?: string[]
    live?: string[] | null
  }) {
    const client = requireClient()
    const { data, error } = await client.rpc('match_retrieval_context', {
      query_embedding: (opts.query ?? Q) as unknown as never,
      p_board_id: boardId,
      p_match_threshold: opts.threshold ?? 0.5,
      p_total_cap: opts.totalCap ?? 20,
      p_excluded_node_ids: opts.excluded ?? [],
      p_live_node_ids: (opts.live === undefined ? LIVE : opts.live) as unknown as never,
    })
    if (error) throw error
    return data ?? []
  }

  it('returns node corpus respecting floor / exclusion / thin-guard / orphan-drop', async () => {
    const rows = await call({ excluded: ['nexc'] })
    const refIds = rows.map((r) => r.ref_id)

    // Present: high + mid live, non-excluded, non-thin nodes.
    expect(refIds).toContain('na')
    expect(refIds).toContain('nb')

    // Absent: below-floor node, thin summary, excluded node, orphan (not live).
    expect(refIds).not.toContain('nc')
    expect(refIds).not.toContain('nthin')
    expect(refIds).not.toContain('nexc')
    expect(refIds).not.toContain('norphan')

    // Only the node corpus exists now.
    const sources = new Set(rows.map((r) => r.source))
    expect(sources).toEqual(new Set(['node']))
  })

  it('drops orphan rows (not in p_live_node_ids); disabling via null returns them', async () => {
    const dropped = await call({ excluded: ['nexc'] })
    expect(dropped.map((r) => r.ref_id)).not.toContain('norphan')

    // Null live array disables orphan-drop → the orphan (≈1.0) returns.
    const kept = await call({ excluded: ['nexc'], live: null })
    expect(kept.map((r) => r.ref_id)).toContain('norphan')
  })

  it('tags nodes as source=node, speaker=null, with node_type', async () => {
    const rows = await call({ excluded: ['nexc'] })
    const na = rows.find((r) => r.ref_id === 'na')
    expect(na?.source).toBe('node')
    expect(na?.speaker).toBeNull()
    expect(na?.node_type).toBe('textCard')
  })

  it('orders by score descending and score == similarity (engagement identity = 1.0)', async () => {
    const rows = await call({ excluded: ['nexc'] })
    const scores = rows.map((r) => r.score)
    const sorted = [...scores].sort((a, b) => b - a)
    expect(scores).toEqual(sorted)
    for (const r of rows) {
      expect(Math.abs(r.score - r.similarity)).toBeLessThan(1e-9)
    }
    // The mid node (≈0.707) ranks below the high-similarity (≈1.0) rows.
    const nb = rows.find((r) => r.ref_id === 'nb')!
    const na = rows.find((r) => r.ref_id === 'na')!
    expect(na.score).toBeGreaterThan(nb.score)
  })

  it('returns empty when nothing clears the floor', async () => {
    const rows = await call({ query: ORTHO, threshold: 0.5 })
    expect(rows).toHaveLength(0)
  })

  it('caps results at p_total_cap', async () => {
    const rows = await call({ excluded: ['nexc'], totalCap: 1 })
    expect(rows).toHaveLength(1)
    // The highest-scoring row is a ≈1.0 match.
    expect(rows[0].score).toBeGreaterThan(0.9)
  })

  it('enforces RLS — another user sees none of these rows (SECURITY INVOKER)', async () => {
    other = await createTestUser('retrieval-rpc-other')
    // `other` is now the signed-in user on the shared client.
    const client = requireClient()
    const { data, error } = await client.rpc('match_retrieval_context', {
      query_embedding: Q as unknown as never,
      p_board_id: boardId,
      p_match_threshold: 0.5,
      p_total_cap: 20,
      p_excluded_node_ids: [],
      p_live_node_ids: LIVE as unknown as never,
    })
    if (error) throw error
    expect(data ?? []).toHaveLength(0)

    // Sign the original user back in so afterAll cleanup runs as them.
    await user.signIn()
  })
})
