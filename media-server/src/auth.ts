import { jwtVerify } from 'jose'

const SUPABASE_JWT_SECRET = process.env.SUPABASE_JWT_SECRET
if (!SUPABASE_JWT_SECRET) {
  throw new Error('SUPABASE_JWT_SECRET is required')
}
const secretKey = new TextEncoder().encode(SUPABASE_JWT_SECRET)

/**
 * Verify a Supabase access token (HS256-signed JWT) and return the user id.
 * Returns null on any failure — never throws.
 */
export async function verifyUserToken(token: string): Promise<string | null> {
  try {
    const { payload } = await jwtVerify(token, secretKey, {
      algorithms: ['HS256'],
    })
    const sub = payload.sub
    return typeof sub === 'string' ? sub : null
  } catch {
    return null
  }
}
