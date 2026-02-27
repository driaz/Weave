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

const STORAGE_KEY = 'weave-boards'
const CURRENT_VERSION = 1

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

function isValidStore(data: unknown): data is WeaveBoardsStore {
  if (!data || typeof data !== 'object') return false
  const obj = data as Record<string, unknown>
  if (typeof obj.version !== 'number') return false
  if (typeof obj.lastActiveBoard !== 'string') return false
  if (!obj.boards || typeof obj.boards !== 'object') return false
  return Object.keys(obj.boards as object).length > 0
}

function loadOrCreateStore(): WeaveBoardsStore {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw)
      if (isValidStore(parsed)) {
        if (!parsed.boards[parsed.lastActiveBoard]) {
          parsed.lastActiveBoard = Object.keys(parsed.boards)[0]
        }
        return parsed
      }
    }
  } catch {
    console.warn('Failed to load board data from localStorage, starting fresh.')
  }

  const board = createDefaultBoard()
  const store: WeaveBoardsStore = {
    version: CURRENT_VERSION,
    lastActiveBoard: board.id,
    boards: { [board.id]: board },
  }

  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store))
  } catch {
    // Silently fail — we'll retry on next save
  }

  return store
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

/** Save binary fields from nodes to IndexedDB */
async function saveBinaryFieldsForNodes(
  boardId: string,
  nodes: SerializedNode[],
): Promise<void> {
  const promises: Promise<void>[] = []
  for (const node of nodes) {
    const fields = getBinaryFields(node.type)
    for (const field of fields) {
      const value = node.data[field]
      if (typeof value === 'string' && value.length > 0) {
        promises.push(saveBinaryData(boardId, node.id, field, value))
      }
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
        // Only load from IndexedDB if the field is missing (stripped)
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
  const [store, setStore] = useState<WeaveBoardsStore>(() => {
    const initial = loadOrCreateStore()
    // Initialize counter ONCE on first load — not on every render
    const board = initial.boards[initial.lastActiveBoard]
    if (board) {
      resetNodeIdCounter(board.nodeIdCounter)
    }
    return initial
  })
  const [storageError, setStorageError] = useState<string | null>(null)
  const [hydratedBoard, setHydratedBoard] = useState<SerializedBoard | null>(
    null,
  )
  const [hydrating, setHydrating] = useState(true)
  const hydratingBoardIdRef = useRef<string | null>(null)

  // Hydrate the active board's binary data from IndexedDB
  useEffect(() => {
    const board = store.boards[store.lastActiveBoard]
    if (!board) return

    // Skip if we're already hydrating this board
    if (hydratingBoardIdRef.current === board.id) return
    hydratingBoardIdRef.current = board.id

    setHydrating(true)
    hydrateNodesFromIndexedDB(board.id, board.nodes).then((hydratedNodes) => {
      setHydratedBoard({ ...board, nodes: hydratedNodes })
      setHydrating(false)
    })
  }, [store.lastActiveBoard, store.boards])

  const persistToLocalStorage = useCallback(
    (nextStore: WeaveBoardsStore) => {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(nextStore))
        setStorageError(null)
      } catch (e) {
        if (e instanceof DOMException && e.name === 'QuotaExceededError') {
          setStorageError(
            'Storage is full. Some changes may not be saved. Try removing large images or PDFs.',
          )
        } else {
          setStorageError('Failed to save board data.')
        }
      }
    },
    [],
  )

  const persist = useCallback(
    (nextStore: WeaveBoardsStore) => {
      setStore(nextStore)
      persistToLocalStorage(nextStore)
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

  const saveCurrentBoard = useCallback(
    (nodes: Node[], connections: Connection[]) => {
      const fullNodes = stripLoadingFromLinkCards(serializeNodes(nodes))
      const counter = getNodeIdCounter()

      // Strip binary data for localStorage, save binaries to IndexedDB
      setStore((prev) => {
        const boardId = prev.lastActiveBoard
        const strippedNodes = fullNodes.map(stripBinaryFields)

        const nextStore = {
          ...prev,
          boards: {
            ...prev.boards,
            [boardId]: {
              ...prev.boards[boardId],
              nodes: strippedNodes,
              connections,
              nodeIdCounter: counter,
              updatedAt: new Date().toISOString(),
            },
          },
        }

        persistToLocalStorage(nextStore)
        return nextStore
      })

      // Save binary data to IndexedDB (fire and forget)
      const boardId = store.lastActiveBoard
      saveBinaryFieldsForNodes(boardId, fullNodes).catch((e) =>
        console.warn('Failed to save binary data to IndexedDB:', e),
      )
    },
    [store.lastActiveBoard, persistToLocalStorage],
  )

  const createBoard = useCallback((): BoardId => {
    const board = createDefaultBoard()
    resetNodeIdCounter(1)

    const nextStore: WeaveBoardsStore = {
      ...store,
      lastActiveBoard: board.id,
      boards: { ...store.boards, [board.id]: board },
    }
    // Reset hydration tracking for the new board
    hydratingBoardIdRef.current = null
    setHydratedBoard(board)
    setHydrating(false)
    persist(nextStore)
    return board.id
  }, [store, persist])

  const switchBoard = useCallback(
    (boardId: BoardId) => {
      const board = store.boards[boardId]
      if (!board) return

      resetNodeIdCounter(board.nodeIdCounter)
      // Reset hydration tracking to trigger re-hydration
      hydratingBoardIdRef.current = null
      persist({ ...store, lastActiveBoard: boardId })
    },
    [store, persist],
  )

  const renameBoard = useCallback(
    (boardId: BoardId, newName: string) => {
      const board = store.boards[boardId]
      if (!board) return

      persist({
        ...store,
        boards: {
          ...store.boards,
          [boardId]: {
            ...board,
            name: newName,
            updatedAt: new Date().toISOString(),
          },
        },
      })
    },
    [store, persist],
  )

  const deleteBoard = useCallback(
    (boardId: BoardId): boolean => {
      const boardIds = Object.keys(store.boards)
      if (boardIds.length <= 1) return false

      const { [boardId]: _removed, ...remainingBoards } = store.boards
      const newActive =
        store.lastActiveBoard === boardId
          ? Object.keys(remainingBoards)[0]
          : store.lastActiveBoard

      const nextBoard = remainingBoards[newActive]
      if (nextBoard) {
        resetNodeIdCounter(nextBoard.nodeIdCounter)
      }

      // Clean up IndexedDB binary data for deleted board
      deleteBinaryDataForBoard(boardId).catch((e) =>
        console.warn('Failed to clean up binary data for deleted board:', e),
      )

      if (store.lastActiveBoard === boardId) {
        hydratingBoardIdRef.current = null
      }

      persist({
        ...store,
        lastActiveBoard: newActive,
        boards: remainingBoards,
      })
      return true
    },
    [store, persist],
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
    storageError,
    dismissStorageError,
  }
}
