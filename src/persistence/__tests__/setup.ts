import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '../../types/database'
import { supabase } from '../../services/supabaseClient'

/**
 * Integration test harness.
 *
 * Creates a dedicated test user via the Supabase admin API, signs the
 * shared anon client (the one the persistence module uses) into that
 * user's session, and yields an object the test can use to clean up.
 *
 * `cleanup()` deletes the user via admin API — all their rows and
 * Storage objects cascade or get orphaned under a throwaway user_id,
 * so nothing bleeds into real data.
 */

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined
const serviceKey =
  (import.meta.env.SUPABASE_SERVICE_ROLE_KEY as string | undefined) ??
  (typeof process !== 'undefined'
    ? (process.env.SUPABASE_SERVICE_ROLE_KEY as string | undefined)
    : undefined)

export function hasServiceRole(): boolean {
  return Boolean(url && anonKey && serviceKey)
}

export function getAdminClient(): SupabaseClient<Database> {
  if (!url || !serviceKey) {
    throw new Error(
      'Integration tests require VITE_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env',
    )
  }
  return createClient<Database>(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
}

export type TestUser = {
  userId: string
  email: string
  password: string
  admin: SupabaseClient<Database>
  /** Sign in as this user on the shared anon client. */
  signIn: () => Promise<void>
  /** Deletes the user; everything they own cascades. */
  cleanup: () => Promise<void>
}

export async function createTestUser(label = 'persistence'): Promise<TestUser> {
  if (!supabase) {
    throw new Error('Shared supabase client is not configured')
  }
  const admin = getAdminClient()
  const email = `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@weave-tests.local`
  const password = `Test-${crypto.randomUUID()}`

  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  })
  if (error || !data.user) {
    throw new Error(`Failed to create test user: ${error?.message}`)
  }
  const userId = data.user.id

  const signIn = async () => {
    if (!supabase) throw new Error('Shared supabase client missing')
    const { error: err } = await supabase.auth.signInWithPassword({ email, password })
    if (err) throw new Error(`Failed to sign in test user: ${err.message}`)
  }

  await signIn()

  const cleanup = async () => {
    if (supabase) {
      await supabase.auth.signOut().catch(() => {})
    }
    await admin.auth.admin.deleteUser(userId).catch(() => {})
  }

  return { userId, email, password, admin, signIn, cleanup }
}
