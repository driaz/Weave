import { useCallback, useEffect, useRef, useState } from 'react'
import { useAuth } from '../auth/AuthContext'

export function UserMenu() {
  const { user, signOut } = useAuth()
  const [open, setOpen] = useState(false)
  const buttonRef = useRef<HTMLButtonElement>(null)

  const closeMenu = useCallback(() => setOpen(false), [])

  useEffect(() => {
    if (!open) return
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('keydown', handleEscape)
    return () => document.removeEventListener('keydown', handleEscape)
  }, [open])

  if (!user) return null

  const displayName =
    (user.user_metadata?.user_name as string | undefined) ||
    (user.user_metadata?.preferred_username as string | undefined) ||
    (user.user_metadata?.name as string | undefined) ||
    user.email ||
    'Signed in'
  const avatarUrl = user.user_metadata?.avatar_url as string | undefined

  return (
    <div className="relative">
      <button
        ref={buttonRef}
        onClick={() => setOpen((prev) => !prev)}
        className="flex items-center cursor-pointer select-none transition-colors duration-150"
        style={{
          gap: 8,
          padding: '4px 10px 4px 4px',
          borderRadius: 'var(--w-radius-pill)',
          background: open ? 'var(--w-paper-dim)' : 'transparent',
          border: 'none',
          fontFamily: 'var(--w-font-sans)',
        }}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Account menu"
      >
        {avatarUrl ? (
          <img
            src={avatarUrl}
            alt=""
            style={{
              width: 24,
              height: 24,
              borderRadius: 999,
            }}
            referrerPolicy="no-referrer"
          />
        ) : (
          <div
            className="flex items-center justify-center"
            style={{
              width: 24,
              height: 24,
              borderRadius: 999,
              background: 'var(--w-paper-dim)',
              color: 'var(--w-ink-soft)',
              fontSize: 10,
              fontFamily: 'var(--w-font-sans)',
              fontWeight: 600,
            }}
          >
            {displayName.charAt(0).toUpperCase()}
          </div>
        )}
        <span
          className="truncate"
          style={{
            fontSize: 12,
            color: 'var(--w-ink-soft)',
            maxWidth: 120,
          }}
        >
          {displayName}
        </span>
      </button>

      {open && (
        <>
          <div
            className="fixed inset-0"
            style={{ zIndex: 40 }}
            onClick={closeMenu}
            aria-hidden="true"
          />
          <div
            className="absolute"
            style={{
              top: 'calc(100% + 6px)',
              right: 0,
              minWidth: 200,
              background: 'var(--w-card)',
              border: '1px solid var(--w-line)',
              borderRadius: 'var(--w-radius-md)',
              boxShadow: 'var(--w-shadow-float)',
              padding: 6,
              zIndex: 50,
            }}
            role="menu"
          >
            <div
              style={{
                padding: '6px 10px',
                fontSize: 11,
                fontFamily: 'var(--w-font-mono)',
                color: 'var(--w-ink-faint)',
                borderBottom: '1px solid var(--w-line-soft)',
                marginBottom: 4,
              }}
            >
              {user.email || 'GitHub account'}
            </div>
            <button
              onClick={() => {
                closeMenu()
                void signOut()
              }}
              className="w-full text-left cursor-pointer transition-colors duration-150"
              style={{
                padding: '8px 10px',
                fontSize: 13,
                fontFamily: 'var(--w-font-sans)',
                color: 'var(--w-ink)',
                background: 'transparent',
                border: 'none',
                borderRadius: 'var(--w-radius-sm)',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = 'var(--w-paper-dim)'
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = 'transparent'
              }}
              role="menuitem"
            >
              Sign out
            </button>
          </div>
        </>
      )}
    </div>
  )
}
