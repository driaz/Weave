// Stage 2a of the reasoning layer: theme extraction (prompt theme-v2).
// Reads a stage-1 snapshot (clusters + v2 provenance), reads node content for
// the members, renders one theme-v2 user prompt per cluster, calls Claude once
// per cluster, and writes the descriptions back to the snapshot row.

import { createClient } from '@supabase/supabase-js'
import type { AnchorProvenance, BoardName, ClusterObj } from '../lib/snapshot/types'
import { callClaude } from '../lib/stage2/claude'
import { STAGE2_MODEL } from '../lib/stage2/models.mjs'
import { PROMPT_VERSION_THEME, THEME_MAX_TOKENS, THEME_SYSTEM_PROMPT_V2 } from '../lib/stage2/prompts'
import { readNodeContent } from '../lib/stage2/reads'
import { renderThemePrompt, type ThemeMember } from '../lib/stage2/renderTheme'
import type { NodeContent } from '../lib/stage2/content'

type StageOneMetadata = {
  anchors?: AnchorProvenance[]
  boards?: BoardName[]
  [k: string]: unknown
}

/** A member with no live content row still renders, with the visual fallback line. */
function placeholderContent(key: string): NodeContent {
  return {
    key,
    boardId: key.slice(0, key.indexOf(':')),
    nodeType: 'unknown',
    cardType: null,
    linkType: null,
    title: null,
    authorName: null,
    authorHandle: null,
    tweetText: null,
    contentSummary: null,
  }
}

/** Anchors first (by w_total desc), then the remaining members in cluster order. */
export function orderMembers(
  cluster: ClusterObj,
  anchors: AnchorProvenance[],
  content: Map<string, NodeContent>,
): ThemeMember[] {
  const own = anchors.filter((a) => a.cluster_id === cluster.cluster_id).sort((a, b) => b.w_total - a.w_total)
  const anchored = new Set(own.map((a) => a.key))
  const members: ThemeMember[] = own.map((a) => ({
    content: content.get(a.key) ?? placeholderContent(a.key),
    anchor: { attention: a.attention, turns: a.turns },
  }))
  for (const key of cluster.member_node_ids) {
    if (anchored.has(key)) continue
    members.push({ content: content.get(key) ?? placeholderContent(key), anchor: null })
  }
  return members
}

function timer(): () => number {
  const start = performance.now()
  return () => Math.round(performance.now() - start)
}

export default async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204 })
  if (req.method !== 'POST') return Response.json({ error: 'Method not allowed' }, { status: 405 })

  const anthropicKey = process.env.ANTHROPIC_API_KEY
  if (!anthropicKey) return Response.json({ error: 'ANTHROPIC_API_KEY not configured' }, { status: 500 })

  const supabaseUrl = process.env.SUPABASE_URL
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!supabaseUrl || !supabaseKey) {
    return Response.json({ error: 'SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not configured' }, { status: 500 })
  }
  const supabase = createClient(supabaseUrl, supabaseKey)

  try {
    let snapshotId: string | null = null
    try {
      const body = await req.json()
      snapshotId = typeof body.snapshot_id === 'string' ? body.snapshot_id : null
    } catch {
      // invalid JSON
    }
    if (!snapshotId) return Response.json({ error: 'snapshot_id is required' }, { status: 400 })

    // Step 1: the stage-1 row
    const { data: snapshot, error: snapErr } = await supabase
      .from('weave_profile_snapshots')
      .select('id, clusters, generation_metadata')
      .eq('id', snapshotId)
      .single()
    if (snapErr || !snapshot) return Response.json({ error: `Snapshot not found: ${snapshotId}` }, { status: 404 })

    const clusters = snapshot.clusters as ClusterObj[] | null
    if (!clusters || clusters.length === 0) {
      return Response.json({ error: 'No clusters to extract themes from' }, { status: 400 })
    }
    const meta = (snapshot.generation_metadata as StageOneMetadata | null) ?? {}
    if (!Array.isArray(meta.anchors) || !Array.isArray(meta.boards)) {
      return Response.json(
        { error: 'Snapshot lacks v2 provenance (anchors, boards); regenerate it with the current stage 1' },
        { status: 400 },
      )
    }

    // Step 2: content for every member, gated
    const memberKeys = [...new Set(clusters.flatMap((c) => c.member_node_ids))]
    const content = await readNodeContent(supabase, memberKeys)

    // Steps 3-4: render and call, one cluster at a time
    const tTotal = timer()
    const perClusterTimings: number[] = []
    let themesExtracted = 0
    let themesFailed = 0
    const themeResults: { cluster_id: string; size: number; theme_description: string }[] = []
    const renderedPrompts: Record<string, string> = {}

    for (const cluster of clusters) {
      const tCluster = timer()
      const userPrompt = renderThemePrompt({ members: orderMembers(cluster, meta.anchors, content.byKey), boards: meta.boards })
      renderedPrompts[cluster.cluster_id] = userPrompt
      console.log(`[Themes] ${cluster.cluster_id} (${cluster.size} nodes)…`)

      const result = await callClaude(anthropicKey, THEME_SYSTEM_PROMPT_V2, userPrompt, { maxTokens: THEME_MAX_TOKENS })
      perClusterTimings.push(tCluster())

      if (result.text === null) {
        console.error(`[Themes] Failed for ${cluster.cluster_id}: ${result.error}`)
        themesFailed++
        themeResults.push({ cluster_id: cluster.cluster_id, size: cluster.size, theme_description: cluster.theme_description })
      } else {
        cluster.theme_description = result.text
        themesExtracted++
        themeResults.push({ cluster_id: cluster.cluster_id, size: cluster.size, theme_description: result.text })
      }
    }
    const totalTiming = tTotal()

    // Step 5: write back
    const updatedMetadata = {
      ...meta,
      theme_extraction_model: STAGE2_MODEL,
      prompt_version_theme: PROMPT_VERSION_THEME,
      theme_extraction_timing_ms: totalTiming,
      theme_extraction_per_cluster_ms: perClusterTimings,
      theme_extraction_errors: themesFailed,
      theme_content_read: { ...content.gates, missing_keys: content.missing },
      theme_user_prompts: renderedPrompts,
    }
    const { error: updateErr } = await supabase
      .from('weave_profile_snapshots')
      .update({ clusters, generation_metadata: updatedMetadata })
      .eq('id', snapshotId)
    if (updateErr) return Response.json({ error: `Failed to update snapshot: ${updateErr.message}` }, { status: 500 })

    return Response.json({
      snapshot_id: snapshotId,
      prompt_version_theme: PROMPT_VERSION_THEME,
      themes_extracted: themesExtracted,
      themes_failed: themesFailed,
      content_read: content.gates,
      themes: themeResults,
    })
  } catch (error) {
    console.error('[Themes] Unexpected error:', error)
    const message = error instanceof Error ? error.message : 'Internal server error'
    return Response.json({ error: message }, { status: 500 })
  }
}

export const config = {
  path: '/api/extract-snapshot-themes',
  // Sequential Claude calls, one per cluster, need more than the 30s default
  timeoutSeconds: 300,
}
