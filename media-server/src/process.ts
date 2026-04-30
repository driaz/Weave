import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { downloadVideo } from './download.js'
import { probeDuration, trimVideo, extractAudio } from './extract.js'
import { fetchTranscript } from './transcript.js'
import { analyzeMedia } from './analyze.js'
import { embedMultimodal } from './embed.js'
import { patchNodeData, upsertEmbedding } from './supabase.js'
import { cleanup } from './cleanup.js'
import { createNodeLogger, type NodeLogger } from './logger.js'

export interface ProcessMediaOptions {
  nodeId: string
  boardId: string
  url: string
  nodeType: 'youtube' | 'twitter'
  userId: string
}

const TRANSCRIPT_CHAR_LIMIT = 3000
const EMBEDDING_TRIM_SECONDS = 120
const LONG_FORM_THRESHOLD_SECONDS = 600

/**
 * Full pipeline. Two tiers based on ffprobe duration:
 *
 *   Under 10 min: full video+audio → analyze; trimmed video + 2 min audio
 *                 + transcript + media_analysis → embed.
 *   Over  10 min: full audio → analyze; 2 min audio + transcript
 *                 + media_analysis → embed (no video).
 *
 * Long-form is almost always a talking head — paying $5+ to send 30 min of
 * video buys no signal the audio doesn't already carry. Revisit if a content
 * type appears where the visuals matter past the 10-min mark.
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
    const transcriptPromise = fetchTranscript(opts.url).then((t) => {
      const trimmed = t.slice(0, TRANSCRIPT_CHAR_LIMIT)
      transcriptOk = trimmed.length > 0
      logger.debug(
        'media.transcript',
        transcriptOk ? 'success' : 'degraded',
        { len: trimmed.length },
        Date.now() - transcriptStart,
      )
      return trimmed
    })

    const { mediaAnalysis, embedding } = isLongForm
      ? await runLongFormTier(videoPath, workDir, transcriptPromise, logger)
      : await runShortFormTier(videoPath, workDir, transcriptPromise, logger)

    analysisOk = mediaAnalysis.length > 0
    analysisLen = mediaAnalysis.length
    embedOk = embedding.length > 0
    embedDims = embedding.length

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

    // upsertEmbedding builds content_summary from the node's title (looked
    // up via _clientNodeId) plus the media analysis. transcriptPromise has
    // already been consumed inside the tier helpers for the embedding
    // payload — no second await needed here.
    const upsertStart = Date.now()
    await upsertEmbedding({
      boardId: opts.boardId,
      nodeId: opts.nodeId,
      userId: opts.userId,
      nodeType: opts.nodeType,
      fallbackUrl: opts.url,
      mediaAnalysis,
      embedding,
      hasVideo: !isLongForm,
      durationSeconds,
    })
    upsertOk = true
    logger.debug('media.upsert', 'success', { embedDims }, Date.now() - upsertStart)

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

async function runShortFormTier(
  videoPath: string,
  workDir: string,
  transcriptPromise: Promise<string>,
  logger: NodeLogger,
): Promise<{ mediaAnalysis: string; embedding: number[] }> {
  // Analysis sees the full source video (which carries its own audio track).
  // Embedding sees a 2-min trimmed clip + a 2-min standalone audio track —
  // the embedding model caps video at 120s and benefits from the audio side
  // being explicit rather than embedded in the mp4 container.
  const analyzeStart = Date.now()
  const [trimmedVideo, trimmedAudio, mediaAnalysis] = await Promise.all([
    trimVideo(videoPath, workDir, EMBEDDING_TRIM_SECONDS),
    extractAudio(videoPath, workDir, EMBEDDING_TRIM_SECONDS),
    analyzeMedia({ videoPath }),
  ])
  logger.debug(
    'media.analyze',
    mediaAnalysis ? 'success' : 'degraded',
    { tier: 'short', analysisLen: mediaAnalysis.length },
    Date.now() - analyzeStart,
  )

  const transcript = await transcriptPromise
  const text = [transcript, mediaAnalysis].filter(Boolean).join('\n\n')

  const embedStart = Date.now()
  const embedding = await embedMultimodal({
    text,
    videoPath: trimmedVideo,
    audioPath: trimmedAudio,
  })
  logger.debug('media.embed', 'success', { tier: 'short', dims: embedding.length, textLen: text.length }, Date.now() - embedStart)

  return { mediaAnalysis, embedding }
}

async function runLongFormTier(
  videoPath: string,
  workDir: string,
  transcriptPromise: Promise<string>,
  logger: NodeLogger,
): Promise<{ mediaAnalysis: string; embedding: number[] }> {
  // No video sent anywhere. Analysis gets the full audio; embedding gets the
  // first 2 min of audio plus transcript + analysis text.
  const [fullAudio, trimmedAudio] = await Promise.all([
    extractAudio(videoPath, workDir),
    extractAudio(videoPath, workDir, EMBEDDING_TRIM_SECONDS),
  ])

  const analyzeStart = Date.now()
  const mediaAnalysis = await analyzeMedia({ audioPath: fullAudio })
  logger.debug(
    'media.analyze',
    mediaAnalysis ? 'success' : 'degraded',
    { tier: 'long', analysisLen: mediaAnalysis.length },
    Date.now() - analyzeStart,
  )

  const transcript = await transcriptPromise
  const text = [transcript, mediaAnalysis].filter(Boolean).join('\n\n')

  const embedStart = Date.now()
  const embedding = await embedMultimodal({
    text,
    audioPath: trimmedAudio,
  })
  logger.debug('media.embed', 'success', { tier: 'long', dims: embedding.length, textLen: text.length }, Date.now() - embedStart)

  return { mediaAnalysis, embedding }
}
