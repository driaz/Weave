/**
 * Exponential-ish backoff for Gemini calls. The 503s we see come from
 * model-overload bursts that clear within tens of seconds, so a short,
 * fixed schedule is enough — no jitter, no AIMD.
 *
 * Schedule: 5s, 10s, 20s. Three retries → up to four total attempts.
 * Only retries on 503 / UNAVAILABLE; everything else (auth, schema,
 * file-too-large, network reset) bubbles immediately so the caller's
 * try/catch can decide.
 */
const RETRY_DELAYS_MS = [5_000, 10_000, 20_000] as const

export async function retryOn503<T>(
  label: string,
  op: () => Promise<T>,
): Promise<T> {
  for (let i = 0; i <= RETRY_DELAYS_MS.length; i++) {
    try {
      return await op()
    } catch (err) {
      // delayMs === undefined means we've exhausted the schedule; throw.
      const delayMs: number | undefined = RETRY_DELAYS_MS[i]
      if (!is503Error(err) || delayMs === undefined) throw err
      console.warn(
        `[${label}] Gemini 503/UNAVAILABLE — retrying in ${delayMs / 1000}s ` +
          `(attempt ${i + 1} of ${RETRY_DELAYS_MS.length})`,
      )
      await sleep(delayMs)
    }
  }
  // Unreachable: the loop either returns the success value or throws.
  throw new Error(`retryOn503(${label}): exhausted retries without resolution`)
}

/**
 * Detect a Gemini 503 across the shapes the SDK uses. The `@google/genai`
 * client sometimes throws ApiError with .status, sometimes a plain Error
 * whose .message embeds the upstream JSON. Match all of:
 *   - { status: 503 }                 — typed ApiError
 *   - { code: 'UNAVAILABLE' }         — gRPC-style status code
 *   - message contains "503", "UNAVAILABLE", or "service unavailable"
 *     (case-insensitive)              — string-formatted upstream errors
 */
function is503Error(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false
  const e = err as { status?: number; code?: string | number; message?: string }
  if (e.status === 503) return true
  if (e.code === 'UNAVAILABLE' || e.code === 503) return true
  if (typeof e.message === 'string' &&
      /\b503\b|UNAVAILABLE|service unavailable/i.test(e.message)) {
    return true
  }
  return false
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
