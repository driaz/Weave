import { describe, expect, it } from 'vitest'
import {
  ANCHOR_COUNT,
  BREADTH_MAX,
  H_BREADTH_DAYS,
  H_DEPTH_DAYS,
  MIN_REAL_TURNS,
  VOICE_BASE,
} from '../constants'
import {
  ENGAGEMENT_RULES,
  assertAttributionCardinality,
  attribute,
  buildWeightMap,
  decay,
  dwellWeight,
  fromVoiceSession,
  fromWeaveEvent,
  pairAsymmetry,
  resolveEdgeTarget,
  resolveEvents,
  voiceWeight,
} from '../engagement'
import type { EmbeddingRow, VoiceSessionRow, WeaveEventRow } from '../types'

const BOARD = 'b1'
const AT = new Date('2026-09-05T00:00:00Z')
const daysAgo = (d: number) => new Date(AT.getTime() - d * 86_400_000).toISOString()

function event(partial: Partial<WeaveEventRow>): WeaveEventRow {
  return {
    id: 'e1',
    event_type: 'item_added',
    target_id: `node:${BOARD}:1`,
    board_id: BOARD,
    session_id: 's1',
    timestamp: AT.toISOString(),
    duration_ms: null,
    metadata: null,
    user_id: 'u1',
    voice_session_id: null,
    ...partial,
  }
}

function emb(nodeId: string, archivedAt: string | null = null): EmbeddingRow {
  return { board_id: BOARD, node_id: nodeId, node_type: 'textCard', embedding: '[1,0]', content_summary: null, archived_at: archivedAt }
}

describe('roster', () => {
  it('has exactly four rules', () => {
    expect(Object.keys(ENGAGEMENT_RULES).sort()).toEqual(
      ['connection_description_closed', 'item_added', 'lightbox_closed', 'voice_session'].sort(),
    )
  })
  it('does not carry the removed types', () => {
    for (const t of ['connection_label_clicked', 'lightbox_opened', 'node_selected', 'weave_triggered']) {
      expect(ENGAGEMENT_RULES[t]).toBeUndefined()
    }
  })
  it('derives VOICE_BASE so MIN_REAL_TURNS turns equal one maximal breadth act', () => {
    expect(voiceWeight(MIN_REAL_TURNS)).toBeCloseTo(BREADTH_MAX, 10)
    expect(VOICE_BASE).toBeCloseTo(BREADTH_MAX / Math.log2(MIN_REAL_TURNS + 1), 12)
  })
})

describe('decay', () => {
  it('halves at one half-life', () => {
    expect(decay(1, H_BREADTH_DAYS, H_BREADTH_DAYS)).toBeCloseTo(0.5, 12)
  })
  it('returns w at age 0', () => {
    expect(decay(0.7, 0, H_BREADTH_DAYS)).toBe(0.7)
  })
  it('voice with MIN_REAL_TURNS turns at 14 d on the depth clock is about 1.19', () => {
    expect(decay(voiceWeight(MIN_REAL_TURNS), 14, H_DEPTH_DAYS)).toBeCloseTo(1.19, 2)
  })
  it('a maximal breadth act at 14 d is 0.75', () => {
    expect(decay(BREADTH_MAX, 14, H_BREADTH_DAYS)).toBeCloseTo(0.75, 12)
  })
})

describe('curves', () => {
  it('dwell curve: 1 s, 20 s, 45 s, 100 s (cap)', () => {
    expect(dwellWeight(1_000)).toBeCloseTo(BREADTH_MAX * (Math.log2(2) / Math.log2(46)), 10)
    expect(dwellWeight(20_000)).toBeCloseTo(BREADTH_MAX * (Math.log2(21) / Math.log2(46)), 10)
    expect(dwellWeight(45_000)).toBeCloseTo(BREADTH_MAX, 10)
    expect(dwellWeight(100_000)).toBeCloseTo(BREADTH_MAX, 10)
    expect(dwellWeight(0)).toBe(0)
    expect(dwellWeight(null)).toBe(0)
  })
  it('voice curve at 4 / 8 / 15 / 23 / 47 turns follows the derived VOICE_BASE', () => {
    // Dispatch R1 pre-registered 1.5 / 2.06 / 2.60 / 2.98 / 3.62 (+-0.01). Those
    // were computed with VOICE_BASE rounded to 0.65; the ratified derivation
    // (BREADTH_MAX / log2(MIN_REAL_TURNS + 1) = 0.6460) gives the values below.
    // At 8, 15, 23 and 47 turns the rounded figures fall 0.012-0.018 outside
    // the derived curve. Flagged in the PR as a dispatch contradiction.
    const expected: Record<number, number> = { 4: 1.5, 8: 2.048, 15: 2.584, 23: 2.962, 47: 3.608 }
    for (const [turns, w] of Object.entries(expected)) {
      expect(voiceWeight(Number(turns))).toBeCloseTo(w, 2)
    }
    expect(voiceWeight(0)).toBe(0)
  })
})

