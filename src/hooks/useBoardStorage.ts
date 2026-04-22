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
import { supabase } from '../services/supabaseClient'
import { useAuth } from '../auth/AuthContext'
import {
  buildStoreFromCache,
  emptyStore,
  fetchFromSupabase,
} from '../persistence/hydration'
import { syncBoardToSupabase } from '../persistence/syncBoard'
import { logHydrationSource, logSyncOutcome } from '../persistence/syncLogger'
import { forgetUploadedImagesForBoard } from '../persistence/imageUpload'
import {
  deleteBoardCache,
  putBoardCache,
  putBoardListCache,
  putLastActiveBoard,
} from '../persistence/cache'
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

function boardListFromStore(store: WeaveBoardsStore) {
  return Object.values(store.boards)
    .map((b) => ({ id: b.id, name: b.name, updatedAt: b.updatedAt }))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

export type BoardSummary = {
  id: BoardId
  name: string
  updatedAt: string
}

export type UseBoardStorageResult = {
  currentBoard: SerializedBoard
  allBoards: BoardSummary[]
  /** True only during cold start WITHOUT a warm cache. */
  hydrating: boolean
  /** True when cold start hit an unrecoverable network error. */
  hydrationError: string | null
  createBoard: () => BoardId
  switchBoard: (boardId: BoardId) => void
  renameBoard: (boardId: BoardId, newName: string) => void
  deleteBoard: (boardId: BoardId) => boolean
  saveCurrentBoard: (nodes: Node[], connections: Connection[]) => void
  markBoardClean: (
    boardId: BoardId,
    nodes: Node[],
    connections: Connection[],
  ) => void
  /**
   * Queue a side-effect to run AFTER the next successful save for
   * `boardId`. On rollback, queued effects for that board are dropped.
   * Used for things like embedding soft-deletes that must not land
   * while the node they describe is still optimistically gone from
   * the canvas but not yet removed in Supabase.
   */
  queueSideEffect: (boardId: BoardId, effect: () => Promise<void> | void) => void
  saveError: string | null
  dismissSaveError: () => void
  /**
   * Increments every time a save rollback restores React state. App.tsx
   * watches this value so it can re-seed its nodes/connections from
   * `currentBoard` after a failure.
   */
  rollbackSignal: number
  /**
   * Increments when background revalidation from Supabase produces a
   * store that differs from the cache-seeded one. App.tsx watches this
   * so its React state re-seeds from `currentBoard` (e.g. picking up
   * image nodes the cache didn't have room for).
   */
  hydrationRevision: number
}

export function useBoardStorage(): UseBoardStorageResult {
  const { user, loading: authLoading } = useAuth()

  // Initial state: build from cache if we can. Otherwise start empty
  // and let the cold-start path render a skeleton until Supabase responds.
  // `hadCacheAtMount` is derived from the same initial read so `hydrating`
  // can be seeded without a ref-access-during-render.
  const initialState = useState<{
    store: WeaveBoardsStore
    hadCache: boolean
  }>(() => {
    const cached = buildStoreFromCache()
    if (cached) {
      const board = cached.boards[cached.lastActiveBoard]
      if (board) resetNodeIdCounter(board.nodeIdCounter)
      return { store: cached, hadCache: true }
    }
    return { store: emptyStore(), hadCache: false }
  })[0]

  const [store, setStore] = useState<WeaveBoardsStore>(initialState.store)
  const hadCacheAtMountRef = useRef(initialState.hadCache)

  const [saveError, setSaveError] = useState<string | null>(null)
  const [hydrationError, setHydrationError] = useState<string | null>(null)
  const [hydrating, setHydrating] = useState<boolean>(!initialState.hadCache)
  const [rollbackSignal, setRollbackSignal] = useState(0)
  const [hydrationRevision, setHydrationRevision] = useState(0)

  // Mirror of `store` so callbacks can read the current value without
  // closing over it in their dep list.
  const storeRef = useRef(store)
  storeRef.current = store

  // Per-board signature of the last snapshot Supabase accepted. The
  // debounced save short-circuits when the current snapshot matches.
  const lastSavedSignatures = useRef<Map<BoardId, string>>(new Map())

  // Serialize Supabase writes through a single promise chain so
  // concurrent saves can't race the replace-all RPC.
  const pendingSupabaseSave = useRef<Promise<unknown>>(Promise.resolve())

  // Per-board queue of post-success side effects. Keyed by board so a
  // rollback on board A doesn't drop pending effects for board B.
  const pendingSideEffects = useRef<Map<BoardId, Array<() => Promise<void> | void>>>(
    new Map(),
  )

  const queueSideEffect = useCallback(
    (boardId: BoardId, effect: () => Promise<void> | void) => {
      const existing = pendingSideEffects.current.get(boardId) ?? []
      existing.push(effect)
      pendingSideEffects.current.set(boardId, existing)
    },
    [],
  )

  const drainSideEffects = useCallback((boardId: BoardId) => {
    const effects = pendingSideEffects.current.get(boardId)
    if (!effects || effects.length === 0) return
    pendingSideEffects.current.delete(boardId)
    for (const effect of effects) {
      try {
        const result = effect()
        if (result && typeof (result as Promise<void>).catch === 'function') {
          ;(result as Promise<void>).catch((err) => {
            console.warn('[Weave sync] post-save side effect failed', err)
          })
        }
      } catch (err) {
        console.warn('[Weave sync] post-save side effect failed', err)
      }
    }
  }, [])

  const dropSideEffects = useCallback((boardId: BoardId) => {
    pendingSideEffects.current.delete(boardId)
  }, [])

  // Run once per auth transition: fetch from Supabase. With a warm
  // cache this runs in the background and silently reconciles; with
  // a cold cache the UI blocks on it (skeleton).
  const didBootstrapRef = useRef(false)
  useEffect(() => {
    if (authLoading) return
    if (didBootstrapRef.current) return
    didBootstrapRef.current = true

    // No cleanup / cancel flag on purpose — StrictMode runs effects
    // twice in dev but the ref guard already prevents a real double-run.
    void (async () => {
      // If we rendered from cache, advertise that explicitly. The
      // background fetch below will overwrite this source when it lands.
      if (hadCacheAtMountRef.current) {
        logHydrationSource('cache', 'rendered from cache, revalidating')
      }

      try {
        const outcome = await fetchFromSupabase(storeRef.current.lastActiveBoard)

        if (outcome.kind === 'success') {
          const next = outcome.store
          const prev = storeRef.current

          // Only swap state if Supabase's view differs from what we
          // rendered. Otherwise we'd trigger a redundant sync cycle
          // in App.tsx for a no-op.
          if (!storesEqual(prev, next)) {
            const activeBoard = next.boards[next.lastActiveBoard]
            if (activeBoard) resetNodeIdCounter(activeBoard.nodeIdCounter)
            setStore(next)
            // Signal App.tsx to re-seed its React state from the
            // freshly-hydrated `currentBoard` — the cache may have
            // been missing image nodes (quota stripping) or stale
            // content, and React state would otherwise never pick
            // up the Supabase view until the next board switch.
            if (hadCacheAtMountRef.current) {
              setHydrationRevision((n) => n + 1)
            }
          }
          setHydrationError(null)
          setHydrating(false)
          return
        }

        // Network error from Supabase.
        if (hadCacheAtMountRef.current) {
          // Cache is live — keep serving it and warn in the console.
          logHydrationSource(
            'cache',
            `supabase unreachable, staying on cache — ${outcome.reason}`,
          )
          console.warn(
            '[Weave hydration] Supabase unreachable, using cached canvas',
            outcome.reason,
          )
          setHydrating(false)
        } else {
          // No cache + no network = hard error state.
          logHydrationSource('error', outcome.reason)
          setHydrationError(
            'Could not reach Weave. Check your connection and try again.',
          )
          setHydrating(false)
        }
      } catch (err) {
        if (err instanceof AuthError) {
          // ProtectedRoute will bounce to /login on the next render.
          throw err
        }
        console.error('[Weave hydration] unexpected error', err)
        logHydrationSource('error', (err as Error)?.message ?? 'unknown')
        if (!hadCacheAtMountRef.current) {
          setHydrationError(
            'Something went wrong loading your canvas. Refresh to try again.',
          )
        }
        setHydrating(false)
      }
    })()
  }, [authLoading, user?.id])

  const currentBoard: SerializedBoard = store.boards[store.lastActiveBoard]

  const allBoards: BoardSummary[] = useMemo(
    () => boardListFromStore(store),
    [store],
  )

  /**
   * Fire a Supabase save, serialized through `pendingSupabaseSave`.
   * Returns a promise that resolves to `true` on success, `false` on
   * failure. Rejections never escape — the chain stays alive.
   */
  const runSupabaseSave = useCallback(
    (board: SerializedBoard): Promise<boolean> => {
      const next = pendingSupabaseSave.current
        .catch(() => {})
        .then(async () => {
          if (!user?.id) {
            logSyncOutcome('supabase', 'skipped', 'no auth session')
            return false
          }
          if (!supabase) {
            logSyncOutcome(
              'supabase',
              'skipped',
              'supabase client not configured',
            )
            return false
          }
          try {
            await syncBoardToSupabase(user.id, board)
            logSyncOutcome('supabase', 'success')
            return true
          } catch (err) {
            const reason = err instanceof Error ? err.message : String(err)
            logSyncOutcome('supabase', 'failure', reason)
            if (err instanceof AuthError) {
              // Re-surface so the hook's caller can bounce to /login.
              throw err
            }
            console.warn('[Weave sync] Supabase write failed', err)
            return false
          }
        })
      pendingSupabaseSave.current = next.catch(() => false)
      return next as Promise<boolean>
    },
    [user?.id],
  )

  /**
   * Primary save entry point. Called from App.tsx's debounced effect.
   *
   * Flow:
   *   1. Signature short-circuit if nothing meaningful has changed.
   *   2. Snapshot the last-synced state for this board (for rollback).
   *   3. Fire Supabase save (serialized).
   *   4. On success: advance store + cache + signature; flush pending
   *      side-effects for this board.
   *   5. On failure: keep store + signature pinned at the snapshot,
   *      bump `rollbackSignal` so App.tsx re-seeds its React state
   *      from `currentBoard`, drop queued side-effects, show a toast.
   */
  const saveCurrentBoard = useCallback(
    (nodes: Node[], connections: Connection[]) => {
      const currentStore = storeRef.current
      const boardId = currentStore.lastActiveBoard
      const existingBoard = currentStore.boards[boardId]
      if (!existingBoard) return

      const signature = computeSaveSignature(nodes, connections)
      if (lastSavedSignatures.current.get(boardId) === signature) {
        return
      }

      // Pin the signature optimistically so rapid follow-up saves
      // (still debounced from the same burst of edits) don't all
      // enqueue. If the save fails, we roll back to the previous
      // signature below.
      const previousSignature = lastSavedSignatures.current.get(boardId)
      lastSavedSignatures.current.set(boardId, signature)

      const fullNodes = stripLoadingFromLinkCards(serializeNodes(nodes))
      const counter = getNodeIdCounter()
      const updatedAt = new Date().toISOString()

      const snapshot: SerializedBoard = {
        ...existingBoard,
        nodes: fullNodes,
        connections,
        nodeIdCounter: counter,
        updatedAt,
      }

      void runSupabaseSave(snapshot).then((ok) => {
        if (ok) {
          // Advance the in-memory store to the saved snapshot and
          // mirror it to cache. `currentBoard` stays referentially
          // stable on the UI side when the snapshot matches what
          // App.tsx already has in React state, so the follow-up
          // sync-from-currentBoard effect is a no-op.
          setStore((prev) => {
            const base = prev.boards[boardId]
            if (!base) return prev
            const mergedBoard: SerializedBoard = {
              ...base,
              nodes: fullNodes,
              connections,
              nodeIdCounter: counter,
              updatedAt,
            }
            const next: WeaveBoardsStore = {
              ...prev,
              boards: { ...prev.boards, [boardId]: mergedBoard },
            }
            return next
          })
          // Cache writes are synchronous + safe-guarded internally;
          // do them outside the reducer so StrictMode replays don't
          // double-write quota-wise (the setter is idempotent anyway).
          putBoardCache(boardId, {
            nodes: fullNodes,
            connections,
            updatedAt,
          })
          putBoardListCache(
            boardListFromStore({
              ...currentStore,
              boards: {
                ...currentStore.boards,
                [boardId]: {
                  ...existingBoard,
                  updatedAt,
                },
              },
            }),
          )
          logSyncOutcome('cache', 'success')
          drainSideEffects(boardId)
        } else {
          // Rollback. `storeRef` never advanced past the pre-save
          // snapshot, so `currentBoard` still reflects the last-synced
          // state. App.tsx will re-seed its React state from it when
          // it sees `rollbackSignal` change.
          if (previousSignature === undefined) {
            lastSavedSignatures.current.delete(boardId)
          } else {
            lastSavedSignatures.current.set(boardId, previousSignature)
          }
          dropSideEffects(boardId)
          setSaveError('Save failed — recent changes reverted')
          setRollbackSignal((n) => n + 1)
        }
      })
    },
    [runSupabaseSave, drainSideEffects, dropSideEffects],
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

    setStore((prev) => {
      const next: WeaveBoardsStore = {
        ...prev,
        lastActiveBoard: board.id,
        boards: { ...prev.boards, [board.id]: board },
      }
      return next
    })

    // Seed the clean-signature so the first debounced save after
    // the create doesn't re-sync an empty canvas.
    lastSavedSignatures.current.set(
      board.id,
      computeSaveSignature([], []),
    )

    // Save goes through the serialized chain so ordering with any
    // in-flight saves is deterministic. On success we write cache;
    // on failure we roll back the local store.
    const snapshotStoreBefore = storeRef.current
    void runSupabaseSave(board).then((ok) => {
      if (ok) {
        putBoardCache(board.id, {
          nodes: [],
          connections: [],
          updatedAt: board.updatedAt,
        })
        putLastActiveBoard(board.id)
        putBoardListCache(
          boardListFromStore({
            ...snapshotStoreBefore,
            lastActiveBoard: board.id,
            boards: { ...snapshotStoreBefore.boards, [board.id]: board },
          }),
        )
        logSyncOutcome('cache', 'success')
      } else {
        setStore(snapshotStoreBefore)
        lastSavedSignatures.current.delete(board.id)
        setSaveError('Could not create board — reverted')
        setRollbackSignal((n) => n + 1)
      }
    })

    return board.id
  }, [runSupabaseSave])

  const switchBoard = useCallback((boardId: BoardId) => {
    const board = storeRef.current.boards[boardId]
    if (!board) return

    resetNodeIdCounter(board.nodeIdCounter)
    setStore((prev) => ({ ...prev, lastActiveBoard: boardId }))
    putLastActiveBoard(boardId)
  }, [])

  const renameBoard = useCallback(
    (boardId: BoardId, newName: string) => {
      const snapshot = storeRef.current
      const existing = snapshot.boards[boardId]
      if (!existing) return

      const updatedAt = new Date().toISOString()

      // Optimistic local update.
      setStore((prev) => {
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

      if (!user?.id || !supabase) {
        // No backing store to sync to; cache-only rename is still
        // valuable for UX consistency during the bake.
        putBoardCache(boardId, {
          nodes: existing.nodes,
          connections: existing.connections,
          updatedAt,
        })
        putBoardListCache(
          boardListFromStore({
            ...snapshot,
            boards: {
              ...snapshot.boards,
              [boardId]: { ...existing, name: newName, updatedAt },
            },
          }),
        )
        return
      }

      persistence.boards
        .update(boardId, { name: newName })
        .then(() => {
          putBoardCache(boardId, {
            nodes: existing.nodes,
            connections: existing.connections,
            updatedAt,
          })
          putBoardListCache(
            boardListFromStore({
              ...storeRef.current,
            }),
          )
          logSyncOutcome('cache', 'success')
        })
        .catch((err) => {
          console.warn('[Weave sync] board rename failed', err)
          setStore(snapshot)
          setSaveError('Rename failed — reverted')
          setRollbackSignal((n) => n + 1)
        })
    },
    [user?.id],
  )

  const deleteBoard = useCallback(
    (boardId: BoardId): boolean => {
      const snapshot = storeRef.current
      const boardIds = Object.keys(snapshot.boards)
      if (boardIds.length <= 1) return false

      const remainingBoards = { ...snapshot.boards }
      delete remainingBoards[boardId]
      const newActive =
        snapshot.lastActiveBoard === boardId
          ? Object.keys(remainingBoards)[0]
          : snapshot.lastActiveBoard

      const nextBoard = remainingBoards[newActive]
      if (nextBoard) {
        resetNodeIdCounter(nextBoard.nodeIdCounter)
      }

      // Optimistic local update — remove from store so the sidebar
      // feels instant.
      setStore(() => ({
        ...snapshot,
        lastActiveBoard: newActive,
        boards: remainingBoards,
      }))

      const doDelete = async () => {
        if (user?.id && supabase) {
          try {
            // Cascade handles nodes + edges on the DB side.
            await persistence.boards.delete(boardId)
          } catch (err) {
            console.warn('[Weave sync] Supabase board delete failed', err)
            setStore(snapshot)
            setSaveError('Delete failed — board restored')
            setRollbackSignal((n) => n + 1)
            return
          }
        }

        // Post-success side effects — only run once the row is gone.
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
        forgetUploadedImagesForBoard(boardId)
        lastSavedSignatures.current.delete(boardId)
        pendingSideEffects.current.delete(boardId)
        deleteBoardCache(boardId)
        putLastActiveBoard(newActive)
        putBoardListCache(
          boardListFromStore({
            ...snapshot,
            lastActiveBoard: newActive,
            boards: remainingBoards,
          }),
        )
      }
      void doDelete()
      return true
    },
    [user?.id],
  )

  const dismissSaveError = useCallback(() => setSaveError(null), [])

  return {
    currentBoard,
    allBoards,
    hydrating,
    hydrationError,
    createBoard,
    switchBoard,
    renameBoard,
    deleteBoard,
    saveCurrentBoard,
    markBoardClean,
    queueSideEffect,
    saveError,
    dismissSaveError,
    rollbackSignal,
    hydrationRevision,
  }
}

/**
 * Shallow comparison good enough for the background-revalidation
 * "should we swap state?" decision. We compare board count, active
 * id, and per-board updatedAt — if those match, the Supabase payload
 * is semantically equivalent to what the cache produced and there's
 * no reason to overwrite React state.
 */
function storesEqual(a: WeaveBoardsStore, b: WeaveBoardsStore): boolean {
  if (a.lastActiveBoard !== b.lastActiveBoard) return false
  const aIds = Object.keys(a.boards).sort()
  const bIds = Object.keys(b.boards).sort()
  if (aIds.length !== bIds.length) return false
  for (let i = 0; i < aIds.length; i++) {
    if (aIds[i] !== bIds[i]) return false
    const aBoard = a.boards[aIds[i]]
    const bBoard = b.boards[aIds[i]]
    if (aBoard.updatedAt !== bBoard.updatedAt) return false
    if (aBoard.name !== bBoard.name) return false
    if (aBoard.nodes.length !== bBoard.nodes.length) return false
    if (aBoard.connections.length !== bBoard.connections.length) return false
  }
  return true
}
