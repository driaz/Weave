import { embedNodeAsync } from './embeddingService'
import { fetchTweetImage, extractYouTubeUrlFromText, type LinkMetadata } from '../utils/linkUtils'
import { fetchTranscript } from '../utils/transcriptUtils'
import { supabase } from './supabaseClient'

const ENRICHMENT_EMBED_DELAY_MS = 8000
const WEAVE_MEDIA_URL = import.meta.env.VITE_WEAVE_MEDIA_URL as string | undefined

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
 * For video-bearing nodes (YouTube + Twitter), also fire-and-forget the
 * Fly media-server pipeline. The server downloads the video, runs Gemini
 * media analysis, and overwrites the client's text-only embedding with a
 * richer multimodal one ~30-90s later. Client embedding stays as the fast
 * fallback so a node always has *something* in the embedding table even
 * if Fly is down or the download fails.
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

    // Embedded YouTube → send the YouTube URL directly (guaranteed-downloadable
    // by yt-dlp). Otherwise send the tweet URL — yt-dlp's Twitter extractor
    // grabs native video; on text-only tweets it fast-fails server-side. We
    // accept those wasted invocations rather than building a separate
    // client-side video-detection path.
    triggerMediaPipeline({
      boardId,
      nodeId,
      url: tweetYouTubeUrl ?? url,
      nodeType: tweetYouTubeUrl ? 'youtube' : 'twitter',
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

    triggerMediaPipeline({ boardId, nodeId, url, nodeType: 'youtube' })

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

/**
 * POST to the Fly media server to kick off the multimodal pipeline.
 * Best-effort: if the env var isn't set (local dev without the server,
 * preview deploys), no JWT is available, or the network call fails, we
 * silently skip — the client-side text embedding still lands at the 8s
 * mark and the node is functional.
 */
function triggerMediaPipeline(opts: {
  boardId: string
  nodeId: string
  url: string
  nodeType: 'youtube' | 'twitter'
}): void {
  if (!WEAVE_MEDIA_URL) return

  void (async () => {
    try {
      const { data } = await supabase.auth.getSession()
      const token = data.session?.access_token
      if (!token) return

      await fetch(`${WEAVE_MEDIA_URL.replace(/\/$/, '')}/process`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          node_id: opts.nodeId,
          board_id: opts.boardId,
          url: opts.url,
          node_type: opts.nodeType,
        }),
        keepalive: true,
      })
    } catch (err) {
      console.warn('[linkEnrichment] media pipeline trigger failed:', err)
    }
  })()
}
