import { describe, expect, it } from 'vitest'
import Fastify from 'fastify'
import cors from '@fastify/cors'
import { buildCorsOptions, CORS_PREFLIGHT_MAX_AGE_S } from '../corsOptions.js'

async function preflight(path: string, origin: string) {
  const app = Fastify()
  await app.register(cors, buildCorsOptions(['https://weave.example']))
  app.post(path, async () => ({ ok: true }))
  const res = await app.inject({
    method: 'OPTIONS',
    url: path,
    headers: {
      origin,
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'authorization,content-type,x-playback-id',
    },
  })
  await app.close()
  return res
}

describe('CORS preflight', () => {
  it('lets browsers cache the preflight for 2 h', async () => {
    const res = await preflight('/api/tts-stream', 'https://weave.example')
    expect(res.statusCode).toBe(204)
    expect(res.headers['access-control-max-age']).toBe(String(CORS_PREFLIGHT_MAX_AGE_S))
    expect(res.headers['access-control-allow-origin']).toBe('https://weave.example')
    expect(res.headers['access-control-allow-headers']).toContain('Authorization')
  })

  it('still refuses origins outside the allow-list', async () => {
    const res = await preflight('/api/claude', 'https://evil.example')
    expect(res.headers['access-control-allow-origin']).toBeUndefined()
  })
})
