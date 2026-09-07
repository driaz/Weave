import { describe, expect, it } from 'vitest'
import type { NodeContent } from '../content'
import { renderThemePrompt } from '../renderTheme'

const PHIL = 'b-phil-0000'
const TECH = 'b-tech-0000'
const BOARDS = [{ id: PHIL, name: 'Philosophy' }, { id: TECH, name: 'Tech and Business' }]

function yt(key: string, boardId: string, title: string, summary: string): NodeContent {
  return { key, boardId, nodeType: 'linkCard', cardType: 'link', linkType: 'youtube', title, authorName: 'Channel', authorHandle: null, tweetText: null, contentSummary: summary }
}
function tweet(key: string, boardId: string, author: string, handle: string, text: string, summary: string | null): NodeContent {
  return { key, boardId, nodeType: 'linkCard', cardType: 'link', linkType: 'tweet', title: author, authorName: author, authorHandle: handle, tweetText: text, contentSummary: summary }
}

describe('renderThemePrompt', () => {
  it('renders the c3-shaped fixture exactly', () => {
    const out = renderThemePrompt({
      boards: BOARDS,
      members: [
        { content: yt(`${PHIL}:39`, PHIL, "Early Retirement Taught Me That We've All Been Sold A Lie?", 'SUMMARY_A'), anchor: { attention: 'discussed', turns: 14 } },
        { content: yt(`${TECH}:6`, TECH, 'The Silent Revolution And The Great Resignation', 'SUMMARY_B'), anchor: { attention: 'discussed', turns: 2 } },
        { content: yt(`${TECH}:9`, TECH, 'Is Ignorance Really Bliss?', 'SUMMARY_C'), anchor: null },
      ],
    })
    expect(out).toBe(
      [
        'Cluster of 3 pieces across 2 boards: "Philosophy", "Tech and Business".',
        '',
        "[youtube · Philosophy] ★ discussed (14 turns) — Early Retirement Taught Me That We've All Been Sold A Lie? — SUMMARY_A",
        '[youtube · Tech and Business] ★ discussed (2 turns) — The Silent Revolution And The Great Resignation — SUMMARY_B',
        '[youtube · Tech and Business] — Is Ignorance Really Bliss? — SUMMARY_C',
        '',
        '---',
        '',
        'What thread runs through these pieces?',
      ].join('\n'),
    )
  })

  it('renders a two-board duplicate as two identical lines differing only by board, and does not dedupe', () => {
    const text = 'life shrinks or expands according to one\'s courage.'
    const out = renderThemePrompt({
      boards: BOARDS,
      members: [
        { content: tweet(`${PHIL}:7`, PHIL, 'gomi', 'parveen', text, 'S'), anchor: { attention: 'dwelt' } },
        { content: tweet(`${TECH}:31`, TECH, 'gomi', 'parveen', text, 'S'), anchor: { attention: 'dwelt' } },
      ],
    })
    const lines = out.split('\n')
    expect(lines[0]).toBe('Cluster of 2 pieces across 2 boards: "Philosophy", "Tech and Business".')
    expect(lines[2]).toBe('[tweet · Philosophy] ★ dwelt — gomi @parveen — S')
    expect(lines[3]).toBe('[tweet · Tech and Business] ★ dwelt — gomi @parveen — S')
    expect(lines.filter((l) => l.startsWith('[tweet'))).toHaveLength(2)
  })

  it('renders a no-anchor cluster without any ★, uses the visual fallback and the id prefix for an unnamed board', () => {
    const out = renderThemePrompt({
      boards: BOARDS,
      members: [
        { content: tweet(`${PHIL}:4`, PHIL, 'Saganism', 'saganism', 'x', null), anchor: null },
        { content: { key: 'zzzzzzzz-unknown:13', boardId: 'zzzzzzzz-unknown', nodeType: 'imageCard', cardType: 'image', linkType: null, title: 'Hate_Room.png', authorName: null, authorHandle: null, tweetText: null, contentSummary: null }, anchor: null },
      ],
    })
    expect(out).not.toContain('★')
    expect(out).toContain('[tweet · Philosophy] — Saganism @saganism — (visual content — no text description available)')
    expect(out).toContain('[image · zzzzzzzz] — Hate_Room.png — (visual content — no text description available)')
    expect(out.split('\n')[0]).toBe('Cluster of 2 pieces across 2 boards: "Philosophy", "zzzzzzzz".')
  })

  it('singularizes one piece on one board', () => {
    const out = renderThemePrompt({ boards: BOARDS, members: [{ content: yt(`${PHIL}:1`, PHIL, 'T', 'S'), anchor: null }] })
    expect(out.split('\n')[0]).toBe('Cluster of 1 piece across 1 board: "Philosophy".')
  })
})
