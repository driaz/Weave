// Direct narrative generation — bypasses Netlify dev's 30s timeout.
// Runs the same logic as generate-snapshot-narrative.ts but as a standalone script.

import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'fs'

// Load .env
const envText = readFileSync('.env', 'utf8')
const env = {}
for (const line of envText.split('\n')) {
  const match = line.match(/^([A-Z_]+)=(.+)$/)
  if (match) env[match[1]] = match[2]
}

const SUPABASE_URL = env.SUPABASE_URL
const SUPABASE_KEY = env.SUPABASE_SERVICE_ROLE_KEY
const ANTHROPIC_KEY = env.ANTHROPIC_API_KEY || env.VITE_ANTHROPIC_API_KEY

if (!SUPABASE_URL || !SUPABASE_KEY || !ANTHROPIC_KEY) {
  console.error('Missing env vars'); process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)

const CLAUDE_MODEL = 'claude-opus-4-6'

const SYSTEM_PROMPT = `You are looking at a set of thematic observations about one person's curated content — tweets, videos, images, articles they've collected on a spatial canvas over time. Each observation describes a structural thread found across a cluster of related pieces. Your job is to synthesize these observations into a short reflective narrative about the person behind the curation.

Write 3-5 paragraphs.

Rules:

This is not a summary of the themes. Do not walk through them one by one. The person can already read the individual themes — they are looking at them on the same page. Your job is to find what the themes reveal together that no single theme says on its own.

Look for tensions between themes. A person who curates content about vulnerability-as-strength AND content about intelligence-as-armor is holding two contradictory postures simultaneously. That contradiction is more interesting than either theme alone. Name it.

Look for recurring moves across themes. If three different clusters all share a structure where someone who understands something is worse off for understanding it, that repetition across different subject matter is a signal. The person is drawn to that move regardless of context.

Do not psychoanalyze. Do not diagnose. Do not presume to know why the person curates what they curate. Describe what you observe in the curation patterns — the postures, the tensions, the recurring figures — and let the person draw their own conclusions. The tone should be that of a perceptive friend who noticed something, not a therapist interpreting symptoms.

Do not use the word "you" — write about "the curation" or "the collection" or "the curator" in third person. This creates the slight distance that makes self-reflection possible rather than self-conscious. The person is looking at a portrait, not being addressed directly.

Weight larger clusters and higher-engagement clusters more heavily in the narrative. A thread that spans 8 pieces across 4 boards is more structurally significant than a pair. But do not ignore the pairs — sometimes the smallest cluster contains the sharpest observation.

Do not open with "This collection..." or any throat-clearing. Start with the most striking observation and build from there.

Respond with ONLY the narrative paragraphs. No titles, no headers, no labels. Just the prose.`

async function callClaude(userPrompt) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 2048,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userPrompt }],
    }),
  })
  if (!res.ok) {
    const body = await res.text()
    return { text: null, error: `HTTP ${res.status}: ${body.slice(0, 200)}` }
  }
  const data = await res.json()
  const text = data?.content?.[0]?.text
  if (!text) return { text: null, error: `Bad response: ${JSON.stringify(data).slice(0, 200)}` }
  return { text: text.trim(), error: null }
}

// Get snapshot_id from arg or fetch latest
let snapshotId = process.argv[2]
if (!snapshotId) {
  const { data } = await supabase
    .from('weave_profile_snapshots')
    .select('id')
    .order('created_at', { ascending: false })
    .limit(1)
    .single()
  snapshotId = data?.id
}

console.log(`Snapshot: ${snapshotId}`)

const { data: snapshot } = await supabase
  .from('weave_profile_snapshots')
  .select('id, clusters, generation_metadata')
  .eq('id', snapshotId)
  .single()

const clusters = snapshot.clusters ?? []
const clustersWithThemes = clusters
  .filter((c) => c.theme_description && c.theme_description.trim().length > 0)
  .sort((a, b) => b.size - a.size)

if (clustersWithThemes.length === 0) {
  console.error('No themes to synthesize'); process.exit(1)
}

const totalPieces = clustersWithThemes.reduce((sum, c) => sum + c.size, 0)
const lines = [
  `Thematic observations from a curated canvas (${totalPieces} pieces across ${clustersWithThemes.length} threads):`,
  '',
]
for (const cluster of clustersWithThemes) {
  lines.push(
    `Thread (${cluster.size} pieces, ${cluster.boards_touched.length} boards, engagement: ${cluster.engagement_weight.toFixed(2)}):`,
  )
  lines.push(cluster.theme_description)
  lines.push('')
}
lines.push('---', '', 'What do these threads reveal together?')

const userPrompt = lines.join('\n')

console.log(`Synthesizing ${clustersWithThemes.length} themes...`)
const tStart = performance.now()
const result = await callClaude(userPrompt)
const elapsed = Math.round(performance.now() - tStart)

if (result.error) {
  console.error(`FAILED (${elapsed}ms): ${result.error}`)
  process.exit(1)
}

const narrative = result.text
console.log(`OK (${elapsed}ms, ${narrative.length} chars)\n`)
console.log('--- NARRATIVE ---\n')
console.log(narrative)
console.log('\n--- END NARRATIVE ---\n')

const existingMeta = snapshot.generation_metadata ?? {}
const { error: updateErr } = await supabase
  .from('weave_profile_snapshots')
  .update({
    narrative,
    generation_metadata: {
      ...existingMeta,
      narrative_model: CLAUDE_MODEL,
      narrative_timing_ms: elapsed,
      narrative_input_themes: clustersWithThemes.length,
    },
  })
  .eq('id', snapshotId)

if (updateErr) console.error('Update failed:', updateErr)
else console.log(`Snapshot ${snapshotId} updated.`)
