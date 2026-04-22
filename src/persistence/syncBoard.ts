import { persistence } from './index'
import {
  ensureNodeImageUploaded,
  IMAGE_STORAGE_PATH_KEY,
} from './imageUpload'
import { AuthError, NotFoundError, mapSupabaseError } from './errors'
import { requireClient, requireUserId } from './session'
import type { Connection } from '../api/claude'
import type { SerializedBoard, SerializedNode } from '../types/board'
import type { NewNodeInput, NewEdgeInput } from './types'

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
 * Build a `NewNodeInput` from a client-side SerializedNode. Binary
 * fields (imageDataUrl / imageBase64) are stripped from the jsonb
 * payload — they go to Storage via `ensureNodeImageUploaded` and the
 * returned path lands on `image_url` instead.
 */
function nodeToInput(
  node: SerializedNode,
  imagePath: string | null,
): NewNodeInput {
  const { data, type } = node
  const card_type = toCardType(type)

  const title = stringOrNull(data.title ?? data.label ?? data.fileName)
  const description = stringOrNull(data.description)
  const url = stringOrNull(data.url)
  const source = stringOrNull(data.source ?? data.domain)
  const text_content = stringOrNull(data.text ?? data.text_content)

  // Preferred `image_url` source, in order: the Storage path returned
  // by this save's `ensureNodeImageUploaded`, the path stashed on the
  // node during hydrate (means the image was already uploaded before),
  // or — for linkCards only — the external web URL the client rendered.
  const stashedPath = data[IMAGE_STORAGE_PATH_KEY]
  let image_url: string | null = null
  if (imagePath) {
    image_url = imagePath
  } else if (typeof stashedPath === 'string' && stashedPath.length > 0) {
    image_url = stashedPath
  } else if (type === 'linkCard') {
    image_url = stringOrNull(data.imageUrl)
  }

  // Strip binary fields and the client-only storage-path marker out
  // of the data blob before it hits the DB — large base64 strings
  // don't belong in Postgres, and the marker is redundant with
  // `image_url` on the row.
  const cleaned: Record<string, unknown> = { ...data }
  delete cleaned.imageDataUrl
  delete cleaned.imageBase64
  delete cleaned.pdfDataUrl
  delete cleaned.thumbnailDataUrl
  delete cleaned[IMAGE_STORAGE_PATH_KEY]

  // Preserve the client-side node id so embeddings keep matching.
  cleaned._clientNodeId = node.id
  cleaned._clientNodeType = type
  cleaned.position = node.position

  return {
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
    data: cleaned as NewNodeInput['data'],
  }
}

function connectionToEdgeInput(
  connection: Connection,
  localToServer: Map<string, string>,
): NewEdgeInput | null {
  // Strip any `node-` prefix Claude may have emitted before looking
  // up the server UUID. `localToServer` is keyed by the bare node id
  // (e.g. "4"), so a prefixed lookup ("node-4") would miss every time
  // and the edge would be silently dropped — the exact bug that wiped
  // Cutover Test 6's edges during soak.
  const fromId = connection.from.replace(/^node-/, '')
  const toId = connection.to.replace(/^node-/, '')

  const sourceServerId = localToServer.get(fromId)
  const targetServerId = localToServer.get(toId)
  if (!sourceServerId || !targetServerId) {
    console.warn(
      '[Weave sync] edge dropped — no local→server mapping for',
      `${connection.from} → ${connection.to}`,
      '(resolved:',
      `${fromId} → ${toId})`,
    )
    return null
  }

  return {
    source_node_id: sourceServerId,
    target_node_id: targetServerId,
    relationship_label: connection.label ?? null,
    data: {
      explanation: connection.explanation,
      type: connection.type,
      strength: connection.strength,
      surprise: connection.surprise,
      mode: connection.mode ?? null,
      from: fromId,
      to: toId,
    } as NewEdgeInput['data'],
  }
}

