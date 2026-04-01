import { YoutubeTranscript } from 'youtube-transcript'

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
    let segments
    try {
      segments = await YoutubeTranscript.fetchTranscript(videoId, {
        lang: 'en',
      })
    } catch {
      // English not available — try without language preference
      segments = await YoutubeTranscript.fetchTranscript(videoId)
    }

    if (!segments || !Array.isArray(segments) || segments.length === 0) {
      return Response.json(
        { transcript: '', error: 'No transcript segments returned' },
        { status: 200 },
      )
    }

    const transcript = segments.map((s) => s.text).join(' ')
    const language = segments[0]?.lang || 'en'

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
