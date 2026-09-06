// Pure engagement layer: rules, resolvers, decay, weight map, attribution,
// pair asymmetry. Inputs are plain data; no I/O lives here.

import {
  BREADTH_MAX,
  DWELL_LOG_DIVISOR,
  H_BREADTH_DAYS,
  H_DEPTH_DAYS,
  ITEM_ADDED_WEIGHT,
  MS_PER_DAY,
  VOICE_BASE,
} from './constants'
import type {
  Attribution,
  AttributeResult,
  Contribution,
  EmbeddingRow,
  EngagementClass,
  EngagementEvent,
  PairAsymmetry,
  PairCounters,
  PerTypeAttribution,
  ResolvedEvent,
  VoiceSessionRow,
  WeaveEventRow,
  WeightMap,
} from './types'

// ---------------------------------------------------------------------------
// Curves
// ---------------------------------------------------------------------------

/** Breadth curve: BREADTH_MAX x min(log2(s+1) / log2(DWELL_CAP_S+1), 1). */
export function dwellWeight(durationMs: number | null): number {
  if (!durationMs || durationMs <= 0) return 0
  const seconds = durationMs / 1000
  const scale = Math.min(Math.log2(seconds + 1) / DWELL_LOG_DIVISOR, 1.0)
  return BREADTH_MAX * scale
}

/** Depth curve: VOICE_BASE x log2(user_turns + 1). No cap, no floor. */
export function voiceWeight(userTurns: number | null): number {
  if (userTurns === null || userTurns < 0) return 0
  return VOICE_BASE * Math.log2(userTurns + 1)
}

/** w_eff = w_rule x 2^(-age / H). */
export function decay(wRule: number, ageDays: number, halfLifeDays: number): number {
  return wRule * Math.pow(2, -ageDays / halfLifeDays)
}

export function halfLifeFor(cls: EngagementClass): number {
  return cls === 'depth' ? H_DEPTH_DAYS : H_BREADTH_DAYS
}

export function ageDays(occurredAt: string, generatedAt: Date): number {
  return (generatedAt.getTime() - new Date(occurredAt).getTime()) / MS_PER_DAY
}

// ---------------------------------------------------------------------------
// Resolvers. target_id formats:
//   node:{board_id}:{node_id}
//   connection:{board_id}:{from_node_id}:{to_node_id}
// ---------------------------------------------------------------------------

export function resolveNodeTarget(targetId: string | null): string[] {
  if (!targetId) return []
  // Only accept the prefixed form; reject connection and legacy formats.
  if (!targetId.startsWith('node:')) return []
  return [targetId.slice('node:'.length)]
}

/** The one edge resolver: both endpoint composite keys of a connection target. */
export function resolveEdgeTarget(targetId: string | null): string[] {
  if (!targetId) return []
  const parts = targetId.split(':')
  if (parts.length !== 4 || parts[0] !== 'connection') return []
  const [, boardId, fromId, toId] = parts
  return [`${boardId}:${fromId}`, `${boardId}:${toId}`]
}

// ---------------------------------------------------------------------------
// Roster: exactly four rules
// ---------------------------------------------------------------------------

export type EngagementRule = {
  class: EngagementClass
  resolve: (event: EngagementEvent) => string[]
  weight: (event: EngagementEvent) => number
}

export const VOICE_SESSION_EVENT_TYPE = 'voice_session'

export const ENGAGEMENT_RULES: Record<string, EngagementRule> = {
  lightbox_closed: {
    class: 'breadth',
    resolve: (e) => resolveNodeTarget(e.target_id),
    weight: (e) => dwellWeight(e.duration_ms),
  },
  connection_description_closed: {
    class: 'breadth',
    resolve: (e) => resolveEdgeTarget(e.target_id),
    weight: (e) => dwellWeight(e.duration_ms),
  },
  [VOICE_SESSION_EVENT_TYPE]: {
    class: 'depth',
    resolve: (e) => resolveEdgeTarget(e.target_id),
    weight: (e) => voiceWeight(e.user_turns),
  },
  item_added: {
    class: 'recency',
    resolve: (e) => resolveNodeTarget(e.target_id),
    weight: () => ITEM_ADDED_WEIGHT,
  },
}

/** Roster types that live in weave_events (voice comes from voice_sessions). */
export const ROSTER_EVENT_TYPES = Object.keys(ENGAGEMENT_RULES).filter(
  (t) => t !== VOICE_SESSION_EVENT_TYPE,
)

