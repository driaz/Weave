import { mapSupabaseError } from './errors'
import { requireClient, requireUserId } from './session'
import type { NewVoiceSessionInput, VoiceSession, VoiceSessionEndPatch } from './types'

/**
 * Phase 8 voice persistence. Sessions are scoped to one mic-modal
 * open/close window. `processing_log` is buffered in memory by the
 * VoiceSessionController and flushed in a single UPDATE on
 * `endSession`. The controller is the only intended caller.
 */

export async function createSession(
  input: NewVoiceSessionInput,
): Promise<VoiceSession> {
  const client = requireClient()
  const userId = await requireUserId()

  const { data, error } = await client
    .from('voice_sessions')
    .insert({ ...input, user_id: userId })
    .select()
    .single()

  if (error) throw mapSupabaseError(error, 'voiceSessions.createSession')
  return data
}

export async function endSession(
  sessionId: string,
  patch: VoiceSessionEndPatch,
): Promise<VoiceSession> {
  const client = requireClient()
  await requireUserId()

  const { data, error } = await client
    .from('voice_sessions')
    .update({
      ended_at: patch.ended_at,
      end_reason: patch.end_reason,
      // The controller stores plain LogEvent-shaped objects in the
      // buffer. Cast to the generated Json shape — the runtime values
      // are JSON-serializable by construction.
      processing_log: patch.processing_log as unknown as never,
    })
    .eq('id', sessionId)
    .select()
    .single()

  if (error) throw mapSupabaseError(error, `voiceSessions.endSession(${sessionId})`)
  return data
}

export async function getSession(sessionId: string): Promise<VoiceSession | null> {
  const client = requireClient()
  await requireUserId()

  const { data, error } = await client
    .from('voice_sessions')
    .select('*')
    .eq('id', sessionId)
    .maybeSingle()

  if (error) throw mapSupabaseError(error, `voiceSessions.getSession(${sessionId})`)
  return data
}
