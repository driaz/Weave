import { supabase } from '../supabaseClient'

/**
 * Stream raw PCM audio from /api/tts-stream. Returns the response body
 * (int16LE mono 24kHz) for piping into PcmStreamPlayer.
 *
 * JWT-gated via Supabase session token. The X-Playback-Id header lets
 * the server correlate logs to the client's playback / turn.
 *
 * Fails loud on missing env, missing auth, or non-2xx status.
 */
export interface FetchTtsStreamInput {
  text: string
  playbackId: string
  signal?: AbortSignal
}

export async function fetchTtsStream(
  input: FetchTtsStreamInput,
): Promise<ReadableStream<Uint8Array>> {
  const mediaUrl = import.meta.env.VITE_WEAVE_MEDIA_URL as string | undefined
  if (!mediaUrl) {
    throw new Error('VITE_WEAVE_MEDIA_URL is not set')
  }
  if (!supabase) {
    throw new Error(
      'Supabase client not configured — cannot authenticate tts-stream request',
    )
  }
  const { data } = await supabase.auth.getSession()
  const token = data.session?.access_token
  if (!token) throw new Error('No Supabase session — please sign in')

  const response = await fetch(`${mediaUrl}/api/tts-stream`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'X-Playback-Id': input.playbackId,
    },
    body: JSON.stringify({ text: input.text }),
    signal: input.signal,
  })

  if (!response.ok) {
    const errorBody = await response.text().catch(() => '')
    throw new Error(
      `tts-stream error (${response.status}): ${errorBody.slice(0, 500)}`,
    )
  }
  if (!response.body) {
    throw new Error('tts-stream response has no body')
  }
  return response.body
}
