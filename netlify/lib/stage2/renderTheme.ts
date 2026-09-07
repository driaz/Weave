// Theme-v2 user prompt renderer (prompt-v2-draft §2.2). Pure: strings in, string out.
//
//   Cluster of 3 pieces across 2 boards: "Philosophy", "Tech and Business".
//
//   [youtube · Philosophy] ★ discussed (14 turns) — <title> — <content_summary>
//   [youtube · Tech and Business] — <title> — <content_summary>
//
//   ---
//
//   What thread runs through these pieces?

import type { BoardName } from '../snapshot/types'
import { THEME_CLOSING_QUESTION } from './prompts'
import {
  ANCHOR_GLYPH,
  attentionText,
  authorOrTitle,
  boardName,
  pieceType,
  pluralize,
  quoteList,
  summaryOrFallback,
  type AttentionMark,
  type NodeContent,
} from './content'

export type ThemeMember = { content: NodeContent; anchor: AttentionMark | null }

export type ThemeRenderInput = {
  /** Anchors first (by w_total desc), then the remaining members in cluster order. */
  members: ThemeMember[]
  boards: BoardName[]
}

export const PROMPT_SEPARATOR = '---'

export function renderThemeLine(m: ThemeMember, boards: BoardName[]): string {
  const head = `[${pieceType(m.content)} · ${boardName(boards, m.content.boardId)}]`
  const mark = m.anchor ? ` ${ANCHOR_GLYPH} ${attentionText(m.anchor)}` : ''
  return `${head}${mark} — ${authorOrTitle(m.content)} — ${summaryOrFallback(m.content)}`
}

export function renderThemePrompt(input: ThemeRenderInput): string {
  const boardIds: string[] = []
  for (const m of input.members) if (!boardIds.includes(m.content.boardId)) boardIds.push(m.content.boardId)
  const names = boardIds.map((id) => boardName(input.boards, id))
  const lines: string[] = []
  lines.push(`Cluster of ${pluralize(input.members.length, 'piece')} across ${pluralize(boardIds.length, 'board')}: ${quoteList(names)}.`)
  lines.push('')
  for (const m of input.members) lines.push(renderThemeLine(m, input.boards))
  lines.push('')
  lines.push(PROMPT_SEPARATOR)
  lines.push('')
  lines.push(THEME_CLOSING_QUESTION)
  return lines.join('\n')
}
