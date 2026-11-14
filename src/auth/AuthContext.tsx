import { useEffect, useMemo, useState, type ReactNode } from 'react'
import type { Session } from '@supabase/supabase-js'
import { supabase } from '../services/supabaseClient'
import { AuthContext, type AuthContextValue } from './useAuth'

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null)
  // Without a Supabase client there is no session to wait for.
  const [loading, setLoading] = useState(() => supabase !== null)

  useEffect(() => {
    if (!supabase) return

    let cancelled = false

    supabase.auth.getSession().then(({ data }) => {
      if (cancelled) return
      setSession(data.session ?? null)
      setLoading(false)
    })

    const { data: subscription } = supabase.auth.onAuthStateChange(
      (_event, nextSession) => {
        setSession(nextSession)
        setLoading(false)
      },
    )

    return () => {
      cancelled = true
      subscription.subscription.unsubscribe()
    }
  }, [])

  const value = useMemo<AuthContextValue>(
    () => ({
      user: session?.user ?? null,
      session,
      loading,
      signOut: async () => {
        if (!supabase) return
        await supabase.auth.signOut()
        window.location.assign('/login')
      },
    }),
    [session, loading],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}
