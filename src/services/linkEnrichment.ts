import { embedNodeAsync } from './embeddingService'
import { fetchTweetImage, extractYouTubeUrlFromText, type LinkMetadata } from '../utils/linkUtils'
import { fetchTranscript } from '../utils/transcriptUtils'

const ENRICHMENT_EMBED_DELAY_MS = 8000

export interface EnrichLinkNodeOptions {
  boardId: string
  nodeId: string
  url: string
  metadata: LinkMetadata
  patchNodeData: (patch: Record<string, unknown>) => void
  getCurrentNodeData: () => Record<string, unknown> | undefined
}

/**
 * After a link node's metadata has rendered, kick off type-specific
 * async enrichments (tweet image, transcripts) and schedule the embedding
 * write. Twitter/YouTube embed after an 8s delay so async fetches have
 * a chance to land; other link types embed immediately.
 *
 * Fire-and-forget — never throws.
 */
export function enrichLinkNode(opts: EnrichLinkNodeOptions): void {
  const { boardId, nodeId, url, metadata, patchNodeData, getCurrentNodeData } = opts

  if (metadata.type === 'twitter') {
    fetchTweetImage(url).then((tweetImage) => {
      if (tweetImage.imageBase64 && tweetImage.imageMimeType) {
        patchNodeData({
          imageBase64: tweetImage.imageBase64,
          imageMimeType: tweetImage.imageMimeType,
        })
      }
    })

    const tweetYouTubeUrl = metadata.tweetText
      ? extractYouTubeUrlFromText(metadata.tweetText)
      : null
    const transcriptUrl = tweetYouTubeUrl || url
    fetchTranscript(transcriptUrl).then((transcript) => {
      if (transcript) {
        const field = tweetYouTubeUrl ? 'youtubeTranscript' : 'transcript'
        patchNodeData({ [field]: transcript })
      }
    })

    setTimeout(() => {
      const current = getCurrentNodeData()
      if (current) {
        embedNodeAsync(boardId, nodeId, 'linkCard', { ...current, loading: false })
      }
    }, ENRICHMENT_EMBED_DELAY_MS)
    return
  }

  if (metadata.type === 'youtube') {
    fetchTranscript(url).then((transcript) => {
      if (transcript) patchNodeData({ transcript })
    })

    setTimeout(() => {
      const current = getCurrentNodeData()
      if (current) {
        embedNodeAsync(boardId, nodeId, 'linkCard', { ...current, loading: false })
      }
    }, ENRICHMENT_EMBED_DELAY_MS)
    return
  }

  embedNodeAsync(boardId, nodeId, 'linkCard', { ...metadata, loading: false })
}
