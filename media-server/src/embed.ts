import { GoogleGenAI, type Part } from '@google/genai'
import { readFile } from 'node:fs/promises'
import { retryOn503 } from './retry.js'

const GEMINI_API_KEY = process.env.GEMINI_API_KEY
if (!GEMINI_API_KEY) throw new Error('GEMINI_API_KEY is required')

const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY })
const MODEL = 'gemini-embedding-2-preview'

export interface MultimodalEmbedInput {
  text: string
  // videoPath/audioPath are dead as of Issue #2 PR-1 — the pipeline sends
  // text only, since mixed media parts were measured as a retrieval
  // downgrade for text queries (docs/token-limit-and-multimodal-probe.md
  // §2.3/§4). Retained for the media-prep cleanup pass — do not remove in
  // that PR's absence.
  videoPath?: string
  audioPath?: string
}

/**
 * Build a single 3072-dim embedding. As of Issue #2 PR-1 every caller
 * passes text only; the inlineData branches below are unreferenced but
 * retained (see MultimodalEmbedInput).
 */
export async function embedMultimodal(input: MultimodalEmbedInput): Promise<number[]> {
  const parts: Part[] = []
  if (input.text) parts.push({ text: input.text })

  if (input.videoPath) {
    const data = (await readFile(input.videoPath)).toString('base64')
    parts.push({ inlineData: { mimeType: 'video/mp4', data } })
  }
  if (input.audioPath) {
    const data = (await readFile(input.audioPath)).toString('base64')
    parts.push({ inlineData: { mimeType: 'audio/opus', data } })
  }

  if (parts.length === 0) throw new Error('embedMultimodal: no parts to embed')

  const res = await retryOn503('embed', () =>
    ai.models.embedContent({
      model: MODEL,
      contents: { parts },
      config: { taskType: 'SEMANTIC_SIMILARITY' },
    }),
  )
  const vec = res.embeddings?.[0]?.values
  if (!vec) throw new Error('embedMultimodal: no embedding returned')
  return vec
}
