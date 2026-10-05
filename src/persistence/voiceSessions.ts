import { mapSupabaseError } from './errors'
import { requireClient, requireUserId } from './session'
import type { Json } from '../types/database'
import type { NewVoiceSessionInput, VoiceSession, VoiceSessionEndPatch } from './types'

/**
 * Phase 8 voice persistence. Sessions are scoped to one mic-modal
 * open/close window. `processing_log` is buffered in memory by the
 * VoiceSessionController and appended in a single call on
 * `endSession`. The controller is the only intended caller.
 *
 * Both writes go through RPCs (migration 040), not direct table
 * writes:
 *   - `create_voice_session` resolves `anchor_edge_id` server-side
 *     from `anchor_hint` when the client has no edge id, and records
 *     the attempt as the row's first processing_log entry.
 *   - `end_voice_session` APPENDS the client buffer to whatever the
 *     server already logged, so that entry survives session end.
 */

export async function createSession(
  input: NewVoiceSessionInput,
): Promise<VoiceSession> {
  const client = requireClient()
  await requireUserId()

  const hint = input.anchor_hint ?? null
  const { data, error } = await client.rpc('create_voice_session', {
    // The generator types every SQL param as non-null; the function
    // accepts null here (null = "client holds no edge id").
    p_anchor_edge_id: (input.anchor_edge_id ?? null) as string,
    p_board_snapshot: input.board_snapshot ?? {},
    p_started_at: input.started_at ?? new Date().toISOString(),
    p_session_kind: input.session_kind ?? 'real',
    // Hint params default to null in SQL; omit them when absent.
    ...(hint && {
      p_board_id: hint.boardId,
      p_client_from: hint.clientFrom,
      p_client_to: hint.clientTo,
      ...(hint.mode !== null && { p_mode: hint.mode }),
    }),
  })

  if (error) throw mapSupabaseError(error, 'voiceSessions.createSession')
  return data
}

export async function endSession(
  sessionId: string,
  patch: VoiceSessionEndPatch,
): Promise<VoiceSession> {
  const client = requireClient()
  await requireUserId()

  const { data, error } = await client.rpc('end_voice_session', {
    p_session_id: sessionId,
    p_ended_at: patch.ended_at,
    p_end_reason: patch.end_reason,
    // The controller stores plain LogEvent-shaped objects in the
    // buffer. Cast to the generated Json shape — the runtime values
    // are JSON-serializable by construction.
    p_log: patch.processing_log as unknown as Json,
  })

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
