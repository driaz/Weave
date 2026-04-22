import { persistence } from './index'
import { AuthError } from './errors'
import { logHydrationSource } from './syncLogger'
import { IMAGE_STORAGE_PATH_KEY } from './imageUpload'
import {
  getBoardCache,
  getBoardListCache,
  getLastActiveBoard,
  putBoardCache,
  putBoardListCache,
  putLastActiveBoard,
} from './cache'
import type {
  BoardId,
  SerializedBoard,
  SerializedNode,
  WeaveBoardsStore,
} from '../types/board'
import type { Connection } from '../api/claude'
import type { Board, Node as DbNode, Edge as DbEdge } from './types'

const CURRENT_VERSION = 1
// Signed URLs survive a working session without round-tripping the
// auth layer; renewal on next hydrate is fine.
const SIGNED_URL_EXPIRY_SECONDS = 60 * 60 * 24 // 24 hours

export function emptyStore(): WeaveBoardsStore {
  const id = crypto.randomUUID()
  const now = new Date().toISOString()
  const board: SerializedBoard = {
    id,
    name: 'Untitled',
    nodes: [],
    connections: [],
    nodeIdCounter: 1,
    createdAt: now,
    updatedAt: now,
  }
  return {
    version: CURRENT_VERSION,
    lastActiveBoard: id,
    boards: { [id]: board },
  }
}

function storeFromSingleBoard(board: Board): WeaveBoardsStore {
  const serialized: SerializedBoard = {
    id: board.id,
    name: board.name,
    nodes: [],
    connections: [],
    nodeIdCounter: 1,
    createdAt: board.created_at,
    updatedAt: board.updated_at,
  }
  return {
    version: CURRENT_VERSION,
    lastActiveBoard: board.id,
    boards: { [board.id]: serialized },
  }
}

function reverseCardType(cardType: string): string {
  switch (cardType) {
    case 'text':
      return 'textCard'
    case 'image':
      return 'imageCard'
    case 'link':
      return 'linkCard'
    case 'pdf':
      return 'pdfCard'
    default:
      return 'textCard'
  }
}

function reverseLinkType(linkType: string | null): string | null {
  if (linkType === 'tweet') return 'twitter'
  if (linkType === 'youtube') return 'youtube'
  if (linkType === 'generic') return 'generic'
  return null
}

/**
 * Convert a Supabase node row back into the SerializedNode shape the
 * canvas consumes. Binary image fields are reconstructed from a
 * signed URL (when image_url looks like a Storage path) or from the
 * original URL the client wrote in `data.imageUrl`.
 */
async function nodeFromSupabase(dbNode: DbNode): Promise<SerializedNode> {
  const clientType = reverseCardType(dbNode.card_type)
  const dataBlob = (dbNode.data ?? {}) as Record<string, unknown>

  const clientId =
    typeof dataBlob._clientNodeId === 'string'
      ? (dataBlob._clientNodeId as string)
      : dbNode.id

  const data: Record<string, unknown> = { ...dataBlob }
  delete data._clientNodeId
  delete data._clientNodeType

  const position =
    typeof data.position === 'object' && data.position !== null
      ? (data.position as { x: number; y: number })
      : { x: dbNode.position_x, y: dbNode.position_y }
  delete data.position

  if (clientType === 'linkCard') {
    data.type = reverseLinkType(dbNode.link_type) ?? data.type ?? 'generic'
    if (dbNode.url) data.url = dbNode.url
    if (dbNode.title) data.title = dbNode.title
    if (dbNode.description) data.description = dbNode.description
    if (dbNode.source) data.domain = dbNode.source
    if (dbNode.image_url) {
      if (looksLikeStoragePath(dbNode.image_url)) {
        data[IMAGE_STORAGE_PATH_KEY] = dbNode.image_url
        try {
          data.imageUrl = await persistence.media.getSignedUrl(
            dbNode.image_url,
            SIGNED_URL_EXPIRY_SECONDS,
          )
        } catch {
          // leave imageUrl unset — UI falls back to placeholder
        }
      } else {
        data.imageUrl = dbNode.image_url
      }
    }
  } else if (clientType === 'imageCard') {
    if (dbNode.image_url && looksLikeStoragePath(dbNode.image_url)) {
      data[IMAGE_STORAGE_PATH_KEY] = dbNode.image_url
      try {
        data.imageDataUrl = await persistence.media.getSignedUrl(
          dbNode.image_url,
          SIGNED_URL_EXPIRY_SECONDS,
        )
      } catch {
        // leave unset
      }
    }
  } else if (clientType === 'textCard') {
    if (dbNode.text_content) {
      data.text = data.text ?? dbNode.text_content
      data.text_content = dbNode.text_content
    }
    if (dbNode.title) data.title = dbNode.title
  }

  return {
    id: clientId,
    type: clientType,
    position,
    data,
  }
}

