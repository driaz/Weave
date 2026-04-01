const INNERTUBE_URL = 'https://www.youtube.com/youtubei/v1/player?prettyPrint=false'
const WEB_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

interface CaptionTrack {
  baseUrl: string
  languageCode: string
}

/**
 * Fetch the YouTube watch page, extract session cookies and visitor data,
 * then use them to make an authenticated Innertube player request.
 * This two-step approach works from datacenter IPs where direct Innertube
 * calls return LOGIN_REQUIRED.
 */
async function fetchCaptionTracks(
  videoId: string,
): Promise<CaptionTrack[] | null> {
  try {
    // Step 1: Fetch the watch page to get session cookies and visitorData
    const pageResp = await fetch(
      `https://www.youtube.com/watch?v=${videoId}`,
      {
        headers: {
          'user-agent': WEB_USER_AGENT,
          'accept-language': 'en-US,en;q=0.9',
          cookie: 'CONSENT=YES+1',
        },
        redirect: 'follow',
      },
    )

    if (!pageResp.ok) return null

    const html = await pageResp.text()

    // Extract cookies from response
    const setCookies = pageResp.headers.getSetCookie?.() ?? []
    const cookieJar = setCookies
      .map((c) => c.split(';')[0])
      .filter(Boolean)
      .join('; ')

    // Extract visitorData from page
    const visitorMatch = html.match(/"VISITOR_DATA":"([^"]+)"/)
    const visitorData = visitorMatch ? visitorMatch[1] : ''

    // Extract API key from page
    const apiKeyMatch = html.match(/"INNERTUBE_API_KEY":"([^"]+)"/)
    const apiKey = apiKeyMatch ? apiKeyMatch[1] : ''

    // First, try to extract captions directly from the page
    const pageMarker = 'var ytInitialPlayerResponse = '
    let markerStart = html.indexOf(pageMarker)
    if (markerStart === -1) {
      // Try without 'var ' prefix
      const altMarker = 'ytInitialPlayerResponse = '
      markerStart = html.indexOf(altMarker)
      if (markerStart !== -1) {
        markerStart += altMarker.length
      }
    } else {
      markerStart += pageMarker.length
    }

    if (markerStart > 0) {
      let depth = 0
      for (let i = markerStart; i < html.length && i < markerStart + 500000; i++) {
        if (html[i] === '{') depth++
        else if (html[i] === '}') {
          depth--
          if (depth === 0) {
            try {
              const parsed = JSON.parse(html.slice(markerStart, i + 1))
              const tracks =
                parsed?.captions?.playerCaptionsTracklistRenderer?.captionTracks
              if (Array.isArray(tracks) && tracks.length > 0) {
                return tracks
              }
            } catch {
              // JSON parse failed, continue to Innertube fallback
            }
            break
          }
        }
      }
    }

    // Step 2: If page didn't have captions, try Innertube with session context
    const innertubeUrl = apiKey
      ? `${INNERTUBE_URL}&key=${apiKey}`
      : INNERTUBE_URL

    const innerResp = await fetch(innertubeUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'user-agent': WEB_USER_AGENT,
        cookie: cookieJar ? `${cookieJar}; CONSENT=YES+1` : 'CONSENT=YES+1',
        origin: 'https://www.youtube.com',
        referer: `https://www.youtube.com/watch?v=${videoId}`,
        ...(visitorData && { 'x-goog-visitor-id': visitorData }),
      },
      body: JSON.stringify({
        context: {
          client: {
            clientName: 'WEB',
            clientVersion: '2.20241126.01.00',
            ...(visitorData && { visitorData }),
          },
        },
        videoId,
      }),
    })

    if (!innerResp.ok) return null

    const data = await innerResp.json()
    const tracks =
      data?.captions?.playerCaptionsTracklistRenderer?.captionTracks

    return Array.isArray(tracks) && tracks.length > 0 ? tracks : null
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
 */
function parseTranscriptXml(xml: string): string[] {
  const segments: string[] = []

  // Try srv3 format: <p t="..." d="...">text or <s> spans</p>
  const pRegex = /<p\s+t="\d+"\s+d="\d+"[^>]*>([\s\S]*?)<\/p>/g
  let match

  while ((match = pRegex.exec(xml)) !== null) {
    const inner = match[1]
    const spanRegex = /<s[^>]*>([^<]*)<\/s>/g
    let spanText = ''
    let spanMatch
    while ((spanMatch = spanRegex.exec(inner)) !== null) {
      spanText += spanMatch[1]
    }
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

  try {
    const tracks = await fetchCaptionTracks(videoId)

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
