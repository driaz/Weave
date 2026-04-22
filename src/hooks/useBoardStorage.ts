import { useState, useCallback, useMemo, useEffect, useRef } from 'react'
import type { Node } from '@xyflow/react'
import type { Connection } from '../api/claude'
import type {
  BoardId,
  SerializedBoard,
  SerializedNode,
  WeaveBoardsStore,
} from '../types/board'
import { resetNodeIdCounter, getNodeIdCounter } from '../utils/nodeId'
import {
  saveBinaryData,
  loadBinaryData,
  deleteBinaryDataForBoard,
  getBinaryFields,
} from '../utils/binaryStorage'
import { supabase } from '../services/supabaseClient'
import { trackEvent } from '../services/eventTracker'
import { useAuth } from '../auth/AuthContext'
import {
  hydrateBoardStore,
  loadFromLocalStorage,
  emptyStore,
} from '../persistence/hydration'
import { syncBoardToSupabase } from '../persistence/syncBoard'
import { logSyncOutcome } from '../persistence/syncLogger'
import { forgetUploadedImagesForBoard } from '../persistence/imageUpload'
import { AuthError, persistence } from '../persistence'
import { computeSaveSignature } from './saveSignature'

function generateBoardId(): BoardId {
  return crypto.randomUUID()
}

function createDefaultBoard(): SerializedBoard {
  const id = generateBoardId()
  const now = new Date().toISOString()
  return {
    id,
    name: 'Untitled Board',
    nodes: [],
    connections: [],
    nodeIdCounter: 1,
    createdAt: now,
    updatedAt: now,
  }
}

/** Strip binary fields from node data for localStorage (metadata only) */
function stripBinaryFields(node: SerializedNode): SerializedNode {
  const fields = getBinaryFields(node.type)
  if (fields.length === 0) return node

  const strippedData = { ...node.data }
  for (const field of fields) {
    delete strippedData[field]
  }
  return { ...node, data: strippedData }
}

/**
 * Persist base64 binaries to IndexedDB — but skip signed URLs, which
 * come back from Supabase hydration and expire. Storing them would
 * serve stale links on the next IndexedDB-only boot.
 */
