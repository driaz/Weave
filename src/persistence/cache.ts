import type { Connection } from '../api/claude'
import type { SerializedNode } from '../types/board'

/**
 * Local read-cache over Supabase. Writes are ALWAYS downstream of a
 * successful Supabase write — never speculative. Used by the canvas
 * at cold-start to render instantly while a background revalidation
 * fetches the latest from Supabase.
 *
 * Key layout:
 *   weave_cache_{boardId}   → CachedBoard (nodes + edges + updatedAt)
 *   weave_cache_boards      → CachedBoardMeta[] (list for the sidebar)
 *   weave_cache_lastActive  → string (the last board the user had open)
 *
 * Binary node fields (imageDataUrl, imageBase64, pdfDataUrl,
 * thumbnailDataUrl) are stripped before write: they'd blow the ~5MB
 * localStorage quota in one or two images. The browser HTTP cache
 * handles image bytes; signed URLs get regenerated on hydration.
 */

const BINARY_CACHE_FIELDS: ReadonlyArray<string> = [
  'imageDataUrl',
  'imageBase64',
  'pdfDataUrl',
  'thumbnailDataUrl',
]

function projectNodeForCache(node: SerializedNode): SerializedNode {
  if (!node.data) return node
  let hasBinary = false
  for (const field of BINARY_CACHE_FIELDS) {
    if (field in node.data) {
      hasBinary = true
      break
    }
  }
  if (!hasBinary) return node
  const cleaned: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(node.data)) {
    if (BINARY_CACHE_FIELDS.includes(k)) continue
    cleaned[k] = v
  }
  return { ...node, data: cleaned }
}

function projectNodesForCache(nodes: SerializedNode[]): SerializedNode[] {
  return nodes.map(projectNodeForCache)
}

const BOARD_PREFIX = 'weave_cache_'
const BOARD_KEY = (id: string): string => `${BOARD_PREFIX}${id}`
const BOARD_LIST_KEY = 'weave_cache_boards'
const LAST_ACTIVE_KEY = 'weave_cache_lastActive'

export type CachedBoardMeta = {
  id: string
  name: string
  updatedAt: string
}

export type CachedBoard = {
  nodes: SerializedNode[]
  connections: Connection[]
  updatedAt: string
}

function safeGet<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return null
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

function safeSet(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // QuotaExceeded / serialization failures — cache is best-effort.
  }
}

function safeRemove(key: string): void {
  try {
    localStorage.removeItem(key)
  } catch {
    // Ignore — removal is best-effort.
  }
}

export function getBoardCache(boardId: string): CachedBoard | null {
  return safeGet<CachedBoard>(BOARD_KEY(boardId))
}

export function putBoardCache(boardId: string, data: CachedBoard): void {
  const projected: CachedBoard = {
    ...data,
    nodes: projectNodesForCache(data.nodes),
  }
  safeSet(BOARD_KEY(boardId), projected)
}

export function deleteBoardCache(boardId: string): void {
  safeRemove(BOARD_KEY(boardId))
}

export function getBoardListCache(): CachedBoardMeta[] | null {
  const data = safeGet<CachedBoardMeta[]>(BOARD_LIST_KEY)
  return Array.isArray(data) ? data : null
}

export function putBoardListCache(meta: CachedBoardMeta[]): void {
  safeSet(BOARD_LIST_KEY, meta)
}

export function getLastActiveBoard(): string | null {
  try {
    return localStorage.getItem(LAST_ACTIVE_KEY)
  } catch {
    return null
  }
}

export function putLastActiveBoard(id: string): void {
  try {
    localStorage.setItem(LAST_ACTIVE_KEY, id)
  } catch {
    // ignore
  }
}

export function clearLastActiveBoard(): void {
  safeRemove(LAST_ACTIVE_KEY)
}

/** Wipe every cache key. Used when the user signs out or on a hard reset. */
export function clearAll(): void {
  try {
    const toRemove: string[] = []
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (key && (key.startsWith(BOARD_PREFIX) || key === LAST_ACTIVE_KEY)) {
        toRemove.push(key)
      }
    }
    for (const key of toRemove) localStorage.removeItem(key)
  } catch {
    // ignore
  }
}