// ---------------------------------------------------------------------------
// Normalization of the two sources into EngagementEvent
// ---------------------------------------------------------------------------

export function fromWeaveEvent(row: WeaveEventRow): EngagementEvent {
  return {
    source: 'weave_events',
    event_type: row.event_type,
    target_id: row.target_id,
    board_id: row.board_id,
    occurred_at: row.timestamp,
    duration_ms: row.duration_ms,
    user_turns: null,
    event_id: row.id,
    voice_session_id: row.voice_session_id,
  }
}

export function fromVoiceSession(row: VoiceSessionRow): EngagementEvent {
  return {
    source: 'voice_session',
    event_type: VOICE_SESSION_EVENT_TYPE,
    target_id: row.anchor_target,
    board_id: row.board_id,
    occurred_at: row.ended_at,
    duration_ms: null,
    user_turns: row.user_turns,
    event_id: null,
    voice_session_id: row.session_id,
  }
}

// ---------------------------------------------------------------------------
// resolveEvents
// ---------------------------------------------------------------------------

/** Edge identity for provenance: the connection target string itself. */
function edgeIdOf(event: EngagementEvent, keys: string[]): string | null {
  return keys.length === 2 && event.target_id ? event.target_id : null
}

/**
 * Apply the roster to a list of events. Events with no rule are skipped and
 * counted; events whose target does not resolve are skipped and counted.
 */
export function resolveEvents(events: EngagementEvent[]): {
  resolved: ResolvedEvent[]
  unmatchedByType: Record<string, number>
  unresolvedByType: Record<string, number>
} {
  const resolved: ResolvedEvent[] = []
  const unmatchedByType: Record<string, number> = {}
  const unresolvedByType: Record<string, number> = {}
  for (const event of events) {
    const rule = ENGAGEMENT_RULES[event.event_type]
    if (!rule) {
      unmatchedByType[event.event_type] = (unmatchedByType[event.event_type] ?? 0) + 1
      continue
    }
    const keys = rule.resolve(event)
    if (keys.length === 0) {
      unresolvedByType[event.event_type] = (unresolvedByType[event.event_type] ?? 0) + 1
      continue
    }
    resolved.push({
      event,
      class: rule.class,
      keys,
      w_rule: rule.weight(event),
      edge_id: edgeIdOf(event, keys),
    })
  }
  return { resolved, unmatchedByType, unresolvedByType }
}

// ---------------------------------------------------------------------------
// buildWeightMap
// ---------------------------------------------------------------------------

export function compositeKey(row: { board_id: string; node_id: string }): string {
  return `${row.board_id}:${row.node_id}`
}

/**
 * The node set the map is keyed on, plus the archived keys needed to classify
 * a miss. `nodeKeys` defaults to every live row; a pinned node set passes its
 * own keys. Archived rows are never deleted (flag-never-delete), so a key that
 * is in `embeddingRows` with archived_at set is an archived miss; a key with no
 * row at all is absent.
 */
export function buildWeightMap(embeddingRows: EmbeddingRow[], nodeKeys?: string[]): WeightMap {
  const weights: Record<string, number> = {}
  const archived = new Set<string>()
  const keys = nodeKeys ?? embeddingRows.filter((r) => r.archived_at === null).map(compositeKey)
  for (const key of keys) weights[key] = 0
  for (const row of embeddingRows) {
    if (row.archived_at !== null) archived.add(compositeKey(row))
  }
  return { weights, archived }
}

// ---------------------------------------------------------------------------
// attribute
// ---------------------------------------------------------------------------

function emptyByClass(): Record<EngagementClass, number> {
  return { breadth: 0, depth: 0, recency: 0 }
}

function perType(): PerTypeAttribution {
  return { resolved: 0, hit: 0, archived: 0, absent: 0 }
}

/**
 * Decay each resolved event, accumulate into the map, and count every
 * resolved key as exactly one of hit / archived / absent.
 *
 * A key in the map is a hit: the node is in the node set. A key not in the
 * map whose weave_embeddings row has archived_at set is an archived miss: the
 * node was archived and its row still exists (flag-never-delete). Only a key
 * with no weave_embeddings row at all is absent.
 *
 * Throws if resolved != hit + archived + absent.
 */
