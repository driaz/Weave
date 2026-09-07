import { describe, expect, it } from 'vitest'
import { attentionFor, turnsFor } from '../attention'
import { buildConversations, generateSnapshot, placementFor, type GenerationInput } from '../generate'
import type { EmbeddingRow, VoiceSessionRow, WeaveEventRow } from '../types'

const AT = new Date('2026-09-06T00:00:00Z')
const B1 = 'board-1'
const B2 = 'board-2'

function emb(board: string, nodeId: string, vec: number[]): EmbeddingRow {
  return { board_id: board, node_id: nodeId, node_type: 'linkCard', embedding: JSON.stringify(vec), content_summary: 's', archived_at: null }
}
function ev(id: string, target: string, board: string = B1): WeaveEventRow {
  return { id, event_type: 'item_added', target_id: target, board_id: board, session_id: 's1', timestamp: AT.toISOString(), duration_ms: null, metadata: null, user_id: 'u', voice_session_id: null }
}
function voice(id: string, target: string, turns: number): VoiceSessionRow {
  return { session_id: id, anchor_edge_id: `edge-${id}`, ended_at: AT.toISOString(), user_turns: turns, anchor_target: target, board_id: B1 }
}

function baseInput(over: Partial<GenerationInput>): GenerationInput {
  return {
    generatedAt: AT,
    options: { anchorCount: 3, uniformWeights: false, pageSize: 500 },
    nodeSet: { source: 'live' },
    embeddingRows: [],
    embeddingsGate: { rows_returned: 0, rows_expected: 0 },
    events: [],
    eventsGate: { rows_returned: 0, rows_expected: 0 },
    eventsByType: {},
    breadthFrom: '2026-06-28T00:00:00Z',
    voiceSessions: [],
    voiceGate: { rows_returned: 0, rows_expected: 0 },
    depthFrom: '2026-02-08T00:00:00Z',
    voiceAnchors: {},
    boards: [{ id: B1, name: 'One' }, { id: B2, name: 'Two' }],
    boardsGate: { rows_returned: 2, rows_expected: 2 },
    ...over,
  }
}

// Two pairs that cluster with each other and not across pairs.
const PAIR_A = [emb(B1, '1', [1, 0, 0]), emb(B2, '2', [1, 0.01, 0])]
const PAIR_B = [emb(B1, '3', [0, 1, 0]), emb(B2, '4', [0, 1, 0.01])]
const SINGLES = [emb(B1, '5', [0, 0, 1]), emb(B1, '6', [1, 1, 0]), emb(B2, '7', [1, -1, 0])]

describe('Decision A — anchors require w_total > 0', () => {
  it('cluster of 2 with one zero-weight member has 1 anchor; all-zero cluster has 0', () => {
    const out = generateSnapshot(baseInput({
      embeddingRows: [...PAIR_A, ...PAIR_B],
      embeddingsGate: { rows_returned: 4, rows_expected: 4 },
      events: [ev('e1', `node:${B1}:1`)],
      eventsGate: { rows_returned: 1, rows_expected: 1 },
      eventsByType: { item_added: 1 },
    }))
    expect(out.clusters).toHaveLength(2)
    const a = out.clusters.find((c) => c.member_node_ids.includes(`${B1}:1`))!
    const b = out.clusters.find((c) => c.member_node_ids.includes(`${B1}:3`))!
    expect(a.anchor_node_ids).toEqual([`${B1}:1`])
    expect(b.anchor_node_ids).toEqual([])
    expect(b.engagement_weight).toBe(0)
    expect(out.summary.anchor_count).toBe(1)
    const meta = out.generationMetadata as { anchors: { key: string; attention: string; turns?: number }[] }
    expect(meta.anchors).toHaveLength(1)
    expect(meta.anchors[0]).toMatchObject({ key: `${B1}:1`, attention: 'added' })
    expect(meta.anchors[0].turns).toBeUndefined()
  })
})

