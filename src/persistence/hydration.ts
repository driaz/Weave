import { persistence } from './index'
import { AuthError } from './errors'
import { logHydrationSource } from './syncLogger'
import { IMAGE_STORAGE_PATH_KEY } from './imageUpload'
import type {
  BoardId,
  SerializedBoard,
  SerializedNode,
  WeaveBoardsStore,
} from '../types/board'
import type { Connection } from '../api/claude'
import type { Board, Node as DbNode, Edge as DbEdge } from './types'

const STORAGE_KEY = 'weave-boards'
const CURRENT_VERSION = 1
// Signed URLs survive a working session without round-tripping the
// auth layer; renewal on next hydrate is fine.
const SIGNED_URL_EXPIRY_SECONDS = 60 * 60 * 24 // 24 hours

function isValidStore(data: unknown): data is WeaveBoardsStore {
  if (!data || typeof data !== 'object') return false
  const obj = data as Record<string, unknown>
  if (typeof obj.version !== 'number') return false
  if (typeof obj.lastActiveBoard !== 'string') return false
  if (!obj.boards || typeof obj.boards !== 'object') return false
  return Object.keys(obj.boards as object).length > 0
}

export function loadFromLocalStorage(): WeaveBoardsStore | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (!isValidStore(parsed)) return null
    if (!parsed.boards[parsed.lastActiveBoard]) {
      parsed.lastActiveBoard = Object.keys(parsed.boards)[0]
    }
    return parsed
  } catch {
    return null
  }
}

export function saveToLocalStorage(store: WeaveBoardsStore): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store))
  } catch {
    // QuotaExceeded etc. — surfaced separately by the hook on save
  }
}

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

export function storeFromSingleBoard(board: Board): WeaveBoardsStore {
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

function hasBoards(store: WeaveBoardsStore): boolean {
  return Object.keys(store.boards).length > 0
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

  // Client-side id persisted in the data blob when we synced. Fallback
  // to the server UUID so we can still render if the row predates the
  // cutover (shouldn't happen for this user, but cheap insurance).
  const clientId =
    typeof dataBlob._clientNodeId === 'string'
      ? (dataBlob._clientNodeId as string)
      : dbNode.id

  const data: Record<string, unknown> = { ...dataBlob }
  delete data._clientNodeId
  delete data._clientNodeType

  // Position can live on the DB columns or inside the data blob; the
  // columns are authoritative.
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
    // For linkCards the image column typically holds the external URL;
    // only convert to a signed URL if it looks like a storage path.
    if (dbNode.image_url) {
      if (looksLikeStoragePath(dbNode.image_url)) {
        // Record the Storage path so subsequent saves know this image
        // is already uploaded and skip the re-upload step.
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
  // Storage paths start with `${userId}/` (a UUID) and don't include a
  // protocol scheme. External URLs always include `://`.
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
  // Client ids that look like plain integers feed generateNodeId; use
  // the max we see to avoid collisions. UUID-shaped ids coexist fine
  // and don't influence the counter.
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

/**
 * Fetch boards + nodes + edges from Supabase and assemble a complete
 * WeaveBoardsStore. Preserves whatever `lastActiveBoard` is in
 * localStorage (if it points at a known board) so we don't lose the
 * user's open board across refreshes.
 */
export async function loadFullStateFromSupabase(
  supabaseBoards: Board[],
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

  const previousLocal = loadFromLocalStorage()
  const lastActiveBoard =
    previousLocal && boards[previousLocal.lastActiveBoard]
      ? previousLocal.lastActiveBoard
      : supabaseBoards[0].id

  return {
    version: CURRENT_VERSION,
    lastActiveBoard,
    boards,
  }
}

export type HydrationResult = {
  store: WeaveBoardsStore
  /** Did this load touch Supabase? (Controls whether dual-write is safe.) */
  fromSupabase: boolean
}

/**
 * Single entry point called by useBoardStorage at mount time.
 *
 * Auth + network errors are swallowed into a localStorage fallback
 * because the canvas must always render *something*; the hook logs
 * the chosen source loudly so regressions surface during bake.
 */
export async function hydrateBoardStore(
  authedUserId: string | null,
): Promise<HydrationResult> {
  if (authedUserId) {
    try {
      const supabaseBoards = await persistence.boards.list()

      if (supabaseBoards.length > 0) {
        const store = await loadFullStateFromSupabase(supabaseBoards)
        saveToLocalStorage(store)
        logHydrationSource('supabase', 'success')
        return { store, fromSupabase: true }
      }

      const local = loadFromLocalStorage()
      if (local && hasBoards(local)) {
        logHydrationSource(
          'localStorage',
          'supabase empty, localStorage has data (awaiting migration)',
        )
        return { store: local, fromSupabase: false }
      }

      // Brand-new user — no localStorage, no Supabase.
      const newBoard = await persistence.boards.create({ name: 'Untitled' })
      const store = storeFromSingleBoard(newBoard)
      saveToLocalStorage(store)
      logHydrationSource('supabase', 'new user, auto-created first board')
      return { store, fromSupabase: true }
    } catch (err) {
      if (err instanceof AuthError) {
        // Kick it up — <ProtectedRoute> will bounce to /login on next render.
        throw err
      }
      console.warn(
        '[Weave hydration] Supabase unreachable, falling back to localStorage',
        err,
      )
      const local = loadFromLocalStorage()
      if (local && hasBoards(local)) {
        logHydrationSource('localStorage', 'supabase unreachable')
        return { store: local, fromSupabase: false }
      }
      const fallback = emptyStore()
      saveToLocalStorage(fallback)
      logHydrationSource(
        'empty',
        'no data available — created empty local board',
      )
      return { store: fallback, fromSupabase: false }
    }
  }

  // No authed user — shouldn't happen because App is behind
  // ProtectedRoute, but we still need to render something if auth is
  // mid-flight.
  const local = loadFromLocalStorage()
  if (local && hasBoards(local)) {
    logHydrationSource('localStorage', 'no auth session')
    return { store: local, fromSupabase: false }
  }
  const fallback = emptyStore()
  logHydrationSource('empty', 'no auth session and no local data')
  return { store: fallback, fromSupabase: false }
}
