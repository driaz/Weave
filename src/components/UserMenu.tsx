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
        className="flex items-center gap-2 px-2 py-1 bg-white border border-gray-200
          rounded-lg shadow-sm hover:shadow-md transition-shadow duration-150
          text-sm text-gray-700 cursor-pointer select-none"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Account menu"
      >
        {avatarUrl ? (
          <img
            src={avatarUrl}
            alt=""
            className="w-6 h-6 rounded-full"
            referrerPolicy="no-referrer"
          />
        ) : (
          <div className="w-6 h-6 rounded-full bg-gray-200 flex items-center justify-center text-[10px] text-gray-500">
            {displayName.charAt(0).toUpperCase()}
          </div>
        )}
        <span className="max-w-[120px] truncate text-xs text-gray-600">
          {displayName}
        </span>
      </button>

      {open && (
        <>
          <div
            className="fixed inset-0 z-40"
            onClick={closeMenu}
            aria-hidden="true"
          />
          <div
            className="absolute top-full right-0 mt-1 bg-white border border-gray-200
              rounded-lg shadow-md py-1 min-w-[180px] z-50"
            role="menu"
          >
            <div className="px-3 py-1.5 text-xs text-gray-400 border-b border-gray-100">
              {user.email || 'GitHub account'}
            </div>
            <button
              onClick={() => {
                closeMenu()
                void signOut()
              }}
              className="w-full text-left px-3 py-1.5 text-sm text-gray-600
                hover:bg-gray-50 hover:text-gray-800 transition-colors duration-150 cursor-pointer"
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
