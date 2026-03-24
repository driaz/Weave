import { supabase } from './supabaseClient'

/** Session ID — unique per browser session, generated once on load */
const sessionId = crypto.randomUUID()

type TrackEventOptions = {
  targetId?: string
  boardId: string
  durationMs?: number
  metadata?: Record<string, unknown>
}

/**
 * Fire a behavioral event to Supabase.
 * Completely non-blocking — failures log to console but never throw.
 */
export function trackEvent(
  eventType: string,
  options: TrackEventOptions,
): void {
  if (!supabase) return

  const row = {
    event_type: eventType,
    target_id: options.targetId ?? null,
    board_id: options.boardId,
    session_id: sessionId,
    duration_ms: options.durationMs ?? null,
    metadata: options.metadata ?? null,
  }

  supabase
    .from('weave_events')
    .insert(row)
    .then(({ error }) => {
      if (error) {
        console.warn(`[Weave Events] Failed to track "${eventType}":`, error.message)
      }
    })
}

/**
 * Returns the current session ID (useful for session_started / session_ended).
 */
export function getSessionId(): string {
  return sessionId
}
