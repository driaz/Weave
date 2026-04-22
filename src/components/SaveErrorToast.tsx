import { useEffect } from 'react'

type Props = {
  message: string
  onDismiss: () => void
}

/**
 * Non-blocking toast for save failures. Shown when a Supabase write
 * fails and the optimistic React state has been rolled back to the
 * last-synced snapshot. Auto-dismisses after 5s; also dismissable
 * via the close button.
 */
export function SaveErrorToast({ message, onDismiss }: Props) {
  useEffect(() => {
    const timer = setTimeout(onDismiss, 5000)
    return () => clearTimeout(timer)
  }, [onDismiss])

  return (
    <div
      className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 bg-red-50 border border-red-200
        text-red-800 text-sm px-4 py-2 rounded-md shadow-md flex items-center gap-3"
      role="alert"
    >
      <span>{message}</span>
      <button
        onClick={onDismiss}
        className="text-red-500 hover:text-red-700 text-xs cursor-pointer"
        aria-label="Dismiss error"
      >
        Dismiss
      </button>
    </div>
  )
}
