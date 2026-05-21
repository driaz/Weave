import { useEffect, useRef } from 'react'
import { useAuth } from '../auth/AuthContext'
import { supabase } from '../services/supabaseClient'
import { profileSnapshotStore } from '../services/profileSnapshot/profileSnapshotStore'

/**
 * Fires `profileSnapshotStore.refresh(supabase)` exactly once per
 * component lifetime, after auth has resolved. Mirrors the bootstrap
 * pattern in `useBoardStorage` but lives at the app level so the
 * refresh kicks off before the user navigates to Reflect — the cache
 * read at module load handles instant render; this revalidates.
 */
export function useProfileSnapshotBootstrap(): void {
  const { user, loading: authLoading } = useAuth()
  const didBootstrapRef = useRef(false)

  useEffect(() => {
    if (authLoading) return
    if (didBootstrapRef.current) return
    didBootstrapRef.current = true

    if (!supabase) return
    void profileSnapshotStore.refresh(supabase)
  }, [authLoading, user?.id])
}
