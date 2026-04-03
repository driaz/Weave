export default async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204 })
  }

  const apiKey = process.env.SUPADATA_API_KEY
  if (!apiKey) {
    return Response.json(
      { transcript: '', error: 'SUPADATA_API_KEY not configured on server' },
      { status: 200 },
    )
  }

  const params = new URL(req.url).searchParams
  const videoUrl = params.get('url') || params.get('videoId')

  if (!videoUrl) {
    return Response.json(
      { transcript: '', error: 'Missing url parameter' },
      { status: 200 },
    )
  }

  // Normalize: if just a video ID was passed, build the full URL
  const fullUrl = videoUrl.startsWith('http')
    ? videoUrl
    : `https://www.youtube.com/watch?v=${videoUrl}`

  try {
    const resp = await fetch(
      `https://api.supadata.ai/v1/transcript?url=${encodeURIComponent(fullUrl)}&text=true&lang=en`,
      {
        headers: { 'x-api-key': apiKey },
      },
    )

    if (!resp.ok) {
      const body = await resp.text()
      return Response.json(
        { transcript: '', error: `Supadata API error (${resp.status}): ${body}` },
        { status: 200 },
      )
    }

    const data = await resp.json()

    return Response.json(
      {
        transcript: data.content || '',
        language: data.lang || 'unknown',
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
