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
  const workDir = await mkdtemp(join(tmpdir(), `weave-media-${opts.nodeId}-`))

  try {
    const videoPath = await downloadVideo(opts.url, workDir)
    const durationSeconds = await probeDuration(videoPath)
    const isLongForm = durationSeconds > LONG_FORM_THRESHOLD_SECONDS

    const transcriptPromise = fetchTranscript(opts.url).then((t) =>
      t.slice(0, TRANSCRIPT_CHAR_LIMIT),
    )

    const { mediaAnalysis, embedding } = isLongForm
      ? await runLongFormTier(videoPath, workDir, transcriptPromise)
      : await runShortFormTier(videoPath, workDir, transcriptPromise)

    if (mediaAnalysis) {
      await patchNodeData({
        nodeId: opts.nodeId,
        boardId: opts.boardId,
        userId: opts.userId,
        patch: { media_analysis: mediaAnalysis },
      })
    }

    const transcript = await transcriptPromise
    const summary = [transcript, mediaAnalysis].filter(Boolean).join('\n\n').slice(0, 500)

    await upsertEmbedding({
      boardId: opts.boardId,
      nodeId: opts.nodeId,
      embedding,
      contentSummary: summary,
      hasVideo: !isLongForm,
      durationSeconds,
    })
  } finally {
    await cleanup(workDir)
  }
}

async function runShortFormTier(
  videoPath: string,
  workDir: string,
  transcriptPromise: Promise<string>,
): Promise<{ mediaAnalysis: string; embedding: number[] }> {
  // Analysis sees the full source video (which carries its own audio track).
  // Embedding sees a 2-min trimmed clip + a 2-min standalone audio track —
  // the embedding model caps video at 120s and benefits from the audio side
  // being explicit rather than embedded in the mp4 container.
  const [trimmedVideo, trimmedAudio, mediaAnalysis] = await Promise.all([
    trimVideo(videoPath, workDir, EMBEDDING_TRIM_SECONDS),
    extractAudio(videoPath, workDir, EMBEDDING_TRIM_SECONDS),
    analyzeMedia({ videoPath }),
  ])

  const transcript = await transcriptPromise
  const text = [transcript, mediaAnalysis].filter(Boolean).join('\n\n')

  const embedding = await embedMultimodal({
    text,
    videoPath: trimmedVideo,
    audioPath: trimmedAudio,
  })

  return { mediaAnalysis, embedding }
}

async function runLongFormTier(
  videoPath: string,
  workDir: string,
  transcriptPromise: Promise<string>,
): Promise<{ mediaAnalysis: string; embedding: number[] }> {
  // No video sent anywhere. Analysis gets the full audio; embedding gets the
  // first 2 min of audio plus transcript + analysis text.
  const [fullAudio, trimmedAudio] = await Promise.all([
    extractAudio(videoPath, workDir),
    extractAudio(videoPath, workDir, EMBEDDING_TRIM_SECONDS),
  ])

  const mediaAnalysis = await analyzeMedia({ audioPath: fullAudio })

  const transcript = await transcriptPromise
  const text = [transcript, mediaAnalysis].filter(Boolean).join('\n\n')

  const embedding = await embedMultimodal({
    text,
    audioPath: trimmedAudio,
  })

  return { mediaAnalysis, embedding }
}
