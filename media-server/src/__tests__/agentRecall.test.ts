import Fastify from 'fastify'
import type { SupabaseClient } from '@supabase/supabase-js'
import { describe, expect, it, vi } from 'vitest'
import {
  AGENT_RECALL_FLOOR,
  AGENT_RECALL_RESPONSE_MAX_CHARS,
  AGENT_RECALL_RPC_CAP,
  AGENT_RECALL_SNIPPET_MAX_CHARS,
  buildRecallResponse,
  keysMatch,
  registerAgentRecallRoute,
  trimSnippet,
  type AgentRecallDeps,
  type AgentRecallRow,
} from '../agentRecall'
import { supabaseRecallReads } from '../agentRecallDeps'
import { RETRIEVAL_FLOOR, RETRIEVAL_K } from '../../../src/services/voice/retrievalContext'

const BOARD = '11111111-2222-4333-8444-555555555555'
const OTHER_BOARD = '99999999-2222-4333-8444-555555555555'
const KEY = 'test-recall-key'

const ROWS: AgentRecallRow[] = [
  { ref_id: 'n1', content: 'A post about courage expanding or shrinking your life.', similarity: 0.81234567 },
  { ref_id: 'n2', content: 'x'.repeat(3000), similarity: 0.7 },
  { ref_id: 'n3', content: 'Third node summary, long enough to serve.', similarity: 0.62 },
  { ref_id: 'n4', content: 'Fourth node summary, long enough to serve.', similarity: 0.58 },
  { ref_id: 'n5', content: 'Fifth node summary, long enough to serve.', similarity: 0.51 },
  { ref_id: 'n6', content: 'Below the floor, must not be returned.', similarity: 0.49 },
]
const TITLES = new Map([
  ['n1', 'Courage'],
  ['n2', 'Long one'],
])

function build(overrides: Partial<AgentRecallDeps> = {}, env: Partial<ReturnType<AgentRecallDeps['getEnv']>> = {}) {
  const deps = {
    getEnv: () => ({ enabled: '1', key: KEY, boardId: BOARD, ...env }),
    embedQuery: vi.fn(async () => [0.1, 0.2, 0.3]),
    matchNodes: vi.fn(async () => ROWS),
    fetchTitles: vi.fn(async () => TITLES),
    ...overrides,
  }
  const app = Fastify()
  registerAgentRecallRoute(app, deps)
  const post = (payload: unknown, headers: Record<string, string> = { 'x-agent-recall-key': KEY }) =>
    app.inject({ method: 'POST', url: '/api/agent-recall', headers, payload: payload as object })
  return { deps, post }
}

describe('constants stay in lockstep with the voice pipeline', () => {
  it('uses the same floor and RPC cap as retrievalContext.ts', () => {
    expect(AGENT_RECALL_FLOOR).toBe(RETRIEVAL_FLOOR)
    expect(AGENT_RECALL_RPC_CAP).toBe(RETRIEVAL_K)
  })
})

describe('POST /api/agent-recall: disabled flag', () => {
  it.each([undefined, '0', 'true'])('is 404 when AGENT_RECALL_ENABLED is %s, even with a valid key', async (enabled) => {
    const { deps, post } = build({}, { enabled })
    const res = await post({ query: 'courage' })
    expect(res.statusCode).toBe(404)
    expect(deps.embedQuery).not.toHaveBeenCalled()
    expect(deps.matchNodes).not.toHaveBeenCalled()
    expect(deps.fetchTitles).not.toHaveBeenCalled()
  })
})

describe('POST /api/agent-recall: auth', () => {
  it.each([
    ['no header', {}],
    ['a wrong key', { 'x-agent-recall-key': 'nope' }],
    ['a key that is a prefix of the real one', { 'x-agent-recall-key': KEY.slice(0, -1) }],
  ])('is 401 with %s and does no work', async (_name, headers) => {
    const { deps, post } = build()
    const res = await post({ query: 'courage' }, headers)
    expect(res.statusCode).toBe(401)
    expect(deps.embedQuery).not.toHaveBeenCalled()
    expect(deps.matchNodes).not.toHaveBeenCalled()
    expect(deps.fetchTitles).not.toHaveBeenCalled()
  })

  it('is 401 for every request when AGENT_RECALL_KEY is unset', async () => {
    const { post } = build({}, { key: undefined })
    expect((await post({ query: 'courage' }, { 'x-agent-recall-key': '' })).statusCode).toBe(401)
    expect((await post({ query: 'courage' }, { 'x-agent-recall-key': 'undefined' })).statusCode).toBe(401)
  })

  it('keysMatch compares whole keys of any length', () => {
    expect(keysMatch('abc', 'abc')).toBe(true)
    expect(keysMatch('abc', 'abcd')).toBe(false)
    expect(keysMatch('', 'abc')).toBe(false)
  })
})

