const INNERTUBE_URL =
  'https://www.youtube.com/youtubei/v1/player?prettyPrint=false'

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

interface CaptionTrack {
  baseUrl: string
  languageCode: string
}

/**
 * Client-side Innertube fetch: call the YouTube player API directly from
 * the user's browser (residential IP, bypasses datacenter restrictions).
 * Returns caption tracks or null.
 */
async function fetchCaptionTracksFromClient(
  videoId: string,
): Promise<CaptionTrack[] | null> {
  try {
    const resp = await fetch(INNERTUBE_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        context: {
          client: {
            clientName: 'WEB',
            clientVersion: '2.20241126.01.00',
          },
        },
        videoId,
      }),
    })

    if (!resp.ok) return null

    const data = await resp.json()
    const tracks =
      data?.captions?.playerCaptionsTracklistRenderer?.captionTracks

    return Array.isArray(tracks) && tracks.length > 0 ? tracks : null
  } catch {
    return null
  }
}

/**
 * Send a caption URL to the serverless function for XML parsing.
 * The server fetches and parses the caption XML (avoids CORS issues
 * with the timedtext endpoint).
 */
async function fetchTranscriptFromCaptionUrl(
  captionUrl: string,
  lang: string,
): Promise<string> {
  try {
    const resp = await fetch(
      `/.netlify/functions/youtube-transcript?captionUrl=${encodeURIComponent(captionUrl)}&lang=${encodeURIComponent(lang)}`,
    )
    if (!resp.ok) return ''

    const data = await resp.json()
    return data.transcript || ''
  } catch {
    return ''
  }
}

/**
 * Fetch the transcript for a YouTube video.
 * Strategy:
 * 1. Ask the serverless function to try server-side extraction
 * 2. If server returns needsClientFetch, use the browser's Innertube
 *    access (residential IP) to get caption tracks, then send the
 *    caption URL back to the server for XML parsing
 *
 * Returns the transcript text, or empty string on failure.
 * Failures are silent — never throws.
 */
export async function fetchYouTubeTranscript(
  videoUrl: string,
): Promise<string> {
  try {
    const videoId = extractVideoId(videoUrl)
    if (!videoId) return ''

    // Try server-side first
    const serverResp = await fetch(
      `/.netlify/functions/youtube-transcript?videoId=${encodeURIComponent(videoId)}`,
    )

    if (serverResp.ok) {
      const serverData = await serverResp.json()

      // If server got the transcript, we're done
      if (serverData.transcript) {
        return serverData.transcript
      }

      // If server says to try client-side
      if (serverData.needsClientFetch) {
        const tracks = await fetchCaptionTracksFromClient(videoId)
        if (!tracks) return ''

        // Prefer English
        const english = tracks.find(
          (t) =>
            t.languageCode === 'en' || t.languageCode?.startsWith('en-'),
        )
        const track = english || tracks[0]

        if (!track.baseUrl) return ''

        // Send caption URL to server for parsing
        return fetchTranscriptFromCaptionUrl(
          track.baseUrl,
          track.languageCode,
        )
      }
    }

    return ''
  } catch {
    return ''
  }
}
