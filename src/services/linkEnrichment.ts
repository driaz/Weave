import { embedNodeAsync } from './embeddingService'
import { fetchTweetImage, extractYouTubeUrlFromText, type LinkMetadata } from '../utils/linkUtils'
import { fetchTranscript } from '../utils/transcriptUtils'
import { supabase } from './supabaseClient'
import type { NodeLogger } from '../utils/logger'

const WEAVE_MEDIA_URL = import.meta.env.VITE_WEAVE_MEDIA_URL as string | undefined

/**
 * Description-generation gate for tweets (Issue #2 Change 5). Generate
 * when media_analysis is present (fusion — it also covers the
 * transcript-absent case) or the transcript is long enough that the
 * description buys compression. Skip short-transcript-no-analysis: the
 * raw transcript already fits the embed and there is nothing to fuse.
 */
const TWEET_DESCRIPTION_TRANSCRIPT_MIN_CHARS = 1000

function shouldGenerateTweetDescription(transcript: string, mediaAnalysis: string): boolean {
  if (mediaAnalysis) return true
  return transcript.length > TWEET_DESCRIPTION_TRANSCRIPT_MIN_CHARS
}

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
 * async enrichments (tweet image, transcripts) and the embedding writes.
 * Every link type embeds immediately on drop with whatever fields exist;
 * content arrivals (transcript, generated description, tweet image) each
 * re-embed with the fuller composition. The old 8s wait lost the race on
 * 6 of 7 logged tweets that ever got a transcript
 * (docs/pre-composition-gate-reads.md §2) — arrival-driven re-embeds
 * replace it.
 *
 * A transcript arrival produces ONE re-embed: transcript → description
 * gate → maybe description → embed. Never two.
 *
 * For video-bearing nodes (YouTube + Twitter), also fire-and-forget the
 * Fly media-server pipeline. The server runs Gemini media analysis and
 * re-embeds with its own text-only composition ~30-90s later — its write
 * must not depend on this board still being open. Client embedding stays
 * as the fast fallback so a node always has *something* in the embedding
 * table even if Fly is down or the download fails.
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

    // Embed immediately on drop with whatever fields exist.
    embedNodeAsync(boardId, nodeId, 'linkCard', { ...metadata, loading: false }, logger, 'initial_drop')

    fetchTweetImage(url).then((tweetImage) => {
      if (tweetImage.imageBase64 && tweetImage.imageMimeType) {
        tweetImageLanded = true
        patchNodeData({
          imageBase64: tweetImage.imageBase64,
          imageMimeType: tweetImage.imageMimeType,
        })
        logger?.debug('enrich.tweet-image', 'success', { mimeType: tweetImage.imageMimeType })
        // Re-embed on image arrival: the drop embed no longer waits for this
        // fetch, and image tweets keep their inline image part in PR-1.
        const current = getCurrentNodeData()
        if (current) {
          embedNodeAsync(boardId, nodeId, 'linkCard', { ...current, loading: false }, logger, 'media_patch')
        }
      } else {
        logger?.debug('enrich.tweet-image', 'skipped', { reason: 'no-image' })
      }
    })

    const tweetYouTubeUrl = metadata.tweetText
      ? extractYouTubeUrlFromText(metadata.tweetText)
      : null
    const transcriptUrl = tweetYouTubeUrl || url
    transcriptField = tweetYouTubeUrl ? 'youtubeTranscript' : 'transcript'
    fetchTranscript(transcriptUrl).then(async (transcript) => {
      if (transcript) {
        transcriptLanded = true
        transcriptLen = transcript.length
        patchNodeData({ [transcriptField]: transcript })
        logger?.debug('enrich.transcript', 'success', { field: transcriptField, len: transcript.length })
      } else {
        logger?.debug('enrich.transcript', 'degraded', { field: transcriptField, reason: 'empty' })
      }

      // Description gate, then at most ONE re-embed for this arrival:
      // transcript → gate → maybe description → embed.
      const beforeDescription = getCurrentNodeData()
      const mediaAnalysis =
        typeof beforeDescription?.media_analysis === 'string'
          ? beforeDescription.media_analysis
          : ''
      let descriptionGenerated = false
      if (shouldGenerateTweetDescription(transcript, mediaAnalysis)) {
        const description = await fetchTweetDescription({
          authorName: metadata.authorName ?? '',
          authorHandle: metadata.authorHandle ?? null,
          tweetText: metadata.tweetText ?? '',
          transcript: transcript || null,
          mediaAnalysis: mediaAnalysis || null,
        })
        if (description) {
          descriptionGenerated = true
          patchNodeData({ contentDescription: description })
          logger?.debug('enrich.description', 'success', { len: description.length })
        } else {
          logger?.debug('enrich.description', 'degraded', { reason: 'empty-or-failed' })
        }
      }

      const elapsed = Date.now() - startedAt
      const outcome = transcriptLanded || tweetImageLanded ? 'success' : 'degraded'
      logger?.persist('enrich.complete', outcome, {
        kind: 'twitter',
        hasTranscript: transcriptLanded,
        transcriptLen,
        transcriptField,
        hasTweetImage: tweetImageLanded,
        mediaTriggered,
        descriptionGenerated,
      }, elapsed)

      // Nothing arrived on this channel → the drop embed stands.
      if (!transcriptLanded && !descriptionGenerated) return
      const current = getCurrentNodeData()
      if (current) {
        embedNodeAsync(
          boardId,
          nodeId,
          'linkCard',
          { ...current, loading: false },
          logger,
          descriptionGenerated ? 'description_generated' : 'transcript_arrival',
        )
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

    return
  }

  if (metadata.type === 'youtube') {
    logger?.debug('enrich.youtube.start', 'success', { url })

    // Embed immediately on drop with whatever fields exist.
    embedNodeAsync(boardId, nodeId, 'linkCard', { ...metadata, loading: false }, logger, 'initial_drop')

    fetchTranscript(url).then(async (transcript) => {
      if (!transcript) {
        logger?.debug('enrich.transcript', 'degraded', { field: 'transcript', reason: 'empty' })
        const elapsed = Date.now() - startedAt
        logger?.persist('enrich.complete', mediaTriggered ? 'success' : 'degraded', {
          kind: 'youtube',
          hasTranscript: false,
          transcriptLen: 0,
          hasTweetImage: false,
          mediaTriggered,
          descriptionGenerated: false,
        }, elapsed)
        return
      }
      patchNodeData({ transcript })
      logger?.debug('enrich.transcript', 'success', { field: 'transcript', len: transcript.length })

      // Generate the voice-pipeline content description, then ONE re-embed
      // for this arrival: transcript → description → embed. Best-effort: a
      // description failure downgrades the trigger, never blocks the embed.
      // media_analysis from the Fly pipeline typically hasn't landed yet at
      // ingest time (it takes 30-90s), so tonal context is left null here —
      // the backfill picks it up for older nodes where it's already present.
      const description = await fetchContentDescription({
        title: metadata.title,
        channel: metadata.authorName ?? null,
        transcript,
      })
      let descriptionGenerated = false
      if (description) {
        descriptionGenerated = true
        patchNodeData({ contentDescription: description })
        logger?.debug('enrich.description', 'success', { len: description.length })
      } else {
        logger?.debug('enrich.description', 'degraded', { reason: 'empty-or-failed' })
      }

      const elapsed = Date.now() - startedAt
      logger?.persist('enrich.complete', 'success', {
        kind: 'youtube',
        hasTranscript: true,
        transcriptLen: transcript.length,
        hasTweetImage: false,
        mediaTriggered,
        descriptionGenerated,
      }, elapsed)

      const current = getCurrentNodeData()
      if (current) {
        embedNodeAsync(
          boardId,
          nodeId,
          'linkCard',
          { ...current, loading: false },
          logger,
          descriptionGenerated ? 'description_generated' : 'transcript_arrival',
        )
      }
    })

    const mediaTriggered = triggerMediaPipeline({ boardId, nodeId, url, nodeType: 'youtube', logger })

    return
  }

  // Generic link — nothing to enrich, embed immediately.
  logger?.persist(
    'enrich.complete',
    'success',
    { kind: 'generic', hasTranscript: false, transcriptLen: 0, hasTweetImage: false, mediaTriggered: false },
    Date.now() - startedAt,
  )
  embedNodeAsync(boardId, nodeId, 'linkCard', { ...metadata, loading: false }, logger, 'initial_drop')
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
 * Ask the Netlify generate-tweet-description function for a content
 * description of a video tweet (Issue #2 Change 5). Same never-throws
 * contract as fetchContentDescription: any failure returns empty string
 * and the caller continues.
 */
async function fetchTweetDescription(opts: {
  authorName: string
  authorHandle: string | null
  tweetText: string
  transcript: string | null
  mediaAnalysis: string | null
}): Promise<string> {
  if (!opts.transcript && !opts.mediaAnalysis) return ''

  let response: Response
  try {
    response = await fetch('/.netlify/functions/generate-tweet-description', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(opts),
    })
  } catch (err) {
    console.warn('[tweetDescription] network error:', err)
    return ''
  }

  if (!response.ok) {
    console.warn(`[tweetDescription] returned ${response.status} ${response.statusText}`)
    return ''
  }

  // Same SPA-fallback guard as fetchContentDescription — `vite` without
  // `netlify dev` will hand back index.html for the function path.
  const contentType = response.headers.get('content-type') ?? ''
  if (!contentType.includes('application/json')) {
    console.warn(
      `[tweetDescription] non-JSON response (content-type "${contentType}"); ` +
        'function probably not running. Try `netlify dev`.',
    )
    return ''
  }

  try {
    const data = (await response.json()) as { description?: string; error?: string }
    if (data.error) {
      console.warn(`[tweetDescription] returned error: ${data.error}`)
    }
    return data.description ?? ''
  } catch (err) {
    console.warn('[tweetDescription] failed to parse JSON:', err)
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
