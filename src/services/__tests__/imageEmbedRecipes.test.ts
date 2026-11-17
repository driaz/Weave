import { describe, expect, it, vi } from 'vitest'

vi.mock('../geminiClient', () => ({ ai: null }))
vi.mock('../supabaseClient', () => ({ supabase: null }))

const { buildPartsForNode } = await import('../embeddingService')

const PIXELS = 'data:image/png;base64,iVBORw0KGgo='

describe('imageCard embed recipe (#17)', () => {
  it('uses label — media_analysis, text only, when analysis exists', () => {
    const r = buildPartsForNode('imageCard', {
      imageDataUrl: PIXELS,
      fileName: 'IMG_1.png',
      label: 'Harbor',
      media_analysis: '  A fog-bound pier at dawn.  ',
    })
    expect(r?.parts).toEqual([{ text: 'Harbor — A fog-bound pier at dawn.' }])
    expect(r?.summary).toBe('Harbor — A fog-bound pier at dawn.')
    expect(r?.hadAnalysis).toBe(true)
  })

  it('falls back to fileName, and works without pixels (post-hydrate signed URL)', () => {
    const r = buildPartsForNode('imageCard', {
      imageDataUrl: 'https://example.supabase.co/storage/v1/object/sign/x',
      fileName: 'IMG_1.png',
      label: '',
      media_analysis: 'A fog-bound pier.',
    })
    expect(r?.parts).toEqual([{ text: 'IMG_1.png — A fog-bound pier.' }])
  })

  it('keeps the pixels + label path without analysis', () => {
    const r = buildPartsForNode('imageCard', { imageDataUrl: PIXELS, fileName: 'IMG_1.png', label: 'Harbor' })
    expect(r?.parts).toEqual([
      { inlineData: { data: 'iVBORw0KGgo=', mimeType: 'image/png' } },
      { text: 'Harbor' },
    ])
    expect(r?.hadAnalysis).toBe(false)
  })

  it('treats blank analysis as absent', () => {
    const r = buildPartsForNode('imageCard', { imageDataUrl: PIXELS, fileName: 'a.png', label: '', media_analysis: '   ' })
    expect(r?.parts[0]).toHaveProperty('inlineData')
  })
})

describe('photo tweet embed recipe (#17)', () => {
  const tweet = {
    type: 'twitter',
    authorName: 'Ana',
    authorHandle: '@ana',
    tweetText: 'rents doubled pic.twitter.com/AbC',
    domain: 'x.com',
    imageBase64: 'AAAA',
    imageMimeType: 'image/jpeg',
  }

  it('goes text-only with analysis — no image part', () => {
    const r = buildPartsForNode('linkCard', { ...tweet, media_analysis: 'A bar chart of rents.' })
    expect(r?.parts).toEqual([{ text: 'Ana — rents doubled pic.twitter.com/AbC — A bar chart of rents.' }])
    expect(r?.hadAnalysis).toBe(true)
  })

  it('keeps text + inline image without analysis', () => {
    const r = buildPartsForNode('linkCard', tweet)
    expect(r?.parts).toEqual([
      { text: 'Ana — @ana — rents doubled pic.twitter.com/AbC — x.com' },
      { inlineData: { data: 'AAAA', mimeType: 'image/jpeg' } },
    ])
    expect(r?.hadAnalysis).toBe(false)
  })
})
