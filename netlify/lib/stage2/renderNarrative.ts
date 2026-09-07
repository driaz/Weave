// Narrative-v2 user prompt renderer (prompt-v2-draft §3.2). Pure.
//
//   Observations from a collection of 71 pieces across 5 boards. 35 pieces fall into 7 threads; 36 stand alone, 21 of them attended.
//
//   THREADS
//
//   Thread of 14 pieces across "A", "B" — attended: dwelt (2), discussed (2 pieces, 30 turns):
//   <theme_description>
//
//   ATTENDED BUT UNCLUSTERED (most attended first)
//
//   [tweet · Philosophy · @handle] discussed (20 turns) — <content_summary ≤ 300 chars>
//
//   CONVERSATIONS (longest first)
//
//   23 turns — Author: "first 80 chars" ⟷ "Video title" — both unclustered
//
//   ---
//
//   What do these reveal together?

import type { Attention } from '../snapshot/attention'
import type { BoardName, ConversationPlacement } from '../snapshot/types'
import { NARRATIVE_CLOSING_QUESTION } from './prompts'
import {
  attentionText,
  boardName,
  isTweet,
  pieceType,
  pluralize,
  quoteList,
  summaryOrFallback,
  truncateAtWord,
  type AttentionMark,
  type NodeContent,
} from './content'
import { PROMPT_SEPARATOR } from './renderTheme'

/** ATTENDED BUT UNCLUSTERED admits entries with w_total at or above this… */
export const UNCLUSTERED_MIN_W_TOTAL = 0.5
/** …and at most this many of them. */
export const UNCLUSTERED_MAX_ENTRIES = 10
/** Unclustered summaries are cut at a word boundary at or before this length. */
export const UNCLUSTERED_SUMMARY_MAX_CHARS = 300
/** Conversation endpoints show this much tweet text. */
export const ENDPOINT_TEXT_MAX_CHARS = 80

export const THREADS_HEADER = 'THREADS'
export const UNCLUSTERED_HEADER = 'ATTENDED BUT UNCLUSTERED (most attended first)'
export const CONVERSATIONS_HEADER = 'CONVERSATIONS (longest first)'
export const NOT_ATTENDED = 'not attended'
export const ENDPOINT_JOIN = '⟷'

export type ThreadInput = {
  cluster_id: string
  size: number
  boardIds: string[]
  theme: string
  anchors: AttentionMark[]
}

export type UnclusteredInput = {
  content: NodeContent
  w_total: number
  mark: AttentionMark
}

export type ConversationInput = {
  user_turns: number
  endpoints: [NodeContent | null, NodeContent | null]
  /** Keys, for the fallback when content is missing. */
  endpointKeys: [string, string]
  placement: ConversationPlacement
}

export type NarrativeRenderInput = {
  totalPieces: number
  boardCount: number
  clusteredPieces: number
  threadCount: number
  singletonCount: number
  attendedSingletonCount: number
  threads: ThreadInput[]
  unclustered: UnclusteredInput[]
  conversations: ConversationInput[]
  /** cluster_id -> size, for placement words. */
  clusterSizes: Record<string, number>
  boards: BoardName[]
}

const ATTENTION_ORDER: Attention[] = ['dwelt', 'discussed', 'added']

/** `dwelt (2), discussed (2 pieces, 30 turns), added (1)` or `not attended`. */
export function attendedText(anchors: AttentionMark[]): string {
  if (anchors.length === 0) return NOT_ATTENDED
  const parts: string[] = []
  for (const label of ATTENTION_ORDER) {
    const of = anchors.filter((a) => a.attention === label)
    if (of.length === 0) continue
    if (label === 'discussed') {
      const turns = of.reduce((s, a) => s + (a.turns ?? 0), 0)
      parts.push(`discussed (${pluralize(of.length, 'piece')}, ${pluralize(turns, 'turn')})`)
    } else {
      parts.push(`${label} (${of.length})`)
    }
  }
  return `attended: ${parts.join(', ')}`
}

export function renderThreadHeader(t: ThreadInput, boards: BoardName[]): string {
  const names = quoteList(t.boardIds.map((id) => boardName(boards, id)))
  return `Thread of ${pluralize(t.size, 'piece')} across ${names} — ${attendedText(t.anchors)}:`
}

