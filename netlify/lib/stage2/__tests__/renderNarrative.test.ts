import { describe, expect, it } from 'vitest'
import type { NodeContent } from '../content'
import { truncateAtWord } from '../content'
import {
  UNCLUSTERED_MAX_ENTRIES,
  UNCLUSTERED_MIN_W_TOTAL,
  UNCLUSTERED_SUMMARY_MAX_CHARS,
  admitUnclustered,
  attendedText,
  placementText,
  renderNarrativePrompt,
  renderUnclusteredLine,
  type NarrativeRenderInput,
} from '../renderNarrative'

const PHIL = 'b-phil-0000'
const TECH = 'b-tech-0000'
const LOVE = 'b-love-0000'
const BOARDS = [{ id: PHIL, name: 'Philosophy' }, { id: TECH, name: 'Tech and Business' }, { id: LOVE, name: 'Love' }]

function tweet(key: string, boardId: string, author: string, handle: string, text: string, summary: string): NodeContent {
  return { key, boardId, nodeType: 'linkCard', cardType: 'link', linkType: 'tweet', title: author, authorName: author, authorHandle: handle, tweetText: text, contentSummary: summary }
}
function yt(key: string, boardId: string, title: string, summary: string): NodeContent {
  return { key, boardId, nodeType: 'linkCard', cardType: 'link', linkType: 'youtube', title, authorName: 'Ch', authorHandle: null, tweetText: null, contentSummary: summary }
}

const DOSTO = tweet(`${PHIL}:35`, PHIL, 'Überkierk', 'UberKierk', 'Dostoevsky talks about this pic.twitter.com/DiCVoPaJEd', 'SUMMARY_DOSTO')
const UNDERSTAND = tweet(`${PHIL}:14`, PHIL, 'lyra', 'lyra_', 'the more you understand this world, the more you destroy yourself.', 'SUMMARY_UNDERSTAND')
const CHAMATH = tweet(`${TECH}:4`, TECH, 'shouko', 'shoukointech', "Chamath Palihapitiya: Why happy childhoods don't build unicorns. pic.twitter.com/rffwI8JRRc", 'SUMMARY_CHAMATH')
const RETIRE = yt(`${PHIL}:39`, PHIL, "Early Retirement Taught Me That We've All Been Sold A Lie?", 'SUMMARY_RETIRE')

function fixture(over: Partial<NarrativeRenderInput> = {}): NarrativeRenderInput {
  return {
    totalPieces: 71,
    boardCount: 5,
    clusteredPieces: 35,
    threadCount: 7,
    singletonCount: 36,
    attendedSingletonCount: 21,
    threads: [
      { cluster_id: 'c3', size: 3, boardIds: [PHIL, TECH], theme: 'THEME_C3', anchors: [{ attention: 'discussed', turns: 14 }, { attention: 'discussed', turns: 2 }] },
      { cluster_id: 'c1', size: 14, boardIds: [TECH, PHIL, LOVE], theme: 'THEME_C1', anchors: [{ attention: 'dwelt' }, { attention: 'discussed', turns: 30 }, { attention: 'dwelt' }] },
    ],
    unclustered: [
      { content: DOSTO, w_total: 8.3, mark: { attention: 'dwelt' } },
      { content: UNDERSTAND, w_total: 2.9, mark: { attention: 'dwelt' } },
      { content: CHAMATH, w_total: 2.5, mark: { attention: 'discussed', turns: 41 } },
    ],
    conversations: [
      { user_turns: 14, endpoints: [DOSTO, RETIRE], endpointKeys: [DOSTO.key, RETIRE.key], placement: 'cluster_and_singleton:c3' },
      { user_turns: 23, endpoints: [CHAMATH, null], endpointKeys: [CHAMATH.key, `${TECH}:8`], placement: 'both_singletons' },
    ],
    clusterSizes: { c1: 14, c3: 3 },
    boards: BOARDS,
    ...over,
  }
}

