import type { Database } from '../types/database'

/**
 * Domain types — re-exports of the rows defined in the generated
 * Supabase schema. Keep this file as the single source of truth so
 * callers do not need to reach into the generated types directly.
 */

export type Board = Database['public']['Tables']['boards']['Row']
export type Node = Database['public']['Tables']['nodes']['Row']
export type Edge = Database['public']['Tables']['edges']['Row']
export type VoiceSession = Database['public']['Tables']['voice_sessions']['Row']
export type VoiceUtterance = Database['public']['Tables']['voice_utterances']['Row']

type BoardInsert = Database['public']['Tables']['boards']['Insert']
type NodeInsert = Database['public']['Tables']['nodes']['Insert']
type EdgeInsert = Database['public']['Tables']['edges']['Insert']
type VoiceSessionInsert = Database['public']['Tables']['voice_sessions']['Insert']
type VoiceUtteranceInsert = Database['public']['Tables']['voice_utterances']['Insert']

/**
 * Input types — what callers provide on create. The module fills in
 * `user_id` from the active session and lets Postgres default
 * `id`, `created_at`, `updated_at`.
 */

export type NewBoardInput = Omit<
  BoardInsert,
  'id' | 'user_id' | 'created_at' | 'updated_at'
>

export type NewNodeInput = Omit<
  NodeInsert,
  'id' | 'user_id' | 'board_id' | 'created_at' | 'updated_at'
>

export type NewEdgeInput = Omit<
  EdgeInsert,
  'id' | 'user_id' | 'board_id' | 'created_at' | 'updated_at'
>

export type NewVoiceSessionInput = Omit<
  VoiceSessionInsert,
  'id' | 'user_id'
>

export type Speaker = 'user' | 'assistant'

/**
 * Insert shape for a single utterance. `user_id` and `embedding` are
 * filled in by the persistence module (the former from the session,
 * the latter set to null at insert time and populated asynchronously
 * via `updateUtteranceEmbedding`). `speaker` is narrowed from the
 * generated `string` to the literal union so callers can't pass
 * arbitrary speaker labels. Sentinel handling is applied before the
 * row hits Postgres — callers pass the raw text and let
 * `writeUtterance` decide.
 */
export type NewVoiceUtteranceInput = Omit<
  VoiceUtteranceInsert,
  'id' | 'user_id' | 'embedding' | 'speaker'
> & { speaker: Speaker }

export type EndReason = 'user_closed' | 'idle_timeout' | 'error'

/**
 * Body of the single UPDATE that closes a session. processing_log is
 * the controller's accumulated event buffer; ended_at and end_reason
 * mark the session terminal.
 */
export interface VoiceSessionEndPatch {
  ended_at: string
  end_reason: EndReason
  processing_log: unknown[]
}

/**
 * Caller-supplied context that `writeUtterance` needs in order to
 * evaluate the sentinel-strip rule. The controller owns this state;
 * the persistence layer is stateless.
 */
export interface WriteUtteranceContext {
  assistantHasSpokenInSession: boolean
}

/**
 * Shape of events that the persistence layer hands back to the
 * controller for inclusion in `processing_log`. Mirrors the
 * `LogEvent` shape used elsewhere in the project (utils/logger.ts)
 * but as a plain payload — no source/correlation/durationMs fields
 * because those don't apply to sentinel decisions.
 */
export interface SentinelEvent {
  phase: 'voice.sentinel.stripped' | 'voice.sentinel.detection_warning'
  outcome: 'success' | 'degraded'
  detail: Record<string, unknown>
  ts: string
}

/**
 * Result of `writeUtterance`. When `stripped` is true the row was
 * intentionally not written (the opening sentinel); the controller
 * should not advance its utterance_index counter. An `event` is
 * present whenever sentinel detection had something to say —
 * success (stripped) or degraded (near-miss warning).
 */
export interface WriteUtteranceResult {
  utteranceId: string | null
  stripped: boolean
  event?: SentinelEvent
}

/**
 * `board_snapshot` shape stored on `voice_sessions`. Captured at
 * session start by the controller. Edges are referenced by uuid so
 * the snapshot stays compact; full content is recoverable by joining
 * back to `nodes` / `edges` if the rows still exist when replay
 * happens.
 */
export interface BoardSnapshot {
  nodes: Array<{
    id: string
    type: string
    position: { x: number; y: number }
    preview_text: string
  }>
  edges: Array<{
    id: string
    source: string
    target: string
  }>
  captured_at: string
}
