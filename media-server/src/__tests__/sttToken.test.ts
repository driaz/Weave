import Fastify from 'fastify'
import { describe, expect, it, vi } from 'vitest'
import {
  mintSttToken,
  registerSttTokenRoute,
  STT_TOKEN_MAX_SESSION_SECONDS,
  STT_TOKEN_URL,
} from '../sttToken'

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('mintSttToken', () => {
  it('posts to the realtime_scribe token endpoint with the key and a session cap', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { token: 'sutkn_abc' }))
    const result = await mintSttToken('key-1', fetchImpl as unknown as typeof fetch)

    expect(result).toEqual({ ok: true, token: 'sutkn_abc' })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(
      `${STT_TOKEN_URL}?max_session_duration_seconds=${STT_TOKEN_MAX_SESSION_SECONDS}`,
    )
    expect(url).toContain('/v1/single-use-token/realtime_scribe')
    expect(init.method).toBe('POST')
    expect(init.headers).toEqual({ 'xi-api-key': 'key-1' })
    expect(init.signal).toBeInstanceOf(AbortSignal)
  })

  it('reports an upstream error status with a trimmed body', async () => {
    const fetchImpl = vi.fn(async () => new Response('x'.repeat(2000), { status: 401 }))
    const result = await mintSttToken('key-1', fetchImpl as unknown as typeof fetch)
    expect(result).toMatchObject({ ok: false, status: 401 })
    if (!result.ok) expect(result.detail.length).toBe(500)
  })

  it('reports a 200 without a token as a failure', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, {}))
    const result = await mintSttToken('key-1', fetchImpl as unknown as typeof fetch)
    expect(result).toEqual({ ok: false, status: 200, detail: 'response had no token' })
  })

  it('reports a network error as status 0 instead of throwing', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('socket hang up')
    })
    const result = await mintSttToken('key-1', fetchImpl as unknown as typeof fetch)
    expect(result).toEqual({ ok: false, status: 0, detail: 'socket hang up' })
  })
})

/** An upstream that never answers; it only settles when the request is aborted. */
const hangingFetch = ((_url: string, init?: RequestInit) =>
  new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(init.signal?.reason))
  })) as unknown as typeof fetch

describe('mintSttToken timeout', () => {
  it('gives up on a hung upstream and reports status 0', async () => {
    const startedAt = Date.now()
    const result = await mintSttToken('key-1', hangingFetch, 50)
    expect(result).toEqual({ ok: false, status: 0, detail: 'timed out after 50 ms' })
    expect(Date.now() - startedAt).toBeLessThan(2000)
  })
})

describe('POST /api/stt-token', () => {
  it('answers 502 instead of hanging when ElevenLabs does not respond', async () => {
    const app = Fastify()
    registerSttTokenRoute(app, {
      verifyUserToken: async () => 'user-1',
      getApiKey: () => 'key-1',
      fetchImpl: hangingFetch,
      timeoutMs: 50,
    })
    const res = await app.inject({
      method: 'POST',
      url: '/api/stt-token',
      headers: { authorization: 'Bearer good-jwt' },
    })
    expect(res.statusCode).toBe(502)
    expect(res.json()).toEqual({ error: 'STT token request failed', statusCode: 0 })
  })

  function build(opts: { apiKey?: string; upstream?: () => Promise<Response> } = {}) {
    const fetchImpl = vi.fn(opts.upstream ?? (async () => jsonResponse(200, { token: 'sutkn_abc' })))
    const app = Fastify()
    registerSttTokenRoute(app, {
      verifyUserToken: async (token) => (token === 'good-jwt' ? 'user-1' : null),
      getApiKey: () => ('apiKey' in opts ? opts.apiKey : 'key-1'),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    return { app, fetchImpl }
  }

  it('rejects a request with no bearer token and never calls ElevenLabs', async () => {
    const { app, fetchImpl } = build()
    const res = await app.inject({ method: 'POST', url: '/api/stt-token' })
    expect(res.statusCode).toBe(401)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('rejects an invalid JWT and never calls ElevenLabs', async () => {
    const { app, fetchImpl } = build()
    const res = await app.inject({
      method: 'POST',
      url: '/api/stt-token',
      headers: { authorization: 'Bearer bad-jwt' },
    })
    expect(res.statusCode).toBe(401)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('returns the token, uncacheable, for a valid JWT', async () => {
    const { app } = build()
    const res = await app.inject({
      method: 'POST',
      url: '/api/stt-token',
      headers: { authorization: 'Bearer good-jwt', 'x-recording-id': 'turn-1' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ token: 'sutkn_abc' })
    expect(res.headers['cache-control']).toBe('no-store')
  })

  it('is 500 when the ElevenLabs key is not configured', async () => {
    const { app, fetchImpl } = build({ apiKey: undefined })
    const res = await app.inject({
      method: 'POST',
      url: '/api/stt-token',
      headers: { authorization: 'Bearer good-jwt' },
    })
    expect(res.statusCode).toBe(500)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('is 502 on an upstream failure and does not leak the upstream body', async () => {
    const { app } = build({
      upstream: async () => new Response('{"detail":"missing_permissions key-xyz"}', { status: 401 }),
    })
    const res = await app.inject({
      method: 'POST',
      url: '/api/stt-token',
      headers: { authorization: 'Bearer good-jwt' },
    })
    expect(res.statusCode).toBe(502)
    expect(res.json()).toEqual({ error: 'STT token request failed', statusCode: 401 })
    expect(res.body).not.toContain('key-xyz')
  })
})
