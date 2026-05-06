import { embedNodeAsync } from './embeddingService'
import { fetchTweetImage, extractYouTubeUrlFromText, type LinkMetadata } from '../utils/linkUtils'
import { fetchTranscript } from '../utils/transcriptUtils'
import { supabase } from './supabaseClient'
import type { NodeLogger } from '../utils/logger'

const ENRICHMENT_EMBED_DELAY_MS = 8000
const WEAVE_MEDIA_URL = import.meta.env.VITE_WEAVE_MEDIA_URL as string | undefined

export interface EnrichLinkNodeOptions {
  boardId: string
  nodeId: string
  url: string
  metadata: LinkMetadata
  patchNodeData: (patch: Record<string, unknown>) => void
  getCurrentNodeData: () => Record<string, unknown> | undefined
  logger?: NodeLogger
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
  const { boardId, nodeId, url, metadata, patchNodeData, getCurrentNodeData, logger } = opts
  const startedAt = Date.now()

  if (metadata.type === 'twitter') {
    let tweetImageLanded = false
    let transcriptLanded = false
    let transcriptLen = 0
    let transcriptField: 'transcript' | 'youtubeTranscript' = 'transcript'

    logger?.debug('enrich.twitter.start', 'success', { url })

    fetchTweetImage(url).then((tweetImage) => {
      if (tweetImage.imageBase64 && tweetImage.imageMimeType) {
        tweetImageLanded = true
        patchNodeData({
          imageBase64: tweetImage.imageBase64,
          imageMimeType: tweetImage.imageMimeType,
        })
        logger?.debug('enrich.tweet-image', 'success', { mimeType: tweetImage.imageMimeType })
      } else {
        logger?.debug('enrich.tweet-image', 'skipped', { reason: 'no-image' })
      }
    })

    const tweetYouTubeUrl = metadata.tweetText
      ? extractYouTubeUrlFromText(metadata.tweetText)
      : null
    const transcriptUrl = tweetYouTubeUrl || url
    transcriptField = tweetYouTubeUrl ? 'youtubeTranscript' : 'transcript'
    fetchTranscript(transcriptUrl).then((transcript) => {
      if (transcript) {
        transcriptLanded = true
        transcriptLen = transcript.length
        patchNodeData({ [transcriptField]: transcript })
        logger?.debug('enrich.transcript', 'success', { field: transcriptField, len: transcript.length })
      } else {
        logger?.debug('enrich.transcript', 'degraded', { field: transcriptField, reason: 'empty' })
      }
    })

    // Embedded YouTube → send the YouTube URL directly (guaranteed-downloadable
    // by yt-dlp). Otherwise send the tweet URL — yt-dlp's Twitter extractor
    // grabs native video; on text-only tweets it fast-fails server-side. We
    // accept those wasted invocations rather than building a separate
    // client-side video-detection path.
    const mediaTriggered = triggerMediaPipeline({
      boardId,
      nodeId,
      url: tweetYouTubeUrl ?? url,
      nodeType: tweetYouTubeUrl ? 'youtube' : 'twitter',
      logger,
    })

    setTimeout(() => {
      const current = getCurrentNodeData()
      const elapsed = Date.now() - startedAt
      const detail = {
        kind: 'twitter',
        hasTranscript: transcriptLanded,
        transcriptLen,
        transcriptField,
        hasTweetImage: tweetImageLanded,
        mediaTriggered,
      }
      const outcome = transcriptLanded || tweetImageLanded ? 'success' : 'degraded'
      logger?.persist('enrich.complete', outcome, detail, elapsed)
      if (current) {
        embedNodeAsync(boardId, nodeId, 'linkCard', { ...current, loading: false }, logger)
      }
    }, ENRICHMENT_EMBED_DELAY_MS)
    return
  }

