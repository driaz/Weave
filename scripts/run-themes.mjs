// Direct theme extraction — bypasses Netlify dev's 30s timeout.
// Runs the same logic as extract-snapshot-themes.ts but as a standalone script.

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

const SYSTEM_PROMPT = `You are analyzing a cluster of content curated by one person onto a spatial canvas. Each piece was chosen because it resonated with them. Your job is to describe the thread that binds these pieces together.

Describe the thread in 2-4 sentences.

Rules:

Do not describe the topic. The person already knows what subjects they curate. "These explore mortality" or "these are about the startup ecosystem" is the answer they could give themselves. You are looking for the answer they could not.

Do not match the content's emotional register. If the content is poetic, do not be poetic. If it is cynical, do not be cynical. Use your own voice — precise, observational, specific. You are describing what you see from outside, not performing what the content performs.

Look for the structural pattern, not the subject. What do these pieces DO that is the same? Do they all present a character in the same position? Do they all make the same rhetorical move? Do they all locate meaning in the same unexpected place? Do they all handle knowledge the same way — as burden, as weapon, as consolation, as trap?

Be specific enough that someone could say "no, that is wrong." The description should be falsifiable. "These pieces share a concern with authenticity" is unfalsifiable mush. "Each of these presents someone performing expertise while privately suspecting they are fraudulent" is specific enough to be wrong, which means it is specific enough to be interesting.

The anchor nodes (marked with ★) are the pieces this person engages with most. They are probably closest to the center of what this cluster means. Weight them accordingly.

Respond with ONLY the 2-4 sentence description. No preamble, no labels, no "This cluster..." opening. Just the observation.`

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
      max_tokens: 1024,
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

const clusters = snapshot.clusters
console.log(`Clusters: ${clusters.length}\n`)

// Fetch content summaries
const allKeys = new Set()
for (const c of clusters) for (const k of c.member_node_ids) allKeys.add(k)
const boardIds = [...new Set([...allKeys].map(k => k.slice(0, k.indexOf(':'))))]
const { data: embRows } = await supabase
  .from('weave_embeddings')
  .select('board_id, node_id, node_type, content_summary')
  .in('board_id', boardIds)

const lookup = new Map()
for (const r of embRows) lookup.set(`${r.board_id}:${r.node_id}`, { nodeType: r.node_type, summary: r.content_summary })

const tStart = performance.now()
const perClusterMs = []
let extracted = 0, failed = 0
const results = []

for (const cluster of clusters) {
  const anchorSet = new Set(cluster.anchor_node_ids)
  const lines = [`Content in this cluster (${cluster.size} pieces across ${cluster.boards_touched.length} boards):`, '']
  for (const key of cluster.member_node_ids) {
    const entry = lookup.get(key)
    const prefix = anchorSet.has(key) ? '★ ' : ''
    const nodeType = entry?.nodeType ?? 'unknown'
    const summary = entry?.summary
    if (summary && summary.trim().length > 0) lines.push(`${prefix}[${nodeType}] ${summary}`)
    else lines.push(`${prefix}[${nodeType}] (visual content — no text description available)`)
  }
  lines.push('', '---', '', 'What thread binds these pieces?')

  const tCluster = performance.now()
  console.log(`[${cluster.cluster_id}] Extracting (${cluster.size} nodes)...`)
  const result = await callClaude(lines.join('\n'))
  const elapsed = Math.round(performance.now() - tCluster)
  perClusterMs.push(elapsed)

  if (result.error) {
    console.error(`  FAILED (${elapsed}ms): ${result.error}`)
    failed++
    results.push({ cluster_id: cluster.cluster_id, size: cluster.size, theme_description: '' })
  } else {
    cluster.theme_description = result.text
    extracted++
    results.push({ cluster_id: cluster.cluster_id, size: cluster.size, theme_description: result.text })
    console.log(`  OK (${elapsed}ms): ${result.text}\n`)
  }
}

const totalMs = Math.round(performance.now() - tStart)

// Update snapshot
const existingMeta = snapshot.generation_metadata ?? {}
const { error: updateErr } = await supabase
  .from('weave_profile_snapshots')
  .update({
    clusters,
    generation_metadata: {
      ...existingMeta,
      theme_extraction_model: CLAUDE_MODEL,
      theme_extraction_timing_ms: totalMs,
      theme_extraction_per_cluster_ms: perClusterMs,
      theme_extraction_errors: failed,
    },
  })
  .eq('id', snapshotId)

if (updateErr) console.error('Update failed:', updateErr)

console.log(JSON.stringify({ snapshot_id: snapshotId, themes_extracted: extracted, themes_failed: failed, themes: results }, null, 2))
