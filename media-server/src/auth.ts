import { createRemoteJWKSet, jwtVerify } from 'jose'

const SUPABASE_URL = process.env.SUPABASE_URL
if (!SUPABASE_URL) {
  throw new Error('SUPABASE_URL is required')
}

// Supabase signs access tokens with ES256 (ECC P-256) and publishes the
// matching public keys at /auth/v1/.well-known/jwks.json. createRemoteJWKSet
// fetches lazily on first use and caches in memory with a built-in cooldown
// — no manual refresh needed. The legacy HS256 + shared secret model only
// works for older projects; new ones are asymmetric-only.
const JWKS = createRemoteJWKSet(
  new URL(`${SUPABASE_URL.replace(/\/$/, '')}/auth/v1/.well-known/jwks.json`),
)

/**
 * Verify a Supabase access token (ES256-signed JWT) and return the user id.
 * Returns null on any failure — never throws.
 */
export async function verifyUserToken(token: string): Promise<string | null> {
  try {
    const { payload } = await jwtVerify(token, JWKS, {
      algorithms: ['ES256'],
    })
    const sub = payload.sub
    return typeof sub === 'string' ? sub : null
  } catch {
    return null
  }
}
