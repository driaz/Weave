// Generates a content description for a video clip shared in a tweet.
// Called by the client after transcript arrival when the description gate
// passes (media_analysis present, or transcript > 1,000 chars) — the
// result patches contentDescription on the tweet node (same field name as
// YouTube) and the re-embed fires after it. Mirrors
// generate-content-description.ts: always responds 200 with either a
// description or an { error } the client logs and shrugs off.

import { generateTweetDescription } from '../lib/tweetDescription'

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
    authorName?: string
    authorHandle?: string | null
    tweetText?: string
    transcript?: string | null
    mediaAnalysis?: string | null
  }
  try {
    body = await req.json()
  } catch {
    return Response.json(
      { description: '', error: 'invalid JSON body' },
      { status: 200 },
    )
  }

  const transcript = (body.transcript ?? '').trim()
  const mediaAnalysis = (body.mediaAnalysis ?? '').trim()
  if (!transcript && !mediaAnalysis) {
    return Response.json(
      { description: '', error: 'transcript or mediaAnalysis is required' },
      { status: 200 },
    )
  }

  const result = await generateTweetDescription(apiKey, {
    authorName: (body.authorName ?? '').trim(),
    authorHandle: body.authorHandle ?? null,
    tweetText: body.tweetText ?? '',
    transcript: transcript || null,
    mediaAnalysis: mediaAnalysis || null,
  })

  if (result.error) {
    return Response.json(
      { description: '', error: result.error },
      { status: 200 },
    )
  }
  return Response.json({ description: result.description }, { status: 200 })
}
