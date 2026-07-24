import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { downloadVideo } from './download.js'
import { probeDuration, extractAudio } from './extract.js'
import { fetchTranscript } from './transcript.js'
import { analyzeMedia } from './analyze.js'
import { embedMultimodal } from './embed.js'
import { patchNodeData, upsertEmbedding, fetchNodeBlob, composeEmbedText, EMBED_TEXT_MAX_CHARS } from './supabase.js'
import { cleanup } from './cleanup.js'
import { createNodeLogger, type NodeLogger } from './logger.js'

export interface ProcessMediaOptions {
  nodeId: string
  boardId: string
  url: string
  nodeType: 'youtube' | 'twitter'
  userId: string
}

// Dead as of Issue #2 PR-1 (embeds are text-only; nothing trims for the
// embed anymore). Retained with trimVideo/the 120s comments for the
// media-prep cleanup pass — do not remove in this PR.
const EMBEDDING_TRIM_SECONDS = 120
void EMBEDDING_TRIM_SECONDS
// Still live — but only to pick the media_analysis input tier (full video
// vs full audio). No longer affects the embed payload.
const LONG_FORM_THRESHOLD_SECONDS = 600

/**
 * Full pipeline. Two analysis tiers based on ffprobe duration:
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
 */
export async function processMedia(opts: ProcessMediaOptions): Promise<void> {
  const logger = createNodeLogger(opts.nodeId, opts.boardId, opts.userId)
  const startedAt = Date.now()
  const workDir = await mkdtemp(join(tmpdir(), `weave-media-${opts.nodeId}-`))

  let tier: 'short' | 'long' | 'unknown' = 'unknown'
  let transcriptOk = false
  let analysisOk = false
  let analysisLen = 0
  let embedOk = false
  let embedDims = 0
  let durationSeconds = 0
  let patchOk = false
  let upsertOk = false

  logger.debug('media.pipeline.start', 'success', { url: opts.url, nodeType: opts.nodeType })

  try {
    const downloadStart = Date.now()
    const videoPath = await downloadVideo(opts.url, workDir)
    logger.debug('media.download', 'success', { workDir }, Date.now() - downloadStart)

    const probeStart = Date.now()
    durationSeconds = await probeDuration(videoPath)
    logger.debug('media.probe', 'success', { durationSeconds }, Date.now() - probeStart)

    const isLongForm = durationSeconds > LONG_FORM_THRESHOLD_SECONDS
    tier = isLongForm ? 'long' : 'short'
    logger.debug('media.tier', 'success', { tier, durationSeconds })

    const transcriptStart = Date.now()
    // Uncapped — the budget is enforced at composition (EMBED_TEXT_MAX_CHARS,
    // transcript-tail-only), not by a blind slice.
    const transcriptPromise = fetchTranscript(opts.url).then((t) => {
      transcriptOk = t.length > 0
      logger.debug(
        'media.transcript',
        transcriptOk ? 'success' : 'degraded',
        { len: t.length },
        Date.now() - transcriptStart,
      )
      return t
    })

    const mediaAnalysis = isLongForm
      ? await runLongFormAnalysis(videoPath, workDir, logger)
      : await runShortFormAnalysis(videoPath, logger)

    analysisOk = mediaAnalysis.length > 0
    analysisLen = mediaAnalysis.length

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

    // Compose text-only embed input from the node's JSONB (client-written
    // fields) + this run's transcript and analysis. The node blob is read
    // AFTER the media_analysis patch so the composition and the blob agree.
    const transcript = await transcriptPromise
    const blob = await fetchNodeBlob({
      nodeId: opts.nodeId,
      boardId: opts.boardId,
      userId: opts.userId,
    })
    const composed = composeEmbedText({
      nodeType: opts.nodeType,
      blob,
      fallbackUrl: opts.url,
      transcript,
      mediaAnalysis,
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
      hasVideo: !isLongForm,
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
      { tier, transcriptOk, analysisOk, analysisLen, embedOk, embedDims, durationSeconds, patchOk, upsertOk },
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
        error: err instanceof Error ? err.message : String(err),
      },
      Date.now() - startedAt,
    )
    throw err
  } finally {
    await cleanup(workDir)
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
