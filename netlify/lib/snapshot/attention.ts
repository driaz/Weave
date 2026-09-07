// Attention label: a presentation field derived from ratified by_class quantities.
// Spec: prompt-v2-draft §1.1 and dispatch R3b §2.2.

import type { Contribution, EngagementClass } from './types'

export type Attention = 'dwelt' | 'discussed' | 'added'

export const ATTENTION_LABELS: readonly Attention[] = ['dwelt', 'discussed', 'added'] as const

/**
 * `dwelt` if breadth >= depth and breadth >= recency; `discussed` if depth is
 * the largest; `added` if recency is the largest. Ties resolve to `dwelt`
 * (dispatch §2.2), which also covers depth == recency > breadth.
 */
export function attentionFor(byClass: Record<EngagementClass, number>): Attention {
  const { breadth, depth, recency } = byClass
  if (breadth >= depth && breadth >= recency) return 'dwelt'
  if (depth > recency) return 'discussed'
  if (recency > depth) return 'added'
  return 'dwelt'
}

/** Sum of user_turns over the node's voice contributions in window. */
export function turnsFor(contributions: Contribution[]): number {
  let turns = 0
  for (const c of contributions) {
    if (c.class === 'depth' && typeof c.user_turns === 'number') turns += c.user_turns
  }
  return turns
}
