import type { FastifyInstance } from 'fastify'

// ElevenLabs single-use token for the realtime speech-to-text socket. The
// browser opens the socket itself with this token, so the API key stays here.
// The token is consumed on first use and expires 15 minutes after minting.
export const STT_TOKEN_URL = 'https://api.elevenlabs.io/v1/single-use-token/realtime_scribe'

// ElevenLabs closes a session opened with the token after this long. One
// socket carries one user turn; the longest prod turn is about 2 minutes.
export const STT_TOKEN_MAX_SESSION_SECONDS = 600

export type MintSttTokenResult =
  | { ok: true; token: string }
  | { ok: false; status: number; detail: string }

/** Mint one token. Never throws: a network error comes back as status 0. */
export async function mintSttToken(
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<MintSttTokenResult> {
  const url = `${STT_TOKEN_URL}?max_session_duration_seconds=${STT_TOKEN_MAX_SESSION_SECONDS}`
  let upstream: Response
  try {
    upstream = await fetchImpl(url, { method: 'POST', headers: { 'xi-api-key': apiKey } })
  } catch (err) {
    return { ok: false, status: 0, detail: err instanceof Error ? err.message : String(err) }
  }
  if (!upstream.ok) {
    const detail = await upstream.text().catch(() => '')
    return { ok: false, status: upstream.status, detail: detail.slice(0, 500) }
  }
  const json = (await upstream.json().catch(() => null)) as { token?: unknown } | null
  if (typeof json?.token !== 'string' || json.token.length === 0) {
    return { ok: false, status: upstream.status, detail: 'response had no token' }
  }
  return { ok: true, token: json.token }
}

export interface SttTokenRouteDeps {
  verifyUserToken: (token: string) => Promise<string | null>
  getApiKey: () => string | undefined
  fetchImpl?: typeof fetch
}

/**
 * POST /api/stt-token. Supabase-JWT gated, same as /api/stt. Returns
 * `{ token }`. The upstream error body is logged, not returned.
 */
export function registerSttTokenRoute(app: FastifyInstance, deps: SttTokenRouteDeps): void {
  app.post('/api/stt-token', async (req, reply) => {
    const auth = req.headers.authorization
    if (!auth?.startsWith('Bearer ')) {
      return reply.code(401).send({ error: 'missing bearer token' })
    }
    const userId = await deps.verifyUserToken(auth.slice('Bearer '.length))
    if (!userId) return reply.code(401).send({ error: 'invalid token' })

    const headerVal = req.headers['x-recording-id']
    const recordingId = (Array.isArray(headerVal) ? headerVal[0] : headerVal) || 'unattributed'
    const log = req.log.child({ recordingId })

    const apiKey = deps.getApiKey()
    if (!apiKey) {
      log.error({ phase: 'stt-token.config' }, 'ELEVENLABS_API_KEY not configured')
      return reply.code(500).send({ error: 'STT token not configured' })
    }

    const startedAt = Date.now()
    const result = await mintSttToken(apiKey, deps.fetchImpl)
    const durationMs = Date.now() - startedAt
    if (!result.ok) {
      log.error(
        { event: 'voice.stt_token.error', statusCode: result.status, detail: result.detail, durationMs },
        'voice.stt_token.error',
      )
      return reply.code(502).send({ error: 'STT token request failed', statusCode: result.status })
    }
    log.info({ event: 'voice.stt_token.minted', durationMs }, 'voice.stt_token.minted')
    return reply.header('Cache-Control', 'no-store').send({ token: result.token })
  })
}
