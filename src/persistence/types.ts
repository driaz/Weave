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

type BoardInsert = Database['public']['Tables']['boards']['Insert']
type NodeInsert = Database['public']['Tables']['nodes']['Insert']
type EdgeInsert = Database['public']['Tables']['edges']['Insert']
type VoiceSessionInsert = Database['public']['Tables']['voice_sessions']['Insert']

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
  'id' | 'user_id' | 'created_at'
>
