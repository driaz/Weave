// Node content as stage 2 renders it, plus the labels and helpers both
// renderers share. Every label and cap appears once, here or in the renderer
// that owns it.

import type { BoardName } from '../snapshot/types'
import type { Attention } from '../snapshot/attention'

export type NodeContent = {
  key: string
  boardId: string
  /** weave_embeddings.node_type, e.g. linkCard / imageCard / textCard. */
  nodeType: string
  /** nodes.card_type, e.g. link / image / text. */
  cardType: string | null
  /** nodes.link_type, e.g. tweet / youtube / generic. */
  linkType: string | null
  title: string | null
  authorName: string | null
  authorHandle: string | null
  tweetText: string | null
  contentSummary: string | null
}

export type AttentionMark = { attention: Attention; turns?: number }

/** Rendered in place of a summary when the node has none (unchanged from v1). */
export const VISUAL_FALLBACK = '(visual content — no text description available)'

/** A board with no `boards` row is named by this many leading id characters. */
export const BOARD_ID_PREFIX_LEN = 8

export const TWEET_LINK_TYPE = 'tweet'

/** `tweet` / `youtube` / `generic` for links, else the card type, else the embedding node type. */
export function pieceType(n: NodeContent): string {
  return n.linkType ?? n.cardType ?? n.nodeType
}

export function boardName(boards: BoardName[], boardId: string): string {
  const hit = boards.find((b) => b.id === boardId)
  return hit ? hit.name : boardId.slice(0, BOARD_ID_PREFIX_LEN)
}

export function isTweet(n: NodeContent): boolean {
  return n.linkType === TWEET_LINK_TYPE
}

/**
 * Tweets: `authorName @handle` (data.authorName, data.authorHandle); YouTube
 * and images: nodes.title. Falls back to whatever exists, then the key.
 */
export function authorOrTitle(n: NodeContent): string {
  if (isTweet(n)) {
    const name = n.authorName?.trim() ?? ''
    const handle = n.authorHandle?.trim().replace(/^@/, '') ?? ''
    if (name && handle) return `${name} @${handle}`
    if (name) return name
    if (handle) return `@${handle}`
  }
  const title = n.title?.trim()
  if (title) return title
  return n.key
}

export function summaryOrFallback(n: NodeContent): string {
  const s = n.contentSummary?.trim()
  return s && s.length > 0 ? s : VISUAL_FALLBACK
}

/** `dwelt`, `discussed (14 turns)`, `added`. Turns render only when discussed. */
export function attentionText(mark: AttentionMark): string {
  if (mark.attention === 'discussed') return `discussed (${mark.turns ?? 0} turns)`
  return mark.attention
}

export const ANCHOR_GLYPH = '★'

export function quoteList(names: string[]): string {
  return names.map((n) => `"${n}"`).join(', ')
}

/** Truncate at a word boundary at or before `max` characters, appending an ellipsis. */
export function truncateAtWord(text: string, max: number): string {
  const t = text.replace(/\s+/g, ' ').trim()
  if (t.length <= max) return t
  const cut = t.lastIndexOf(' ', max)
  return (cut > 0 ? t.slice(0, cut) : t.slice(0, max)).trimEnd() + '…'
}

export function pluralize(n: number, singular: string, plural: string = `${singular}s`): string {
  return `${n} ${n === 1 ? singular : plural}`
}
