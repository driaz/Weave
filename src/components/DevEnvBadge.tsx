import { getSupabaseProjectRef } from '../services/supabaseClient'

/**
 * Supabase project ref for Weave-Dev. When the app is pointed at
 * this project, we render a subtle "DEV" pill so there's no
 * confusion about which environment's data you're looking at.
 * Production points at a different ref (Weave prod) and this
 * component renders nothing there.
 */
const DEV_PROJECT_REF = 'bxbhjybahfyeqytwpkry'

/**
 * Low-opacity corner pill that appears only when the running
 * instance is connected to the dev Supabase project. Exists so you
 * can tell at a glance whether you're mutating dev or prod data —
 * noticeable when you're looking for it, not distracting during use.
 */
export function DevEnvBadge() {
  const ref = getSupabaseProjectRef()
  if (ref !== DEV_PROJECT_REF) return null

  return (
    <div
      className="fixed top-2 left-2 z-50 px-2 py-0.5 rounded-full
        bg-amber-100/60 border border-amber-300/50 text-amber-800/80
        text-[10px] font-mono tracking-wide uppercase
        pointer-events-none select-none shadow-sm"
      aria-label="Connected to the Weave-Dev Supabase project"
      title={`Connected to Weave-Dev (${ref})`}
    >
      dev
    </div>
  )
}
