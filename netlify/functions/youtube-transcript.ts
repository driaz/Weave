const WEB_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

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
  const captionUrl = url.searchParams.get('captionUrl')

  // Mode 1: Client sends a captionUrl — just fetch, parse, and return the transcript
  if (captionUrl) {
    try {
      const resp = await fetch(captionUrl, {
        headers: { 'user-agent': WEB_USER_AGENT },
      })
      if (!resp.ok) {
        return Response.json(
          { transcript: '', error: 'Failed to fetch caption data' },
          { status: 200 },
        )
      }
      const xml = await resp.text()
      const segments = parseTranscriptXml(xml)
      const transcript = segments.join(' ')
      return Response.json(
        { transcript, language: url.searchParams.get('lang') || 'en' },
        { status: 200 },
      )
    } catch (error) {
      return Response.json(
        {
          transcript: '',
          error:
            error instanceof Error ? error.message : 'Failed to parse captions',
        },
        { status: 200 },
      )
    }
  }

  // Mode 2: Client sends a videoId — try to get captions server-side
  // (works for some videos; for others the client should use Mode 1)
  if (!videoId) {
    return Response.json(
      { transcript: '', error: 'Missing videoId or captionUrl parameter' },
      { status: 200 },
    )
  }

  try {
    // Try fetching the watch page and extracting caption tracks
    const pageResp = await fetch(
      `https://www.youtube.com/watch?v=${videoId}`,
      {
        headers: {
          'user-agent': WEB_USER_AGENT,
          'accept-language': 'en-US,en;q=0.9',
          cookie: 'CONSENT=YES+1',
        },
      },
    )

    if (!pageResp.ok) {
      return Response.json(
        { transcript: '', error: 'Failed to fetch YouTube page' },
        { status: 200 },
      )
    }

    const html = await pageResp.text()

    // Extract captions from ytInitialPlayerResponse
    let markerStr = 'var ytInitialPlayerResponse = '
    let markerIdx = html.indexOf(markerStr)
    if (markerIdx === -1) {
      markerStr = 'ytInitialPlayerResponse = '
      markerIdx = html.indexOf(markerStr)
    }

    if (markerIdx !== -1) {
      const jsonStart = markerIdx + markerStr.length
      let depth = 0
      for (let i = jsonStart; i < html.length && i < jsonStart + 500000; i++) {
        if (html[i] === '{') depth++
        else if (html[i] === '}') {
          depth--
          if (depth === 0) {
            try {
              const parsed = JSON.parse(html.slice(jsonStart, i + 1))
              const tracks =
                parsed?.captions?.playerCaptionsTracklistRenderer?.captionTracks
              if (Array.isArray(tracks) && tracks.length > 0) {
                // Found tracks — fetch the English one (or first)
                const english = tracks.find(
                  (t: { languageCode: string }) =>
                    t.languageCode === 'en' ||
                    t.languageCode?.startsWith('en-'),
                )
                const track = english || tracks[0]
                if (track.baseUrl) {
                  const capResp = await fetch(track.baseUrl, {
                    headers: { 'user-agent': WEB_USER_AGENT },
                  })
                  if (capResp.ok) {
                    const xml = await capResp.text()
                    const segments = parseTranscriptXml(xml)
                    return Response.json(
                      {
                        transcript: segments.join(' '),
                        language: track.languageCode || 'en',
                      },
                      { status: 200 },
                    )
                  }
                }
              }
            } catch {
              // JSON parse failed, fall through
            }
            break
          }
        }
      }
    }

    // Server-side extraction failed — return needsClientFetch so client
    // can try Innertube directly from the browser (residential IP)
    return Response.json(
      {
        transcript: '',
        needsClientFetch: true,
        error: 'Server could not extract captions — try client-side fetch',
      },
      { status: 200 },
    )
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