describe('renderNarrativePrompt', () => {
  it('renders 2 threads + 3 unclustered + 2 conversations exactly, threads by size desc, conversations by turns desc', () => {
    expect(renderNarrativePrompt(fixture())).toBe(
      [
        'Observations from a collection of 71 pieces across 5 boards. 35 pieces fall into 7 threads; 36 stand alone, 21 of them attended.',
        '',
        'THREADS',
        '',
        'Thread of 14 pieces across "Tech and Business", "Philosophy", "Love" — attended: dwelt (2), discussed (1 piece, 30 turns):',
        'THEME_C1',
        '',
        'Thread of 3 pieces across "Philosophy", "Tech and Business" — attended: discussed (2 pieces, 16 turns):',
        'THEME_C3',
        '',
        'ATTENDED BUT UNCLUSTERED (most attended first)',
        '',
        '[tweet · Philosophy · @UberKierk] dwelt — SUMMARY_DOSTO',
        '[tweet · Philosophy · @lyra_] dwelt — SUMMARY_UNDERSTAND',
        '[tweet · Tech and Business · @shoukointech] discussed (41 turns) — SUMMARY_CHAMATH',
        '',
        'CONVERSATIONS (longest first)',
        '',
        `23 turns — shouko: "Chamath Palihapitiya: Why happy childhoods don't build unicorns.…" ⟷ ${TECH}:8 — both unclustered`,
        '14 turns — Überkierk: "Dostoevsky talks about this pic.twitter.com/DiCVoPaJEd" ⟷ "Early Retirement Taught Me That We\'ve All Been Sold A Lie?" — unclustered ⟷ thread of 3',
        '',
        '---',
        '',
        'What do these reveal together?',
      ].join('\n'),
    )
  })

  it('omits empty sections entirely', () => {
    const out = renderNarrativePrompt(fixture({ unclustered: [], conversations: [] }))
    expect(out).not.toContain('ATTENDED BUT UNCLUSTERED')
    expect(out).not.toContain('CONVERSATIONS')
    expect(out).toContain('THREADS')
    expect(out.endsWith('\n---\n\nWhat do these reveal together?')).toBe(true)
  })

  it('renders "not attended" for a thread with no anchors and every placement wording', () => {
    expect(attendedText([])).toBe('not attended')
    expect(attendedText([{ attention: 'added' }])).toBe('attended: added (1)')
    const sizes = { c1: 14, c2: 10 }
    expect(placementText('both_singletons', sizes)).toBe('both unclustered')
    expect(placementText('cluster_and_singleton:c1', sizes)).toBe('unclustered ⟷ thread of 14')
    expect(placementText('same_cluster:c2', sizes)).toBe('within thread of 10')
    expect(placementText('cross_cluster:c1,c2', sizes)).toBe('thread of 14 ⟷ thread of 10')
  })

  it('admits w_total >= 0.5 only, at most 10, most attended first', () => {
    const entries = Array.from({ length: 14 }, (_, i) => ({ w_total: 0.2 + i * 0.1, i }))
    const admitted = admitUnclustered(entries)
    expect(admitted.every((e) => e.w_total >= UNCLUSTERED_MIN_W_TOTAL)).toBe(true)
    expect(admitted.length).toBe(UNCLUSTERED_MAX_ENTRIES)
    expect(admitted[0].w_total).toBeGreaterThan(admitted[admitted.length - 1].w_total)
  })

  it('truncates a 300+ char summary at a word boundary with an ellipsis', () => {
    const words = Array.from({ length: 80 }, (_, i) => `word${i}`).join(' ')
    expect(words.length).toBeGreaterThan(UNCLUSTERED_SUMMARY_MAX_CHARS)
    const line = renderUnclusteredLine({ content: { ...DOSTO, contentSummary: words }, w_total: 1, mark: { attention: 'dwelt' } }, BOARDS)
    const rendered = line.slice(line.indexOf(' — ') + 3)
    expect(rendered.endsWith('…')).toBe(true)
    const body = rendered.slice(0, -1)
    expect(body.length).toBeLessThanOrEqual(UNCLUSTERED_SUMMARY_MAX_CHARS)
    expect(words.startsWith(body + ' ')).toBe(true) // cut exactly at a space
    expect(truncateAtWord('short text', 300)).toBe('short text')
  })
})
