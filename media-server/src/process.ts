import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { downloadVideo } from './download.js'
import { probeDuration, extractAudio } from './extract.js'
import { fetchTranscript } from './transcript.js'
import { analyzeMedia } from './analyze.js'
import { embedMultimodal } from './embed.js'
import {
  patchNodeData,
  upsertEmbedding,
  fetchNodeBlob,
  buildUnionView,
  composeEmbedText,
  EMBED_TEXT_MAX_CHARS,
  fetchNodeImageSource,
  downloadMediaObject,
  type ClientNodeRef,
  type NodeImageSource,
} from './supabase.js'
import { hasAttachedPhoto, resolveImageMime } from './image.js'
import { shouldGenerateTweetDescription, fetchTweetDescription } from './description.js'
import { cleanup } from './cleanup.js'
import { createNodeLogger, type NodeLogger } from './logger.js'

export interface ProcessMediaOptions {
  nodeId: string
  boardId: string
  /** Unused for image cards ('' is fine): their bytes come from Storage. */
  url: string
  nodeType: 'youtube' | 'twitter' | 'image'
  userId: string
}

/**
 * Photo tweets (#17): the tweet image arrives from Microlink after the drop
 * and is uploaded on a later save, so it can lag the /process trigger.
 * The fallback re-reads nodes.image_url after each of these waits.
 */
export const TWEET_PHOTO_RETRY_DELAYS_MS = [5000, 5000, 5000]

// Dead as of Issue #2 PR-1 (embeds are text-only; nothing trims for the
// embed anymore). Retained with trimVideo/the 120s comments for the
// media-prep cleanup pass — do not remove in this PR.
const EMBEDDING_TRIM_SECONDS = 120
void EMBEDDING_TRIM_SECONDS
// Still live — but only to pick the media_analysis input tier (full video
// vs full audio). No longer affects the embed payload.
const LONG_FORM_THRESHOLD_SECONDS = 600

/**
 * Full pipeline. YouTube goes by URL: Gemini reads the public video itself
 * (first 15 min, youtubeUrl.ts) — no download, no ffprobe, no tiers, and so
 * no duration (duration_seconds is written as null). yt-dlp on Fly fails
 * YouTube's bot check, which left every YouTube card without analysis.
 *
 * Tweets download via yt-dlp and pick a tier on ffprobe duration:
 *
 *   Under 10 min: full video+audio → analyze.
 *   Over  10 min: full audio → analyze.
 *
 * Long-form is almost always a talking head — paying $5+ to send 30 min of
 * video buys no signal the audio doesn't already carry. Revisit if a content
 * type appears where the visuals matter past the 10-min mark.
 *
 * The embed is TEXT-ONLY as of Issue #2 PR-1: mixed media parts were
 * measured as a retrieval downgrade for text queries
 * (docs/token-limit-and-multimodal-probe.md §2.3/§4). Composition mirrors
 * the client recipes; the transcript is uncapped up to the shared
 * EMBED_TEXT_MAX_CHARS budget. This server write must not depend on the
 * client still having the board open — it patches media_analysis and
 * re-embeds on its own.
 *
 * Images (#17) are analysed once here too, from the bytes in Storage
 * (nodes.image_url), never from the client:
 *
 *   Image cards (nodeType 'image'): always.
 *   Photo tweets: when yt-dlp finds no video AND the tweet text carries a
 *   pic.twitter.com / pic.x.com link — the gate that keeps avatars out.
 *
 * An empty image analysis stops before the embed: the client's pixel embed
 * is better than a label-only text one.
 */
