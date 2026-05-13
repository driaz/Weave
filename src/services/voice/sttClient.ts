import { supabase } from '../supabaseClient'

const STT_URL = 'https://weave-media.fly.dev/api/stt'

export interface TranscribeAudioInput {
  audioBlob: Blob
  recordingId?: string
}

export interface TranscribeAudioOutput {
  transcript: string
  durationMs: number
}

/**
 * Upload an audio blob to the Whisper STT proxy at /api/stt and return
 * the transcript. JWT-gated via Supabase session token.
 *
 * Fails loud on non-2xx with HTTP status + response body context.
 */
export async function transcribeAudio(
  input: TranscribeAudioInput,
): Promise<TranscribeAudioOutput> {
  const { audioBlob, recordingId } = input
  const audioSizeBytes = audioBlob.size

  console.log('[voice.stt.started]', {
    recordingId,
    audioSizeBytes,
  })

  if (!supabase) {
    throw new Error(
      'Supabase client not configured — cannot authenticate STT request',
    )
  }
  const { data } = await supabase.auth.getSession()
  const token = data.session?.access_token
  if (!token) throw new Error('No Supabase session — please sign in')

  const form = new FormData()
  form.append('audio', audioBlob, 'audio')

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
  }
  if (recordingId) headers['X-Recording-Id'] = recordingId

  const startedAt = Date.now()
  let response: Response
  try {
    response = await fetch(STT_URL, {
      method: 'POST',
      headers,
      body: form,
    })
  } catch (err) {
    console.warn('[voice.stt.error]', { recordingId, error: err })
    throw err
  }

  const networkLatencyMs = Date.now() - startedAt

  if (!response.ok) {
    const errorBody = await response.text().catch(() => '')
    console.warn('[voice.stt.error]', {
      recordingId,
      statusCode: response.status,
      errorBody: errorBody.slice(0, 500),
    })
    throw new Error(
      `STT proxy error (${response.status}): ${errorBody.slice(0, 500)}`,
    )
  }

  const json = (await response.json()) as {
    transcript?: unknown
    durationMs?: unknown
  }
  const transcript = typeof json.transcript === 'string' ? json.transcript : ''
  const durationMs = typeof json.durationMs === 'number' ? json.durationMs : 0

  console.log('[voice.stt.completed]', {
    recordingId,
    transcriptLength: transcript.length,
    durationMs,
    networkLatencyMs,
  })

  return { transcript, durationMs }
}