function looksLikeStoragePath(value: string): boolean {
  return !value.includes('://')
}

function connectionFromEdge(
  edge: DbEdge,
  serverIdToClientId: Map<string, string>,
): Connection | null {
  const from =
    serverIdToClientId.get(edge.source_node_id) ??
    ((edge.data as Record<string, unknown> | null)?.from as string | undefined)
  const to =
    serverIdToClientId.get(edge.target_node_id) ??
    ((edge.data as Record<string, unknown> | null)?.to as string | undefined)
  if (!from || !to) return null

  const blob = (edge.data ?? {}) as Record<string, unknown>
  return {
    from,
    to,
    label: edge.relationship_label ?? '',
    explanation:
      typeof blob.explanation === 'string' ? (blob.explanation as string) : '',
    type: typeof blob.type === 'string' ? (blob.type as string) : 'related',
    strength: typeof blob.strength === 'number' ? (blob.strength as number) : 0,
    surprise: typeof blob.surprise === 'number' ? (blob.surprise as number) : 0,
    mode:
      blob.mode === 'weave' || blob.mode === 'deeper' || blob.mode === 'tensions'
        ? (blob.mode as Connection['mode'])
        : undefined,
  }
}

function computeNodeIdCounter(nodes: SerializedNode[]): number {
  let max = 1
  for (const n of nodes) {
    const asNumber = Number(n.id)
    if (Number.isFinite(asNumber) && asNumber > max) max = asNumber
  }
  return max + 1
}

async function boardFromSupabase(
  board: Board,
  dbNodes: DbNode[],
  dbEdges: DbEdge[],
): Promise<SerializedBoard> {
  const nodes = await Promise.all(dbNodes.map((n) => nodeFromSupabase(n)))
  const serverIdToClientId = new Map<string, string>()
  for (let i = 0; i < dbNodes.length; i++) {
    serverIdToClientId.set(dbNodes[i].id, nodes[i].id)
  }
  const connections = dbEdges
    .map((e) => connectionFromEdge(e, serverIdToClientId))
    .filter((c): c is Connection => c !== null)

  return {
    id: board.id,
    name: board.name,
    nodes,
    connections,
    nodeIdCounter: computeNodeIdCounter(nodes),
    createdAt: board.created_at,
    updatedAt: board.updated_at,
  }
}

async function loadFullStateFromSupabase(
  supabaseBoards: Board[],
  preferredActiveId: string | null,
): Promise<WeaveBoardsStore> {
  const assembled = await Promise.all(
    supabaseBoards.map(async (board) => {
      const [dbNodes, dbEdges] = await Promise.all([
        persistence.nodes.listByBoard(board.id),
        persistence.edges.listByBoard(board.id),
      ])
      const serialized = await boardFromSupabase(board, dbNodes, dbEdges)
      return [board.id, serialized] as const
    }),
  )

  const boards: Record<BoardId, SerializedBoard> = {}
  for (const [id, board] of assembled) boards[id] = board

  const lastActiveBoard =
    preferredActiveId && boards[preferredActiveId]
      ? preferredActiveId
      : supabaseBoards[0].id

  return {
    version: CURRENT_VERSION,
    lastActiveBoard,
    boards,
  }
}

