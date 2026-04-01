/**
 * Extract a YouTube video ID from various URL formats.
 */
function extractVideoId(url: string): string | null {
  try {
    const parsed = new URL(url.trim())
    const hostname = parsed.hostname.replace(/^www\./, '')

    if (hostname === 'youtu.be') {
      return parsed.pathname.slice(1) || null
    }

    if (hostname === 'youtube.com' || hostname === 'm.youtube.com') {
      const v = parsed.searchParams.get('v')
      if (v) return v

      const shortsMatch = parsed.pathname.match(/^\/shorts\/([^/?]+)/)
      if (shortsMatch) return shortsMatch[1]
    }

    return null
  } catch {
    return null
  }
}

/**
 * Fetch the transcript for a YouTube video.
 * Returns the transcript text, or empty string on failure.
 * Failures are silent — never throws.
 */
export async function fetchYouTubeTranscript(
  videoUrl: string,
): Promise<string> {
  try {
    const videoId = extractVideoId(videoUrl)
    if (!videoId) return ''

    const response = await fetch(
      `/.netlify/functions/youtube-transcript?videoId=${encodeURIComponent(videoId)}`,
    )

    if (!response.ok) return ''

    const data = await response.json()
    return data.transcript || ''
  } catch {
    return ''
  }
}
