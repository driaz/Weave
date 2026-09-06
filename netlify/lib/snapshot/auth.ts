// Caller identity for the snapshot insert. The row must carry the caller's
// user_id (RLS reads under auth.uid() = user_id); a snapshot with no verified
// caller is never written.

import type { SupabaseClient } from '@supabase/supabase-js'

export class UnauthorizedError extends Error {}

export function bearerToken(req: Request): string | null {
  const header = req.headers.get('authorization') ?? req.headers.get('Authorization')
  if (!header) return null
  const m = /^Bearer\s+(.+)$/i.exec(header.trim())
  return m ? m[1] : null
}

/**
 * Verify the caller's Supabase JWT and return their user id. Uses
 * auth.getUser(jwt), which validates the token against the project's auth
 * server (the same check the Fly routes' verifyUserToken performs).
 */
export async function verifyCaller(
  req: Request,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: SupabaseClient<any, any, any>,
): Promise<string> {
  const token = bearerToken(req)
  if (!token) throw new UnauthorizedError('Missing Authorization: Bearer <supabase access token>')
  const { data, error } = await supabase.auth.getUser(token)
  if (error || !data?.user?.id) {
    throw new UnauthorizedError(`Caller token rejected: ${error?.message ?? 'no user'}`)
  }
  return data.user.id
}