/**
 * Build a WeaveBoardsStore synchronously from cached data. Returns
 * null if the cache doesn't have enough to render the canvas (no
 * last-active board, or no per-board entry for that board).
 *
 * Nodes for boards we don't have per-board cache for are rendered as
 * empty — the background Supabase fetch will fill them in. This
 * matches the cold-start contract: instant render from cache, reconcile
 * silently.
 */
export function buildStoreFromCache(): WeaveBoardsStore | null {
  const list = getBoardListCache()
  const lastActive = getLastActiveBoard()
  if (!list || list.length === 0 || !lastActive) return null
  if (!list.some((b) => b.id === lastActive)) return null

  const activeBoardCache = getBoardCache(lastActive)
  if (!activeBoardCache) return null

  const boards: Record<BoardId, SerializedBoard> = {}
  const now = new Date().toISOString()
  for (const meta of list) {
    const perBoard = meta.id === lastActive ? activeBoardCache : getBoardCache(meta.id)
    const nodes = perBoard?.nodes ?? []
    const connections = perBoard?.connections ?? []
    boards[meta.id] = {
      id: meta.id,
      name: meta.name,
      nodes,
      connections,
      nodeIdCounter: computeNodeIdCounter(nodes),
      createdAt: now,
      updatedAt: perBoard?.updatedAt ?? meta.updatedAt,
    }
  }

  return {
    version: CURRENT_VERSION,
    lastActiveBoard: lastActive,
    boards,
  }
}

/**
 * Mirror the full store (or a single board) into cache. Called AFTER
 * a successful Supabase read/write — never speculatively.
 */
export function writeStoreToCache(store: WeaveBoardsStore): void {
  const list = Object.values(store.boards)
    .map((b) => ({ id: b.id, name: b.name, updatedAt: b.updatedAt }))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  putBoardListCache(list)
  putLastActiveBoard(store.lastActiveBoard)
  for (const board of Object.values(store.boards)) {
    putBoardCache(board.id, {
      nodes: board.nodes,
      connections: board.connections,
      updatedAt: board.updatedAt,
    })
  }
}

export type HydrationOutcome =
  | { kind: 'success'; store: WeaveBoardsStore; source: 'supabase' }
  | { kind: 'network-error'; reason: string }

/**
 * Fetch the authoritative store from Supabase. Auto-creates an
 * Untitled board for first-time users so the canvas never renders
 * blank against an empty account.
 *
 * Auth errors are rethrown (ProtectedRoute bounces to /login on the
 * next render). Everything else is surfaced as a network-error
 * outcome so the caller can decide between "show the cache" and
 * "show the error state".
 */
export async function fetchFromSupabase(
  preferredActiveId: string | null,
): Promise<HydrationOutcome> {
  try {
    const supabaseBoards = await persistence.boards.list()

    if (supabaseBoards.length > 0) {
      const store = await loadFullStateFromSupabase(
        supabaseBoards,
        preferredActiveId,
      )
      writeStoreToCache(store)
      logHydrationSource('supabase', 'fetched from Supabase')
      return { kind: 'success', store, source: 'supabase' }
    }

    // Brand-new account: auto-create the first board so the canvas
    // has something to render.
    const newBoard = await persistence.boards.create({ name: 'Untitled' })
    const store = storeFromSingleBoard(newBoard)
    writeStoreToCache(store)
    logHydrationSource('supabase', 'new user, auto-created first board')
    return { kind: 'success', store, source: 'supabase' }
  } catch (err) {
    if (err instanceof AuthError) throw err
    const reason = err instanceof Error ? err.message : String(err)
    return { kind: 'network-error', reason }
  }
}
