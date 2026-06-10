import { describe, expect, it, vi } from 'vitest'
import {
  admitToWorkingMemory,
  BLEND_CURRENT,
  BLEND_PRIOR,
  blendQueryVectors,
  buildRelatedMaterial,
  buildWorkingMemoryBlock,
  fetchRetrievalContext,
  filterUnseen,
  formatRetrievalBullet,
  lookupEdgeQueryVector,
  parseStoredEmbedding,
  RELATED_MATERIAL_FRAMING,
  RETRIEVAL_K,
  WORKING_MEMORY_FRAMING,
  workingMemoryKey,
  type RetrievalRow,
  type WorkingMemoryAdmitInfo,
  type WorkingMemoryEntry,
  type WorkingMemoryOverflowInfo,
} from '../retrievalContext'
import { buildSystemPrompt } from '../buildSystemPrompt'

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

  it('leaves under-budget content unchanged, no ellipsis', () => {
    const short = 'A complete thought that fits well within the budget.'
    const out = buildRelatedMaterial([row({ content: short })])!
    expect(out).toContain(`- ${short}`)
    expect(out).not.toContain('…')
  })

  it('clips over-budget content at the last sentence end within budget', () => {
    // Sentences of 80 chars each: 8 fit fully in 600 (640 > 600 → clip lands
    // mid-sentence-8, last terminator is sentence 7's at index 559 > 300).
    const sentence = `Sentence about meaning${'x'.repeat(57)}.`
    const long = Array.from({ length: 10 }, () => sentence).join('')
    const out = buildRelatedMaterial([row({ content: long })])!
    const line = out.split('\n').find((l) => l.startsWith('- '))!
    expect(line.endsWith('.…')).toBe(true)
    expect(line.length).toBeLessThanOrEqual(2 + 600 + 1) // "- " + budget + "…"
    expect(line).not.toContain(sentence.repeat(8))
  })

  it('clips at a word boundary when no sentence end is in budget', () => {
    const long = Array.from({ length: 100 }, (_, i) => `word${i}`).join(' ')
    const out = buildRelatedMaterial([row({ content: long })])!
    const line = out.split('\n').find((l) => l.startsWith('- '))!
    expect(line.endsWith('…')).toBe(true)
    // No mid-word cut: everything before the ellipsis is whole words.
    expect(line.slice(2, -1).split(' ').every((w) => /^word\d+$/.test(w))).toBe(true)
  })

  it('hard-clips unbreakable content (no sentence or word boundary)', () => {
    const long = 'x'.repeat(700)
    const out = buildRelatedMaterial([row({ content: long })])!
    expect(out).toContain(`- ${'x'.repeat(600)}…`)
    expect(out).not.toContain('x'.repeat(601))
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

describe('working memory (SURFACED THIS SESSION)', () => {
  it('stores the byte-identical line RELATED MATERIAL rendered', () => {
    const r = row({ content: 'some saved node content here' })
    expect(buildRelatedMaterial([r])!).toContain(formatRetrievalBullet(r.content))
  })

  it('admits each refId at most once across turns (novelty filter is the only dedupe)', () => {
    const memory = new Map<string, WorkingMemoryEntry>()
    const seen = new Set<string>()

    // Turn 1: r1 surfaces.
    const turn1 = filterUnseen([row({ ref_id: 'r1', content: 'first content here' })], seen)
    turn1.forEach((r) => seen.add(r.ref_id))
    admitToWorkingMemory(memory, turn1, 'b1', 1)

    // Turn 2: the RPC returns r1 again plus r2; the novelty filter strips r1
    // before admission, exactly as in runRetrieval.
    const turn2 = filterUnseen(
      [
        row({ ref_id: 'r1', content: 'first content here' }),
        row({ ref_id: 'r2', content: 'second content here' }),
      ],
      seen,
    )
    turn2.forEach((r) => seen.add(r.ref_id))
    admitToWorkingMemory(memory, turn2, 'b1', 2)

    expect([...memory.keys()]).toEqual([
      workingMemoryKey('node', 'b1', 'r1'),
      workingMemoryKey('node', 'b1', 'r2'),
    ])
    expect(memory.get(workingMemoryKey('node', 'b1', 'r1'))!.surfacedAtTurn).toBe(1) // untouched by turn 2
  })

  it('same refId from different boards coexist as distinct identities', () => {
    const memory = new Map<string, WorkingMemoryEntry>()
    admitToWorkingMemory(memory, [row({ ref_id: '16', content: 'board one node content' })], 'b1', 1)
    admitToWorkingMemory(memory, [row({ ref_id: '16', content: 'board two node content' })], 'b2', 2)

    expect(memory.size).toBe(2)
    expect(memory.get(workingMemoryKey('node', 'b1', '16'))!.content).toContain('board one')
    expect(memory.get(workingMemoryKey('node', 'b2', '16'))!.content).toContain('board two')
  })

  it('same (refType, sourceBoard, refId) admitted twice is still once-per-identity', () => {
    const memory = new Map<string, WorkingMemoryEntry>()
    const r = row({ ref_id: 'r1', content: 'identical identity content' })
    admitToWorkingMemory(memory, [r], 'b1', 1)
    admitToWorkingMemory(memory, [r], 'b1', 2)
    expect(memory.size).toBe(1)
  })

  it('overflow guard drops oldest entries (by surfacedAtTurn) and reports', () => {
    const memory = new Map<string, WorkingMemoryEntry>()
    const overflows: WorkingMemoryOverflowInfo[] = []
    // 598-char content → 600-char bullet ("- " prefix, under the truncate budget).
    const big = (id: string): RetrievalRow => row({ ref_id: id, content: 'y'.repeat(598) })

    for (let turn = 1; turn <= 13; turn++) {
      admitToWorkingMemory(memory, [big(`r${turn}`)], 'b1', turn, (info) => overflows.push(info))
    }
    expect(overflows).toHaveLength(0) // 13 × 600 = 7800 ≤ 8000

    admitToWorkingMemory(memory, [big('r14')], 'b1', 14, (info) => overflows.push(info))
    expect(overflows).toHaveLength(1) // 8400 > 8000 → guard fires
    expect(overflows[0]).toEqual({ sizeChars: 7800, entryCount: 13, incomingChars: 600 })
    expect(memory.has(workingMemoryKey('node', 'b1', 'r1'))).toBe(false) // oldest evicted...
    expect(memory.has(workingMemoryKey('node', 'b1', 'r2'))).toBe(true) // ...and only the oldest (7800 fits)
    expect(memory.has(workingMemoryKey('node', 'b1', 'r14'))).toBe(true)
    expect(memory.size).toBe(13)
  })

  it('onAdmit fires per entry with cumulative store stats', () => {
    const memory = new Map<string, WorkingMemoryEntry>()
    const admits: WorkingMemoryAdmitInfo[] = []
    const rows = [
      row({ ref_id: 'r1', content: 'x'.repeat(98) }), // bullet = 100 chars
      row({ ref_id: 'r2', content: 'x'.repeat(198) }), // bullet = 200 chars
    ]
    admitToWorkingMemory(memory, rows, 'b1', 3, undefined, (info) => admits.push(info))

    expect(admits).toEqual([
      {
        refId: 'r1',
        refType: 'node',
        sourceBoard: 'b1',
        surfacedAtTurn: 3,
        chars: 100,
        storeSizeAfterChars: 100, // cumulative, not final-state
        entryCountAfter: 1,
      },
      {
        refId: 'r2',
        refType: 'node',
        sourceBoard: 'b1',
        surfacedAtTurn: 3,
        chars: 200,
        storeSizeAfterChars: 300,
        entryCountAfter: 2,
      },
    ])
  })

  it('onAdmit and onOverflow both fire on an admission that evicts', () => {
    const memory = new Map<string, WorkingMemoryEntry>()
    const admits: WorkingMemoryAdmitInfo[] = []
    const overflows: WorkingMemoryOverflowInfo[] = []
    const big = (id: string): RetrievalRow => row({ ref_id: id, content: 'y'.repeat(598) })

    for (let turn = 1; turn <= 14; turn++) {
      admitToWorkingMemory(
        memory,
        [big(`r${turn}`)],
        'b1',
        turn,
        (info) => overflows.push(info),
        (info) => admits.push(info),
      )
    }

    expect(overflows).toHaveLength(1) // eviction still fires (14 × 600 > 8000)
    expect(admits).toHaveLength(14) // every entry still logged as admitted
    // The 14th admission's stats reflect the post-eviction store.
    expect(admits[13]).toMatchObject({
      refId: 'r14',
      sourceBoard: 'b1',
      storeSizeAfterChars: 7800,
      entryCountAfter: 13,
    })
  })

  it('empty store renders nothing', () => {
    expect(buildWorkingMemoryBlock([])).toBeNull()
  })

  it("renders 'node' entries; throws on refTypes with no renderer yet", () => {
    const entry: WorkingMemoryEntry = {
      refType: 'node',
      refId: 'r1',
      sourceBoard: 'b1',
      content: '- saved thing',
      surfacedAtTurn: 1,
    }
    const out = buildWorkingMemoryBlock([entry])!
    // Byte-identity: sourceBoard is ledger metadata, never prompt content.
    expect(out).toBe(`${WORKING_MEMORY_FRAMING}\n\n- saved thing`)
    expect(() => buildWorkingMemoryBlock([{ ...entry, refType: 'edge' }])).toThrow(
      /no renderer/,
    )
  })

  it('integration: node surfaced on the opening persists into an empty-retrieval follow-up prompt', () => {
    const memory = new Map<string, WorkingMemoryEntry>()
    const seen = new Set<string>()

    // Opening turn: one node clears the floor and renders in RELATED MATERIAL.
    const surfaced = row({
      ref_id: 'n7',
      content: 'The Odyssey trailer — tell me what you remember',
    })
    const novel = filterUnseen([surfaced], seen)
    const openingBlock = buildRelatedMaterial(novel)!
    novel.forEach((r) => seen.add(r.ref_id))
    admitToWorkingMemory(memory, novel, 'board-1', 1)

    // Follow-up turn: retrieval comes back empty (e.g. a meta-question whose
    // embedding clears nothing above the floor) — the orchestrator rebuild
    // path's exact inputs:
    const followUpPrompt = buildSystemPrompt({
      role: 'ROLE',
      cadence: 'CADENCE-FOLLOWUP',
      connectionContext: 'CONN',
      nodeContent: 'NODES',
      relatedMaterial: undefined,
      workingMemory: buildWorkingMemoryBlock([...memory.values()]) ?? undefined,
    })

    const expectedBullet = formatRetrievalBullet(surfaced.content)
    expect(followUpPrompt).toContain('SURFACED THIS SESSION')
    expect(followUpPrompt).toContain(expectedBullet)
    expect(openingBlock).toContain(expectedBullet) // same line both turns
    expect(followUpPrompt).not.toContain('RELATED MATERIAL')
  })
})
