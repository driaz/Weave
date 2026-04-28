import { GoogleGenAI, type Part } from '@google/genai'
import { readFile } from 'node:fs/promises'

const GEMINI_API_KEY = process.env.GEMINI_API_KEY
if (!GEMINI_API_KEY) throw new Error('GEMINI_API_KEY is required')

const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY })
const MODEL = 'gemini-embedding-2-preview'

export interface MultimodalEmbedInput {
  text: string
  videoPath?: string
  audioPath?: string
}

/**
 * Build a single 3072-dim multimodal embedding from text + optional video
 * and audio files. Mirrors the client-side text-only call in
 * src/services/embeddingService.ts but adds inlineData parts for media.
 *
 * Tier-aware payloads (set by process.ts):
 *  - Under 10 min: text + trimmed video + trimmed audio
 *  - Over  10 min: text + trimmed audio (no video)
 *
 * The model's multimodal acceptance was confirmed via
 * scripts/probe-embedding-multimodal.mjs in the main repo.
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

  const res = await ai.models.embedContent({
    model: MODEL,
    contents: { parts },
    config: { taskType: 'SEMANTIC_SIMILARITY' },
  })
  const vec = res.embeddings?.[0]?.values
  if (!vec) throw new Error('embedMultimodal: no embedding returned')
  return vec
}