export async function processMedia(opts: ProcessMediaOptions): Promise<void> {
  const logger = createNodeLogger(opts.nodeId, opts.boardId, opts.userId)
  const startedAt = Date.now()
  const workDir = await mkdtemp(join(tmpdir(), `weave-media-${opts.nodeId}-`))

  let tier: 'short' | 'long' | 'url' | 'image' | 'tweet-photo' | 'unknown' = 'unknown'
  let transcriptOk = false
  let analysisOk = false
  let analysisLen = 0
  let embedOk = false
  let embedDims = 0
  let durationSeconds: number | null = null
  let patchOk = false
  let upsertOk = false
  let descriptionOk = false
  let descriptionStep = 'not-reached'

  logger.debug('media.pipeline.start', 'success', { url: opts.url, nodeType: opts.nodeType })

  const ref: ClientNodeRef = { nodeId: opts.nodeId, boardId: opts.boardId, userId: opts.userId }

  try {
    const transcriptStart = Date.now()
    // Uncapped — the budget is enforced at composition (EMBED_TEXT_MAX_CHARS,
    // transcript-tail-only), not by a blind slice.
    const transcriptPromise = (
      opts.nodeType === 'image' ? Promise.resolve('') : fetchTranscript(opts.url)
    ).then((t) => {
      transcriptOk = t.length > 0
      logger.debug(
        'media.transcript',
        transcriptOk ? 'success' : 'degraded',
        { len: t.length },
        Date.now() - transcriptStart,
      )
      return t
    })

    let mediaAnalysis = ''
    if (opts.nodeType === 'youtube') {
      tier = 'url'
      mediaAnalysis = await runYouTubeUrlAnalysis(opts.url, logger)
    } else if (opts.nodeType === 'image') {
      tier = 'image'
      const source = await fetchNodeImageSource(ref)
      mediaAnalysis = await runImageAnalysis(source?.path ?? null, '', tier, logger)
    } else {
      const downloadStart = Date.now()
      let videoPath: string | null = null
      try {
        videoPath = await downloadVideo(opts.url, workDir)
      } catch (err) {
        // No video (or yt-dlp failed): an attached photo is the fallback.
        // Anything else keeps the old behaviour — the pipeline fails.
        const photo = await resolveTweetPhoto(ref, logger)
        if (!photo) throw err
        tier = 'tweet-photo'
        mediaAnalysis = await runImageAnalysis(photo.path, photo.tweetText, tier, logger)
      }

      if (videoPath) {
        logger.debug('media.download', 'success', { workDir }, Date.now() - downloadStart)

        const probeStart = Date.now()
        const probed = await probeDuration(videoPath)
        durationSeconds = probed
        logger.debug('media.probe', 'success', { durationSeconds }, Date.now() - probeStart)

        tier = probed > LONG_FORM_THRESHOLD_SECONDS ? 'long' : 'short'
        logger.debug('media.tier', 'success', { tier, durationSeconds })

        mediaAnalysis = tier === 'long'
          ? await runLongFormAnalysis(videoPath, workDir, logger)
          : await runShortFormAnalysis(videoPath, logger)
      }
    }

    analysisOk = mediaAnalysis.length > 0
    analysisLen = mediaAnalysis.length
    const isImageTier = tier === 'image' || tier === 'tweet-photo'

    if (isImageTier && !mediaAnalysis) {
      await transcriptPromise
      await logger.persist(
        'media.pipeline',
        'degraded',
        { tier, analysisOk, embedOk, reason: 'empty-image-analysis' },
        Date.now() - startedAt,
      )
      return
    }

    if (mediaAnalysis) {
      const patchStart = Date.now()
      await patchNodeData({
        nodeId: opts.nodeId,
        boardId: opts.boardId,
        userId: opts.userId,
        patch: { media_analysis: mediaAnalysis },
      })
      patchOk = true
      logger.debug('media.patch', 'success', { analysisLen }, Date.now() - patchStart)
    } else {
      logger.debug('media.patch', 'skipped', { reason: 'empty-analysis' })
    }

    // Union view (Fix B): per recipe field, this run's own artifact if
    // present, else the stored JSONB value — never own-fetch-only when the
    // store holds more. The node blob is read AFTER the media_analysis
    // patch so the composition and the blob agree.
    const transcript = await transcriptPromise
    const blob = await fetchNodeBlob({
      nodeId: opts.nodeId,
      boardId: opts.boardId,
      userId: opts.userId,
    })
    let view = buildUnionView(blob, { transcript, mediaAnalysis })

    // Description step (Fix C): the client-side gate ran at transcript
    // arrival, but analysis always lands later (this pipeline ~30-90s vs
    // ~22s for the client fetch), so the fusion arm can only ever fire
    // here. Re-evaluate against the union; generate via the existing
    // Netlify function; a missing description degrades the embed, never
    // fails the pipeline.
    if (opts.nodeType === 'image') {
      descriptionStep = 'skipped-image'
    } else if (opts.nodeType !== 'twitter') {
      descriptionStep = 'skipped-youtube'
    } else if (!mediaAnalysis) {
      descriptionStep = 'skipped-no-analysis'
    } else if (view.contentDescription) {
      descriptionStep = 'skipped-already-present'
    } else if (!shouldGenerateTweetDescription(view)) {
      // Unreachable while analysis is non-empty (the fusion arm passes),
      // kept so the gate rule stays spelled out in one place.
      descriptionStep = 'skipped-gate'
    } else {
      const description = await fetchTweetDescription(view, logger)
      if (description) {
        descriptionOk = true
        descriptionStep = 'generated'
        view = { ...view, contentDescription: description }
        try {
          await patchNodeData({
            nodeId: opts.nodeId,
            boardId: opts.boardId,
            userId: opts.userId,
            patch: { contentDescription: description },
          })
        } catch (err) {
          // Composition still carries the description; only the JSONB copy
          // is missing. Warn, don't fail.
          logger.warn('media.description.patch', 'failed', {
            error: err instanceof Error ? err.message : String(err),
          })
        }
      } else {
        descriptionStep = 'failed'
      }
    }

    const composed = composeEmbedText({
      nodeType: opts.nodeType,
      view,
      fallbackUrl: opts.url,
    })

    // Budget tripwire: overflow past EMBED_TEXT_MAX_CHARS is otherwise
    // perfectly silent at the API — this persisted event is the only trace.
    if (composed.truncatedFromChars !== null) {
      await logger.persist('embed.budget', 'degraded', {
        composedChars: composed.truncatedFromChars,
        cap: EMBED_TEXT_MAX_CHARS,
        droppedChars: composed.truncatedFromChars - composed.text.length,
        trigger: 'media_patch',
      })
    }

    const embedStart = Date.now()
    const embedding = await embedMultimodal({ text: composed.text })
    embedOk = embedding.length > 0
    embedDims = embedding.length
    logger.debug('media.embed', 'success', { dims: embedding.length, textLen: composed.text.length }, Date.now() - embedStart)

    const upsertStart = Date.now()
    const { embedGeneration } = await upsertEmbedding({
      boardId: opts.boardId,
      nodeId: opts.nodeId,
      userId: opts.userId,
      composed,
      embedding,
      nodeType: opts.nodeType === 'image' ? 'imageCard' : 'linkCard',
      hasVideo: tier !== 'long' && !isImageTier,
      durationSeconds,
    })
    upsertOk = true
    logger.debug('media.upsert', 'success', { embedDims }, Date.now() - upsertStart)

    await logger.persist(
      'embed.server',
      'success',
      {
        trigger: 'media_patch',
        embedGeneration,
        embeddingDims: embedding.length,
        embedTextChars: composed.text.length,
        hadTranscript: composed.hadTranscript,
        hadDescription: composed.hadDescription,
        hadAnalysis: composed.hadAnalysis,
      },
      Date.now() - embedStart,
    )

    const outcome = analysisOk && embedOk ? 'success' : 'degraded'
    await logger.persist(
      'media.pipeline',
      outcome,
      { tier, transcriptOk, analysisOk, analysisLen, embedOk, embedDims, durationSeconds, patchOk, upsertOk, descriptionOk, descriptionStep },
      Date.now() - startedAt,
    )
  } catch (err) {
    await logger.persist(
      'media.pipeline',
      'failed',
      {
        tier,
        transcriptOk,
        analysisOk,
        analysisLen,
        embedOk,
        embedDims,
        durationSeconds,
        patchOk,
        upsertOk,
        descriptionOk,
        descriptionStep,
        error: err instanceof Error ? err.message : String(err),
      },
      Date.now() - startedAt,
    )
    throw err
  } finally {
    await cleanup(workDir)
  }
}

