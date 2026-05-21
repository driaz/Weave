import { useSyncExternalStore } from 'react'
import { profileSnapshotStore } from '../services/profileSnapshot/profileSnapshotStore'

/**
 * React subscription to the profile-snapshot store. Returns the live
 * `{ snapshot, loading, error }` triple. Third arg mirrors the second
 * for SSR-safety even though we don't SSR — the API requires it.
 */
export function useProfileSnapshot() {
  return useSyncExternalStore(
    profileSnapshotStore.subscribe,
    profileSnapshotStore.getState,
    profileSnapshotStore.getState,
  )
}
