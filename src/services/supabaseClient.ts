import { createClient } from '@supabase/supabase-js'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string | undefined
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined

/**
 * Supabase client instance.
 * Returns null if env vars are not configured — all downstream
 * consumers must handle the null case gracefully.
 */
export const supabase =
  supabaseUrl && supabaseAnonKey
    ? createClient(supabaseUrl, supabaseAnonKey)
    : null

/**
 * Extract the project ref from a Supabase project URL. Shape is
 * always `https://<ref>.supabase.co`; the ref is the leftmost
 * subdomain. Returns null if we can't parse a ref (env not set,
 * non-Supabase URL, etc.) — callers should treat that as "unknown".
 */
export function getSupabaseProjectRef(): string | null {
  if (!supabaseUrl) return null
  try {
    const host = new URL(supabaseUrl).hostname
    const ref = host.split('.')[0]
    return ref || null
  } catch {
    return null
  }
}

// Emit which project is connected on startup so it's obvious at a
// glance whether the running instance is dev or prod. One line,
// info-level — no noise. Quiet if the env isn't configured at all.
if (supabaseUrl) {
  const ref = getSupabaseProjectRef()
  console.info(
    `[Weave] Connected to Supabase: ${ref ?? '(unknown project ref)'}`,
  )
}
