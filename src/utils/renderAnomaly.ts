import { getBoardCache } from '../persistence/cache'
import { getLastHydrationSource } from '../persistence/syncLogger'

/**
 * Diagnostic-only instrumentation for two intermittent bugs on the
 * board hydration / switch path:
 *
 *   - empty_render: a board renders with zero nodes when we have
 *     reason to expect content (cache claims content exists, or the
 *     boot fetch hasn't confirmed the board's true contents).
 *   - snap_back: the rendered board id differs from the most recent
 *     user-initiated switch — typically the in-flight bootstrap in
 *     useBoardStorage.ts overwriting a switch that happened during
 *     its await.
 *
 * Module-scoped state is updated from useBoardStorage; detection is
 * called from App.tsx at the moment React state is about to re-seed
 * from `currentBoard`. Fires a single `[Weave render anomaly]` warn
 * and sets `window.__weaveLastRenderAnomaly` per anomaly observation
 * (deduped per renderedId+requestedId).
 *
 * No Supabase writes, no new event types, no behavior changes.
 */

export type BootFetchStatus = 'not-started' | 'pending' | 'success' | 'failed'

let bootFetchStatus: BootFetchStatus = 'not-started'
let lastRequestedBoardId: string | null = null
let lastFiredAnomalyKey: string | null = null

export function setBootFetchStatus(status: BootFetchStatus): void {
  bootFetchStatus = status
}

export function setLastRequestedBoardId(id: string): void {
  lastRequestedBoardId = id
}

type RenderAnomaly = {
  anomalyType: 'empty_render' | 'snap_back'
  requestedBoardId: string | null
  requestedBoardName: string | null
  renderedBoardId: string
  renderedBoardName: string
  hasPerBoardCache: boolean
  cachedNodeCount: number | null
  renderedNodeCount: number
  bootFetchStatus: BootFetchStatus
  hydrationSource: ReturnType<typeof getLastHydrationSource>
  timestamp: string
}

export function detectRenderAnomaly(input: {
  rendered: { id: string; name: string; nodeCount: number }
  boards: ReadonlyArray<{ id: string; name: string }>
}): void {
  const { rendered, boards } = input
  const requestedId = lastRequestedBoardId

  const cached = getBoardCache(rendered.id)
  const hasPerBoardCache = cached !== null
  const cachedNodeCount = cached ? cached.nodes.length : null

  let anomalyType: 'empty_render' | 'snap_back' | null = null

  if (requestedId && requestedId !== rendered.id) {
    anomalyType = 'snap_back'
  } else if (rendered.nodeCount === 0) {
    const cacheClaimsContent =
      hasPerBoardCache && cachedNodeCount !== null && cachedNodeCount > 0
    const bootIncomplete = bootFetchStatus !== 'success'
    if (cacheClaimsContent || bootIncomplete) {
      anomalyType = 'empty_render'
    }
  }

  if (!anomalyType) {
    // Re-seed without an anomaly = the situation cleared. Reset so a
    // future recurrence with the same (type, renderedId, requestedId)
    // tuple isn't masked by the stale dedupe key.
    lastFiredAnomalyKey = null
    return
  }

  // Dedupe so a follow-up re-seed for the same board (e.g. background
  // revalidation landing while the bug is still unresolved) doesn't
  // refire the same observation. Cleared on the next clean re-seed.
  const dedupeKey = `${anomalyType}:${rendered.id}:${requestedId ?? '-'}`
  if (lastFiredAnomalyKey === dedupeKey) return
  lastFiredAnomalyKey = dedupeKey

  const requestedBoard = requestedId
    ? boards.find((b) => b.id === requestedId) ?? null
    : null

  const payload: RenderAnomaly = {
    anomalyType,
    requestedBoardId: requestedId,
    requestedBoardName: requestedBoard?.name ?? null,
    renderedBoardId: rendered.id,
    renderedBoardName: rendered.name,
    hasPerBoardCache,
    cachedNodeCount,
    renderedNodeCount: rendered.nodeCount,
    bootFetchStatus,
    hydrationSource: getLastHydrationSource(),
    timestamp: new Date().toISOString(),
  }

  console.warn('[Weave render anomaly]', payload)
  if (typeof window !== 'undefined') {
    ;(window as unknown as Record<string, unknown>).__weaveLastRenderAnomaly =
      payload
  }
}
