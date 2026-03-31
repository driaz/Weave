import type { WeaveBoardsStore } from '../types/board'
import { fetchTweetImage } from './linkUtils'
import { saveBinaryData } from './binaryStorage'
import { embedNodeAsync } from '../services/embeddingService'

const STORAGE_KEY = 'weave-boards'
const DELAY_MS = 1000

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function backfillTweetImages(): Promise<void> {
  const raw = localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    console.log('[backfill-images] No board data found in localStorage.')
    return
  }

  const store: WeaveBoardsStore = JSON.parse(raw)
  let totalUpdated = 0
  let totalSkipped = 0

  for (const [boardId, board] of Object.entries(store.boards)) {
    const tweetNodes = board.nodes.filter(
      (n) =>
        n.type === 'linkCard' &&
        n.data.type === 'twitter' &&
        !n.data.imageBase64,
    )

    if (tweetNodes.length === 0) continue
    console.log(
      `[backfill-images] Board "${board.name}" (${boardId}): ${tweetNodes.length} tweet(s) need images`,
    )

    for (const node of tweetNodes) {
      const url = node.data.url as string
      console.log(`[backfill-images]   Fetching image for ${url}...`)

      try {
        const result = await fetchTweetImage(url)

        if (result.imageBase64 && result.imageMimeType) {
          // Update node data in the store
          node.data.imageBase64 = result.imageBase64
          node.data.imageMimeType = result.imageMimeType
          totalUpdated++

          // Persist binary data to IndexedDB
          await saveBinaryData(boardId, node.id, 'imageBase64', result.imageBase64)

          // Re-embed with the image included
          embedNodeAsync(boardId, node.id, 'linkCard', {
            ...node.data,
          })

          console.log(
            `[backfill-images]   ✓ Got image (${Math.round(result.imageBase64.length * 0.75 / 1024)}KB, ${result.imageMimeType})`,
          )
        } else {
          totalSkipped++
          console.log(`[backfill-images]   ✗ No tweet image found`)
        }
      } catch (err) {
        totalSkipped++
        console.warn(`[backfill-images]   ✗ Failed:`, err)
      }

      await delay(DELAY_MS)
    }
  }

  if (totalUpdated > 0) {
    // Save updated metadata (imageBase64 stripped by persistence layer,
    // but imageMimeType persists in localStorage)
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store))
    console.log(
      `[backfill-images] Done. Updated ${totalUpdated} tweet(s), skipped ${totalSkipped}. Reload the page to see changes.`,
    )
  } else {
    console.log(
      `[backfill-images] Done. No tweets had images to fetch (${totalSkipped} checked).`,
    )
  }
}

// Register on window for console access
;(window as unknown as Record<string, unknown>).backfillTweetImages =
  backfillTweetImages
