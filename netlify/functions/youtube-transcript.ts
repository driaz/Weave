const INNERTUBE_URL =
  'https://www.youtube.com/youtubei/v1/player?prettyPrint=false'
const ANDROID_VERSION = '20.10.38'
const ANDROID_USER_AGENT = `com.google.android.youtube/${ANDROID_VERSION} (Linux; U; Android 14)`
const WEB_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_4) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/85.0.4183.83 Safari/537.36,gzip(gfe)'

interface CaptionTrack {
  baseUrl: string
  languageCode: string
}

/**
 * Try fetching caption tracks via the ANDROID Innertube client.
 */
async function fetchViaInnerTube(
  videoId: string,
): Promise<CaptionTrack[] | null> {
  try {
    const resp = await fetch(INNERTUBE_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'user-agent': ANDROID_USER_AGENT,
      },
      body: JSON.stringify({
        context: {
          client: {
            clientName: 'ANDROID',
            clientVersion: ANDROID_VERSION,
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
 * Fallback: scrape the YouTube watch page for caption tracks embedded
 * in ytInitialPlayerResponse.
 */
async function fetchViaWebPage(
  videoId: string,
): Promise<CaptionTrack[] | null> {
  try {
    const resp = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
      headers: { 'user-agent': WEB_USER_AGENT },
    })

    if (!resp.ok) return null

    const html = await resp.text()

    // The marker may or may not include 'var ' prefix
    let marker = 'var ytInitialPlayerResponse = '
    let start = html.indexOf(marker)
    if (start === -1) {
      marker = 'ytInitialPlayerResponse = '
      start = html.indexOf(marker)
    }
    if (start === -1) return null

    const jsonStart = start + marker.length
    let depth = 0
    for (let i = jsonStart; i < html.length; i++) {
      if (html[i] === '{') depth++
      else if (html[i] === '}') {
        depth--
        if (depth === 0) {
          try {
            const parsed = JSON.parse(html.slice(jsonStart, i + 1))
            const tracks =
              parsed?.captions?.playerCaptionsTracklistRenderer?.captionTracks
            return Array.isArray(tracks) && tracks.length > 0 ? tracks : null
          } catch {
            return null
          }
        }
      }
    }

    return null
  } catch {
    return null
  }
}

/**
 * Decode common HTML entities in caption text.
 */
function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) =>
      String.fromCodePoint(parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/g, (_, num) =>
      String.fromCodePoint(parseInt(num, 10)),
    )
}

/**
 * Parse caption XML (handles both srv3 <p> format and srv1 <text> format).
 * For srv3, also handles nested <s> spans within <p> elements.
 */
function parseTranscriptXml(xml: string): string[] {
  const segments: string[] = []

  // Try srv3 format first: <p t="..." d="...">text or <s> spans</p>
  const pRegex = /<p\s+t="\d+"\s+d="\d+"[^>]*>([\s\S]*?)<\/p>/g
  let match

  while ((match = pRegex.exec(xml)) !== null) {
    const inner = match[1]

    // Check for nested <s> spans
    const spanRegex = /<s[^>]*>([^<]*)<\/s>/g
    let spanText = ''
    let spanMatch
    while ((spanMatch = spanRegex.exec(inner)) !== null) {
      spanText += spanMatch[1]
    }

    // Use span text if found, otherwise strip tags from inner content
    const raw = spanText || inner.replace(/<[^>]+>/g, '')
    const decoded = decodeEntities(raw).trim()
    if (decoded) segments.push(decoded)
  }

  if (segments.length > 0) return segments

  // Fallback to srv1 format: <text start="..." dur="...">text</text>
  const textRegex = /<text[^>]*>([^<]*)<\/text>/g
  while ((match = textRegex.exec(xml)) !== null) {
    const decoded = decodeEntities(match[1]).trim()
    if (decoded) segments.push(decoded)
  }

  return segments
}

export default async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204 })
  }

  const url = new URL(req.url)
  const videoId = url.searchParams.get('videoId')

  if (!videoId) {
    return Response.json(
      { transcript: '', error: 'Missing videoId parameter' },
      { status: 200 },
    )
  }

  const debug = url.searchParams.get('debug') === '1'

  try {
    // Try ANDROID Innertube first, fall back to web page scraping
    const innertubeResult = await fetchViaInnerTube(videoId)
    let tracks = innertubeResult
    let source = 'innertube'

    if (!tracks) {
      tracks = await fetchViaWebPage(videoId)
      source = tracks ? 'webpage' : 'none'
    }

    if (debug) {
      // Return diagnostic info
      const webResp = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
        headers: { 'user-agent': WEB_USER_AGENT },
      })
      const html = await webResp.text()
      const hasConsent = html.includes('consent.youtube.com') || html.includes('consent.google.com')
      const hasPlayerResponse = html.includes('ytInitialPlayerResponse')
      const hasCaptionTracks = html.includes('captionTracks')

      return Response.json({
        videoId,
        source,
        innertubeTrackCount: innertubeResult?.length ?? 0,
        webpageTrackCount: tracks?.length ?? 0,
        webpageHtmlLength: html.length,
        webpageHasConsent: hasConsent,
        webpageHasPlayerResponse: hasPlayerResponse,
        webpageHasCaptionTracks: hasCaptionTracks,
        webpageFirst500: html.slice(0, 500),
      }, { status: 200 })
    }

    if (!tracks || tracks.length === 0) {
      return Response.json(
        { transcript: '', error: 'No captions available for this video' },
        { status: 200 },
      )
    }

    // Prefer English, fall back to first available
    const englishTrack = tracks.find(
      (t) =>
        t.languageCode === 'en' || t.languageCode?.startsWith('en-'),
    )
    const track = englishTrack || tracks[0]

    if (!track.baseUrl) {
      return Response.json(
        { transcript: '', error: 'No caption URL found' },
        { status: 200 },
      )
    }

    // Fetch and parse the caption XML
    const captionResp = await fetch(track.baseUrl, {
      headers: { 'user-agent': WEB_USER_AGENT },
    })

    if (!captionResp.ok) {
      return Response.json(
        { transcript: '', error: 'Failed to fetch caption data' },
        { status: 200 },
      )
    }

    const xml = await captionResp.text()
    const segments = parseTranscriptXml(xml)
    const transcript = segments.join(' ')
    const language = track.languageCode || 'unknown'

    return Response.json({ transcript, language }, { status: 200 })
  } catch (error) {
    return Response.json(
      {
        transcript: '',
        error:
          error instanceof Error ? error.message : 'Unknown error occurred',
      },
      { status: 200 },
    )
  }
}

export const config = {
  path: '/.netlify/functions/youtube-transcript',
}
