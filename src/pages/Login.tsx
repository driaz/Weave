import { useEffect, useState, type CSSProperties } from 'react'
import { Navigate, useLocation, useSearchParams } from 'react-router-dom'
import { supabase } from '../services/supabaseClient'
import { useAuth } from '../auth/AuthContext'

const PAPER_GRAIN_URL =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='80' height='80'%3E%3Ccircle cx='2' cy='2' r='0.6' fill='%232a2521' fill-opacity='0.05'/%3E%3C/svg%3E\")"

function BackgroundThreads() {
  return (
    <svg
      aria-hidden="true"
      style={{
        position: 'absolute',
        inset: 0,
        width: '100%',
        height: '100%',
        pointerEvents: 'none',
      }}
      preserveAspectRatio="none"
      viewBox="0 0 1280 720"
    >
      <path
        d="M -40 180 Q 300 80, 620 200 T 1280 160"
        stroke="var(--w-standard-accent)"
        strokeWidth="1.2"
        strokeOpacity="0.18"
        strokeLinecap="round"
        fill="none"
      />
      <path
        d="M -40 540 Q 340 460, 680 580 T 1300 560"
        stroke="var(--w-deeper-accent)"
        strokeWidth="1.2"
        strokeOpacity="0.18"
        strokeLinecap="round"
        fill="none"
      />
      <path
        d="M -40 360 Q 260 300, 620 400 T 1280 340"
        stroke="var(--w-tensions-accent)"
        strokeWidth="1.2"
        strokeOpacity="0.18"
        strokeLinecap="round"
        strokeDasharray="5 4"
        fill="none"
      />
    </svg>
  )
}

function WeaveMark() {
  return (
    <svg
      width="44"
      height="44"
      viewBox="0 0 40 40"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M 6 14 Q 20 28, 34 14"
        stroke="#c9942f"
        strokeWidth="2"
        fill="none"
        strokeLinecap="round"
      />
      <path
        d="M 6 26 Q 20 12, 34 26"
        stroke="#c9942f"
        strokeOpacity="0.55"
        strokeWidth="2"
        fill="none"
        strokeLinecap="round"
      />
      <circle cx="6" cy="20" r="2.4" fill="#faf6ec" stroke="#c9942f" strokeWidth="1.5" />
      <circle cx="34" cy="20" r="2.4" fill="#faf6ec" stroke="#c9942f" strokeWidth="1.5" />
      <circle cx="20" cy="20" r="2.8" fill="#c9942f" />
    </svg>
  )
}

function GitHubIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M12 2C6.48 2 2 6.48 2 12c0 4.42 2.87 8.17 6.84 9.5.5.09.68-.22.68-.48 0-.24-.01-.87-.01-1.71-2.78.6-3.37-1.34-3.37-1.34-.45-1.16-1.11-1.46-1.11-1.46-.91-.62.07-.61.07-.61 1 .07 1.53 1.03 1.53 1.03.89 1.52 2.34 1.08 2.91.83.09-.65.35-1.08.63-1.33-2.22-.25-4.55-1.11-4.55-4.94 0-1.09.39-1.98 1.03-2.68-.1-.25-.45-1.27.1-2.65 0 0 .84-.27 2.75 1.02.8-.22 1.65-.33 2.5-.33.85 0 1.7.11 2.5.33 1.91-1.29 2.75-1.02 2.75-1.02.55 1.38.2 2.4.1 2.65.64.7 1.03 1.59 1.03 2.68 0 3.84-2.34 4.68-4.57 4.93.36.31.68.92.68 1.85 0 1.34-.01 2.42-.01 2.75 0 .27.18.58.69.48A10.02 10.02 0 0022 12c0-5.52-4.48-10-10-10z" />
    </svg>
  )
}

const BUTTON_BASE: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 12,
  padding: '14px 24px',
  borderRadius: 'var(--w-radius-pill)',
  background: '#fffdf6',
  color: 'var(--w-ink)',
  border: '1px solid var(--w-line)',
  boxShadow: 'var(--w-shadow-lift)',
  fontFamily: 'var(--w-font-sans)',
  fontSize: 15,
  fontWeight: 500,
  cursor: 'pointer',
  transition:
    'background 180ms ease, color 180ms ease, border-color 180ms ease, box-shadow 180ms ease, transform 180ms ease',
}

const BUTTON_HOVER: Partial<CSSProperties> = {
  background: '#2a2521',
  color: '#fffdf6',
  borderColor: '#2a2521',
  boxShadow: 'var(--w-shadow-pop)',
  transform: 'translateY(-1px)',
}

