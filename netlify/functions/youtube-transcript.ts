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
    // Hit YouTube's Innertube player endpoint with ANDROID client context
    // (WEB client returns UNPLAYABLE with no captions for most videos)
    const playerResponse = await fetch(
      'https://www.youtube.com/youtubei/v1/player',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          context: {
            client: {
              clientName: 'ANDROID',
              clientVersion: '20.10.38',
            },
          },
          videoId,
        }),
      },
    )

    if (!playerResponse.ok) {
      return Response.json(
        { transcript: '', error: 'YouTube player request failed' },
        { status: 200 },
      )
    }

    const playerData = await playerResponse.json()

    const captionTracks =
      playerData?.captions?.playerCaptionsTracklistRenderer?.captionTracks

    if (!captionTracks || captionTracks.length === 0) {
      return Response.json(
        { transcript: '', error: 'No captions available for this video' },
        { status: 200 },
      )
    }

    // Prefer English caption track, fall back to first available
    const englishTrack = captionTracks.find(
      (track: { languageCode: string }) =>
        track.languageCode === 'en' ||
        track.languageCode?.startsWith('en-'),
    )
    const track = englishTrack || captionTracks[0]
    const captionUrl = track.baseUrl

    if (!captionUrl) {
      return Response.json(
        { transcript: '', error: 'No caption URL found' },
        { status: 200 },
      )
    }

    // Fetch the caption XML
    const captionResponse = await fetch(captionUrl)
    if (!captionResponse.ok) {
      return Response.json(
        { transcript: '', error: 'Failed to fetch caption data' },
        { status: 200 },
      )
    }

    const captionXml = await captionResponse.text()

    // Parse XML to extract plain text
    // srv3 format uses <p t="..." d="...">text</p>
    // srv1 format uses <text start="..." dur="...">text</text>
    const textSegments: string[] = []
    const textRegex = /<(?:text|p)[^>]*>([\s\S]*?)<\/(?:text|p)>/g
    let match
    while ((match = textRegex.exec(captionXml)) !== null) {
      let text = match[1]
      // Decode HTML entities
      text = text
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&apos;/g, "'")
        .replace(/&#(\d+);/g, (_, num) => String.fromCharCode(parseInt(num)))
      // Strip any remaining XML/HTML tags
      text = text.replace(/<[^>]+>/g, '')
      text = text.trim()
      if (text) textSegments.push(text)
    }

    const transcript = textSegments.join(' ')
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
