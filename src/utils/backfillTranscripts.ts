import type { WeaveBoardsStore } from '../types/board'
import { fetchTranscript } from './transcriptUtils'
import { extractYouTubeUrlFromText } from './linkUtils'
import { embedNodeAsync } from '../services/embeddingService'

const STORAGE_KEY = 'weave-boards'
const DELAY_MS = 1000

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function backfillTranscripts(): Promise<void> {
  const raw = localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    console.log('[backfill-transcripts] No board data found in localStorage.')
    return
  }

  const store: WeaveBoardsStore = JSON.parse(raw)
  let totalUpdated = 0
  let totalSkipped = 0

  for (const [boardId, board] of Object.entries(store.boards)) {
    // Find YouTube linkCards missing transcripts
    const youtubeNodes = board.nodes.filter(
      (n) =>
        n.type === 'linkCard' &&
        n.data.type === 'youtube' &&
        !n.data.transcript,
    )

    // Find tweet linkCards missing transcript (native video)
    const tweetVideoNodes = board.nodes.filter(
      (n) =>
        n.type === 'linkCard' &&
        n.data.type === 'twitter' &&
        !n.data.transcript,
    )

    // Find tweet linkCards with YouTube URLs missing youtubeTranscript
    const tweetYouTubeNodes = board.nodes.filter(
      (n) =>
        n.type === 'linkCard' &&
        n.data.type === 'twitter' &&
        n.data.tweetText &&
        !n.data.youtubeTranscript &&
        extractYouTubeUrlFromText(n.data.tweetText as string),
    )

    const total = youtubeNodes.length + tweetVideoNodes.length + tweetYouTubeNodes.length
    if (total === 0) continue

    console.log(
      `[backfill-transcripts] Board "${board.name}" (${boardId}): ${youtubeNodes.length} YouTube + ${tweetVideoNodes.length} tweet video + ${tweetYouTubeNodes.length} tweet w/ YouTube need transcripts`,
    )

    for (const node of youtubeNodes) {
      const url = node.data.url as string
      console.log(`[backfill-transcripts]   Fetching transcript for ${url}...`)

      try {
        const transcript = await fetchTranscript(url)

        if (transcript) {
          node.data.transcript = transcript
          totalUpdated++

          embedNodeAsync(boardId, node.id, 'linkCard', { ...node.data })

          console.log(
            `[backfill-transcripts]   ✓ Got transcript (${transcript.length} chars)`,
          )
        } else {
          totalSkipped++
          console.log(`[backfill-transcripts]   ✗ No transcript available`)
        }
      } catch (err) {
        totalSkipped++
        console.warn(`[backfill-transcripts]   ✗ Failed:`, err)
      }

      await delay(DELAY_MS)
    }

    for (const node of tweetVideoNodes) {
      const url = node.data.url as string
      console.log(`[backfill-transcripts]   Fetching transcript for tweet ${url}...`)

      try {
        const transcript = await fetchTranscript(url)

        if (transcript) {
          node.data.transcript = transcript
          totalUpdated++

          embedNodeAsync(boardId, node.id, 'linkCard', { ...node.data })

          console.log(
            `[backfill-transcripts]   ✓ Got tweet video transcript (${transcript.length} chars)`,
          )
        } else {
          totalSkipped++
          console.log(`[backfill-transcripts]   ✗ No video transcript (tweet may not have video)`)
        }
      } catch (err) {
        totalSkipped++
        console.warn(`[backfill-transcripts]   ✗ Failed:`, err)
      }

      await delay(DELAY_MS)
    }

    for (const node of tweetYouTubeNodes) {
      const tweetText = node.data.tweetText as string
      const youtubeUrl = extractYouTubeUrlFromText(tweetText)!
      console.log(
        `[backfill-transcripts]   Fetching transcript for YouTube in tweet ${node.data.url}...`,
      )

      try {
        const transcript = await fetchTranscript(youtubeUrl)

        if (transcript) {
          node.data.youtubeTranscript = transcript
          totalUpdated++

          embedNodeAsync(boardId, node.id, 'linkCard', { ...node.data })

          console.log(
            `[backfill-transcripts]   ✓ Got transcript (${transcript.length} chars)`,
          )
        } else {
          totalSkipped++
          console.log(`[backfill-transcripts]   ✗ No transcript available`)
        }
      } catch (err) {
        totalSkipped++
        console.warn(`[backfill-transcripts]   ✗ Failed:`, err)
      }

      await delay(DELAY_MS)
    }
  }

  if (totalUpdated > 0) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store))
    console.log(
      `[backfill-transcripts] Done. Updated ${totalUpdated} node(s), skipped ${totalSkipped}. Reload the page to see changes.`,
    )
  } else {
    console.log(
      `[backfill-transcripts] Done. No transcripts fetched (${totalSkipped} checked).`,
    )
  }
}

// Register on window for console access
;(window as unknown as Record<string, unknown>).backfillTranscripts =
  backfillTranscripts
