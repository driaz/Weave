// Step 3 of the reasoning layer pipeline: theme extraction.
// Reads a snapshot with clusters (from generate-profile-snapshot),
// calls Claude once per cluster to generate a theme description,
// and writes the descriptions back to the snapshot row.

import { createClient } from '@supabase/supabase-js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CLAUDE_MODEL = 'claude-opus-4-6'
const CLAUDE_API_URL = 'https://api.anthropic.com/v1/messages'
const CLAUDE_MAX_TOKENS = 1024

const SYSTEM_PROMPT = `You are analyzing a cluster of content curated by one person onto a spatial canvas. Each piece was chosen because it resonated with them. Your job is to describe the thread that binds these pieces together.

Describe the thread in 2-4 sentences.

Rules:

Do not describe the topic. The person already knows what subjects they curate. "These explore mortality" or "these are about the startup ecosystem" is the answer they could give themselves. You are looking for the answer they could not.

Do not match the content's emotional register. If the content is poetic, do not be poetic. If it is cynical, do not be cynical. Use your own voice — precise, observational, specific. You are describing what you see from outside, not performing what the content performs.

Look for the structural pattern, not the subject. What do these pieces DO that is the same? Do they all present a character in the same position? Do they all make the same rhetorical move? Do they all locate meaning in the same unexpected place? Do they all handle knowledge the same way — as burden, as weapon, as consolation, as trap?

Be specific enough that someone could say "no, that is wrong." The description should be falsifiable. "These pieces share a concern with authenticity" is unfalsifiable mush. "Each of these presents someone performing expertise while privately suspecting they are fraudulent" is specific enough to be wrong, which means it is specific enough to be interesting.

The anchor nodes (marked with ★) are the pieces this person engages with most. They are probably closest to the center of what this cluster means. Weight them accordingly.

Respond with ONLY the 2-4 sentence description. No preamble, no labels, no "This cluster..." opening. Just the observation.`

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

type EmbeddingLookup = {
  board_id: string
  node_id: string
  node_type: string
  content_summary: string | null
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

function buildUserPrompt(
  cluster: ClusterObj,
  contentLookup: Map<string, { nodeType: string; summary: string | null }>,
): string {
  const anchorSet = new Set(cluster.anchor_node_ids)
  const lines: string[] = []

  lines.push(
    `Content in this cluster (${cluster.size} pieces across ${cluster.boards_touched.length} boards):`,
  )
  lines.push('')

  for (const key of cluster.member_node_ids) {
    const entry = contentLookup.get(key)
    const prefix = anchorSet.has(key) ? '★ ' : ''
    const nodeType = entry?.nodeType ?? 'unknown'
    const summary = entry?.summary

    if (summary && summary.trim().length > 0) {
      lines.push(`${prefix}[${nodeType}] ${summary}`)
    } else {
      lines.push(`${prefix}[${nodeType}] (visual content — no text description available)`)
    }
  }

  lines.push('')
  lines.push('---')
  lines.push('')
  lines.push('What thread binds these pieces?')

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
        { error: 'No clusters to extract themes from' },
        { status: 400 },
      )
    }

    // ------------------------------------------------------------------
    // Step 2: Fetch content summaries for all member nodes
    // ------------------------------------------------------------------
    const allMemberKeys = new Set<string>()
    for (const cluster of clusters) {
      for (const key of cluster.member_node_ids) {
        allMemberKeys.add(key)
      }
    }

    // Parse composite keys into board_id/node_id pairs for querying
    const keyPairs = [...allMemberKeys].map((key) => {
      const colonIdx = key.indexOf(':')
      return { boardId: key.slice(0, colonIdx), nodeId: key.slice(colonIdx + 1) }
    })

    // Fetch all embeddings for these nodes
    // Use board_id filter + select all, then filter client-side
    // (Supabase doesn't support OR of composite key pairs in a single query)
    const boardIds = [...new Set(keyPairs.map((p) => p.boardId))]
    const { data: embRows, error: embErr } = await supabase
      .from('weave_embeddings')
      .select('board_id, node_id, node_type, content_summary')
      .in('board_id', boardIds)

    if (embErr) {
      return Response.json(
        { error: `Failed to fetch embeddings: ${embErr.message}` },
        { status: 500 },
      )
    }

    // Build lookup map: "board_id:node_id" → { nodeType, summary }
    const contentLookup = new Map<string, { nodeType: string; summary: string | null }>()
    for (const row of (embRows ?? []) as EmbeddingLookup[]) {
      contentLookup.set(`${row.board_id}:${row.node_id}`, {
        nodeType: row.node_type,
        summary: row.content_summary,
      })
    }

    // ------------------------------------------------------------------
    // Step 3–4: Call Claude for each cluster
    // ------------------------------------------------------------------
    const tTotal = timer()
    const perClusterTimings: number[] = []
    let themesExtracted = 0
    let themesFailed = 0
    const themeResults: { cluster_id: string; size: number; theme_description: string }[] = []

    for (const cluster of clusters) {
      const tCluster = timer()
      const userPrompt = buildUserPrompt(cluster, contentLookup)

      console.log(`[Themes] Extracting theme for ${cluster.cluster_id} (${cluster.size} nodes)...`)

      const result = await callClaude(anthropicKey, SYSTEM_PROMPT, userPrompt)

      const clusterTiming = tCluster()
      perClusterTimings.push(clusterTiming)

      if (result.error) {
        console.error(`[Themes] Failed for ${cluster.cluster_id}: ${result.error}`)
        themesFailed++
        themeResults.push({
          cluster_id: cluster.cluster_id,
          size: cluster.size,
          theme_description: cluster.theme_description, // keep existing (empty string)
        })
      } else {
        cluster.theme_description = result.text
        themesExtracted++
        themeResults.push({
          cluster_id: cluster.cluster_id,
          size: cluster.size,
          theme_description: result.text,
        })
        console.log(`[Themes] ${cluster.cluster_id}: ${result.text.slice(0, 100)}...`)
      }
    }

    const totalTiming = tTotal()

    // ------------------------------------------------------------------
    // Step 5: Update snapshot row
    // ------------------------------------------------------------------
    const existingMetadata = (snapshot.generation_metadata as Record<string, unknown>) ?? {}
    const updatedMetadata = {
      ...existingMetadata,
      theme_extraction_model: CLAUDE_MODEL,
      theme_extraction_timing_ms: totalTiming,
      theme_extraction_per_cluster_ms: perClusterTimings,
      theme_extraction_errors: themesFailed,
    }

    const { error: updateErr } = await supabase
      .from('weave_profile_snapshots')
      .update({
        clusters: clusters,
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
    // Step 6: Return summary
    // ------------------------------------------------------------------
    return Response.json({
      snapshot_id: snapshotId,
      themes_extracted: themesExtracted,
      themes_failed: themesFailed,
      themes: themeResults,
    })
  } catch (error) {
    console.error('[Themes] Unexpected error:', error)
    return Response.json(
      { error: 'Internal server error' },
      { status: 500 },
    )
  }
}

export const config = {
  path: '/api/extract-snapshot-themes',
  // 17 sequential Claude calls need more than the 30s default
  timeoutSeconds: 300,
}
