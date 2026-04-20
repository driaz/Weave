/**
 * Strip server-owned or cross-row fields from a patch so they can't
 * be mutated via update paths. Called from every `update()` function.
 */
const FORBIDDEN_KEYS = new Set([
  'id',
  'user_id',
  'board_id',
  'created_at',
])

export function sanitizePatch<T extends Record<string, unknown>>(
  patch: T,
): Partial<T> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(patch)) {
    if (!FORBIDDEN_KEYS.has(key)) out[key] = value
  }
  return out as Partial<T>
}
