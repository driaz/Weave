import { afterEach, describe, expect, it, vi } from 'vitest'
import { warmMediaConnection } from '../warmMediaConnection'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('warmMediaConnection', () => {
  it('hits /health once per distinct origin, uncredentialed', () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('ok'))
    vi.stubGlobal('fetch', fetchMock)

    warmMediaConnection([
      'https://weave-media.fly.dev/api/claude',
      'https://weave-media.fly.dev',
      'http://localhost:3000',
    ])

    expect(fetchMock.mock.calls).toEqual([
      ['https://weave-media.fly.dev/health', { credentials: 'omit', cache: 'no-store' }],
      ['http://localhost:3000/health', { credentials: 'omit', cache: 'no-store' }],
    ])
  })

  it('skips missing or malformed URLs', () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('ok'))
    vi.stubGlobal('fetch', fetchMock)

    warmMediaConnection([undefined, 'not a url'])

    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('swallows network failures', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('offline'))
    vi.stubGlobal('fetch', fetchMock)

    expect(() => warmMediaConnection(['https://weave-media.fly.dev'])).not.toThrow()
    await Promise.resolve()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
