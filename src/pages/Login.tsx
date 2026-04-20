import { useEffect, useState } from 'react'
import { Navigate, useLocation, useSearchParams } from 'react-router-dom'
import { supabase } from '../services/supabaseClient'
import { useAuth } from '../auth/AuthContext'

export function Login() {
  const { user, loading } = useAuth()
  const location = useLocation()
  const [searchParams] = useSearchParams()
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const queryError = searchParams.get('error')
    if (queryError) setError(queryError)
  }, [searchParams])

  if (loading) {
    return (
      <div className="w-screen h-screen flex items-center justify-center">
        <p className="text-gray-400 text-sm font-light select-none">Loading…</p>
      </div>
    )
  }

  if (user) {
    const from =
      (location.state as { from?: { pathname?: string } } | null)?.from
        ?.pathname || '/'
    return <Navigate to={from} replace />
  }

  const handleSignIn = async () => {
    if (!supabase) {
      setError('Authentication is not configured. Check environment variables.')
      return
    }
    setSubmitting(true)
    setError(null)
    const { error: oauthError } = await supabase.auth.signInWithOAuth({
      provider: 'github',
      options: {
        redirectTo: `${window.location.origin}/auth/callback`,
      },
    })
    if (oauthError) {
      setError(oauthError.message)
      setSubmitting(false)
    }
  }

  return (
    <div className="w-screen h-screen flex items-center justify-center bg-white">
      <div className="flex flex-col items-center gap-6 max-w-sm w-full px-6">
        <h1 className="text-2xl font-light text-gray-800 select-none">Weave</h1>
        <p className="text-sm text-gray-500 text-center font-light">
          Sign in to open your canvas.
        </p>
        <button
          onClick={handleSignIn}
          disabled={submitting}
          className="flex items-center gap-2 px-4 py-2 bg-white border border-gray-200
            rounded-lg shadow-sm hover:shadow-md transition-shadow duration-150
            text-sm text-gray-700 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <svg
            className="w-4 h-4"
            viewBox="0 0 24 24"
            fill="currentColor"
            aria-hidden="true"
          >
            <path d="M12 0C5.37 0 0 5.37 0 12c0 5.3 3.438 9.8 8.205 11.385.6.113.82-.26.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61-.546-1.387-1.333-1.756-1.333-1.756-1.09-.745.083-.73.083-.73 1.205.085 1.838 1.237 1.838 1.237 1.07 1.835 2.81 1.305 3.495.998.108-.776.42-1.305.763-1.605-2.665-.305-5.467-1.332-5.467-5.932 0-1.31.468-2.38 1.236-3.22-.124-.303-.536-1.524.118-3.176 0 0 1.008-.323 3.3 1.23A11.5 11.5 0 0 1 12 5.803c1.02.005 2.047.138 3.006.404 2.29-1.553 3.297-1.23 3.297-1.23.655 1.653.243 2.874.12 3.176.77.84 1.235 1.91 1.235 3.22 0 4.61-2.807 5.625-5.48 5.922.432.372.816 1.102.816 2.222 0 1.606-.015 2.898-.015 3.293 0 .32.216.694.824.576C20.565 21.795 24 17.295 24 12c0-6.63-5.37-12-12-12z" />
          </svg>
          {submitting ? 'Redirecting…' : 'Continue with GitHub'}
        </button>
        {error && (
          <p className="text-xs text-red-600 text-center max-w-xs">{error}</p>
        )}
      </div>
    </div>
  )
}