describe('attention', () => {
  it('labels by largest class, ties to dwelt', () => {
    expect(attentionFor({ breadth: 1, depth: 0.5, recency: 0 })).toBe('dwelt')
    expect(attentionFor({ breadth: 0.2, depth: 1, recency: 0 })).toBe('discussed')
    expect(attentionFor({ breadth: 0, depth: 0, recency: 0.2 })).toBe('added')
    expect(attentionFor({ breadth: 1, depth: 1, recency: 0 })).toBe('dwelt')
    expect(attentionFor({ breadth: 0, depth: 1, recency: 1 })).toBe('dwelt')
    expect(attentionFor({ breadth: 0, depth: 0, recency: 0 })).toBe('dwelt')
  })
  it('sums user_turns over voice contributions only', () => {
    expect(turnsFor([
      { event_type: 'voice_session', class: 'depth', w_rule: 1, w_eff: 1, age_days: 0, user_turns: 4 },
      { event_type: 'voice_session', class: 'depth', w_rule: 1, w_eff: 1, age_days: 0, user_turns: 9 },
      { event_type: 'lightbox_closed', class: 'breadth', w_rule: 1, w_eff: 1, age_days: 0 },
    ])).toBe(13)
  })
  it('a discussed anchor carries turns; event-sourced top_events carry event_id', () => {
    const out = generateSnapshot(baseInput({
      embeddingRows: [...PAIR_A],
      embeddingsGate: { rows_returned: 2, rows_expected: 2 },
      events: [ev('evt-42', `node:${B1}:1`)],
      eventsGate: { rows_returned: 1, rows_expected: 1 },
      eventsByType: { item_added: 1 },
      voiceSessions: [voice('vs-1', `connection:${B1}:1:9`, 7), voice('vs-2', `connection:${B1}:1:9`, 5)],
      voiceGate: { rows_returned: 2, rows_expected: 2 },
    }))
    const meta = out.generationMetadata as { anchors: { key: string; attention: string; turns?: number; top_events: { event_id?: string; voice_session_id?: string }[] }[] }
    const a = meta.anchors.find((x) => x.key === `${B1}:1`)!
    expect(a.attention).toBe('discussed')
    expect(a.turns).toBe(12)
    expect(a.top_events.map((t) => t.event_id ?? t.voice_session_id).sort()).toEqual(['evt-42', 'vs-1', 'vs-2'])
  })
})

describe('Decision B — unclustered_attended', () => {
  it('lists engaged singletons only, ranked by w_total', () => {
    const out = generateSnapshot(baseInput({
      embeddingRows: [...SINGLES],
      embeddingsGate: { rows_returned: 3, rows_expected: 3 },
      events: [ev('e1', `node:${B1}:5`), ev('e2', `node:${B1}:6`), ev('e3', `node:${B1}:6`)],
      eventsGate: { rows_returned: 3, rows_expected: 3 },
      eventsByType: { item_added: 3 },
    }))
    expect(out.clusters).toHaveLength(0)
    const meta = out.generationMetadata as { unclustered_attended: { key: string; w_total: number; attention: string }[] }
    expect(meta.unclustered_attended.map((u) => u.key)).toEqual([`${B1}:6`, `${B1}:5`])
    expect(meta.unclustered_attended[0].w_total).toBeGreaterThan(meta.unclustered_attended[1].w_total)
    expect(meta.unclustered_attended[0].attention).toBe('added')
    expect(out.summary.unclustered_attended_count).toBe(2)
  })
})

describe('conversations', () => {
  const clusterOf = new Map<string, string>([[`${B1}:1`, 'c1'], [`${B2}:2`, 'c1'], [`${B1}:3`, 'c2']])
  it('places each pair', () => {
    expect(placementFor([`${B1}:1`, `${B2}:2`], clusterOf)).toBe('same_cluster:c1')
    expect(placementFor([`${B1}:1`, `${B1}:3`], clusterOf)).toBe('cross_cluster:c1,c2')
    expect(placementFor([`${B1}:1`, `${B1}:9`], clusterOf)).toBe('cluster_and_singleton:c1')
    expect(placementFor([`${B1}:9`, `${B1}:3`], clusterOf)).toBe('cluster_and_singleton:c2')
    expect(placementFor([`${B1}:8`, `${B1}:9`], clusterOf)).toBe('both_singletons')
  })
  it('records one entry per voice session with edge identity and endpoints', () => {
    const out = buildConversations([voice('vs-1', `connection:${B1}:1:9`, 7)], clusterOf, 1)
    expect(out).toEqual([{
      voice_session_id: 'vs-1', edge_id: `connection:${B1}:1:9`, anchor_edge_id: 'edge-vs-1', ended_at: AT.toISOString(),
      user_turns: 7, endpoints: [`${B1}:1`, `${B1}:9`], placement: 'cluster_and_singleton:c1',
    }])
  })
  it('throws when the count differs from rows_returned', () => {
    expect(() => buildConversations([voice('vs-1', `connection:${B1}:1:9`, 7)], clusterOf, 2)).toThrow(/conversations cardinality/)
  })
  it('throws when an anchor target does not resolve to two endpoints', () => {
    expect(() => buildConversations([voice('vs-1', `node:${B1}:1`, 7)], clusterOf, 1)).toThrow(/two endpoints/)
  })
})
