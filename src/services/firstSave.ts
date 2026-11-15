/**
 * First-save signal: lets a card's side effects wait until Supabase has
 * confirmed a save that includes that card.
 *
 * Why: the Fly media pipeline resolves its node by (board, _clientNodeId)
 * at write time. If it runs before the card's first save lands, its
 * writes find no row and are dropped (docs/reads/trigger-before-save.md).
 *
 * `useBoardStorage` calls `notifyBoardSaved` after every successful save
 * with the client node ids that save carried. `waitForFirstSave` resolves
 * true once a confirmed save includes the node (immediately if the latest
 * one already did), or false after the timeout.
 */

interface Waiter {
  boardId: string
  nodeId: string
  timer: ReturnType<typeof setTimeout>
  settle: (saved: boolean) => void
}

/** Client node ids carried by the latest confirmed save, per board. */
const lastSavedNodeIds = new Map<string, Set<string>>()
const waiters = new Set<Waiter>()

export function notifyBoardSaved(boardId: string, nodeIds: Iterable<string>): void {
  const ids = new Set(nodeIds)
  lastSavedNodeIds.set(boardId, ids)
  for (const waiter of waiters) {
    if (waiter.boardId === boardId && ids.has(waiter.nodeId)) waiter.settle(true)
  }
}

export function waitForFirstSave(
  boardId: string,
  nodeId: string,
  timeoutMs: number,
): Promise<boolean> {
  if (lastSavedNodeIds.get(boardId)?.has(nodeId)) return Promise.resolve(true)
  return new Promise((resolve) => {
    const waiter: Waiter = {
      boardId,
      nodeId,
      timer: setTimeout(() => waiter.settle(false), timeoutMs),
      settle: (saved) => {
        clearTimeout(waiter.timer)
        waiters.delete(waiter)
        resolve(saved)
      },
    }
    waiters.add(waiter)
  })
}

/** Test-only: forget recorded saves and abandon pending waiters unsettled. */
export function resetFirstSaveSignal(): void {
  for (const waiter of waiters) clearTimeout(waiter.timer)
  waiters.clear()
  lastSavedNodeIds.clear()
}
