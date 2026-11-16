import type { Part } from '@google/genai'

/**
 * YouTube cards are analyzed by handing Gemini the public URL — no yt-dlp
 * download (blocked by YouTube's bot check on Fly), no ffprobe, no tiers.
 * Analysis is capped at the first 15 min via endOffset; past that the cost
 * grows with no tier to fall back to (~91 tokens/s at default settings).
 */
export const YOUTUBE_ANALYSIS_CAP_SECONDS = 900

/** Mirrors extractYouTubeVideoId in src/utils/linkUtils.ts (client). */
export function extractYouTubeVideoId(url: string): string | null {
  try {
    const parsed = new URL(url.trim())
    const hostname = parsed.hostname.replace(/^www\./, '')

    if (hostname === 'youtu.be') {
      return parsed.pathname.slice(1).split('/')[0] || null
    }

    if (hostname === 'youtube.com' || hostname === 'm.youtube.com') {
      const v = parsed.searchParams.get('v')
      if (v) return v

      const shortsMatch = parsed.pathname.match(/^\/shorts\/([^/?]+)/)
      if (shortsMatch) return shortsMatch[1] ?? null
    }

    return null
  } catch {
    return null
  }
}

/** Gemini fileData part for a public YouTube video, or null if the URL has no video id. */
export function youtubeVideoPart(url: string): Part | null {
  const id = extractYouTubeVideoId(url)
  if (!id) return null
  return {
    fileData: { fileUri: `https://www.youtube.com/watch?v=${id}`, mimeType: 'video/mp4' },
    videoMetadata: { endOffset: `${YOUTUBE_ANALYSIS_CAP_SECONDS}s` },
  }
}
