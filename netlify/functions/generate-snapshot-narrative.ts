// Step 4 of the reasoning layer pipeline: narrative synthesis.
// Reads a snapshot whose clusters have theme_descriptions populated
// (from extract-snapshot-themes), calls Claude once to synthesize the
// themes into a cohesive reflective narrative, and writes the result
// to the snapshot's `narrative` field.

import { createClient } from '@supabase/supabase-js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CLAUDE_MODEL = 'claude-opus-4-6'
const CLAUDE_API_URL = 'https://api.anthropic.com/v1/messages'
const CLAUDE_MAX_TOKENS = 2048

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

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ClusterObj = {
  cluster_id: string
  member_node_ids: string[]
  anchor_node_ids: string[]
  theme_description: string
  engagement_weight: number
  size: number
  boards_touched: string[]
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function timer(): () => number {
  const start = performance.now()
  return () => Math.round(performance.now() - start)
}

async function callClaude(
  apiKey: string,
  systemPrompt: string,
  userPrompt: string,
): Promise<{ text: string; error: null } | { text: null; error: string }> {
  try {
    const response = await fetch(CLAUDE_API_URL, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: CLAUDE_MODEL,
        max_tokens: CLAUDE_MAX_TOKENS,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
      }),
    })

    if (!response.ok) {
      const body = await response.text()
      return { text: null, error: `HTTP ${response.status}: ${body.slice(0, 200)}` }
    }

    const data = await response.json()
    const text = data?.content?.[0]?.text
    if (!text) {
      return { text: null, error: `Unexpected response shape: ${JSON.stringify(data).slice(0, 200)}` }
    }

    return { text: text.trim(), error: null }
  } catch (err) {
    return { text: null, error: `Fetch error: ${err instanceof Error ? err.message : String(err)}` }
  }
}

function buildUserPrompt(clustersWithThemes: ClusterObj[]): string {
  const totalPieces = clustersWithThemes.reduce((sum, c) => sum + c.size, 0)
  const totalClusters = clustersWithThemes.length

  const lines: string[] = []
  lines.push(
    `Thematic observations from a curated canvas (${totalPieces} pieces across ${totalClusters} threads):`,
  )
  lines.push('')

  for (const cluster of clustersWithThemes) {
    const boardsTouched = cluster.boards_touched.length
    const weight = cluster.engagement_weight.toFixed(2)
    lines.push(
      `Thread (${cluster.size} pieces, ${boardsTouched} boards, engagement: ${weight}):`,
    )
    lines.push(cluster.theme_description)
    lines.push('')
  }

  lines.push('---')
  lines.push('')
  lines.push('What do these threads reveal together?')

  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export default async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204 })
  }

  if (req.method !== 'POST') {
    return Response.json({ error: 'Method not allowed' }, { status: 405 })
  }

  const anthropicKey = process.env.ANTHROPIC_API_KEY
  if (!anthropicKey) {
    return Response.json(
      { error: 'ANTHROPIC_API_KEY not configured' },
      { status: 500 },
    )
  }

  const supabaseUrl = process.env.SUPABASE_URL
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!supabaseUrl || !supabaseKey) {
    return Response.json(
      { error: 'SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not configured' },
      { status: 500 },
    )
  }

  const supabase = createClient(supabaseUrl, supabaseKey)

  try {
    // Parse request body
    let snapshotId: string | null = null
    try {
      const body = await req.json()
      snapshotId = body.snapshot_id ?? null
    } catch {
      // invalid JSON
    }

    if (!snapshotId) {
      return Response.json({ error: 'snapshot_id is required' }, { status: 400 })
    }

    // ------------------------------------------------------------------
    // Step 1: Fetch snapshot
    // ------------------------------------------------------------------
    const { data: snapshot, error: snapErr } = await supabase
      .from('weave_profile_snapshots')
      .select('id, clusters, generation_metadata')
      .eq('id', snapshotId)
      .single()

    if (snapErr || !snapshot) {
      return Response.json({ error: `Snapshot not found: ${snapshotId}` }, { status: 404 })
    }

    const clusters = snapshot.clusters as ClusterObj[] | null
    if (!clusters || clusters.length === 0) {
      return Response.json(
        { error: 'No themes to synthesize' },
        { status: 400 },
      )
    }

    // Only clusters with non-empty theme_description contribute. Sorted
    // by size descending so the largest threads appear first in the
    // prompt — the model treats input order as a structural cue.
    const clustersWithThemes = clusters
      .filter((c) => c.theme_description && c.theme_description.trim().length > 0)
      .sort((a, b) => b.size - a.size)

    if (clustersWithThemes.length === 0) {
      return Response.json(
        { error: 'No themes to synthesize' },
        { status: 400 },
      )
    }

    // ------------------------------------------------------------------
    // Step 2–4: Build prompt and call Claude
    // ------------------------------------------------------------------
    const userPrompt = buildUserPrompt(clustersWithThemes)

    console.log(
      `[Narrative] Synthesizing ${clustersWithThemes.length} themes into narrative...`,
    )

    const tClaude = timer()
    const result = await callClaude(anthropicKey, SYSTEM_PROMPT, userPrompt)
    const claudeTiming = tClaude()

    if (result.error) {
      console.error(`[Narrative] Claude call failed: ${result.error}`)
      return Response.json(
        { error: `Narrative generation failed: ${result.error}` },
        { status: 500 },
      )
    }

    const narrative = result.text
    console.log(
      `[Narrative] Generated (${claudeTiming}ms, ${narrative.length} chars)`,
    )

    // ------------------------------------------------------------------
    // Step 5: Update snapshot row
    // ------------------------------------------------------------------
    const existingMetadata =
      (snapshot.generation_metadata as Record<string, unknown>) ?? {}
    const updatedMetadata = {
      ...existingMetadata,
      narrative_model: CLAUDE_MODEL,
      narrative_timing_ms: claudeTiming,
      narrative_input_themes: clustersWithThemes.length,
    }

    const { error: updateErr } = await supabase
      .from('weave_profile_snapshots')
      .update({
        narrative,
        generation_metadata: updatedMetadata,
      })
      .eq('id', snapshotId)

    if (updateErr) {
      return Response.json(
        { error: `Failed to update snapshot: ${updateErr.message}` },
        { status: 500 },
      )
    }

    // ------------------------------------------------------------------
    // Step 6: Return result
    // ------------------------------------------------------------------
    return Response.json({
      snapshot_id: snapshotId,
      narrative,
    })
  } catch (error) {
    console.error('[Narrative] Unexpected error:', error)
    return Response.json(
      { error: 'Internal server error' },
      { status: 500 },
    )
  }
}

export const config = {
  path: '/api/generate-snapshot-narrative',
  timeoutSeconds: 120,
}
