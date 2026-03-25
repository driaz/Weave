import type { WeaveBoardsStore, SerializedNode } from '../types/board'
import { loadBinaryData, getBinaryFields } from './binaryStorage'
import { embedNode } from '../services/embeddingService'

const STORAGE_KEY = 'weave-boards'
const DELAY_MS = 750

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Hydrate a single node's binary fields from IndexedDB */
async function hydrateNode(
  boardId: string,
  node: SerializedNode,
): Promise<SerializedNode> {
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
}

/**
 * Backfill embeddings for every node across all boards.
 * Reads from localStorage + IndexedDB, calls embedNode() sequentially
 * with a delay between each call to avoid Gemini rate limits.
 *
 * Attach to window so it can be triggered from the browser console:
 *   window.backfillEmbeddings()
 */
export async function backfillEmbeddings(): Promise<void> {
  const raw = localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    console.warn('[Backfill] No board data found in localStorage.')
    return
  }

  let store: WeaveBoardsStore
  try {
    store = JSON.parse(raw) as WeaveBoardsStore
  } catch {
    console.error('[Backfill] Failed to parse board data from localStorage.')
    return
  }

  const boards = Object.values(store.boards)
  const totalNodes = boards.reduce((sum, b) => sum + b.nodes.length, 0)

  console.log(
    `[Backfill] Starting — ${totalNodes} nodes across ${boards.length} board(s)`,
  )

  let processed = 0
  let embedded = 0
  let skipped = 0

  for (const board of boards) {
    console.log(
      `[Backfill] Board "${board.name}" — ${board.nodes.length} node(s)`,
    )

    for (const strippedNode of board.nodes) {
      processed++
      const progress = `${processed}/${totalNodes}`

      // Hydrate binary data from IndexedDB
      const node = await hydrateNode(board.id, strippedNode)

      console.log(
        `[Backfill] Embedding node ${progress} on board "${board.name}" (type: ${node.type}, id: ${node.id})`,
      )

      try {
        await embedNode(board.id, node.id, node.type, node.data)
        embedded++
      } catch (err) {
        console.warn(
          `[Backfill] Failed node ${node.id} on "${board.name}":`,
          err,
        )
        skipped++
      }

      // Throttle to avoid rate limiting
      await delay(DELAY_MS)
    }
  }

  console.log(
    `[Backfill] Complete — ${embedded} embedded, ${skipped} skipped, ${totalNodes} total`,
  )
}