  if (metadata.type === 'youtube') {
    let transcriptLanded = false
    let transcriptLen = 0

    logger?.debug('enrich.youtube.start', 'success', { url })

    fetchTranscript(url).then(async (transcript) => {
      if (!transcript) {
        logger?.debug('enrich.transcript', 'degraded', { field: 'transcript', reason: 'empty' })
        return
      }
      transcriptLanded = true
      transcriptLen = transcript.length
      patchNodeData({ transcript })
      logger?.debug('enrich.transcript', 'success', { field: 'transcript', len: transcript.length })

      // Generate the voice-pipeline content description. Best-effort: a
      // failure here doesn't block transcript persistence or the embed
      // that fires at the 8s mark. media_analysis from the Fly pipeline
      // typically hasn't landed yet at ingest time (it takes 30-90s),
      // so tonal context is left null here — the backfill picks it up
      // for older nodes where it's already present.
      const description = await fetchContentDescription({
        title: metadata.title,
        channel: metadata.authorName ?? null,
        transcript,
      })
      if (description) {
        patchNodeData({ contentDescription: description })
        logger?.debug('enrich.description', 'success', { len: description.length })
      } else {
        logger?.debug('enrich.description', 'degraded', { reason: 'empty-or-failed' })
      }
    })

    const mediaTriggered = triggerMediaPipeline({ boardId, nodeId, url, nodeType: 'youtube', logger })

    setTimeout(() => {
      const current = getCurrentNodeData()
      const elapsed = Date.now() - startedAt
      const detail = {
        kind: 'youtube',
        hasTranscript: transcriptLanded,
        transcriptLen,
        hasTweetImage: false,
        mediaTriggered,
      }
      const outcome = transcriptLanded || mediaTriggered ? 'success' : 'degraded'
      logger?.persist('enrich.complete', outcome, detail, elapsed)
      if (current) {
        embedNodeAsync(boardId, nodeId, 'linkCard', { ...current, loading: false }, logger)
      }
    }, ENRICHMENT_EMBED_DELAY_MS)
    return
  }

  // Generic link — nothing to enrich, embed immediately.
  logger?.persist(
    'enrich.complete',
    'success',
    { kind: 'generic', hasTranscript: false, transcriptLen: 0, hasTweetImage: false, mediaTriggered: false },
    Date.now() - startedAt,
  )
  embedNodeAsync(boardId, nodeId, 'linkCard', { ...metadata, loading: false }, logger)
}

/**
 * Ask the Netlify generate-content-description function for a 2-3
 * sentence summary of the YouTube video. Mirrors fetchTranscript's
 * never-throws contract: any failure (network, missing API key on the
 * server, Sonnet error) returns empty string and the caller continues.
 */
async function fetchContentDescription(opts: {
  title: string
  channel: string | null
  transcript: string
  tonalContext?: string | null
}): Promise<string> {
  if (!opts.title || !opts.transcript) return ''

  let response: Response
  try {
    response = await fetch('/.netlify/functions/generate-content-description', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(opts),
    })
  } catch (err) {
    console.warn('[contentDescription] network error:', err)
    return ''
  }

  if (!response.ok) {
    console.warn(
      `[contentDescription] returned ${response.status} ${response.statusText}`,
    )
    return ''
  }

  // Same SPA-fallback guard as fetchTranscript — `vite` without `netlify
  // dev` will hand back index.html for the function path and JSON.parse
  // explodes silently.
  const contentType = response.headers.get('content-type') ?? ''
  if (!contentType.includes('application/json')) {
    console.warn(
      `[contentDescription] non-JSON response (content-type "${contentType}"); ` +
        'function probably not running. Try `netlify dev`.',
    )
    return ''
  }

  try {
    const data = (await response.json()) as { description?: string; error?: string }
    if (data.error) {
      console.warn(`[contentDescription] returned error: ${data.error}`)
    }
    return data.description ?? ''
  } catch (err) {
    console.warn('[contentDescription] failed to parse JSON:', err)
    return ''
  }
}

/**
 * POST to the Fly media server to kick off the multimodal pipeline.
 * Best-effort: if the env var isn't set (local dev without the server,
 * preview deploys), no JWT is available, or the network call fails, we
 * silently skip — the client-side text embedding still lands at the 8s
 * mark and the node is functional.
 *
 * Returns true if a request was actually attempted (env + supabase + token
 * all available); false if we no-opped early. Network errors after the
 * fetch is sent still return true — the request was fired even if it
 * later failed.
 */
function triggerMediaPipeline(opts: {
  boardId: string
  nodeId: string
  url: string
  nodeType: 'youtube' | 'twitter'
  logger?: NodeLogger
}): boolean {
  if (!WEAVE_MEDIA_URL) {
    opts.logger?.debug('media.trigger', 'skipped', { reason: 'no-media-url' })
    return false
  }
  // supabaseClient.ts exports `SupabaseClient | null` — null when env vars
  // aren't configured. Without this guard the runtime throws a TypeError
  // (caught by the inner try, silently no-ops) AND Netlify's strict
  // typecheck refuses to build (TS18047).
  if (!supabase) {
    opts.logger?.debug('media.trigger', 'skipped', { reason: 'no-supabase-client' })
    return false
  }

  void (async () => {
    try {
      const { data } = await supabase!.auth.getSession()
      const token = data.session?.access_token
      if (!token) {
        opts.logger?.debug('media.trigger', 'skipped', { reason: 'no-token' })
        return
      }

      await fetch(`${WEAVE_MEDIA_URL!.replace(/\/$/, '')}/process`, {
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
      opts.logger?.debug('media.trigger', 'success', { nodeType: opts.nodeType })
    } catch (err) {
      opts.logger?.warn('media.trigger', 'failed', { error: String(err) })
    }
  })()
  return true
}
