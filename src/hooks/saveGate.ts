/**
 * Warm-boot stale-save gate (docs/reads/warm-boot-save.md).
 *
 * On a warm-cache boot, React state is seeded from the localStorage cache
 * before the fresh Supabase fetch lands. Any save in that window writes
 * cached — possibly stale — content over the server. The gate holds one
 * flag per board: a board may be saved only after the first successful
 * fresh fetch has delivered it (or it was created in this page load, so
 * there is nothing to fetch). A save attempted before that is dropped and
 * counted — never queued — and logged with the path that attempted it.
 *
 * A failed fetch does not open the gate: saves stay blocked rather than
 * write the cache over the server.
 */

/** The four client paths that write board contents. */
export type SavePath = 'debounce' | 'switch' | 'create-board' | 'new-board'

export type SaveDecision = 'save' | 'dropped-before-fetch' | 'unchanged'

export type SaveGate = {
  /** The first successful fetch delivered these boards. */
  markFetched: (boardIds: Iterable<string>) => void
  /** A board created in this page load has nothing to fetch. */
  markCreated: (boardId: string) => void
  isOpen: (boardId: string) => boolean
  /** Saves dropped so far, per path. */
  dropped: () => Record<SavePath, number>
  /** Gate check, then the signature check. Counts and logs drops. */
  decide: (opts: {
    boardId: string
    path: SavePath
    signature: string
    lastSavedSignature: string | undefined
  }) => SaveDecision
}

export function createSaveGate(): SaveGate {
  const open = new Set<string>()
  const dropped: Record<SavePath, number> = {
    debounce: 0,
    switch: 0,
    'create-board': 0,
    'new-board': 0,
  }

  return {
    markFetched(boardIds) {
      for (const id of boardIds) open.add(id)
    },
    markCreated(boardId) {
      open.add(boardId)
    },
    isOpen(boardId) {
      return open.has(boardId)
    },
    dropped() {
      return { ...dropped }
    },
    decide({ boardId, path, signature, lastSavedSignature }) {
      if (!open.has(boardId)) {
        dropped[path] += 1
        console.debug(
          `[Weave sync] save dropped before first fetch — path=${path} board=${boardId} (dropped on this path: ${dropped[path]})`,
        )
        return 'dropped-before-fetch'
      }
      if (lastSavedSignature === signature) return 'unchanged'
      return 'save'
    },
  }
}