describe('POST /api/agent-recall: validation and board scoping', () => {
  it.each([{}, { query: '' }, { query: '   ' }, { query: 42 }, { query: 'q'.repeat(2001) }])(
    'is 400 for body %j',
    async (body) => {
      const { deps, post } = build()
      expect((await post(body)).statusCode).toBe(400)
      expect(deps.embedQuery).not.toHaveBeenCalled()
    },
  )

  it('is 400 for a boardId that is not a uuid', async () => {
    const { post } = build()
    expect((await post({ query: 'courage', boardId: 'abc' })).statusCode).toBe(400)
    expect((await post({ query: 'courage', boardId: 7 })).statusCode).toBe(400)
  })

  it('is 500 when no board is given and AGENT_RECALL_BOARD_ID is unset', async () => {
    const { post } = build({}, { boardId: undefined })
    expect((await post({ query: 'courage' })).statusCode).toBe(500)
  })

  it('defaults to AGENT_RECALL_BOARD_ID and lets the body override it', async () => {
    const { deps, post } = build()
    await post({ query: 'courage' })
    await post({ query: 'courage', boardId: OTHER_BOARD })
    const boards = deps.matchNodes.mock.calls.map((c) => (c as unknown as [{ boardId: string }])[0].boardId)
    expect(boards).toEqual([BOARD, OTHER_BOARD])
  })
})

describe('POST /api/agent-recall: response shape', () => {
  it('returns the top 5 above the floor as title, snippet, similarity', async () => {
    const { deps, post } = build()
    const res = await post({ query: '  courage  ' })
    expect(res.statusCode).toBe(200)
    expect(res.headers['cache-control']).toBe('no-store')

    const body = res.json() as { results: { title: string | null; snippet: string; similarity: number }[] }
    expect(Object.keys(body)).toEqual(['results'])
    expect(body.results).toHaveLength(5)
    for (const r of body.results) expect(Object.keys(r)).toEqual(['title', 'snippet', 'similarity'])
    expect(body.results[0]).toEqual({
      title: 'Courage',
      snippet: 'A post about courage expanding or shrinking your life.',
      similarity: 0.8123,
    })
    expect(body.results[1]!.snippet.length).toBe(AGENT_RECALL_SNIPPET_MAX_CHARS)
    expect(body.results[2]!.title).toBeNull()
    expect(body.results.map((r) => r.similarity)).toEqual([0.8123, 0.7, 0.62, 0.58, 0.51])
    expect(res.body.length).toBeLessThanOrEqual(AGENT_RECALL_RESPONSE_MAX_CHARS)

    expect(deps.embedQuery).toHaveBeenCalledWith('courage', expect.any(AbortSignal))
    expect(deps.matchNodes).toHaveBeenCalledWith(
      { queryVector: [0.1, 0.2, 0.3], boardId: BOARD, cap: RETRIEVAL_K },
      expect.any(AbortSignal),
    )
  })

  it('returns an empty list when nothing clears the floor', async () => {
    const { post } = build({ matchNodes: async () => [{ ref_id: 'n1', content: 'c', similarity: 0.3 }] })
    const res = await post({ query: 'courage' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ results: [] })
  })

  it('still answers, with null titles, when the title lookup fails', async () => {
    const { post } = build({
      fetchTitles: async () => {
        throw new Error('boom')
      },
    })
    const res = await post({ query: 'courage' })
    expect(res.statusCode).toBe(200)
    expect((res.json() as { results: { title: unknown }[] }).results.every((r) => r.title === null)).toBe(true)
  })

  it('keeps the whole response under the budget with five maximal results', () => {
    const rows = Array.from({ length: 6 }, (_, i) => ({
      ref_id: `n${i}`,
      content: '"\n'.repeat(2000),
      similarity: 0.9 - i * 0.01,
    }))
    const titles = new Map(rows.map((r) => [r.ref_id, 'T'.repeat(500)]))
    const body = buildRecallResponse(rows, titles)
    expect(JSON.stringify(body).length).toBeLessThanOrEqual(AGENT_RECALL_RESPONSE_MAX_CHARS)
    expect(body.results.length).toBeGreaterThan(0)
    expect(body.results.length).toBeLessThan(5)
  })

  it('trimSnippet never exceeds the cap and prefers a sentence end', () => {
    expect(trimSnippet('short')).toBe('short')
    expect(trimSnippet('y'.repeat(601)).length).toBe(600)
    const text = `${'a'.repeat(400)}. ${'b'.repeat(400)}`
    expect(trimSnippet(text)).toBe(`${'a'.repeat(400)}.…`)
  })
})