async function saveBinaryFieldsForNodes(
  boardId: string,
  nodes: SerializedNode[],
): Promise<void> {
  const promises: Promise<void>[] = []
  for (const node of nodes) {
    const fields = getBinaryFields(node.type)
    for (const field of fields) {
      const value = node.data[field]
      if (typeof value !== 'string' || value.length === 0) continue
      if (/^https?:\/\//i.test(value)) continue
      promises.push(saveBinaryData(boardId, node.id, field, value))
    }
  }
  await Promise.all(promises)
}

/** Hydrate nodes by loading binary fields from IndexedDB */
async function hydrateNodesFromIndexedDB(
  boardId: string,
  nodes: SerializedNode[],
): Promise<SerializedNode[]> {
  return Promise.all(
    nodes.map(async (node) => {
      const fields = getBinaryFields(node.type)
      if (fields.length === 0) return node

      const hydratedData = { ...node.data }
      for (const field of fields) {
        if (!hydratedData[field]) {
          const value = await loadBinaryData(boardId, node.id, field)
          if (value) {
            hydratedData[field] = value
          }
        }
      }
      return { ...node, data: hydratedData }
    }),
  )
}

function serializeNodes(nodes: Node[]): SerializedNode[] {
  return nodes.map((node) => ({
    id: node.id,
    type: node.type ?? 'textCard',
    position: node.position,
    data: node.data as Record<string, unknown>,
  }))
}

function stripLoadingFromLinkCards(nodes: SerializedNode[]): SerializedNode[] {
  return nodes.map((node) => {
    if (node.type === 'linkCard' && node.data.loading) {
      return { ...node, data: { ...node.data, loading: false } }
    }
    return node
  })
}

export type BoardSummary = {
  id: BoardId
  name: string
  updatedAt: string
}

export function useBoardStorage() {
  const { user, loading: authLoading } = useAuth()

  // Sync load from localStorage first so the canvas has SOMETHING to
  // render while async hydration runs. The async path will replace
  // this store if Supabase has data.
  const [store, setStore] = useState<WeaveBoardsStore>(() => {
    const initial = loadFromLocalStorage() ?? emptyStore()
    const board = initial.boards[initial.lastActiveBoard]
    if (board) resetNodeIdCounter(board.nodeIdCounter)
    return initial
  })
  const [storageError, setStorageError] = useState<string | null>(null)
  const [hydratedBoard, setHydratedBoard] = useState<SerializedBoard | null>(
    null,
  )
  const [hydrating, setHydrating] = useState(true)
  const [bootstrapped, setBootstrapped] = useState(false)
  const hydratingBoardIdRef = useRef<string | null>(null)

  // Mirror of `store` so callbacks can read the current value without
  // closing over it in their dep list. Without this, `saveCurrentBoard`
  // would get a fresh reference on every save (because it mutates store),
  // retrigger App.tsx's debounced save effect, and loop forever.
  const storeRef = useRef(store)
  storeRef.current = store

  // Per-board cache of the last "known clean" content signature. When
  // `saveCurrentBoard` is called, we recompute the signature and skip
  // the write entirely if it matches — this prevents the post-hydrate
  // / post-switch `setNodes(currentBoard.nodes.map(...))` re-reference
  // from triggering a spurious replace-all save cycle.
  const lastSavedSignatures = useRef<Map<BoardId, string>>(new Map())

  // Serialize all Supabase writes through a single promise chain so
  // two saves never run concurrently on the same board. Concurrent
  // replace-all cycles would race (save A deletes A-1's fresh nodes,
  // save A-1's edge insert then hits FK violation → 409). Every save
  // awaits the previous one; rejections are absorbed so the chain
  // stays alive.
  const pendingSupabaseSave = useRef<Promise<unknown>>(Promise.resolve())

  // Run once per auth transition: fetch Supabase (or localStorage
  // fallback) and pick the source of truth for the canvas. IndexedDB
  // hydration waits on `bootstrapped` so it doesn't run twice (once
  // against the initial localStorage store, once against the
  // Supabase-hydrated store).
  const didBootstrapRef = useRef(false)
  useEffect(() => {
    if (authLoading) return
    if (didBootstrapRef.current) return
    didBootstrapRef.current = true

    // No cleanup / cancel flag on purpose — React 19 StrictMode runs
    // effects twice in dev (mount → cleanup → mount) and a cancel
    // token would abort the first (and only) async, leaving
    // `bootstrapped` permanently false. The `didBootstrapRef` guard
    // already prevents a real double-run; React 18+ safely ignores
    // setState calls after unmount, so there's no leak.
    void (async () => {
      try {
        const { store: hydrated } = await hydrateBoardStore(user?.id ?? null)
        const activeBoard = hydrated.boards[hydrated.lastActiveBoard]
        if (activeBoard) {
          resetNodeIdCounter(activeBoard.nodeIdCounter)
        }
        hydratingBoardIdRef.current = null
        setStore(hydrated)
      } catch (err) {
        console.error('[Weave hydration] unexpected error', err)
      } finally {
        setBootstrapped(true)
      }
    })()
  }, [authLoading, user?.id])

  // Hydrate the active board's binary data from IndexedDB. Gated on
  // `bootstrapped` so we don't race the Supabase bootstrap.
  useEffect(() => {
    if (!bootstrapped) return
    const board = store.boards[store.lastActiveBoard]
    if (!board) return

    if (hydratingBoardIdRef.current === board.id) return
    hydratingBoardIdRef.current = board.id

    setHydrating(true)
    hydrateNodesFromIndexedDB(board.id, board.nodes).then((hydratedNodes) => {
      setHydratedBoard({ ...board, nodes: hydratedNodes })
      setHydrating(false)
    })
  }, [store.lastActiveBoard, store.boards, bootstrapped])

  const persistToLocalStorage = useCallback(
    (nextStore: WeaveBoardsStore) => {
      try {
        localStorage.setItem('weave-boards', JSON.stringify(nextStore))
        setStorageError(null)
        logSyncOutcome('localStorage', 'success')
      } catch (e) {
        if (e instanceof DOMException && e.name === 'QuotaExceededError') {
          setStorageError(
            'Storage is full. Some changes may not be saved. Try removing large images or PDFs.',
          )
        } else {
          setStorageError('Failed to save board data.')
        }
        logSyncOutcome('localStorage', 'failure', (e as Error)?.message)
      }
    },
    [],
  )

  // All callers pass a functional updater so multiple state changes
  // queued in the same event handler compose cleanly instead of
  // clobbering each other. The localStorage write happens inside the
  // updater so it uses the post-compose value — React may replay the
  // updater in StrictMode, but `localStorage.setItem` is idempotent.
  const persist = useCallback(
    (updater: (prev: WeaveBoardsStore) => WeaveBoardsStore) => {
      setStore((prev) => {
        const next = updater(prev)
        persistToLocalStorage(next)
        return next
      })
    },
    [persistToLocalStorage],
  )

  const currentBoard: SerializedBoard =
    hydratedBoard && hydratedBoard.id === store.lastActiveBoard
      ? hydratedBoard
      : store.boards[store.lastActiveBoard]

  const allBoards: BoardSummary[] = useMemo(
    () =>
      Object.values(store.boards)
        .map((b) => ({ id: b.id, name: b.name, updatedAt: b.updatedAt }))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    [store.boards],
  )

  // Dual-write dispatcher: runs after every save. Non-blocking — the
  // UI has already updated and localStorage is the caller's safety
  // net. We swallow network/RLS errors on purpose; the next debounced
  // save will retry with fresh state.
  //
  // Writes are chained through `pendingSupabaseSave` so two saves
  // for the same board (or even different boards) never run in
  // parallel against Supabase. The `.catch(() => {})` absorbs prior
  // rejections so one failure doesn't poison the chain.
  const syncToSupabase = useCallback(
    (board: SerializedBoard): Promise<void> => {
      const next = pendingSupabaseSave.current
        .catch(() => {})
        .then(async () => {
          if (!user?.id) {
            logSyncOutcome('supabase', 'skipped', 'no auth session')
            return
          }
          if (!supabase) {
            logSyncOutcome(
              'supabase',
              'skipped',
              'supabase client not configured',
            )
            return
          }
          try {
            await syncBoardToSupabase(user.id, board)
            logSyncOutcome('supabase', 'success')
          } catch (err) {
            const reason = err instanceof Error ? err.message : String(err)
            logSyncOutcome('supabase', 'failure', reason)
            if (!(err instanceof AuthError)) {
              console.warn('[Weave sync] Supabase write failed', err)
            }
          }
        })
      pendingSupabaseSave.current = next
      return next
    },
    [user?.id],
  )

  const saveCurrentBoard = useCallback(
    (nodes: Node[], connections: Connection[]) => {
      const currentStore = storeRef.current
      const boardId = currentStore.lastActiveBoard
      const existingBoard = currentStore.boards[boardId]
      if (!existingBoard) return

      // Signature short-circuit. If nothing meaningful has changed
      // since the last save / last hydrate / last board switch, the
      // replace-all cycle is pure cost (round trips + a narrow
      // destructive window between DELETE and INSERT). Skip.
      const signature = computeSaveSignature(nodes, connections)
      if (lastSavedSignatures.current.get(boardId) === signature) {
        return
      }

      const fullNodes = stripLoadingFromLinkCards(serializeNodes(nodes))
      const counter = getNodeIdCounter()
      const strippedNodes = fullNodes.map(stripBinaryFields)
      const updatedAt = new Date().toISOString()

      // Functional updater so it composes with any other setStore call
      // queued in the same handler (e.g. handleSwitchBoard calls
      // saveCurrentBoard then switchBoard). `prev` is React's live
      // baseline, not a closure snapshot, so switchBoard's updater
      // will see our changes before applying its own.
      persist((prev) => {
        const base = prev.boards[boardId] ?? existingBoard
        const mergedBoard: SerializedBoard = {
          ...base,
          nodes: strippedNodes,
          connections,
          nodeIdCounter: counter,
          updatedAt,
        }
        return {
          ...prev,
          boards: { ...prev.boards, [boardId]: mergedBoard },
        }
      })

      // localStorage write just committed via `persist`. Advance the
      // clean-signature marker now so the next tick of the debounced
      // save effect short-circuits if state hasn't moved.
      lastSavedSignatures.current.set(boardId, signature)

      // Fire-and-forget IndexedDB write; never blocks the canvas.
      saveBinaryFieldsForNodes(boardId, fullNodes).catch((e) =>
        console.warn('Failed to save binary data to IndexedDB:', e),
      )

      // Fire-and-forget Supabase dual-write. Pass the full-data
      // snapshot (binaries included) so images can be uploaded to
      // Storage during the sync. Serialized via `syncToSupabase`'s
      // internal promise chain — this enqueues, doesn't block.
      const supabaseSnapshot: SerializedBoard = {
        ...existingBoard,
        nodes: fullNodes,
        connections,
        nodeIdCounter: counter,
        updatedAt,
      }
      void syncToSupabase(supabaseSnapshot)
    },
    [persist, syncToSupabase],
  )

  /**
   * Seed the "clean" signature for a board from its hydrated state.
   * App.tsx calls this right after `setNodes` / `setConnections`
   * inside the sync-from-`currentBoard` effect so the follow-up
   * debounced save recognises that the state is already in sync.
   */
  const markBoardClean = useCallback(
    (boardId: BoardId, nodes: Node[], connections: Connection[]) => {
      lastSavedSignatures.current.set(
        boardId,
        computeSaveSignature(nodes, connections),
      )
    },
    [],
  )

  const createBoard = useCallback((): BoardId => {
    const board = createDefaultBoard()
    resetNodeIdCounter(1)

    hydratingBoardIdRef.current = null
    setHydratedBoard(board)
    setHydrating(false)

    persist((prev) => ({
      ...prev,
      lastActiveBoard: board.id,
      boards: { ...prev.boards, [board.id]: board },
    }))

    // Seed the clean-signature marker with the empty-state signature
    // so the debounced save effect doesn't immediately re-sync an
    // empty canvas back to Supabase.
    lastSavedSignatures.current.set(
      board.id,
      computeSaveSignature([], []),
    )

    // Fire-and-forget create in Supabase so the board row exists even
    // before any nodes land. Saves that follow will upsert fine.
    void syncToSupabase(board)

    return board.id
  }, [persist, syncToSupabase])

  const switchBoard = useCallback(
    (boardId: BoardId) => {
      const board = storeRef.current.boards[boardId]
      if (!board) return

      resetNodeIdCounter(board.nodeIdCounter)
      hydratingBoardIdRef.current = null
      persist((prev) => ({ ...prev, lastActiveBoard: boardId }))
    },
    [persist],
  )

  const renameBoard = useCallback(
    (boardId: BoardId, newName: string) => {
      const current = storeRef.current.boards[boardId]
      if (!current) return

      const updatedAt = new Date().toISOString()

      setHydratedBoard((prev) =>
        prev && prev.id === boardId ? { ...prev, name: newName } : prev,
      )

      persist((prev) => {
        const base = prev.boards[boardId]
        if (!base) return prev
        return {
          ...prev,
          boards: {
            ...prev.boards,
            [boardId]: { ...base, name: newName, updatedAt },
          },
        }
      })

      // Patch only the board row so we don't race a pending debounced
      // save that's about to replace-all nodes/edges.
      if (user?.id && supabase) {
        persistence.boards
          .update(boardId, { name: newName })
          .catch((err) => {
            console.warn('[Weave sync] board rename failed', err)
          })
      }
    },
    [persist, user?.id],
  )

  const deleteBoard = useCallback(
    (boardId: BoardId): boolean => {
      const current = storeRef.current
      const boardIds = Object.keys(current.boards)
      if (boardIds.length <= 1) return false

      const remainingBoards = { ...current.boards }
      delete remainingBoards[boardId]
      const newActive =
        current.lastActiveBoard === boardId
          ? Object.keys(remainingBoards)[0]
          : current.lastActiveBoard

      const nextBoard = remainingBoards[newActive]
      if (nextBoard) {
        resetNodeIdCounter(nextBoard.nodeIdCounter)
      }

      deleteBinaryDataForBoard(boardId).catch((e) =>
        console.warn('Failed to clean up binary data for deleted board:', e),
      )

      if (supabase) {
        supabase
          .from('weave_embeddings')
          .update({ archived_at: new Date().toISOString() })
          .eq('board_id', boardId)
          .then(({ error }) => {
            if (error) {
              console.warn(
                '[Weave] Failed to archive embeddings for deleted board:',
                error.message,
              )
            }
          })
      }

      // Supabase cascade removes nodes + edges on board delete.
      if (user?.id) {
        persistence.boards.delete(boardId).catch((err) => {
          console.warn('[Weave sync] Supabase board delete failed', err)
        })
      }
      forgetUploadedImagesForBoard(boardId)
      lastSavedSignatures.current.delete(boardId)

      trackEvent('board_deleted', {
        targetId: `board:${boardId}`,
        boardId,
      })

      if (current.lastActiveBoard === boardId) {
        hydratingBoardIdRef.current = null
      }

      persist((prev) => {
        const nextBoards = { ...prev.boards }
        delete nextBoards[boardId]
        const nextActive =
          prev.lastActiveBoard === boardId
            ? (Object.keys(nextBoards)[0] ?? prev.lastActiveBoard)
            : prev.lastActiveBoard
        return {
          ...prev,
          lastActiveBoard: nextActive,
          boards: nextBoards,
        }
      })
      return true
    },
    [persist, user?.id],
  )

  const dismissStorageError = useCallback(() => setStorageError(null), [])

  return {
    currentBoard,
    allBoards,
    hydrating,
    createBoard,
    switchBoard,
    renameBoard,
    deleteBoard,
    saveCurrentBoard,
    markBoardClean,
    storageError,
    dismissStorageError,
  }
}

