import type { Node } from '@xyflow/react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../services/supabaseClient', () => ({ supabase: null }))
// Canvas-based compression needs a DOM; identity is enough here.
vi.mock('../../utils/imageUtils', () => ({ compressBase64Image: async (s: string) => s }))

const { serializeNodes } = await import('../claude')

type Block = Awaited<ReturnType<typeof serializeNodes>>[number]

function blocks(content: Block[]) {
  const text = content
    .filter((b): b is Extract<Block, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('')
  const images = content.filter((b) => b.type === 'image')
  return { text, images }
}

const imageCard = (data: Record<string, unknown>): Node => ({
  id: 'img1',
  type: 'imageCard',
  position: { x: 0, y: 0 },
  data: { imageDataUrl: 'data:image/png;base64,iVBORw0KGgo=', fileName: 'IMG_1.png', label: 'Harbor', ...data },
})

const tweet = (data: Record<string, unknown>): Node => ({
  id: 'tw1',
  type: 'linkCard',
  position: { x: 0, y: 0 },
  data: {
    type: 'twitter',
    url: 'https://x.com/ana/status/1',
    domain: 'x.com',
    title: 'Ana',
    authorName: 'Ana',
    authorHandle: '@ana',
    tweetText: 'rents doubled pic.twitter.com/AbC',
    imageBase64: 'AAAA',
    imageMimeType: 'image/jpeg',
    ...data,
  },
})

describe('serializeNodes — weave call (#17)', () => {
  it('image card with analysis: text, no image block', async () => {
    const { text, images } = blocks(await serializeNodes([imageCard({ media_analysis: 'A fog-bound pier.' })]))
    expect(text).toContain('[Node img1 — Image Card] (label: "Harbor"):\nImage analysis: A fog-bound pier.')
    expect(images).toHaveLength(0)
  })

  it('image card without analysis: image block fallback', async () => {
    const { text, images } = blocks(await serializeNodes([imageCard({})]))
    expect(text).not.toContain('Image analysis')
    expect(images).toEqual([
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } },
    ])
  })

  it('tweet with analysis: analysis text, no image block (photo and video alike)', async () => {
    const { text, images } = blocks(await serializeNodes([tweet({ media_analysis: 'A bar chart of rents.' })]))
    expect(text).toContain('Tweet media analysis (what the attached video or image shows): A bar chart of rents.')
    expect(images).toHaveLength(0)
  })

  it('tweet without analysis: image block fallback', async () => {
    const { text, images } = blocks(await serializeNodes([tweet({})]))
    expect(text).not.toContain('Tweet media analysis')
    expect(images).toEqual([
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'AAAA' } },
    ])
  })
})