describe('uniform weights', () => {
  it('gives every resolving event w_rule = 1 across a mixed fixture, leaving keys and classes intact', () => {
    const events = [
      fromWeaveEvent(event({ id: 'a', event_type: 'lightbox_closed', target_id: `node:${BOARD}:1`, duration_ms: 45_000 })),
      fromWeaveEvent(event({ id: 'b', event_type: 'connection_description_closed', target_id: `connection:${BOARD}:1:2`, duration_ms: 2_000 })),
      fromWeaveEvent(event({ id: 'c', event_type: 'item_added', target_id: `node:${BOARD}:3` })),
      fromVoiceSession({ session_id: 'vs1', anchor_edge_id: 'e', ended_at: AT.toISOString(), user_turns: 23, anchor_target: `connection:${BOARD}:1:2`, board_id: BOARD }),
    ]
    const weighted = resolveEvents(events).resolved
    const uniform = resolveEvents(events, { uniformWeights: true }).resolved
    expect(new Set(weighted.map((r) => r.w_rule)).size).toBe(4)
    expect(uniform.map((r) => r.w_rule)).toEqual([1, 1, 1, 1])
    expect(uniform.map((r) => r.keys)).toEqual(weighted.map((r) => r.keys))
    expect(uniform.map((r) => r.class)).toEqual(weighted.map((r) => r.class))
  })
  it('a zero-turn voice session still weighs 1 under uniform weights', () => {
    const { resolved } = resolveEvents(
      [fromVoiceSession({ session_id: 'vs0', anchor_edge_id: 'e', ended_at: AT.toISOString(), user_turns: 0, anchor_target: `connection:${BOARD}:1:2`, board_id: BOARD })],
      { uniformWeights: true },
    )
    expect(resolved[0].w_rule).toBe(1)
  })
})

describe('edge resolution', () => {
  it('one edge event resolves to two endpoint keys and keeps the edge id', () => {
    const target = `connection:${BOARD}:4:9`
    expect(resolveEdgeTarget(target)).toEqual([`${BOARD}:4`, `${BOARD}:9`])
    const { resolved } = resolveEvents([
      fromWeaveEvent(event({ event_type: 'connection_description_closed', target_id: target, duration_ms: 3_000 })),
    ])
    expect(resolved).toHaveLength(1)
    expect(resolved[0].keys).toEqual([`${BOARD}:4`, `${BOARD}:9`])
    expect(resolved[0].edge_id).toBe(target)
    expect(resolved[0].class).toBe('breadth')
  })
  it('rejects malformed connection targets', () => {
    expect(resolveEdgeTarget(`connection:${BOARD}:4`)).toEqual([])
    expect(resolveEdgeTarget(`node:${BOARD}:4`)).toEqual([])
    expect(resolveEdgeTarget(null)).toEqual([])
  })
  it('a voice session resolves through the same edge resolver with depth class and provenance', () => {
    const vs: VoiceSessionRow = {
      session_id: 'vs1',
      anchor_edge_id: 'edge-uuid',
      ended_at: AT.toISOString(),
      user_turns: 4,
      anchor_target: `connection:${BOARD}:4:9`,
      board_id: BOARD,
    }
    const { resolved } = resolveEvents([fromVoiceSession(vs)])
    expect(resolved[0].class).toBe('depth')
    expect(resolved[0].keys).toEqual([`${BOARD}:4`, `${BOARD}:9`])
    expect(resolved[0].w_rule).toBeCloseTo(BREADTH_MAX, 10)
    expect(resolved[0].event.voice_session_id).toBe('vs1')
    expect(resolved[0].event.user_turns).toBe(4)
  })
})