export function attribute(
  resolvedEvents: ResolvedEvent[],
  map: WeightMap,
  generatedAt: Date,
): AttributeResult {
  const weights: Record<string, number> = { ...map.weights }
  const byClass: Record<string, Record<EngagementClass, number>> = {}
  const contributions: Record<string, Contribution[]> = {}
  const attribution: Attribution = {
    resolved: 0,
    hit: 0,
    dropped: { archived: 0, absent: 0 },
    by_type: {},
    zero_weight_events: 0,
  }

  for (const r of resolvedEvents) {
    if (r.w_rule <= 0) {
      attribution.zero_weight_events++
      continue
    }
    const age = ageDays(r.event.occurred_at, generatedAt)
    const wEff = decay(r.w_rule, age, halfLifeFor(r.class))
    const t = (attribution.by_type[r.event.event_type] ??= perType())
    for (const key of r.keys) {
      attribution.resolved++
      t.resolved++
      if (key in weights) {
        attribution.hit++
        t.hit++
        weights[key] += wEff
        const cls = (byClass[key] ??= emptyByClass())
        cls[r.class] += wEff
        const c: Contribution = {
          event_type: r.event.event_type,
          class: r.class,
          w_rule: r.w_rule,
          w_eff: wEff,
          age_days: age,
        }
        if (r.edge_id) c.edge_id = r.edge_id
        if (r.event.voice_session_id) c.voice_session_id = r.event.voice_session_id
        if (r.event.user_turns !== null) c.user_turns = r.event.user_turns
        const list = (contributions[key] ??= [])
        list.push(c)
      } else if (map.archived.has(key)) {
        attribution.dropped.archived++
        t.archived++
      } else {
        attribution.dropped.absent++
        t.absent++
      }
    }
  }

  assertAttributionCardinality(attribution)
  return { weights, byClass, contributions, attribution }
}

/** resolved = hit + archived + absent, overall and per type. Fail-loud. */
export function assertAttributionCardinality(attribution: Attribution): void {
  const sum = attribution.hit + attribution.dropped.archived + attribution.dropped.absent
  if (attribution.resolved !== sum) {
    throw new Error(
      `[Snapshot] attribution cardinality failed: resolved ${attribution.resolved} != hit ${attribution.hit} + archived ${attribution.dropped.archived} + absent ${attribution.dropped.absent}`,
    )
  }
  for (const [type, t] of Object.entries(attribution.by_type)) {
    if (t.resolved !== t.hit + t.archived + t.absent) {
      throw new Error(`[Snapshot] attribution cardinality failed for ${type}: ${t.resolved} != ${t.hit} + ${t.archived} + ${t.absent}`)
    }
  }
}

// ---------------------------------------------------------------------------
// pairAsymmetry: order-independent, per (session_id, target_id) group
// ---------------------------------------------------------------------------

export const PAIRS = {
  connection: { open: 'connection_label_clicked', close: 'connection_description_closed' },
  lightbox: { open: 'lightbox_opened', close: 'lightbox_closed' },
} as const

export const PAIR_EVENT_TYPES = Object.values(PAIRS).flatMap((p) => [p.open, p.close])

function countPair(events: WeaveEventRow[], open: string, close: string): PairCounters {
  const groups = new Map<string, { opens: number; closes: number }>()
  for (const e of events) {
    if (e.event_type !== open && e.event_type !== close) continue
    const g = `${e.session_id} ${e.target_id ?? ''}`
    const c = groups.get(g) ?? { opens: 0, closes: 0 }
    if (e.event_type === open) c.opens++
    else c.closes++
    groups.set(g, c)
  }
  const out: PairCounters = { opens: 0, closes: 0, paired: 0, orphan_opens: 0, unmatched_closes: 0 }
  for (const c of groups.values()) {
    out.opens += c.opens
    out.closes += c.closes
    out.paired += Math.min(c.opens, c.closes)
    out.orphan_opens += Math.max(0, c.opens - c.closes)
    out.unmatched_closes += Math.max(0, c.closes - c.opens)
  }
  return out
}

/** Never pairs by timestamp sequence: server timestamps invert on fire-and-forget inserts. */
export function pairAsymmetry(events: WeaveEventRow[]): PairAsymmetry {
  return {
    connection: countPair(events, PAIRS.connection.open, PAIRS.connection.close),
    lightbox: countPair(events, PAIRS.lightbox.open, PAIRS.lightbox.close),
  }
}