async function runYouTubeUrlAnalysis(
  url: string,
  logger: NodeLogger,
): Promise<string> {
  const analyzeStart = Date.now()
  const mediaAnalysis = await analyzeMedia({ youtubeUrl: url })
  logger.debug(
    'media.analyze',
    mediaAnalysis ? 'success' : 'degraded',
    { tier: 'url', analysisLen: mediaAnalysis.length },
    Date.now() - analyzeStart,
  )
  return mediaAnalysis
}

/**
 * Photo-tweet gate + wait. Null (no fallback) when the tweet text has no
 * photo link, or the image never lands within TWEET_PHOTO_RETRY_DELAYS_MS.
 */
async function resolveTweetPhoto(
  ref: ClientNodeRef,
  logger: NodeLogger,
): Promise<{ path: string; tweetText: string } | null> {
  let source: NodeImageSource | null = await fetchNodeImageSource(ref)
  if (!source || !hasAttachedPhoto(source.tweetText)) {
    logger.debug('media.photo', 'skipped', { reason: source ? 'no-photo-link' : 'no-row' })
    return null
  }
  for (const delay of TWEET_PHOTO_RETRY_DELAYS_MS) {
    if (source?.path) break
    await new Promise((resolve) => setTimeout(resolve, delay))
    source = await fetchNodeImageSource(ref)
  }
  if (!source?.path) {
    logger.debug('media.photo', 'skipped', { reason: 'no-image-uploaded' })
    return null
  }
  return { path: source.path, tweetText: source.tweetText }
}

