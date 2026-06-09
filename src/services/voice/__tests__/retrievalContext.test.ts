import { describe, expect, it, vi } from 'vitest'
import {
  BLEND_CURRENT,
  BLEND_PRIOR,
  blendQueryVectors,
  buildRelatedMaterial,
  fetchRetrievalContext,
  filterUnseen,
  lookupEdgeQueryVector,
  parseStoredEmbedding,
  RELATED_MATERIAL_FRAMING,
  RETRIEVAL_K,
  type RetrievalRow,
} from '../retrievalContext'

function row(partial: Partial<RetrievalRow>): RetrievalRow {
  return {
    source: 'node',
    ref_id: 'r1',
    content: 'content',
    speaker: null,
    node_type: 'textCard',
    similarity: 0.8,
    score: 0.8,
    ...partial,
  }
}

describe('parseStoredEmbedding', () => {
  it('parses a stringified array (PostgREST halfvec read-back)', () => {
    expect(parseStoredEmbedding('[0.1,0.2,0.3]')).toEqual([0.1, 0.2, 0.3])
  })
  it('passes through an already-parsed number array', () => {
    expect(parseStoredEmbedding([1, 2, 3])).toEqual([1, 2, 3])
  })
  it('returns null on non-numeric / malformed / null input', () => {
    expect(parseStoredEmbedding('not json')).toBeNull()
    expect(parseStoredEmbedding('["a","b"]')).toBeNull()
    expect(parseStoredEmbedding(null)).toBeNull()
    expect(parseStoredEmbedding(42)).toBeNull()
  })
})

describe('blendQueryVectors', () => {
  it('recency-weights current over prior', () => {
    const out = blendQueryVectors([1, 0], [0, 1])
    expect(out[0]).toBeCloseTo(BLEND_CURRENT)
    expect(out[1]).toBeCloseTo(BLEND_PRIOR)
  })
  it('N-1-not-ready: null prior weights current alone', () => {
    expect(blendQueryVectors([1, 2, 3], null)).toEqual([1, 2, 3])
  })
  it('dimension mismatch falls back to current alone', () => {
    expect(blendQueryVectors([1, 2, 3], [9, 9])).toEqual([1, 2, 3])
  })
})

describe('filterUnseen', () => {
  it('drops already-surfaced ref_ids and does not mutate the set', () => {
    const seen = new Set(['r1'])
    const rows = [row({ ref_id: 'r1' }), row({ ref_id: 'r2' })]
    const out = filterUnseen(rows, seen)
    expect(out.map((r) => r.ref_id)).toEqual(['r2'])
    expect([...seen]).toEqual(['r1']) // unchanged
  })
})

describe('buildRelatedMaterial', () => {
  it('returns null when there are no rows (caller omits the section)', () => {
    expect(buildRelatedMaterial([])).toBeNull()
  })

  it('always leads with the constant framing', () => {
    const out = buildRelatedMaterial([row({})])
    expect(out).toContain(RELATED_MATERIAL_FRAMING)
  })

  it('partitions curated nodes from prior reasoning, speaker-aware', () => {
    const out = buildRelatedMaterial([
      row({ source: 'node', content: 'saved node' }),
      row({ source: 'utterance', speaker: 'user', content: 'my earlier thought' }),
      row({ source: 'utterance', speaker: 'assistant', content: 'a drawn connection' }),
    ])!
    expect(out).toContain('saved node')
    expect(out).toContain('my earlier thought')
    expect(out).toContain('a drawn connection')
    // user reasoning framed as "build on", assistant as "go further"
    expect(out).toMatch(/build on[\s\S]*my earlier thought/)
    expect(out).toMatch(/go further[\s\S]*a drawn connection/)
  })

  it('truncates very long content', () => {
    const long = 'x'.repeat(500)
    const out = buildRelatedMaterial([row({ content: long })])!
    expect(out).toContain('…')
    expect(out).not.toContain('x'.repeat(400))
  })
})

describe('lookupEdgeQueryVector', () => {
  function clientReturning(result: { data: unknown; error: unknown }) {
    const maybeSingle = vi.fn(async () => result)
    const eq4 = { maybeSingle }
    const eq3 = { eq: vi.fn(() => eq4) }
    const eq2 = { eq: vi.fn(() => eq3) }
    const eq1 = { eq: vi.fn(() => eq2) }
    const select = vi.fn(() => ({ eq: vi.fn(() => eq1) }))
    const from = vi.fn(() => ({ select }))
    return { from } as never
  }

  const conn = { from: 'node-b', to: 'node-a', mode: undefined }

  it('returns the parsed stored vector on a hit', async () => {
    const client = clientReturning({ data: { embedding: '[0.1,0.2]' }, error: null })
    expect(await lookupEdgeQueryVector(client, 'board-1', conn)).toEqual([0.1, 0.2])
  })

  it('degrades to null when no row exists yet (edge just created)', async () => {
    const client = clientReturning({ data: null, error: null })
    expect(await lookupEdgeQueryVector(client, 'board-1', conn)).toBeNull()
  })

  it('degrades to null on query error', async () => {
    const client = clientReturning({ data: null, error: { message: 'boom' } })
    expect(await lookupEdgeQueryVector(client, 'board-1', conn)).toBeNull()
  })
})

describe('fetchRetrievalContext', () => {
  it('calls the RPC with threshold 0 (full band; floor applied client-side)', async () => {
    const rpc = vi.fn(async () => ({ data: [row({})], error: null }))
    const client = { rpc } as never
    const out = await fetchRetrievalContext(client, {
      queryVector: [0.1, 0.2],
      boardId: 'board-1',
      excludedNodeIds: ['a', 'b'],
      liveNodeIds: ['a', 'b', 'c'],
    })
    expect(out).toHaveLength(1)
    expect(rpc).toHaveBeenCalledWith('match_retrieval_context', {
      query_embedding: '[0.1,0.2]',
      p_board_id: 'board-1',
      // RPC threshold is always 0 now — the band is floored client-side.
      p_match_threshold: 0,
      p_total_cap: RETRIEVAL_K,
      p_excluded_node_ids: ['a', 'b'],
      p_live_node_ids: ['a', 'b', 'c'],
    })
  })

  it('passes null live node ids through (disables orphan-drop)', async () => {
    const rpc = vi.fn(async () => ({ data: [], error: null }))
    const client = { rpc } as never
    await fetchRetrievalContext(client, {
      queryVector: [0.1],
      boardId: 'b',
      excludedNodeIds: [],
      liveNodeIds: null,
    })
    const args = (rpc.mock.calls[0] as unknown[])[1] as {
      p_live_node_ids: unknown
    }
    expect(args.p_live_node_ids).toBeNull()
  })

  it('returns [] on RPC error (never breaks the turn)', async () => {
    const rpc = vi.fn(async () => ({ data: null, error: { message: 'boom' } }))
    const client = { rpc } as never
    const out = await fetchRetrievalContext(client, {
      queryVector: [0.1],
      boardId: 'b',
      excludedNodeIds: [],
      liveNodeIds: [],
    })
    expect(out).toEqual([])
  })
})
