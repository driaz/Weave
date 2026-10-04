// The narrative handler's write path around the title step: Supabase and the
// Claude call are mocked, so this runs without network.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ClaudeResult } from '../claude'

const claudeResults: ClaudeResult[] = []
const callClaude = vi.fn(async (): Promise<ClaudeResult> => {
  const next = claudeResults.shift()
  if (!next) throw new Error('unexpected extra Claude call')
  return next
})
vi.mock('../claude', () => ({ callClaude: (...args: unknown[]) => callClaude(...(args as [])) }))

let row: Record<string, unknown>
const updates: Array<Record<string, unknown>> = []
vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from: () => ({
      select: () => ({ eq: () => ({ single: async () => ({ data: row, error: null }) }) }),
      update: (payload: Record<string, unknown>) => {
        updates.push(payload)
        return { eq: async () => ({ error: null }) }
      },
    }),
  }),
}))

const { default: handler } = await import('../../../functions/generate-snapshot-narrative')

const NARRATIVE = 'The narrative body.'
const OVER = 'Clarity as the specific price of having nowhere to put what one sees'

function request(): Request {
  return new Request('http://localhost/api/generate-snapshot-narrative', { method: 'POST', body: JSON.stringify({ snapshot_id: 'snap-1' }) })
}

beforeEach(() => {
  process.env.ANTHROPIC_API_KEY = 'test'
  process.env.SUPABASE_URL = 'http://localhost'
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test'
  claudeResults.length = 0
  updates.length = 0
  callClaude.mockClear()
  row = {
    id: 'snap-1',
    clusters: [{ cluster_id: 'c0', member_node_ids: ['b1:n1', 'b1:n2'], anchor_node_ids: [], theme_description: 'A theme.', engagement_weight: 1, size: 2, boards_touched: ['b1'] }],
    generation_metadata: {
      anchors: [],
      unclustered_attended: [],
      conversations: [],
      boards: [{ id: 'b1', name: 'Board' }],
      node_set: { keys: ['b1:n1', 'b1:n2'], count: 2 },
      // A prior run's title must not survive next to a new narrative.
      title: 'Stale title from a previous narrative',
      title_attempts: 1,
    },
  }
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

describe('generate-snapshot-narrative title write', () => {
  it('writes narrative + title in one update with title_attempts on success', async () => {
    claudeResults.push({ text: NARRATIVE, error: null }, { text: 'A short title', error: null })
    const res = await handler(request())
    expect(res.status).toBe(200)
    expect(updates).toHaveLength(1)
    const meta = updates[0].generation_metadata as Record<string, unknown>
    expect(updates[0].narrative).toBe(NARRATIVE)
    expect(meta.title).toBe('A short title')
    expect(meta.title_attempts).toBe(1)
    expect(meta).not.toHaveProperty('title_error')
  })

  it('writes the corrected title with title_attempts = 2 after one over-length', async () => {
    claudeResults.push({ text: NARRATIVE, error: null }, { text: OVER, error: null }, { text: 'Clarity with nowhere to put it', error: null })
    await handler(request())
    const meta = updates[0].generation_metadata as Record<string, unknown>
    expect(meta.title).toBe('Clarity with nowhere to put it')
    expect(meta.title_attempts).toBe(2)
  })

  it('writes the narrative with title_error (no title) when over-length twice', async () => {
    claudeResults.push({ text: NARRATIVE, error: null }, { text: OVER, error: null }, { text: OVER, error: null })
    const res = await handler(request())
    expect(res.status).toBe(200)
    expect(updates).toHaveLength(1)
    expect(updates[0].narrative).toBe(NARRATIVE)
    const meta = updates[0].generation_metadata as Record<string, unknown>
    expect(meta).not.toHaveProperty('title')
    expect(meta).not.toHaveProperty('title_attempts')
    expect(meta.title_error).toEqual({ phase: 'title_validation', reason: 'over_length: 68 > 64', attempts: 2, rejected_values: [OVER, OVER] })
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('TITLE FAILED snapshot=snap-1'))
  })

  it('writes the narrative with title_error when the title call errors', async () => {
    claudeResults.push({ text: NARRATIVE, error: null }, { text: null, error: 'HTTP 529: overloaded' })
    await handler(request())
    expect(updates[0].narrative).toBe(NARRATIVE)
    const meta = updates[0].generation_metadata as Record<string, unknown>
    expect(meta).not.toHaveProperty('title')
    expect(meta.title_error).toEqual({ phase: 'title_generation', reason: 'HTTP 529: overloaded', attempts: 1, rejected_values: [] })
  })
})