/** Download from Storage and analyse. '' on any miss — never throws. */
async function runImageAnalysis(
  path: string | null,
  caption: string,
  tier: 'image' | 'tweet-photo',
  logger: NodeLogger,
): Promise<string> {
  if (!path) {
    logger.debug('media.analyze', 'skipped', { tier, reason: 'no-image-path' })
    return ''
  }
  const analyzeStart = Date.now()
  try {
    const object = await downloadMediaObject(path)
    const mimeType = resolveImageMime(object.mimeType, path)
    if (!mimeType) {
      logger.debug('media.analyze', 'skipped', { tier, reason: 'unsupported-mime', reported: object.mimeType })
      return ''
    }
    const mediaAnalysis = await analyzeMedia({ image: { data: object.data, mimeType }, caption })
    logger.debug(
      'media.analyze',
      mediaAnalysis ? 'success' : 'degraded',
      { tier, analysisLen: mediaAnalysis.length, bytes: object.data.length },
      Date.now() - analyzeStart,
    )
    return mediaAnalysis
  } catch (err) {
    logger.warn('media.analyze', 'failed', {
      tier,
      error: err instanceof Error ? err.message : String(err),
    })
    return ''
  }
}

async function runShortFormAnalysis(
  videoPath: string,
  logger: NodeLogger,
): Promise<string> {
  // Analysis sees the full source video (which carries its own audio track).
  const analyzeStart = Date.now()
  const mediaAnalysis = await analyzeMedia({ videoPath })
  logger.debug(
    'media.analyze',
    mediaAnalysis ? 'success' : 'degraded',
    { tier: 'short', analysisLen: mediaAnalysis.length },
    Date.now() - analyzeStart,
  )
  return mediaAnalysis
}

async function runLongFormAnalysis(
  videoPath: string,
  workDir: string,
  logger: NodeLogger,
): Promise<string> {
  // No video sent anywhere past the 10-min mark — analysis gets full audio.
  const fullAudio = await extractAudio(videoPath, workDir)

  const analyzeStart = Date.now()
  const mediaAnalysis = await analyzeMedia({ audioPath: fullAudio })
  logger.debug(
    'media.analyze',
    mediaAnalysis ? 'success' : 'degraded',
    { tier: 'long', analysisLen: mediaAnalysis.length },
    Date.now() - analyzeStart,
  )
  return mediaAnalysis
}
