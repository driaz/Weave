import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { requireClient } from '../session'
import { createTestUser, hasServiceRole, type TestUser } from './setup'

/**
 * Integration test for the Phase 10A retrieval RPC (migration 032).
 *
 * Everything is deterministic: we insert hand-built halfvec vectors so cosine
 * similarity is known exactly, with no Gemini call. The query vector is the
 * basis vector e0, so a row's similarity to it is fully determined by how it
 * projects onto e0:
 *   - e0            → similarity 1.0
 *   - e0 + e1       → similarity 1/sqrt(2) ≈ 0.707
 *   - e1 (orthogonal) → similarity 0.0
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

describe.skipIf(!hasServiceRole())('match_retrieval_context RPC (integration)', () => {
  let user: TestUser
  let other: TestUser
  let boardId: string
  let priorSessionId: string
  let currentSessionId: string
  let u1Id: string // prior-session user utterance
  let u2Id: string // prior-session assistant utterance

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

    // --- nodes corpus (weave_embeddings) ---
    const nodeRows = [
      { node_id: 'na', node_type: 'textCard', embedding: HIGH, content_summary: `Alpha — ${LONG}` },
      { node_id: 'nb', node_type: 'textCard', embedding: MID, content_summary: `Beta — ${LONG}` },
      { node_id: 'nc', node_type: 'textCard', embedding: ZERO, content_summary: `Gamma — ${LONG}` },
      // thin summary (filename) — matches on vector but must be guarded out
      { node_id: 'nthin', node_type: 'imageCard', embedding: HIGH, content_summary: 'img.png' },
      // high similarity but excluded by the client-supplied exclusion array
      { node_id: 'nexc', node_type: 'textCard', embedding: HIGH, content_summary: `Excluded — ${LONG}` },
    ].map((r) => ({ ...r, board_id: boardId }))
    const nodesIns = await client.from('weave_embeddings').insert(nodeRows)
    if (nodesIns.error) throw nodesIns.error

    // --- utterances corpus (voice_utterances) ---
    const now = new Date().toISOString()
    const prior = await client
      .from('voice_sessions')
      .insert({ user_id: user.userId, board_snapshot: {}, started_at: now })
      .select('id')
      .single()
    if (prior.error) throw prior.error
    priorSessionId = prior.data.id

    const current = await client
      .from('voice_sessions')
      .insert({ user_id: user.userId, board_snapshot: {}, started_at: now })
      .select('id')
      .single()
    if (current.error) throw current.error
    currentSessionId = current.data.id

    const u1 = await client
      .from('voice_utterances')
      .insert({
        session_id: priorSessionId,
        user_id: user.userId,
        speaker: 'user',
        text: 'I keep thinking about how consensus relates to trust',
        embedding: HIGH,
        utterance_index: 0,
        started_at: now,
        ended_at: now,
      })
      .select('id')
      .single()
    if (u1.error) throw u1.error
    u1Id = u1.data.id

    const u2 = await client
      .from('voice_utterances')
      .insert({
        session_id: priorSessionId,
        user_id: user.userId,
        speaker: 'assistant',
        text: 'Reflecting on that prior point about consensus and trust',
        embedding: HIGH,
        utterance_index: 1,
        started_at: now,
        ended_at: now,
      })
      .select('id')
      .single()
    if (u2.error) throw u2.error
    u2Id = u2.data.id

    // current-session utterance — must be excluded by the session filter
    const uc = await client.from('voice_utterances').insert({
      session_id: currentSessionId,
      user_id: user.userId,
      speaker: 'user',
      text: 'Current-session utterance that must be excluded',
      embedding: HIGH,
      utterance_index: 0,
      started_at: now,
      ended_at: now,
    })
    if (uc.error) throw uc.error
  })

  afterAll(async () => {
    await user?.cleanup()
    await other?.cleanup()
  })

  async function call(opts: {
    query?: string
    threshold?: number
    count?: number
    excluded?: string[]
    currentSession?: string | null
  }) {
    const client = requireClient()
    const { data, error } = await client.rpc('match_retrieval_context', {
      query_embedding: (opts.query ?? Q) as unknown as never,
      p_board_id: boardId,
      p_match_threshold: opts.threshold ?? 0.5,
      p_match_count: opts.count ?? 20,
      p_excluded_node_ids: opts.excluded ?? [],
      p_current_session_id: (opts.currentSession === undefined
        ? currentSessionId
        : opts.currentSession) as unknown as never,
    })
    if (error) throw error
    return data ?? []
  }

  it('spans both corpora, respecting floor / exclusion / thin-guard / session', async () => {
    const rows = await call({ excluded: ['nexc'] })
    const refIds = rows.map((r) => r.ref_id)

    // Present: high + mid nodes, both prior-session utterances.
    expect(refIds).toContain('na')
    expect(refIds).toContain('nb')
    expect(refIds).toContain(u1Id)
    expect(refIds).toContain(u2Id)

    // Absent: below-floor node, thin summary, excluded node, current session.
    expect(refIds).not.toContain('nc')
    expect(refIds).not.toContain('nthin')
    expect(refIds).not.toContain('nexc')

    // Both corpora represented.
    const sources = new Set(rows.map((r) => r.source))
    expect(sources).toContain('node')
    expect(sources).toContain('utterance')
  })

  it('returns assistant utterances tagged (not silently dropped) and node_type for nodes', async () => {
    const rows = await call({ excluded: ['nexc'] })
    const u2 = rows.find((r) => r.ref_id === u2Id)
    expect(u2?.speaker).toBe('assistant')
    expect(u2?.source).toBe('utterance')
    expect(u2?.node_type).toBeNull()

    const na = rows.find((r) => r.ref_id === 'na')
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

  it('caps results at k', async () => {
    const rows = await call({ excluded: ['nexc'], count: 2 })
    expect(rows).toHaveLength(2)
    // The two highest-scoring rows are the ≈1.0 matches.
    for (const r of rows) expect(r.score).toBeGreaterThan(0.9)
  })

  it('includes current-session utterances when no current session is passed', async () => {
    const rows = await call({ currentSession: null })
    // With the session filter disabled, the current-session utterance returns.
    const utterances = rows.filter((r) => r.source === 'utterance')
    expect(utterances.length).toBeGreaterThanOrEqual(3)
  })

  it('enforces RLS — another user sees none of these rows (SECURITY INVOKER)', async () => {
    other = await createTestUser('retrieval-rpc-other')
    // `other` is now the signed-in user on the shared client.
    const client = requireClient()
    const { data, error } = await client.rpc('match_retrieval_context', {
      query_embedding: Q as unknown as never,
      p_board_id: boardId,
      p_match_threshold: 0.5,
      p_match_count: 20,
      p_excluded_node_ids: [],
      p_current_session_id: currentSessionId as unknown as never,
    })
    if (error) throw error
    expect(data ?? []).toHaveLength(0)

    // Sign the original user back in so afterAll cleanup runs as them.
    await user.signIn()
  })
})