describe('attribution', () => {
  it('counts one hit, one archived, one absent and satisfies the cardinality assert', () => {
    const rows = [emb('1'), emb('2', '2026-08-01T00:00:00Z')]
    const map = buildWeightMap(rows)
    expect(Object.keys(map.weights)).toEqual([`${BOARD}:1`])
    expect(map.archived.has(`${BOARD}:2`)).toBe(true)

    const { resolved } = resolveEvents([
      fromWeaveEvent(event({ id: 'a', target_id: `node:${BOARD}:1` })),
      fromWeaveEvent(event({ id: 'b', target_id: `node:${BOARD}:2` })),
      fromWeaveEvent(event({ id: 'c', target_id: `node:${BOARD}:3` })),
    ])
    const out = attribute(resolved, map, AT)
    expect(out.attribution).toMatchObject({ resolved: 3, hit: 1, dropped: { archived: 1, absent: 1 } })
    expect(out.attribution.by_type.item_added).toEqual({ resolved: 3, hit: 1, archived: 1, absent: 1 })
    expect(out.weights[`${BOARD}:1`]).toBeCloseTo(0.2, 12)
    expect(out.byClass[`${BOARD}:1`].recency).toBeCloseTo(0.2, 12)
    expect(out.contributions[`${BOARD}:1`]).toHaveLength(1)
  })
  it('decays each event before aggregation and records provenance per class', () => {
    const map = buildWeightMap([emb('1'), emb('2')])
    const { resolved } = resolveEvents([
      fromWeaveEvent(event({ id: 'a', event_type: 'lightbox_closed', target_id: `node:${BOARD}:1`, duration_ms: 45_000, timestamp: daysAgo(14) })),
      fromVoiceSession({ session_id: 'vs1', anchor_edge_id: 'e', ended_at: daysAgo(14), user_turns: 4, anchor_target: `connection:${BOARD}:1:2`, board_id: BOARD }),
    ])
    const out = attribute(resolved, map, AT)
    const k1 = `${BOARD}:1`
    expect(out.byClass[k1].breadth).toBeCloseTo(0.75, 10)
    expect(out.byClass[k1].depth).toBeCloseTo(1.19, 2)
    expect(out.weights[k1]).toBeCloseTo(0.75 + decay(BREADTH_MAX, 14, H_DEPTH_DAYS), 10)
    const voiceContribution = out.contributions[k1].find((c) => c.class === 'depth')
    expect(voiceContribution).toMatchObject({ voice_session_id: 'vs1', user_turns: 4, edge_id: `connection:${BOARD}:1:2` })
  })
  it('throws on a deliberately broken map', () => {
    // Classification is exhaustive by construction, so the assert is
    // exercised two ways: a map whose classifier fails propagates fail-loud,
    // and a fabricated mismatched tally trips the assert itself.
    const map = buildWeightMap([emb('1')])
    const broken = {
      weights: map.weights,
      archived: { has: () => { throw new Error('classifier exploded') } } as unknown as Set<string>,
    }
    const { resolved } = resolveEvents([fromWeaveEvent(event({ target_id: `node:${BOARD}:9` }))])
    expect(() => attribute(resolved, broken, AT)).toThrow(/classifier exploded/)

    expect(() =>
      assertAttributionCardinality({ resolved: 3, hit: 1, dropped: { archived: 1, absent: 0 }, by_type: {}, zero_weight_events: 0 }),
    ).toThrow(/cardinality failed: resolved 3 != hit 1 \+ archived 1 \+ absent 0/)
    expect(() =>
      assertAttributionCardinality({
        resolved: 2, hit: 1, dropped: { archived: 1, absent: 0 }, zero_weight_events: 0,
        by_type: { item_added: { resolved: 2, hit: 1, archived: 0, absent: 0 } },
      }),
    ).toThrow(/cardinality failed for item_added/)
  })
  it('skips zero-weight events without counting them', () => {
    const map = buildWeightMap([emb('1')])
    const { resolved } = resolveEvents([
      fromWeaveEvent(event({ event_type: 'lightbox_closed', target_id: `node:${BOARD}:1`, duration_ms: 0 })),
    ])
    const { attribution } = attribute(resolved, map, AT)
    expect(attribution.resolved).toBe(0)
    expect(attribution.zero_weight_events).toBe(1)
  })
})

describe('pair asymmetry', () => {
  const open = (id: string, target: string, ts: string) =>
    event({ id, event_type: 'connection_label_clicked', target_id: target, timestamp: ts })
  const close = (id: string, target: string, ts: string) =>
    event({ id, event_type: 'connection_description_closed', target_id: target, timestamp: ts })
  const T = `connection:${BOARD}:4:9`

  it('pairs a close that precedes its open by 1 ms', () => {
    const out = pairAsymmetry([close('x', T, '2026-09-01T00:00:00.000Z'), open('c', T, '2026-09-01T00:00:00.001Z')])
    expect(out.connection).toEqual({ opens: 1, closes: 1, paired: 1, orphan_opens: 0, unmatched_closes: 0 })
  })
  it('counts a genuine orphan open', () => {
    const out = pairAsymmetry([open('c', T, '2026-09-01T00:00:00Z')])
    expect(out.connection).toEqual({ opens: 1, closes: 0, paired: 0, orphan_opens: 1, unmatched_closes: 0 })
  })
  it('counts a genuine unmatched close', () => {
    const out = pairAsymmetry([close('x', T, '2026-09-01T00:00:00Z')])
    expect(out.connection).toEqual({ opens: 0, closes: 1, paired: 0, orphan_opens: 0, unmatched_closes: 1 })
  })
  it('groups per (session_id, target_id) and reports the lightbox pair separately', () => {
    const out = pairAsymmetry([
      open('c1', T, '2026-09-01T00:00:00Z'),
      close('x1', T, '2026-09-01T00:00:01Z'),
      open('c2', T, '2026-09-01T00:00:02Z'),
      event({ id: 'c3', event_type: 'connection_label_clicked', target_id: T, session_id: 's2' }),
      event({ id: 'l1', event_type: 'lightbox_opened', target_id: `node:${BOARD}:1` }),
      event({ id: 'l2', event_type: 'lightbox_closed', target_id: `node:${BOARD}:1`, duration_ms: 5 }),
    ])
    expect(out.connection).toEqual({ opens: 3, closes: 1, paired: 1, orphan_opens: 2, unmatched_closes: 0 })
    expect(out.lightbox).toEqual({ opens: 1, closes: 1, paired: 1, orphan_opens: 0, unmatched_closes: 0 })
  })
})

describe('constants', () => {
  it('anchor count is 3', () => {
    expect(ANCHOR_COUNT).toBe(3)
  })
})
