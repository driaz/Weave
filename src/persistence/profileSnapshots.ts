import { mapSupabaseError } from './errors'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '../types/database'

export type SnapshotCluster = {
  cluster_id: string
  size: number
  theme_description: string | null
}

/**
 * Consumer-facing shape for a profile snapshot row. `narrative` is
 * guaranteed non-blank when returned (the helper collapses null /
 * whitespace narratives into a null return). `clusters` and
 * `generation_metadata` are narrowed from raw Json at this boundary
 * so downstream consumers don't have to repeat the cast.
 */
export type ProfileSnapshot = {
  id: string
  created_at: string
  node_count: number
  clusters: SnapshotCluster[] | null
  narrative: string
  generation_metadata: { title?: string } | null
}

/**
 * Profile snapshot reads. Snapshots are produced by an out-of-band
 * pipeline that lives outside this client; we only consume them.
 *
 * Consumers: Phase 9 voice opening turns (read `narrative` for the
 * `recentThinking` section of the system prompt) and the Reflect view
 * (renders the full row). RLS (migration 014) scopes the read to
 * `auth.uid() = user_id` so no explicit user filter is needed.
 */
export async function getLatestProfileSnapshot(
  client: SupabaseClient<Database>,
): Promise<ProfileSnapshot | null> {
  const { data, error } = await client
    .from('weave_profile_snapshots')
    .select('id, created_at, node_count, clusters, narrative, generation_metadata')
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

  return {
    id: data.id,
    created_at: data.created_at,
    node_count: data.node_count,
    clusters: data.clusters as SnapshotCluster[] | null,
    narrative,
    generation_metadata: data.generation_metadata as { title?: string } | null,
  }
}
