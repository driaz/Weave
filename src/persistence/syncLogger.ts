/**
 * Tiny logging helpers for the persistence cutover.
 *
 * `logSyncOutcome` is called once per save target per debounced save.
 * `logHydrationSource` is called once per app load. Both are one
 * console line so devs can tail output during bake without noise.
 *
 * In dev, the last hydration source is also exposed on
 * `window.__weaveHydrationSource` so the dev indicator can read it
 * without prop-drilling or a React context.
 */

export type SyncTarget = 'localStorage' | 'supabase'
export type SyncOutcome = 'success' | 'failure' | 'skipped'

export type HydrationSource = 'supabase' | 'localStorage' | 'empty'

export type HydrationSourceRecord = {
  source: HydrationSource
  reason: string
  timestamp: string
}

const HYDRATION_GLOBAL = '__weaveHydrationSource' as const

export function logSyncOutcome(
  target: SyncTarget,
  outcome: SyncOutcome,
  reason?: string,
): void {
  const timestamp = new Date().toISOString()
  const suffix = reason ? ` — ${reason}` : ''
  console.log(`[Weave sync] ${timestamp} ${target} ${outcome}${suffix}`)
}

export function logHydrationSource(
  source: HydrationSource,
  reason: string,
): void {
  const record: HydrationSourceRecord = {
    source,
    reason,
    timestamp: new Date().toISOString(),
  }
  console.log(
    `[Weave hydrate] ${record.timestamp} source=${source} — ${reason}`,
  )
  if (import.meta.env.DEV && typeof window !== 'undefined') {
    ;(window as unknown as Record<string, unknown>)[HYDRATION_GLOBAL] = record
    window.dispatchEvent(new CustomEvent('weave:hydration-source', { detail: record }))
  }
}

export function getLastHydrationSource(): HydrationSourceRecord | null {
  if (typeof window === 'undefined') return null
  const value = (window as unknown as Record<string, unknown>)[HYDRATION_GLOBAL]
  return (value as HydrationSourceRecord | undefined) ?? null
}
