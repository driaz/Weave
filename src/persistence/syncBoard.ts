import { persistence } from './index'
import {
  ensureNodeImageUploaded,
  IMAGE_STORAGE_PATH_KEY,
} from './imageUpload'
import { AuthError, NotFoundError, mapSupabaseError } from './errors'
import { requireClient, requireUserId } from './session'
import type { Connection } from '../api/claude'
import type { SerializedBoard, SerializedNode } from '../types/board'
import type { Json } from '../types/database'

/**
 * Map client-side node `type` (e.g. "imageCard") to the `card_type`
 * value accepted by the DB's CHECK constraint.
 */
function toCardType(clientType: string): string {
  switch (clientType) {
    case 'textCard':
      return 'text'
    case 'imageCard':
      return 'image'
    case 'linkCard':
      return 'link'
    case 'pdfCard':
      return 'pdf'
    default:
      return 'text'
  }
}

/**
 * Map client-side linkCard `data.type` ("twitter" | "youtube" | "generic")
 * to the `link_type` accepted by the DB ("tweet" | "youtube" | "generic").
 */
function toLinkType(value: unknown): string | null {
  if (value === 'twitter') return 'tweet'
  if (value === 'youtube') return 'youtube'
  if (value === 'generic') return 'generic'
  return null
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

/**
 * Payload shape for a single node in the `replace_board_contents`
 * RPC. Mirrors `NewNodeInput` from `types.ts` but adds `client_id`
 * — the RPC uses that to build the client→server id map so edges
 * inserted in the same transaction can resolve source/target refs.
 */
type RpcNodePayload = {
  client_id: string
  card_type: string
  link_type: string | null
  position_x: number
  position_y: number
  title: string | null
  description: string | null
  url: string | null
  source: string | null
  text_content: string | null
  image_url: string | null
  data: Record<string, unknown>
}

type RpcEdgePayload = {
  client_source_id: string
  client_target_id: string
  relationship_label: string | null
  data: Record<string, unknown>
}

/**
 * Build the node payload for the RPC. Strips binary fields out of
 * the jsonb blob (they live in Storage / IndexedDB), stashes the
 * client-side id + type so hydration can round-trip the client's
 * view of the node without needing a mapping table.
 */
function nodeToRpcPayload(
  node: SerializedNode,
  imagePath: string | null,
): RpcNodePayload {
  const { data, type } = node
  const card_type = toCardType(type)

  const title = stringOrNull(data.title ?? data.label ?? data.fileName)
  const description = stringOrNull(data.description)
  const url = stringOrNull(data.url)
  const source = stringOrNull(data.source ?? data.domain)
  const text_content = stringOrNull(data.text ?? data.text_content)

  // Preferred `image_url` source, in order: fresh upload this cycle,
  // path stashed on the node during hydrate, or — for linkCards —
  // the external web URL the client rendered.
  const stashedPath = data[IMAGE_STORAGE_PATH_KEY]
  let image_url: string | null = null
  if (imagePath) {
    image_url = imagePath
  } else if (typeof stashedPath === 'string' && stashedPath.length > 0) {
    image_url = stashedPath
  } else if (type === 'linkCard') {
    image_url = stringOrNull(data.imageUrl)
  }

  // Strip binary fields and the client-only storage-path marker
  // before the blob goes over the wire.
  const cleaned: Record<string, unknown> = { ...data }
  delete cleaned.imageDataUrl
  delete cleaned.imageBase64
  delete cleaned.pdfDataUrl
  delete cleaned.thumbnailDataUrl
  delete cleaned[IMAGE_STORAGE_PATH_KEY]

  // Preserve the client-side node id so hydration + embeddings keep
  // matching across the replace-all cycle.
  cleaned._clientNodeId = node.id
  cleaned._clientNodeType = type
  cleaned.position = node.position

  return {
    client_id: node.id,
    card_type,
    link_type: type === 'linkCard' ? toLinkType(data.type) : null,
    position_x: node.position.x,
    position_y: node.position.y,
    title,
    description,
    url,
    source,
    text_content,
    image_url,
    data: cleaned,
  }
}

/**
 * Build the edge payload for the RPC. Strips any `node-` prefix
 * Claude may have emitted — the RPC's id_map is keyed on whatever
 * the client_id on the node payload is, which is always the bare
 * SerializedNode.id. Ingest in App.tsx should already have
 * normalised these; belt-and-suspenders here so a slip-through
 * doesn't silently drop the edge.
 */
function connectionToRpcPayload(connection: Connection): RpcEdgePayload {
  const fromId = connection.from.replace(/^node-/, '')
  const toId = connection.to.replace(/^node-/, '')

  return {
    client_source_id: fromId,
    client_target_id: toId,
    relationship_label: connection.label ?? null,
    data: {
      explanation: connection.explanation,
      type: connection.type,
      strength: connection.strength,
      surprise: connection.surprise,
      mode: connection.mode ?? null,
      from: fromId,
      to: toId,
    },
  }
}

/**
 * Wrap each await with a step label so post-mortem `supabase failure`
 * logs tell us *which* step of the replace-all died.
 */
async function step<T>(label: string, op: () => Promise<T>): Promise<T> {
  try {
    return await op()
  } catch (err) {
    const cause = err instanceof Error ? err.message : String(err)
    const wrapped = new Error(`${label}: ${cause}`, {
      cause: err as Error,
    })
    if (err instanceof Error) wrapped.name = err.name
    throw wrapped
  }
}

/**
 * Create-or-update a board row preserving the client-generated UUID
 * so the local board id (used everywhere in client state, localStorage,
 * and eventTracker) matches the DB primary key.
 *
 * The `replace_board_contents` RPC does not create the board row —
 * it requires the board to already exist so its ownership check can
 * run. First-save-of-a-new-board uses this upsert to make sure the
 * row is there before the RPC call.
 */
async function upsertBoardRow(id: string, name: string): Promise<void> {
  const client = requireClient()
  const userId = await requireUserId()

  const { error } = await client
    .from('boards')
    .upsert({ id, user_id: userId, name }, {
      onConflict: 'id',
      ignoreDuplicates: true,
    })
  if (error) throw mapSupabaseError(error, `syncBoard.upsertBoardRow(${id})`)
}

/**
 * Single-statement atomic replace of a board's nodes + edges.
 * Delegates to the `replace_board_contents` PL/pgSQL function so
 * the DELETE and both INSERTs live inside one transaction — a
 * failure anywhere inside rolls back all three, leaving the prior
 * state untouched. Prior client-orchestrated sequence could strand
 * a board at 0/0 if the node INSERT failed after the DELETE
 * committed.
 *
 * The RPC also advances `boards.updated_at`, which fixes the
 * stale-sidebar-ordering issue from before — the client code no
 * longer needs to touch the boards row for activity tracking.
 */
async function callReplaceBoardContents(
  boardId: string,
  nodes: RpcNodePayload[],
  edges: RpcEdgePayload[],
): Promise<void> {
  const client = requireClient()
  await requireUserId()

  const { error } = await client.rpc('replace_board_contents', {
    p_board_id: boardId,
    p_nodes: nodes as unknown as Json,
    p_edges: edges as unknown as Json,
  })
  if (error)
    throw mapSupabaseError(error, `syncBoard.replaceBoardContents(${boardId})`)
}

/**
 * Replace-all sync of a single board to Supabase.
 *
 * 1. Ensure the board row exists (first-save creates, rename
 *    updates; unchanged name is a no-op).
 * 2. Upload any new base64 images to Storage (memoized — repeat
 *    saves don't re-upload).
 * 3. Single RPC call: DELETE existing nodes (cascade-deletes edges),
 *    INSERT new nodes, INSERT new edges, advance boards.updated_at.
 *    Atomic — any failure rolls the whole function back.
 */
export async function syncBoardToSupabase(
  userId: string,
  board: SerializedBoard,
): Promise<void> {
  // 1. Board row
  const existing = await step('step:board-get', () =>
    persistence.boards.get(board.id).catch((err) => {
      if (err instanceof NotFoundError) return null
      throw err
    }),
  )

  if (!existing) {
    await step('step:board-upsert', () =>
      upsertBoardRow(board.id, board.name),
    )
  } else if (existing.name !== board.name) {
    await step('step:board-rename', () =>
      persistence.boards.update(board.id, { name: board.name }),
    )
  }

  // 2. Upload images (best-effort — memoized so repeat saves are cheap)
  const imagePaths = new Map<string, string | null>()
  await Promise.all(
    board.nodes.map(async (node) => {
      try {
        const path = await ensureNodeImageUploaded(
          userId,
          board.id,
          node.id,
          node.type,
          node.data,
        )
        imagePaths.set(node.id, path)
      } catch (err) {
        if (err instanceof AuthError) throw err
        console.warn(
          '[Weave sync] image upload failed for node',
          node.id,
          err,
        )
        imagePaths.set(node.id, null)
      }
    }),
  )

  // 3. Atomic replace-all via RPC.
  const nodePayload = board.nodes.map((node) =>
    nodeToRpcPayload(node, imagePaths.get(node.id) ?? null),
  )
  const edgePayload = board.connections.map(connectionToRpcPayload)

  await step('step:rpc-replace-all', () =>
    callReplaceBoardContents(board.id, nodePayload, edgePayload),
  )
}