describe('POST /api/agent-recall: upstream failures and timeouts', () => {
  const hang = () => new Promise<never>(() => {})

  it('is 504 when the embed call hangs, without calling the RPC', async () => {
    const { deps, post } = build({ embedQuery: hang, timeoutMs: 30 })
    const res = await post({ query: 'courage' })
    expect(res.statusCode).toBe(504)
    expect(res.json()).toEqual({ error: 'embed timed out' })
    expect(deps.matchNodes).not.toHaveBeenCalled()
  })

  it('is 504 when the RPC hangs, and aborts its signal', async () => {
    let seen: AbortSignal | undefined
    const { post } = build({
      matchNodes: (_args, signal) => {
        seen = signal
        return hang()
      },
      timeoutMs: 30,
    })
    const res = await post({ query: 'courage' })
    expect(res.statusCode).toBe(504)
    expect(res.json()).toEqual({ error: 'rpc timed out' })
    expect(seen?.aborted).toBe(true)
  })

  it('is 502 when the RPC errors, without leaking the detail', async () => {
    const { post } = build({
      matchNodes: async () => {
        throw new Error('secret detail')
      },
    })
    const res = await post({ query: 'courage' })
    expect(res.statusCode).toBe(502)
    expect(res.json()).toEqual({ error: 'rpc failed' })
  })
})

describe('read-only path', () => {
  /** A client that records every call and throws on anything that could write. */
  function recordingClient() {
    const calls: string[] = []
    const rpcArgs: unknown[] = []
    const result = (data: unknown) => ({ abortSignal: async () => ({ data, error: null }) })
    const client = {
      rpc(name: string, args: unknown) {
        calls.push(`rpc:${name}`)
        rpcArgs.push(args)
        return result(ROWS)
      },
      from(table: string) {
        const writer = (op: string) => () => {
          throw new Error(`write attempted: ${table}.${op}`)
        }
        return {
          select(cols: string) {
            calls.push(`select:${table}:${cols}`)
            return { eq: () => result([{ title: 'Courage', client_id: 'n1' }]) }
          },
          insert: writer('insert'),
          upsert: writer('upsert'),
          update: writer('update'),
          delete: writer('delete'),
        }
      },
    }
    return { client: client as unknown as SupabaseClient, calls, rpcArgs }
  }

  it('touches Supabase only through the retrieval RPC and a nodes select', async () => {
    const { client, calls, rpcArgs } = recordingClient()
    const { post } = build(supabaseRecallReads(client))
    const res = await post({ query: 'courage' })
    expect(res.statusCode).toBe(200)
    expect((res.json() as { results: { title: string | null }[] }).results[0]!.title).toBe('Courage')

    expect([...calls].sort()).toEqual([
      'rpc:match_retrieval_context',
      'select:nodes:title, client_id:data->>_clientNodeId',
    ])
    // Same arguments as fetchRetrievalContext, minus an anchor edge.
    expect(rpcArgs[0]).toEqual({
      query_embedding: '[0.1,0.2,0.3]',
      p_board_id: BOARD,
      p_match_threshold: 0,
      p_total_cap: RETRIEVAL_K,
      p_excluded_node_ids: [],
      p_live_node_ids: null,
    })
  })

  it('surfaces an RPC error as a failure rather than an empty result', async () => {
    const client = {
      rpc: () => ({ abortSignal: async () => ({ data: null, error: { message: 'bad' } }) }),
      from: () => ({ select: () => ({ eq: () => ({ abortSignal: async () => ({ data: [], error: null }) }) }) }),
    } as unknown as SupabaseClient
    const { post } = build(supabaseRecallReads(client))
    expect((await post({ query: 'courage' })).statusCode).toBe(502)
  })
})
