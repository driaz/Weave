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
    const segments = await YoutubeTranscript.fetchTranscript(videoId, {
      lang: 'en',
    })

    const transcript = segments.map((s) => s.text).join(' ')
    const language = segments[0]?.lang || 'en'

    return Response.json({ transcript, language }, { status: 200 })
  } catch (firstError) {
    // If English wasn't available, try without language preference (gets first available)
    try {
      const segments = await YoutubeTranscript.fetchTranscript(videoId)

      const transcript = segments.map((s) => s.text).join(' ')
      const language = segments[0]?.lang || 'unknown'

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
}

export const config = {
  path: '/.netlify/functions/youtube-transcript',
}
