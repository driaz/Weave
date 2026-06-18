import { describe, expect, it } from 'vitest'
import {
  cosineSimilarity,
  loadDepositCorpus,
  scoreDeposits,
  type DepositCorpusRow,
} from '../depositRetrieval'

function corpusRow(partial: Partial<DepositCorpusRow>): DepositCorpusRow {
  return {
    id: 'd1',
    sessionId: 's1',
    type: 'deposit',
    body: 'a deposit body',
    embedding: [1, 0],
    sourceBoard: null,
    ...partial,
  }
}

describe('cosineSimilarity', () => {
  it('is 1 for identical direction and magnitude-invariant', () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1)
    // Same direction, different magnitude → still 1 (normalized).
    expect(cosineSimilarity([1, 0], [5, 0])).toBeCloseTo(1)
  })
  it('is 0 for orthogonal vectors', () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0)
  })
  it('is -1 for opposite direction', () => {
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1)
  })
  it('returns -1 (sorts last) on dimension mismatch', () => {
    expect(cosineSimilarity([1, 0, 0], [1, 0])).toBe(-1)
  })
  it('returns -1 on a zero-norm vector rather than dividing by zero', () => {
    expect(cosineSimilarity([0, 0], [1, 0])).toBe(-1)
  })
})

describe('scoreDeposits', () => {
  it('ranks all rows by similarity desc with an id tiebreak — no cap, no floor', () => {
    const corpus = [
      corpusRow({ id: 'far', embedding: [0, 1] }), // orthogonal → 0
      corpusRow({ id: 'b-near', embedding: [1, 0] }), // identical → 1
      corpusRow({ id: 'a-near', embedding: [2, 0] }), // identical → 1 (tie, id wins)
    ]
    const ranked = scoreDeposits(corpus, [1, 0])
    // every row is returned (the below-cap rows are the instrument)
    expect(ranked).toHaveLength(3)
    // ties broken by id ascending: 'a-near' before 'b-near'
    expect(ranked.map((r) => r.id)).toEqual(['a-near', 'b-near', 'far'])
    expect(ranked[0].similarity).toBeCloseTo(1)
    expect(ranked[2].similarity).toBeCloseTo(0)
  })

  it('carries type through so open_edge position is observable in the ranking', () => {
    const corpus = [
      corpusRow({ id: 'oe', type: 'open_edge', embedding: [0, 1] }),
      corpusRow({ id: 'dep', type: 'deposit', embedding: [1, 0] }),
    ]
    const ranked = scoreDeposits(corpus, [1, 0])
    expect(ranked.map((r) => [r.id, r.type])).toEqual([
      ['dep', 'deposit'],
      ['oe', 'open_edge'],
    ])
  })
})

describe('loadDepositCorpus', () => {
  function mockClient(tables: {
    deposits: { data: unknown; error: unknown }
    sessions?: { data: unknown }
    edges?: { data: unknown }
  }) {
    return {
      from(table: string) {
        if (table === 'real_voice_session_deposits') {
          return { select: async () => tables.deposits }
        }
        if (table === 'voice_sessions') {
          return { select: () => ({ in: async () => tables.sessions ?? { data: [] } }) }
        }
        if (table === 'edges') {
          return { select: () => ({ in: async () => tables.edges ?? { data: [] } }) }
        }
        throw new Error(`unexpected table ${table}`)
      },
    } as never
  }

  it('parses embeddings, drops unparseable rows, and reports scanned/dropped', async () => {
    const client = mockClient({
      deposits: {
        data: [
          { id: 'd1', session_id: 's1', type: 'deposit', body: 'ok', embedding: '[0.1,0.2]' },
          { id: 'd2', session_id: 's1', type: 'open_edge', body: 'also ok', embedding: [0.3, 0.4] },
          { id: 'd3', session_id: 's1', type: 'deposit', body: 'bad embed', embedding: 'not json' },
        ],
        error: null,
      },
    })
    const { corpus, scanned, dropped } = await loadDepositCorpus(client)
    expect(scanned).toBe(3)
    expect(dropped).toBe(1)
    expect(corpus.map((r) => r.id)).toEqual(['d1', 'd2'])
    expect(corpus[0].embedding).toEqual([0.1, 0.2])
    expect(corpus[1].type).toBe('open_edge')
  })

  it('resolves sourceBoard through the soft anchor join (session → anchor edge → board)', async () => {
    const client = mockClient({
      deposits: {
        data: [
          { id: 'd1', session_id: 's-anchored', type: 'deposit', body: 'x', embedding: [1, 0] },
          { id: 'd2', session_id: 's-noanchor', type: 'deposit', body: 'y', embedding: [0, 1] },
        ],
        error: null,
      },
      sessions: {
        data: [
          { id: 's-anchored', anchor_edge_id: 'e1' },
          { id: 's-noanchor', anchor_edge_id: null },
        ],
      },
      edges: { data: [{ id: 'e1', board_id: 'board-42' }] },
    })
    const { corpus } = await loadDepositCorpus(client)
    const byId = Object.fromEntries(corpus.map((r) => [r.id, r.sourceBoard]))
    expect(byId.d1).toBe('board-42')
    expect(byId.d2).toBeNull() // no anchor → unresolved, never invented
  })

  it('returns an empty corpus on a query error (never breaks the turn)', async () => {
    const client = mockClient({ deposits: { data: null, error: { message: 'boom' } } })
    expect(await loadDepositCorpus(client)).toEqual({ corpus: [], scanned: 0, dropped: 0 })
  })
})
