import { describe, expect, it } from 'vitest'
import { generateSnapshot, type GenerationInput } from '../generate'
import type { EmbeddingRow, WeaveEventRow } from '../types'

const AT = new Date('2026-09-05T00:00:00Z')
const B1 = 'board-1'
const B2 = 'board-2'

function emb(board: string, nodeId: string, vec: number[], archivedAt: string | null = null): EmbeddingRow {
  return { board_id: board, node_id: nodeId, node_type: 'textCard', embedding: JSON.stringify(vec), content_summary: null, archived_at: archivedAt }
}

function ev(partial: Partial<WeaveEventRow>): WeaveEventRow {
  return {
    id: Math.random().toString(36).slice(2),
    event_type: 'item_added',
    target_id: `node:${B1}:1`,
    board_id: B1,
    session_id: 's1',
    timestamp: AT.toISOString(),
    duration_ms: null,
    metadata: null,
    user_id: 'u1',
    voice_session_id: null,
    ...partial,
  }
}

function input(over: Partial<GenerationInput> = {}): GenerationInput {
  // Two near-identical vectors on different boards cluster together; a third
  // orthogonal node is a singleton; a fourth is archived.
  const embeddingRows = [
    emb(B1, '1', [1, 0.01]),
    emb(B2, '7', [1, 0.02]),
    emb(B1, '2', [0, 1]),
    emb(B1, '3', [1, 0], '2026-08-01T00:00:00Z'),
  ]
  const events = [
    ev({ target_id: `node:${B1}:1` }),
    ev({ target_id: `node:${B2}:7`, board_id: B2 }),
    ev({ target_id: `node:${B2}:7`, board_id: B2 }),
    ev({ target_id: `node:${B1}:3` }), // archived
    ev({ target_id: `node:${B1}:99` }), // absent
    ev({ event_type: 'connection_label_clicked', target_id: `connection:${B1}:1:2` }),
  ]
  return {
    generatedAt: AT,
    options: { anchorCount: 3, uniformWeights: false, pageSize: 500 },
    nodeSet: { source: 'live' },
    embeddingRows,
    embeddingsGate: { rows_returned: 4, rows_expected: 4 },
    events,
    eventsGate: { rows_returned: events.length, rows_expected: events.length },
    eventsByType: { item_added: 5, connection_label_clicked: 1 },
    breadthFrom: '2026-06-27T00:00:00Z',
    voiceSessions: [],
    voiceGate: { rows_returned: 0, rows_expected: 0 },
    depthFrom: '2026-02-07T00:00:00Z',
    voiceAnchors: {},
    ...over,
  }
}

describe('generateSnapshot', () => {
  it('clusters across boards, reports losses, and records provenance', () => {
    const out = generateSnapshot(input())
    expect(out.nodeCount).toBe(3)
    expect(out.clusters).toHaveLength(1)
    expect(out.clusters[0].boards_touched.sort()).toEqual([B1, B2])
    expect(out.clusters[0].anchor_node_ids[0]).toBe(`${B2}:7`)
    expect(out.summary.cross_board_cluster_count).toBe(1)
    expect(out.summary.singletons_dropped).toBe(1)

    const meta = out.generationMetadata as Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(meta.pipeline_version).toBe('v2')
    expect(meta.node_set).toEqual({ source: 'live', keys: [`${B1}:1`, `${B2}:7`, `${B1}:2`], count: 3 })
    expect(meta.attribution).toMatchObject({ resolved: 5, hit: 3, dropped: { archived: 1, absent: 1 } })
    expect(meta.events_unmatched_by_type).toEqual({ connection_label_clicked: 1 })
    expect(meta.pair_asymmetry.connection).toEqual({ opens: 1, closes: 0, paired: 0, orphan_opens: 1, unmatched_closes: 0 })
    expect(meta.parameters).toMatchObject({ anchor_count: 3, uniform_weights: false, page_size: 500, breadth_max: 1.5, h_breadth_days: 14, h_depth_days: 42, k: 5 })

    const anchors = meta.anchors as { key: string; board_id: string; cluster_id: string; top_events: unknown[] }[]
    expect(anchors.map((a) => a.key)).toEqual([`${B2}:7`, `${B1}:1`])
    expect(anchors[0]).toMatchObject({ board_id: B2, cluster_id: 'c1' })
    expect(anchors[0].top_events).toHaveLength(2)
  })

  it('honours anchor_count with Math.min(N, size)', () => {
    const out = generateSnapshot(input({ options: { anchorCount: 1, uniformWeights: false, pageSize: 500 } }))
    expect(out.clusters[0].anchor_node_ids).toEqual([`${B2}:7`])
    const big = generateSnapshot(input({ options: { anchorCount: 10, uniformWeights: false, pageSize: 500 } }))
    expect(big.clusters[0].anchor_node_ids).toHaveLength(2)
  })

  it('uses a pinned node set verbatim and records its source', () => {
    const out = generateSnapshot(input({ nodeSet: { source: 'pinned:snap-1', keys: [`${B1}:1`, `${B1}:3`] } }))
    const meta = out.generationMetadata as Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(meta.node_set).toEqual({ source: 'pinned:snap-1', keys: [`${B1}:1`, `${B1}:3`], count: 2 })
    // The archived node is in the pinned set, so its event is now a hit.
    expect(meta.attribution).toMatchObject({ hit: 2, dropped: { archived: 0, absent: 3 } })
  })

  it('records uniform_weights and page_size in parameters', () => {
    const out = generateSnapshot(input({ options: { anchorCount: 3, uniformWeights: true, pageSize: 50 } }))
    const meta = out.generationMetadata as Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(meta.parameters).toMatchObject({ uniform_weights: true, page_size: 50 })
    // Every hit contributes exactly 1 before decay (age 0 here), so the anchor
    // with two events weighs 2 and the anchor with one weighs 1.
    const anchors = meta.anchors as { key: string; w_total: number }[]
    expect(anchors.find((a) => a.key === `${B2}:7`)?.w_total).toBeCloseTo(2, 10)
    expect(anchors.find((a) => a.key === `${B1}:1`)?.w_total).toBeCloseTo(1, 10)
  })

  it('throws when a pinned key has no embedding row', () => {
    expect(() => generateSnapshot(input({ nodeSet: { source: 'pinned:snap-1', keys: [`${B1}:404`] } }))).toThrow(/pinned node set/)
  })
})
