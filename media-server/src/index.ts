// Side-effect import — must come before any module that reads process.env at
// load time (auth.ts, supabase.ts, analyze.ts, embed.ts all throw on missing
// vars). On Fly the env comes from `fly secrets`, so .env is absent and
// dotenv silently no-ops; locally it loads media-server/.env from cwd.
import 'dotenv/config'

import Fastify from 'fastify'
import sensible from '@fastify/sensible'
import cors from '@fastify/cors'
import { Readable } from 'node:stream'
import type { ReadableStream as WebReadableStream } from 'node:stream/web'
import { verifyUserToken } from './auth.js'
import { processMedia } from './process.js'

const PORT = Number(process.env.PORT ?? 3000)

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY
if (!ANTHROPIC_API_KEY) {
  throw new Error('ANTHROPIC_API_KEY is required')
}

// Browsers send a CORS preflight (OPTIONS) for cross-origin POSTs that
// carry Authorization + Content-Type: application/json — which every
// /process call does. Without an allow-list registered, Fastify 404s the
// preflight and the browser logs it as a failed POST. Allowed origins
// come from env (comma-separated); local dev defaults to Vite's port.
const allowedOrigins = (process.env.WEAVE_ALLOWED_ORIGINS ?? 'http://localhost:5173')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)

const app = Fastify({ logger: true, bodyLimit: 10 * 1024 * 1024 })
await app.register(sensible)
await app.register(cors, {
  origin: allowedOrigins,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
})

app.get('/health', async () => ({ status: 'ok' }))

interface ProcessBody {
  node_id: string
  board_id: string
  url: string
  node_type: 'youtube' | 'twitter'
}

app.post<{ Body: ProcessBody }>('/process', async (req, reply) => {
  const auth = req.headers.authorization
  if (!auth?.startsWith('Bearer ')) {
    return reply.unauthorized('missing bearer token')
  }
  const userId = await verifyUserToken(auth.slice('Bearer '.length))
  if (!userId) return reply.unauthorized('invalid token')

  const { node_id, board_id, url, node_type } = req.body ?? ({} as ProcessBody)
  if (!node_id || !board_id || !url || !node_type) {
    return reply.badRequest('node_id, board_id, url, node_type required')
  }
  if (node_type !== 'youtube' && node_type !== 'twitter') {
    return reply.badRequest('node_type must be youtube or twitter')
  }

  // Fire-and-forget. Errors are logged inside processMedia; the client
  // doesn't wait — the embedding + media_analysis land async via Supabase.
  processMedia({ nodeId: node_id, boardId: board_id, url, nodeType: node_type, userId })
    .catch((err) => app.log.error({ err, nodeId: node_id }, 'processMedia failed'))

  return reply.code(202).send({ accepted: true })
})

interface TtsBody {
  text: string
}

const TTS_MAX_TEXT_LENGTH = 5000