/**
 * Create-or-update a board row preserving the client-generated UUID
 * so the local board id (used everywhere in client state, localStorage,
 * and eventTracker) matches the DB primary key.
 *
 * Uses `upsert({ ignoreDuplicates: true })` rather than a plain insert
 * because concurrent saves (and reruns of a single save) would
 * otherwise race: both read `boards.get(id) === null` before either
 * insert commits, one succeeds, the other 409s on `boards_pkey`.
 * The upsert form is idempotent; the rename case is handled by the
 * explicit `.update` call in `syncBoardToSupabase`.
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
 * Delete every node on a board in one statement. There's no top-level
 * `persistence.nodes.deleteByBoard` because until now the module
 * hasn't needed it; this is the first "replace all" caller.
 */
async function deleteNodesByBoard(boardId: string): Promise<void> {
  const client = requireClient()
  await requireUserId()

  const { error } = await client.from('nodes').delete().eq('board_id', boardId)
  if (error)
    throw mapSupabaseError(error, `syncBoard.deleteNodesByBoard(${boardId})`)
}

/**
 * Wrap each await with a step label so post-mortem `supabase failure`
 * logs tell us *which* step of the replace-all died instead of just
 * echoing the raw Supabase error text.
 */
async function step<T>(label: string, op: () => Promise<T>): Promise<T> {
  try {
    return await op()
  } catch (err) {
    const cause = err instanceof Error ? err.message : String(err)
    const wrapped = new Error(`${label}: ${cause}`, {
      cause: err as Error,
    })
    // Preserve the original class (AuthError, ValidationError, etc.)
    // so downstream `instanceof` branches still work.
    if (err instanceof Error) wrapped.name = err.name
    throw wrapped
  }
}

/**
 * Replace-all sync of a single board to Supabase.
 *
 * 1. Upsert the board row (create on first sight, update otherwise).
 * 2. Upload any new base64 images to Storage (memoized — repeat saves
 *    don't re-upload).
 * 3. Delete every node for this board, then `batchCreate` a fresh set.
 *    Each inserted row gets a server-generated UUID that we thread
 *    into edges below. Edges are cascade-deleted by the FK when the
 *    nodes go away (see migration 008), so there's no separate
 *    `edges.deleteByBoard` round trip.
 * 4. Insert fresh edges using the client-id → server-id map.
 *
 * **Destructive window:** step 3's DELETE commits before step 3's
 * INSERT runs. If the INSERT fails (network, constraint, etc.) the
 * board is left at 0 nodes / 0 edges until the next save. Fix C
 * (transactional RPC) is the proper closure; Fix A + Fix B in the
 * caller (useBoardStorage) narrow the window by eliminating spurious
 * saves and serializing concurrent ones.
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

  // 3. Replace all nodes. Edges cascade-delete via FK on delete.
  await step('step:delete-nodes', () => deleteNodesByBoard(board.id))

  const inputs = board.nodes.map((node) =>
    nodeToInput(node, imagePaths.get(node.id) ?? null),
  )
  const created = inputs.length
    ? await step('step:insert-nodes', () =>
        persistence.nodes.batchCreate(board.id, inputs),
      )
    : []

  // batchCreate returns rows in the order they were sent — zip them
  // against the client nodes to build the id translation map.
  const localToServer = new Map<string, string>()
  for (let i = 0; i < board.nodes.length; i++) {
    const serverNode = created[i]
    if (serverNode) localToServer.set(board.nodes[i].id, serverNode.id)
  }

  // 4. Insert fresh edges. No explicit delete — step 3 already
  // cascaded them.
  const edgeInputs = board.connections
    .map((c) => connectionToEdgeInput(c, localToServer))
    .filter((input): input is NewEdgeInput => input !== null)
  if (edgeInputs.length > 0) {
    await step('step:insert-edges', () =>
      persistence.edges.batchCreate(board.id, edgeInputs),
    )
  }
}
