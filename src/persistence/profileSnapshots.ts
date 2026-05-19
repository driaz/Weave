import { mapSupabaseError } from './errors'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '../types/database'

/**
 * Profile snapshot reads. Snapshots are produced by an out-of-band
 * pipeline that lives outside this client; we only consume them.
 *
 * Phase 9 voice opening turns call this to fetch the user's most
 * recent snapshot narrative and inject it as the `recentThinking`
 * section of the system prompt. RLS (migration 014) scopes the read
 * to `auth.uid() = user_id` so no explicit user filter is needed.
 */
export async function getLatestProfileSnapshot(
  client: SupabaseClient<Database>,
): Promise<{ id: string; narrative: string } | null> {
  const { data, error } = await client
    .from('weave_profile_snapshots')
    .select('id, narrative')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error) {
    throw mapSupabaseError(error, 'profileSnapshots.getLatestProfileSnapshot')
  }
  if (!data) return null

  // The contract is "a usable snapshot or nothing" — a row whose
  // narrative is null or blank is indistinguishable from no row from
  // the caller's perspective, so collapse both cases here.
  const narrative = data.narrative?.trim()
  if (!narrative) return null

  return { id: data.id, narrative }
}
