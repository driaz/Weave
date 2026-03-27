import type { WeaveBoardsStore } from '../types/board'
import { fetchLinkMetadata } from './linkUtils'

const STORAGE_KEY = 'weave-boards'
const DELAY_MS = 750

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function backfillTweetEmbeds(): Promise<void> {
  const raw = localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    console.log('[backfill] No board data found in localStorage.')
    return
  }

  const store: WeaveBoardsStore = JSON.parse(raw)
  let totalUpdated = 0

  for (const [boardId, board] of Object.entries(store.boards)) {
    const tweetNodes = board.nodes.filter(
      (n) =>
        n.type === 'linkCard' &&
        n.data.type === 'twitter' &&
        !n.data.embedHtml,
    )

    if (tweetNodes.length === 0) continue
    console.log(
      `[backfill] Board "${board.name}" (${boardId}): ${tweetNodes.length} tweet(s) need embedHtml`,
    )

    for (const node of tweetNodes) {
      const url = node.data.url as string
      console.log(`[backfill]   Fetching embedHtml for ${url}...`)

      try {
        const metadata = await fetchLinkMetadata(url)
        if (metadata.embedHtml) {
          node.data.embedHtml = metadata.embedHtml
          totalUpdated++
          console.log(`[backfill]   ✓ Got embedHtml (${metadata.embedHtml.length} chars)`)
        } else {
          console.log(`[backfill]   ✗ No embedHtml returned (oEmbed may have failed)`)
        }
      } catch (err) {
        console.warn(`[backfill]   ✗ Failed to fetch metadata:`, err)
      }

      await delay(DELAY_MS)
    }
  }

  if (totalUpdated > 0) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store))
    console.log(
      `[backfill] Done. Updated ${totalUpdated} tweet(s). Reload the page to see changes.`,
    )
  } else {
    console.log('[backfill] Done. No tweets needed updating.')
  }
}

// Register on window for console access
;(window as unknown as Record<string, unknown>).backfillTweetEmbeds =
  backfillTweetEmbeds
