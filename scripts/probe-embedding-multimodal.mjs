// Probes whether gemini-embedding-2-preview accepts video and audio
// inlineData parts. Prints which mime types succeed and which fail,
// and the response shape for each case.
//
// Run with:  node --env-file=.env scripts/probe-embedding-multimodal.mjs
//
// Requires fixtures at /tmp/weave-probe/test.mp4 and /tmp/weave-probe/test.opus
// (generated via ffmpeg -f lavfi).

import { GoogleGenAI } from '@google/genai'
import { readFileSync } from 'node:fs'

const apiKey = process.env.VITE_GEMINI_API_KEY
if (!apiKey) {
  console.error('VITE_GEMINI_API_KEY not set in env')
  process.exit(1)
}

const ai = new GoogleGenAI({ apiKey })
const MODEL = 'gemini-embedding-2-preview'

function loadBase64(path) {
  return readFileSync(path).toString('base64')
}

async function probe(label, parts) {
  process.stdout.write(`\n[${label}] `)
  try {
    const res = await ai.models.embedContent({
      model: MODEL,
      contents: { parts },
      config: { taskType: 'SEMANTIC_SIMILARITY' },
    })
    const vec = res.embeddings?.[0]?.values
    if (vec) {
      console.log(`OK — ${vec.length}-dim vector`)
    } else {
      console.log('NO VECTOR returned, full response:', JSON.stringify(res, null, 2))
    }
  } catch (err) {
    console.log('FAILED')
    console.log('  message:', err?.message ?? String(err))
    if (err?.status) console.log('  status:', err.status)
    if (err?.error) console.log('  error:', JSON.stringify(err.error, null, 2))
  }
}

const videoB64 = loadBase64('/tmp/weave-probe/test.mp4')
const audioB64 = loadBase64('/tmp/weave-probe/test.opus')

console.log(`Model: ${MODEL}`)
console.log(`Video fixture: ${videoB64.length} base64 chars`)
console.log(`Audio fixture: ${audioB64.length} base64 chars`)

await probe('text-only baseline', [{ text: 'a test of the embedding model' }])

await probe('video/mp4 only', [
  { inlineData: { mimeType: 'video/mp4', data: videoB64 } },
])

await probe('video/mp4 + text', [
  { text: 'a 5-second test video' },
  { inlineData: { mimeType: 'video/mp4', data: videoB64 } },
])

await probe('audio/opus only', [
  { inlineData: { mimeType: 'audio/opus', data: audioB64 } },
])

await probe('audio/opus + text', [
  { text: 'a 5-second sine wave' },
  { inlineData: { mimeType: 'audio/opus', data: audioB64 } },
])

await probe('video + audio + text (full multimodal)', [
  { text: 'a test multimodal input' },
  { inlineData: { mimeType: 'video/mp4', data: videoB64 } },
  { inlineData: { mimeType: 'audio/opus', data: audioB64 } },
])
