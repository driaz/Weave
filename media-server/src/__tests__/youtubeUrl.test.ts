import { describe, expect, it } from 'vitest'
import { extractYouTubeVideoId, youtubeVideoPart, YOUTUBE_ANALYSIS_CAP_SECONDS } from '../youtubeUrl'

describe('extractYouTubeVideoId', () => {
  it.each([
    ['https://www.youtube.com/watch?v=tGYMrBOPQVI', 'tGYMrBOPQVI'],
    ['https://youtube.com/watch?v=tGYMrBOPQVI&t=42s&si=abc', 'tGYMrBOPQVI'],
    ['https://m.youtube.com/watch?v=tGYMrBOPQVI', 'tGYMrBOPQVI'],
    ['https://youtu.be/tGYMrBOPQVI?si=abc', 'tGYMrBOPQVI'],
    ['https://www.youtube.com/shorts/tGYMrBOPQVI?feature=share', 'tGYMrBOPQVI'],
    ['  https://youtu.be/tGYMrBOPQVI  ', 'tGYMrBOPQVI'],
  ])('%s → %s', (url, id) => {
    expect(extractYouTubeVideoId(url)).toBe(id)
  })

  it.each([
    'https://www.youtube.com/',
    'https://youtu.be/',
    'https://x.com/someone/status/1',
    'not a url',
  ])('returns null for %s', (url) => {
    expect(extractYouTubeVideoId(url)).toBeNull()
  })
})

describe('youtubeVideoPart', () => {
  it('builds a canonical watch URL fileData part capped at 15 min', () => {
    expect(YOUTUBE_ANALYSIS_CAP_SECONDS).toBe(900)
    expect(youtubeVideoPart('https://youtu.be/tGYMrBOPQVI?si=abc')).toEqual({
      fileData: { fileUri: 'https://www.youtube.com/watch?v=tGYMrBOPQVI', mimeType: 'video/mp4' },
      videoMetadata: { endOffset: '900s' },
    })
  })

  it('returns null when the URL carries no video id', () => {
    expect(youtubeVideoPart('https://www.youtube.com/')).toBeNull()
  })
})
