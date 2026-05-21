/**
 * Profile snapshot cache + in-memory store.
 *
 * Mirrors the voice session store shape: factory `createProfileSnapshotStore()`
 * plus a module-level singleton export. State is read synchronously from
 * localStorage at module load so React consumers (via useSyncExternalStore)
 * render the cached snapshot on first paint when one exists.
 *
 * Auth-resolved bootstrap calls `refresh(client)` to revalidate against
 * Supabase. Voice opening (a follow-up PR) will read via `getState()`
 * directly instead of fetching at turn-start time.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '../../types/database'
import {
  getLatestProfileSnapshot,
  type ProfileSnapshot,
} from '../../persistence/profileSnapshots'

export type ProfileSnapshotStoreState = {
  snapshot: ProfileSnapshot | null
  loading: boolean
  error: Error | null
}

export type ProfileSnapshotStoreListener = (
  state: ProfileSnapshotStoreState,
  prev: ProfileSnapshotStoreState,
) => void

export interface ProfileSnapshotStore {
  getState(): ProfileSnapshotStoreState
  subscribe(listener: ProfileSnapshotStoreListener): () => void
  refresh(client: SupabaseClient<Database>): Promise<void>
  clearForSignout(): void
}

const SCHEMA_VERSION = 1
const CACHE_KEY = 'weave.snapshot.latest'

type CachedSnapshot = {
  schemaVersion: typeof SCHEMA_VERSION
  snapshot: ProfileSnapshot
  cachedAt: string
}

function readCache(): ProfileSnapshot | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as CachedSnapshot | null
    if (!parsed || parsed.schemaVersion !== SCHEMA_VERSION) return null
    if (!parsed.snapshot) return null
    return parsed.snapshot
  } catch {
    return null
  }
}

function writeCache(snapshot: ProfileSnapshot): void {
  try {
    const blob: CachedSnapshot = {
      schemaVersion: SCHEMA_VERSION,
      snapshot,
      cachedAt: new Date().toISOString(),
    }
    localStorage.setItem(CACHE_KEY, JSON.stringify(blob))
  } catch {
    // QuotaExceeded / serialization failures — best-effort.
  }
}

function clearCache(): void {
  try {
    localStorage.removeItem(CACHE_KEY)
  } catch {
    // ignore
  }
}

export function createProfileSnapshotStore(): ProfileSnapshotStore {
  let state: ProfileSnapshotStoreState = {
    snapshot: readCache(),
    loading: false,
    error: null,
  }
  const listeners = new Set<ProfileSnapshotStoreListener>()

  function setState(patch: Partial<ProfileSnapshotStoreState>): void {
    const prev = state
    state = { ...state, ...patch }
    for (const listener of listeners) listener(state, prev)
  }

  return {
    getState: () => state,

    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },

    async refresh(client) {
      setState({ loading: true, error: null })
      try {
        const result = await getLatestProfileSnapshot(client)
        if (result) {
          writeCache(result)
          setState({ snapshot: result, loading: false, error: null })
        } else {
          setState({ snapshot: null, loading: false, error: null })
        }
      } catch (err) {
        setState({
          loading: false,
          error: err instanceof Error ? err : new Error(String(err)),
        })
      }
    },

    clearForSignout() {
      clearCache()
      setState({ snapshot: null, loading: false, error: null })
    },
  }
}

export const profileSnapshotStore: ProfileSnapshotStore =
  createProfileSnapshotStore()
