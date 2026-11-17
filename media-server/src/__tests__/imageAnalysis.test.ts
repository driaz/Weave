import { beforeAll, describe, expect, it, vi } from 'vitest'
import { hasAttachedPhoto, resolveImageMime } from '../image'

// analyze.ts and supabase.ts throw at import without these; no network is
// touched by anything under test here.
vi.stubEnv('GEMINI_API_KEY', 'test-key')
vi.stubEnv('SUPABASE_URL', 'https://example.supabase.co')
vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'test-service-role')

type Supa = typeof import('../supabase')
type Analyze = typeof import('../analyze')
let supa: Supa
let analyze: Analyze

beforeAll(async () => {
  supa = await import('../supabase')
  analyze = await import('../analyze')
})

describe('hasAttachedPhoto (photo-tweet gate)', () => {
  it.each([
    'Look at this pic.twitter.com/AbC123',
    'new chart pic.x.com/xyz',
    'PIC.TWITTER.COM/upper',
  ])('accepts %s', (text) => {
    expect(hasAttachedPhoto(text)).toBe(true)
  })

  it.each(['plain text tweet', 'https://twitter.com/x/status/1', 'pic.twitter.com without slash', ''])(
    'rejects %s',
    (text) => {
      expect(hasAttachedPhoto(text)).toBe(false)
    },
  )
})

describe('resolveImageMime', () => {
  it('keeps a reported image type', () => {
    expect(resolveImageMime('image/webp', 'u/b/n.bin')).toBe('image/webp')
  })
  it('falls back to the path extension', () => {
    expect(resolveImageMime('application/octet-stream', 'u/b/n.jpg')).toBe('image/jpeg')
    expect(resolveImageMime('', 'u/b/n.PNG')).toBe('image/png')
  })
  it('refuses svg and unknown types', () => {
    expect(resolveImageMime('image/svg+xml', 'u/b/n.svg')).toBeNull()
    expect(resolveImageMime('', 'u/b/n.bin')).toBeNull()
  })
})

describe('buildImagePrompt', () => {
  it('is the bare image prompt without a caption', () => {
    const prompt = analyze.buildImagePrompt()
    expect(prompt).toContain('analyzing an image')
    expect(prompt).not.toContain('POST TEXT')
  })
  it('appends the tweet text as context', () => {
    const prompt = analyze.buildImagePrompt('  the caption  ')
    expect(prompt).toContain('POST TEXT:\nthe caption')
    expect(prompt).toContain("don't repeat it")
  })
})

describe('composeEmbedText — image card recipe', () => {
  it('label — media_analysis', () => {
    const view = supa.buildUnionView({ label: 'Harbor', fileName: 'IMG_1.jpg' }, { mediaAnalysis: 'A fog-bound pier.' })
    const composed = supa.composeEmbedText({ nodeType: 'image', view, fallbackUrl: '' })
    expect(composed.text).toBe('Harbor — A fog-bound pier.')
    expect(composed.hadAnalysis).toBe(true)
    expect(composed.hadTranscript).toBe(false)
    expect(composed.truncatedFromChars).toBeNull()
  })

  it('falls back to fileName, then "Image"', () => {
    const byFile = supa.buildUnionView({ label: '', fileName: 'IMG_1.jpg' }, { mediaAnalysis: 'X.' })
    expect(supa.composeEmbedText({ nodeType: 'image', view: byFile, fallbackUrl: '' }).text).toBe('IMG_1.jpg — X.')
    const bare = supa.buildUnionView(null, { mediaAnalysis: 'X.' })
    expect(supa.composeEmbedText({ nodeType: 'image', view: bare, fallbackUrl: '' }).text).toBe('Image — X.')
  })

  it('photo tweet uses the tweet recipe with analysis', () => {
    const view = supa.buildUnionView(
      { authorName: 'Ana', tweetText: 'look pic.twitter.com/a' },
      { mediaAnalysis: 'A chart of rents.' },
    )
    const composed = supa.composeEmbedText({ nodeType: 'twitter', view, fallbackUrl: 'u' })
    expect(composed.text).toBe('Ana — look pic.twitter.com/a — A chart of rents.')
    expect(composed.hadAnalysis).toBe(true)
  })
})