export function Login() {
  const { user, loading } = useAuth()
  const location = useLocation()
  const [searchParams] = useSearchParams()
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [hovered, setHovered] = useState(false)

  useEffect(() => {
    const queryError = searchParams.get('error')
    if (queryError) setError(queryError)
  }, [searchParams])

  if (loading) {
    return (
      <div
        style={{
          width: '100%',
          height: '100%',
          background: 'var(--w-paper)',
          display: 'grid',
          placeItems: 'center',
        }}
      >
        <p
          style={{
            fontFamily: 'var(--w-font-mono)',
            fontSize: 11,
            color: 'var(--w-ink-faint)',
            letterSpacing: 0.5,
            userSelect: 'none',
          }}
        >
          LOADING…
        </p>
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

  const buttonStyle: CSSProperties = {
    ...BUTTON_BASE,
    ...(hovered && !submitting ? BUTTON_HOVER : null),
    opacity: submitting ? 0.6 : 1,
    cursor: submitting ? 'not-allowed' : 'pointer',
  }

  const hintColor =
    hovered && !submitting ? 'rgba(255, 253, 246, 0.6)' : 'var(--w-ink-faint)'
  const hintBorderColor =
    hovered && !submitting ? 'rgba(255, 253, 246, 0.2)' : 'var(--w-line)'

  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        background: 'var(--w-paper)',
        position: 'relative',
        overflow: 'hidden',
        display: 'grid',
        placeItems: 'center',
      }}
    >
      <div
        aria-hidden="true"
        style={{
          position: 'absolute',
          inset: 0,
          pointerEvents: 'none',
          backgroundImage: PAPER_GRAIN_URL,
        }}
      />
      <BackgroundThreads />

      <div
        style={{
          position: 'relative',
          width: 420,
          maxWidth: 'calc(100% - 32px)',
          padding: '48px 40px 36px',
          background: '#fffdf6',
          borderRadius: 'var(--w-radius-xl)',
          boxShadow: 'var(--w-shadow-float)',
          border: '1px solid var(--w-line)',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
        }}
      >
        <WeaveMark />

        <h1
          style={{
            margin: 0,
            marginTop: 18,
            marginBottom: 4,
            fontFamily: 'var(--w-font-display)',
            fontSize: 32,
            fontWeight: 600,
            letterSpacing: '-0.8px',
            color: 'var(--w-ink)',
            userSelect: 'none',
          }}
        >
          Weave
        </h1>

        <p
          style={{
            margin: 0,
            marginBottom: 28,
            fontFamily: 'var(--w-font-sans)',
            fontSize: 14,
            color: 'var(--w-ink-soft)',
          }}
        >
          Sign in to open your canvas.
        </p>

        <button
          onClick={handleSignIn}
          disabled={submitting}
          onMouseEnter={() => setHovered(true)}
          onMouseLeave={() => setHovered(false)}
          onFocus={() => setHovered(true)}
          onBlur={() => setHovered(false)}
          style={buttonStyle}
        >
          <GitHubIcon />
          <span>{submitting ? 'Redirecting…' : 'Continue with GitHub'}</span>
          <span
            style={{
              paddingLeft: 12,
              borderLeft: `1px solid ${hintBorderColor}`,
              fontFamily: 'var(--w-font-mono)',
              fontSize: 10,
              letterSpacing: 0.5,
              color: hintColor,
              transition: 'color 180ms ease, border-color 180ms ease',
            }}
            aria-hidden="true"
          >
            ↵
          </span>
        </button>

        {error && (
          <p
            style={{
              marginTop: 16,
              marginBottom: 0,
              fontFamily: 'var(--w-font-sans)',
              fontSize: 12,
              color: 'var(--w-tensions-accent)',
              textAlign: 'center',
              maxWidth: 320,
            }}
          >
            {error}
          </p>
        )}

        <p
          style={{
            marginTop: 24,
            marginBottom: 0,
            maxWidth: 340,
            textAlign: 'center',
            fontFamily: 'var(--w-font-mono)',
            fontSize: 10,
            color: 'var(--w-ink-faint)',
            letterSpacing: 0.4,
            lineHeight: 1.6,
          }}
        >
          By continuing you agree to Weave's{' '}
          <a
            href="/terms"
            style={{
              color: 'inherit',
              textDecoration: 'underline',
              textDecorationColor: 'var(--w-line)',
            }}
          >
            Terms
          </a>{' '}
          and{' '}
          <a
            href="/privacy"
            style={{
              color: 'inherit',
              textDecoration: 'underline',
              textDecorationColor: 'var(--w-line)',
            }}
          >
            Privacy
          </a>
          .
        </p>
      </div>
    </div>
  )
}
