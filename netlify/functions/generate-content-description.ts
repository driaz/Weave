// Generates a 2-3 sentence summary of a YouTube video from its transcript.
// Called by the client during YouTube linkCard ingestion (after the
// Supadata transcript lands, before the embedding fires) so the voice
// pipeline has a concise content summary to talk about — separate from
// the OG meta description on linkCards (`data.description`).

import { generateYouTubeDescription } from '../lib/youtubeDescription'

export default async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204 })
  }
  if (req.method !== 'POST') {
    return Response.json({ error: 'Method not allowed' }, { status: 405 })
  }

  const apiKey = process.env.VITE_ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    return Response.json(
      { description: '', error: 'ANTHROPIC_API_KEY not configured on server' },
      { status: 200 },
    )
  }

  let body: {
    title?: string
    channel?: string | null
    transcript?: string
    tonalContext?: string | null
  }
  try {
    body = await req.json()
  } catch {
    return Response.json(
      { description: '', error: 'invalid JSON body' },
      { status: 200 },
    )
  }

  const title = (body.title ?? '').trim()
  const transcript = (body.transcript ?? '').trim()
  if (!title || !transcript) {
    return Response.json(
      { description: '', error: 'title and transcript are required' },
      { status: 200 },
    )
  }

  const result = await generateYouTubeDescription(apiKey, {
    title,
    channel: body.channel ?? null,
    transcript,
    tonalContext: body.tonalContext ?? null,
  })

  if (result.error) {
    return Response.json(
      { description: '', error: result.error },
      { status: 200 },
    )
  }
  return Response.json({ description: result.description }, { status: 200 })
}


