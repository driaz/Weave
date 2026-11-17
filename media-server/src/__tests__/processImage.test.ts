import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * processMedia's #17 image paths with every I/O module mocked. The
 * composition helpers (buildUnionView, composeEmbedText) stay real so the
 * embed text asserted here is the one production would send.
 */

const m = vi.hoisted(() => {
  process.env.SUPABASE_URL = 'https://example.supabase.co'
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role'
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), persist: vi.fn(async () => {}) }
  return {
    logger,
    downloadVideo: vi.fn(),
    probeDuration: vi.fn(async () => 30),
    fetchTranscript: vi.fn(async () => ''),
    analyzeMedia: vi.fn(async () => ''),
    embedMultimodal: vi.fn(async () => [0.1, 0.2, 0.3]),
    patchNodeData: vi.fn(async () => {}),
    upsertEmbedding: vi.fn(async () => ({ embedGeneration: 2 })),
    fetchNodeBlob: vi.fn(async (): Promise<Record<string, unknown> | null> => null),
    fetchNodeImageSource: vi.fn(),
    downloadMediaObject: vi.fn(async () => ({ data: Buffer.from('img'), mimeType: 'image/jpeg' })),
    fetchTweetDescription: vi.fn(async () => ''),
  }
})

vi.mock('../download.js', () => ({ downloadVideo: m.downloadVideo }))
vi.mock('../extract.js', () => ({ probeDuration: m.probeDuration, extractAudio: vi.fn() }))
vi.mock('../transcript.js', () => ({ fetchTranscript: m.fetchTranscript }))
vi.mock('../analyze.js', () => ({ analyzeMedia: m.analyzeMedia }))
vi.mock('../embed.js', () => ({ embedMultimodal: m.embedMultimodal }))
vi.mock('../cleanup.js', () => ({ cleanup: vi.fn(async () => {}) }))
vi.mock('../logger.js', () => ({ createNodeLogger: () => m.logger }))
vi.mock('../description.js', async () => {
  const actual = await vi.importActual<typeof import('../description')>('../description.js')
  return { ...actual, fetchTweetDescription: m.fetchTweetDescription }
})
vi.mock('../supabase.js', async () => {
  const actual = await vi.importActual<typeof import('../supabase')>('../supabase.js')
  return {
    ...actual,
    patchNodeData: m.patchNodeData,
    upsertEmbedding: m.upsertEmbedding,
    fetchNodeBlob: m.fetchNodeBlob,
    fetchNodeImageSource: m.fetchNodeImageSource,
    downloadMediaObject: m.downloadMediaObject,
  }
})

const { processMedia, TWEET_PHOTO_RETRY_DELAYS_MS } = await import('../process')

const base = { nodeId: 'n1', boardId: 'b1', userId: 'u1' }

function pipelinePersist() {
  const call = m.logger.persist.mock.calls.find((c: unknown[]) => c[0] === 'media.pipeline') as
    | [string, string, Record<string, unknown>]
    | undefined
  return call ? { outcome: call[1], detail: call[2] } : null
}

beforeEach(() => {
  vi.clearAllMocks()
  m.fetchTranscript.mockResolvedValue('')
  m.analyzeMedia.mockResolvedValue('')
  m.fetchNodeBlob.mockResolvedValue(null)
  m.downloadMediaObject.mockResolvedValue({ data: Buffer.from('img'), mimeType: 'image/jpeg' })
})

afterEach(() => {
  vi.useRealTimers()
})

/**
 * Drive the retry waits: only setTimeout is faked, so real I/O (mkdtemp)
 * still progresses between steps via setImmediate.
 */
async function runWithFakeWaits<T>(run: Promise<T>): Promise<void> {
  let done = false
  run.then(
    () => { done = true },
    () => { done = true },
  )
  while (!done) {
    await new Promise((resolve) => setImmediate(resolve))
    await vi.advanceTimersByTimeAsync(1000)
  }
}

describe('processMedia — image card', () => {
  it('analyses the stored image, patches media_analysis, embeds label — analysis', async () => {
    m.fetchNodeImageSource.mockResolvedValue({ path: 'u1/b1/n1.jpg', tweetText: '' })
    m.analyzeMedia.mockResolvedValue('A fog-bound pier at dawn.')
    m.fetchNodeBlob.mockResolvedValue({ label: 'Harbor', fileName: 'IMG_1.jpg', media_analysis: 'A fog-bound pier at dawn.' })

    await processMedia({ ...base, url: '', nodeType: 'image' })

    expect(m.fetchTranscript).not.toHaveBeenCalled()
    expect(m.downloadVideo).not.toHaveBeenCalled()
    expect(m.downloadMediaObject).toHaveBeenCalledWith('u1/b1/n1.jpg')
    expect(m.analyzeMedia).toHaveBeenCalledWith({
      image: { data: Buffer.from('img'), mimeType: 'image/jpeg' },
      caption: '',
    })
    expect(m.patchNodeData).toHaveBeenCalledWith({ ...base, patch: { media_analysis: 'A fog-bound pier at dawn.' } })
    expect(m.embedMultimodal).toHaveBeenCalledWith({ text: 'Harbor — A fog-bound pier at dawn.' })
    expect(m.fetchTweetDescription).not.toHaveBeenCalled()
    const upsert = m.upsertEmbedding.mock.calls[0]![0] as Record<string, unknown>
    expect(upsert.nodeType).toBe('imageCard')
    expect(upsert.hasVideo).toBe(false)
    expect(pipelinePersist()).toMatchObject({ outcome: 'success', detail: { tier: 'image', descriptionStep: 'skipped-image' } })
  })

  it('stops before the embed when analysis is empty (client pixel embed stays)', async () => {
    m.fetchNodeImageSource.mockResolvedValue({ path: 'u1/b1/n1.jpg', tweetText: '' })
    m.analyzeMedia.mockResolvedValue('')

    await processMedia({ ...base, url: '', nodeType: 'image' })

    expect(m.patchNodeData).not.toHaveBeenCalled()
    expect(m.embedMultimodal).not.toHaveBeenCalled()
    expect(m.upsertEmbedding).not.toHaveBeenCalled()
    expect(pipelinePersist()).toMatchObject({ outcome: 'degraded', detail: { tier: 'image', reason: 'empty-image-analysis' } })
  })

  it('stops when the image is not in Storage', async () => {
    m.fetchNodeImageSource.mockResolvedValue({ path: null, tweetText: '' })

    await processMedia({ ...base, url: '', nodeType: 'image' })

    expect(m.downloadMediaObject).not.toHaveBeenCalled()
    expect(m.analyzeMedia).not.toHaveBeenCalled()
    expect(m.embedMultimodal).not.toHaveBeenCalled()
    expect(pipelinePersist()?.outcome).toBe('degraded')
  })
})

