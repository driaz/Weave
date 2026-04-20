import { useEffect } from 'react'
import { Navigate, useNavigate } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext'

export function AuthCallback() {
  const { user, loading } = useAuth()
  const navigate = useNavigate()

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const hashParams = new URLSearchParams(
      window.location.hash.replace(/^#/, ''),
    )
    const errorDescription =
      params.get('error_description') || hashParams.get('error_description')
    if (errorDescription) {
      navigate(`/login?error=${encodeURIComponent(errorDescription)}`, {
        replace: true,
      })
    }
  }, [navigate])

  if (!loading && user) {
    return <Navigate to="/" replace />
  }

  return (
    <div className="w-screen h-screen flex items-center justify-center">
      <p className="text-gray-400 text-sm font-light select-none">
        Completing sign in…
      </p>
    </div>
  )
}