export function renderUnclusteredLine(u: UnclusteredInput, boards: BoardName[]): string {
  const handle = u.content.authorHandle?.trim().replace(/^@/, '')
  const head = `[${pieceType(u.content)} · ${boardName(boards, u.content.boardId)}${handle ? ` · @${handle}` : ''}]`
  return `${head} ${attentionText(u.mark)} — ${truncateAtWord(summaryOrFallback(u.content), UNCLUSTERED_SUMMARY_MAX_CHARS)}`
}

/** Tweets: `Author: "first 80 chars"`; video/image: `"title"`; missing content: the key. */
export function renderEndpoint(n: NodeContent | null, key: string): string {
  if (!n) return key
  if (isTweet(n) && n.tweetText) {
    const author = n.authorName?.trim() || (n.authorHandle ? `@${n.authorHandle.replace(/^@/, '')}` : 'tweet')
    return `${author}: "${truncateAtWord(n.tweetText, ENDPOINT_TEXT_MAX_CHARS)}"`
  }
  const title = n.title?.trim()
  return title ? `"${title}"` : key
}

export function placementText(p: ConversationPlacement, clusterSizes: Record<string, number>): string {
  const thread = (id: string) => `thread of ${clusterSizes[id] ?? '?'}`
  if (p === 'both_singletons') return 'both unclustered'
  if (p.startsWith('same_cluster:')) return `within ${thread(p.slice('same_cluster:'.length))}`
  if (p.startsWith('cluster_and_singleton:')) return `unclustered ${ENDPOINT_JOIN} ${thread(p.slice('cluster_and_singleton:'.length))}`
  const [a, b] = p.slice('cross_cluster:'.length).split(',')
  return `${thread(a)} ${ENDPOINT_JOIN} ${thread(b)}`
}

export function renderConversationLine(c: ConversationInput, clusterSizes: Record<string, number>): string {
  const [a, b] = c.endpoints
  return `${pluralize(c.user_turns, 'turn')} — ${renderEndpoint(a, c.endpointKeys[0])} ${ENDPOINT_JOIN} ${renderEndpoint(b, c.endpointKeys[1])} — ${placementText(c.placement, clusterSizes)}`
}

/** Apply the ATTENDED BUT UNCLUSTERED admission: w_total >= min, at most max entries, most attended first. */
export function admitUnclustered<T extends { w_total: number }>(entries: T[]): T[] {
  return [...entries]
    .filter((e) => e.w_total >= UNCLUSTERED_MIN_W_TOTAL)
    .sort((a, b) => b.w_total - a.w_total)
    .slice(0, UNCLUSTERED_MAX_ENTRIES)
}

export function renderNarrativePrompt(input: NarrativeRenderInput): string {
  const lines: string[] = []
  lines.push(
    `Observations from a collection of ${pluralize(input.totalPieces, 'piece')} across ${pluralize(input.boardCount, 'board')}. ` +
      `${pluralize(input.clusteredPieces, 'piece')} fall into ${pluralize(input.threadCount, 'thread')}; ` +
      `${input.singletonCount} stand alone, ${input.attendedSingletonCount} of them attended.`,
  )

  const threads = [...input.threads].sort((a, b) => b.size - a.size)
  if (threads.length > 0) {
    lines.push('', THREADS_HEADER, '')
    for (const t of threads) {
      lines.push(renderThreadHeader(t, input.boards))
      lines.push(t.theme.trim())
      lines.push('')
    }
    lines.pop()
  }

  const unclustered = admitUnclustered(input.unclustered)
  if (unclustered.length > 0) {
    lines.push('', UNCLUSTERED_HEADER, '')
    for (const u of unclustered) lines.push(renderUnclusteredLine(u, input.boards))
  }

  const conversations = [...input.conversations].sort((a, b) => b.user_turns - a.user_turns)
  if (conversations.length > 0) {
    lines.push('', CONVERSATIONS_HEADER, '')
    for (const c of conversations) lines.push(renderConversationLine(c, input.clusterSizes))
  }

  lines.push('', PROMPT_SEPARATOR, '', NARRATIVE_CLOSING_QUESTION)
  return lines.join('\n')
}
