/**
 * Fetch a transcript for any supported URL via the Supadata API proxy.
 * Works with YouTube videos, Twitter/X video tweets, and other platforms.
 * Returns the transcript text, or empty string on failure.
 * Failures are silent — never throws.
 */
export async function fetchTranscript(url: string): Promise<string> {
  try {
    if (!url) return ''

    const response = await fetch(
      `/.netlify/functions/youtube-transcript?url=${encodeURIComponent(url)}`,
    )

    if (!response.ok) return ''

    const data = await response.json()
    return data.transcript || ''
  } catch {
    return ''
  }
}

/** @deprecated Use fetchTranscript instead */
export const fetchYouTubeTranscript = fetchTranscript
