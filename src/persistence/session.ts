import { supabase } from '../services/supabaseClient'
import { AuthError, PersistenceError } from './errors'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '../types/database'

/**
 * Return the configured Supabase client or throw. The underlying
 * client in services/supabaseClient.ts is untyped (to preserve
 * compatibility with legacy callers that predate the generated
 * types); we cast it here so the persistence module gets full
 * typed-query support.
 */
export function requireClient(): SupabaseClient<Database> {
  if (!supabase) {
    throw new PersistenceError(
      'Supabase is not configured — VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY must be set',
    )
  }
  return supabase as unknown as SupabaseClient<Database>
}

/**
 * Fail-fast auth check. Callers that need to inject `user_id` (all
 * write paths) call this first so we get a clean AuthError rather
 * than an opaque RLS denial.
 */
export async function requireUserId(): Promise<string> {
  const client = requireClient()
  const { data, error } = await client.auth.getUser()

  if (error) {
    throw new AuthError(error.message, error)
  }
  if (!data.user) {
    throw new AuthError('No authenticated user')
  }
  return data.user.id
}