app.post<{ Body: TtsBody }>('/api/tts', async (req, reply) => {
  const { text } = req.body ?? ({} as TtsBody)
  if (typeof text !== 'string' || text.trim().length === 0) {
    return reply.badRequest('text is required')
  }
  if (text.length > TTS_MAX_TEXT_LENGTH) {
    return reply.badRequest(`text exceeds max length of ${TTS_MAX_TEXT_LENGTH} characters`)
  }

  const apiKey = process.env.ELEVENLABS_API_KEY
  if (!apiKey) {
    req.log.error({ phase: 'tts.config' }, 'ELEVENLABS_API_KEY not configured')
    return reply.code(500).send({ error: 'ElevenLabs API key not configured' })
  }

  const voiceId = process.env.ELEVENLABS_VOICE_ID
  if (!voiceId) {
    req.log.error({ phase: 'tts.config' }, 'ELEVENLABS_VOICE_ID not configured')
    return reply.code(500).send({ error: 'ElevenLabs voice ID not configured' })
  }

  let upstream: Response
  try {
    upstream = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream`, {
      method: 'POST',
      headers: {
        'xi-api-key': apiKey,
        'Content-Type': 'application/json',
        Accept: 'audio/mpeg',
      },
      body: JSON.stringify({
        text,
        model_id: 'eleven_flash_v2_5',
        voice_settings: { stability: 0.5, similarity_boost: 0.75 },
        output_format: 'mp3_44100_128',
      }),
    })
  } catch (err) {
    req.log.error({ err, phase: 'tts.fetch' }, 'ElevenLabs request failed')
    return reply.code(502).send({ error: 'TTS generation failed' })
  }

  if (!upstream.ok || !upstream.body) {
    const detail = await upstream.text().catch(() => '')
    req.log.error(
      { status: upstream.status, detail: detail.slice(0, 500), phase: 'tts.upstream' },
      'ElevenLabs returned error',
    )
    return reply.code(502).send({ error: 'TTS generation failed' })
  }

  reply
    .header('Content-Type', 'audio/mpeg')
    .header('Transfer-Encoding', 'chunked')

  return reply.send(Readable.fromWeb(upstream.body as WebReadableStream<Uint8Array>))
})

app.post<{ Body: TtsBody }>('/api/tts-stream', async (req, reply) => {
  // Client mints a playbackId per listen-button click and sends it in
  // X-Playback-Id so the full turn (client logs + Fly logs) can be joined.
  // Missing header → 'unattributed' placeholder so the field is always
  // present in logs. Don't fail the request — voice-v2 is rolling out
  // behind a flag and old clients won't send it.
  const headerVal = req.headers['x-playback-id']
  const rawPlaybackId = Array.isArray(headerVal) ? headerVal[0] : headerVal
  const playbackId =
    typeof rawPlaybackId === 'string' && rawPlaybackId.length > 0
      ? rawPlaybackId
      : 'unattributed'
  const log = req.log.child({ playbackId })
  if (playbackId === 'unattributed') {
    log.warn({ phase: 'tts-stream.no-correlation' }, 'X-Playback-Id header missing')
  }

  const auth = req.headers.authorization
  if (!auth?.startsWith('Bearer ')) {
    return reply.unauthorized('missing bearer token')
  }
  const userId = await verifyUserToken(auth.slice('Bearer '.length))
  if (!userId) return reply.unauthorized('invalid token')

  const { text } = req.body ?? ({} as TtsBody)
  if (typeof text !== 'string' || text.trim().length === 0) {
    return reply.badRequest('text is required')
  }
  if (text.length > TTS_MAX_TEXT_LENGTH) {
    return reply.badRequest(`text exceeds max length of ${TTS_MAX_TEXT_LENGTH} characters`)
  }

  const apiKey = process.env.ELEVENLABS_API_KEY
  if (!apiKey) {
    log.error({ phase: 'tts-stream.config' }, 'ELEVENLABS_API_KEY not configured')
    return reply.code(500).send({ error: 'ElevenLabs API key not configured' })
  }

  const voiceId = process.env.ELEVENLABS_VOICE_ID
  if (!voiceId) {
    log.error({ phase: 'tts-stream.config' }, 'ELEVENLABS_VOICE_ID not configured')
    return reply.code(500).send({ error: 'ElevenLabs voice ID not configured' })
  }

  log.info({ phase: 'tts-stream.request', textLength: text.length }, 'tts-stream request received')

  // output_format must be a query param, NOT a body field — ElevenLabs silently
  // ignores it in the body and falls back to mp3, which breaks the PCM pipeline.
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream?output_format=pcm_24000`

  let upstream: Response
  try {
    log.info({ phase: 'tts-stream.upstream', url }, 'issuing ElevenLabs request')
    upstream = await fetch(url, {
      method: 'POST',
      headers: {
        'xi-api-key': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        text,
        model_id: 'eleven_turbo_v2_5',
        voice_settings: {
          stability: 0.6,
          similarity_boost: 0.8,
          style: 0.2,
          use_speaker_boost: true,
        },
      }),
    })
  } catch (err) {
    log.error({ err, phase: 'tts-stream.upstream' }, 'ElevenLabs request failed')
    return reply.code(502).send({ error: 'TTS generation failed' })
  }

  if (!upstream.ok || !upstream.body) {
    const detail = await upstream.text().catch(() => '')
    log.error(
      { status: upstream.status, detail: detail.slice(0, 500), phase: 'tts-stream.upstream' },
      'ElevenLabs returned error',
    )
    return reply.code(502).send({ error: 'TTS generation failed' })
  }

  log.info(
    { status: upstream.status, phase: 'tts-stream.upstream' },
    'ElevenLabs stream opened',
  )

  reply
    .header('Content-Type', 'audio/pcm')
    .header('Transfer-Encoding', 'chunked')
    .header('Cache-Control', 'no-cache')
    .header('X-Accel-Buffering', 'no')

  const nodeStream = Readable.fromWeb(upstream.body as WebReadableStream<Uint8Array>)
  let bytesStreamed = 0
  nodeStream.on('data', (chunk: Buffer) => {
    bytesStreamed += chunk.length
  })
  nodeStream.on('end', () => {
    log.info({ phase: 'tts-stream.complete', bytesStreamed }, 'streaming ended')
  })
  nodeStream.on('error', (err) => {
    log.error({ err, phase: 'tts-stream.pipe' }, 'stream error during pipe')
  })

  return reply.send(nodeStream)
})

app.post('/api/claude', async (req, reply) => {
  const auth = req.headers.authorization
  if (!auth?.startsWith('Bearer ')) {
    return reply.unauthorized('missing bearer token')
  }
  const userId = await verifyUserToken(auth.slice('Bearer '.length))
  if (!userId) return reply.unauthorized('invalid token')

  const body = req.body
  if (!body || typeof body !== 'object') {
    return reply.badRequest('JSON body required')
  }

  let upstream: Response
  try {
    upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ ...body, stream: true }),
    })
  } catch (err) {
    req.log.error({ err, phase: 'claude.fetch' }, 'Anthropic request failed')
    return reply.code(502).send({ error: 'Claude request failed' })
  }

  if (!upstream.ok || !upstream.body) {
    const detail = await upstream.text().catch(() => '')
    req.log.error(
      { status: upstream.status, detail: detail.slice(0, 500), phase: 'claude.upstream' },
      'Anthropic returned error',
    )
    return reply.code(upstream.status).send({ error: 'Claude request failed', detail })
  }

  reply
    .header('Content-Type', 'text/event-stream')
    .header('Cache-Control', 'no-cache')
    .header('X-Accel-Buffering', 'no')

  return reply.send(Readable.fromWeb(upstream.body as WebReadableStream<Uint8Array>))
})

await app.listen({ host: '0.0.0.0', port: PORT })