describe('processMedia — tweet photo fallback', () => {
  const photoTweet = 'rents doubled pic.twitter.com/AbC'

  it('analyses the attached photo when yt-dlp finds no video', async () => {
    m.downloadVideo.mockRejectedValue(new Error('yt-dlp exited with code 1'))
    m.fetchNodeImageSource.mockResolvedValue({ path: 'u1/b1/n1.jpg', tweetText: photoTweet })
    m.analyzeMedia.mockResolvedValue('A bar chart of rents.')
    m.fetchNodeBlob.mockResolvedValue({ authorName: 'Ana', tweetText: photoTweet })
    m.fetchTweetDescription.mockResolvedValue('Ana charts rent doubling.')

    await processMedia({ ...base, url: 'https://x.com/a/status/1', nodeType: 'twitter' })

    expect(m.analyzeMedia).toHaveBeenCalledWith({
      image: { data: Buffer.from('img'), mimeType: 'image/jpeg' },
      caption: photoTweet,
    })
    expect(m.patchNodeData).toHaveBeenCalledWith({ ...base, patch: { media_analysis: 'A bar chart of rents.' } })
    expect(m.embedMultimodal).toHaveBeenCalledWith({
      text: `Ana charts rent doubling. — Ana — ${photoTweet} — A bar chart of rents.`,
    })
    const upsert = m.upsertEmbedding.mock.calls[0]![0] as Record<string, unknown>
    expect(upsert.nodeType).toBe('linkCard')
    expect(upsert.hasVideo).toBe(false)
    expect(pipelinePersist()).toMatchObject({ outcome: 'success', detail: { tier: 'tweet-photo', descriptionStep: 'generated' } })
  })

  it('does not analyse an image on a tweet without a photo link (avatar guard)', async () => {
    m.downloadVideo.mockRejectedValue(new Error('yt-dlp exited with code 1'))
    m.fetchNodeImageSource.mockResolvedValue({ path: 'u1/b1/n1.jpg', tweetText: 'just words' })

    await expect(
      processMedia({ ...base, url: 'https://x.com/a/status/1', nodeType: 'twitter' }),
    ).rejects.toThrow('yt-dlp exited with code 1')

    expect(m.fetchNodeImageSource).toHaveBeenCalledTimes(1)
    expect(m.analyzeMedia).not.toHaveBeenCalled()
    expect(pipelinePersist()?.outcome).toBe('failed')
  })

  it('waits for a late image upload', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] })
    m.downloadVideo.mockRejectedValue(new Error('yt-dlp exited with code 1'))
    m.fetchNodeImageSource
      .mockResolvedValueOnce({ path: null, tweetText: photoTweet })
      .mockResolvedValueOnce({ path: null, tweetText: photoTweet })
      .mockResolvedValue({ path: 'u1/b1/n1.jpg', tweetText: photoTweet })
    m.analyzeMedia.mockResolvedValue('A bar chart of rents.')

    const run = processMedia({ ...base, url: 'https://x.com/a/status/1', nodeType: 'twitter' })
    await runWithFakeWaits(run)
    await run

    expect(m.fetchNodeImageSource).toHaveBeenCalledTimes(3)
    expect(m.analyzeMedia).toHaveBeenCalledTimes(1)
    expect(m.embedMultimodal).toHaveBeenCalledTimes(1)
  })

  it('gives up (pipeline fails as before) when the image never lands', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] })
    m.downloadVideo.mockRejectedValue(new Error('yt-dlp exited with code 1'))
    m.fetchNodeImageSource.mockResolvedValue({ path: null, tweetText: photoTweet })

    const run = processMedia({ ...base, url: 'https://x.com/a/status/1', nodeType: 'twitter' })
    await runWithFakeWaits(run)
    await expect(run).rejects.toThrow('yt-dlp exited with code 1')

    expect(m.fetchNodeImageSource).toHaveBeenCalledTimes(1 + TWEET_PHOTO_RETRY_DELAYS_MS.length)
    expect(m.analyzeMedia).not.toHaveBeenCalled()
  })

  it('video tweets never touch the image path', async () => {
    m.downloadVideo.mockResolvedValue('/tmp/video.mp4')
    m.analyzeMedia.mockResolvedValue('Handheld footage.')

    await processMedia({ ...base, url: 'https://x.com/a/status/1', nodeType: 'twitter' })

    expect(m.fetchNodeImageSource).not.toHaveBeenCalled()
    expect(m.analyzeMedia).toHaveBeenCalledWith({ videoPath: '/tmp/video.mp4' })
    const upsert = m.upsertEmbedding.mock.calls[0]![0] as Record<string, unknown>
    expect(upsert.hasVideo).toBe(true)
  })
})
