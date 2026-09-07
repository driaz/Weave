// Stage 2b of the reasoning layer: narrative synthesis (prompt narrative-v2).
// Reads a snapshot whose clusters carry theme_descriptions (stage 2a), the v2
// provenance (anchors, unclustered_attended, conversations, boards), and node
// content for the unclustered entries and conversation endpoints; renders the
// narrative-v2 user prompt; calls Claude once; writes `narrative` and a title.

import { createClient } from '@supabase/supabase-js'
import type { AnchorProvenance, BoardName, ClusterObj, Conversation, UnclusteredAttended } from '../lib/snapshot/types'
import { callClaude } from '../lib/stage2/claude'
import { STAGE2_MODEL, TITLE_MODEL } from '../lib/stage2/models.mjs'
import {
  NARRATIVE_MAX_TOKENS,
  NARRATIVE_SYSTEM_PROMPT_V2,
  PROMPT_VERSION_NARRATIVE,
  TITLE_MAX_LENGTH,
  TITLE_MAX_TOKENS,
  TITLE_PROMPT_TEMPLATE,
} from '../lib/stage2/prompts'
import { readNodeContent } from '../lib/stage2/reads'
import {
  admitUnclustered,
  renderNarrativePrompt,
  type ConversationInput,
  type NarrativeRenderInput,
  type ThreadInput,
  type UnclusteredInput,
} from '../lib/stage2/renderNarrative'

type StageOneMetadata = {
  anchors?: AnchorProvenance[]
  unclustered_attended?: UnclusteredAttended[]
  conversations?: Conversation[]
  boards?: BoardName[]
  node_set?: { keys?: string[]; count?: number }
  [k: string]: unknown
}

function timer(): () => number {
  const start = performance.now()
  return () => Math.round(performance.now() - start)
}

/** Everything the renderer needs, from the row's metadata plus a content map. */
export function buildNarrativeInput(
  clusters: ClusterObj[],
  themed: ClusterObj[],
  meta: Required<Pick<StageOneMetadata, 'anchors' | 'unclustered_attended' | 'conversations' | 'boards'>> & { node_set: { keys: string[]; count: number } },
  content: Map<string, import('../lib/stage2/content').NodeContent>,
): NarrativeRenderInput {
  const threads: ThreadInput[] = themed.map((c) => ({
    cluster_id: c.cluster_id,
    size: c.size,
    boardIds: c.boards_touched,
    theme: c.theme_description,
    anchors: meta.anchors.filter((a) => a.cluster_id === c.cluster_id).map((a) => ({ attention: a.attention, turns: a.turns })),
  }))
  const unclustered: UnclusteredInput[] = admitUnclustered(meta.unclustered_attended)
    .filter((u) => content.has(u.key))
    .map((u) => ({ content: content.get(u.key)!, w_total: u.w_total, mark: { attention: u.attention, turns: u.turns } }))
  const conversations: ConversationInput[] = meta.conversations.map((c) => ({
    user_turns: c.user_turns,
    endpoints: [content.get(c.endpoints[0]) ?? null, content.get(c.endpoints[1]) ?? null],
    endpointKeys: c.endpoints,
    placement: c.placement,
  }))
  const clusterSizes: Record<string, number> = {}
  for (const c of clusters) clusterSizes[c.cluster_id] = c.size
  const clusteredPieces = clusters.reduce((s, c) => s + c.size, 0)
  const boardCount = new Set(meta.node_set.keys.map((k) => k.slice(0, k.indexOf(':')))).size
  return {
    totalPieces: meta.node_set.count,
    boardCount,
    clusteredPieces,
    threadCount: clusters.length,
    singletonCount: meta.node_set.count - clusteredPieces,
    attendedSingletonCount: meta.unclustered_attended.length,
    threads,
    unclustered,
    conversations,
    clusterSizes,
    boards: meta.boards,
  }
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

    // Step 1: the row
    const { data: snapshot, error: snapErr } = await supabase
      .from('weave_profile_snapshots')
      .select('id, clusters, generation_metadata')
      .eq('id', snapshotId)
      .single()
    if (snapErr || !snapshot) return Response.json({ error: `Snapshot not found: ${snapshotId}` }, { status: 404 })

    const clusters = snapshot.clusters as ClusterObj[] | null
    if (!clusters || clusters.length === 0) return Response.json({ error: 'No themes to synthesize' }, { status: 400 })

    // The gate: narrative requires themes.
    const themed = clusters.filter((c) => c.theme_description && c.theme_description.trim().length > 0)
    if (themed.length === 0) return Response.json({ error: 'No themes to synthesize' }, { status: 400 })

    const meta = (snapshot.generation_metadata as StageOneMetadata | null) ?? {}
    if (
      !Array.isArray(meta.anchors) ||
      !Array.isArray(meta.unclustered_attended) ||
      !Array.isArray(meta.conversations) ||
      !Array.isArray(meta.boards) ||
      !Array.isArray(meta.node_set?.keys) ||
      typeof meta.node_set?.count !== 'number'
    ) {
      return Response.json(
        { error: 'Snapshot lacks v2 provenance (anchors, unclustered_attended, conversations, boards, node_set); regenerate it with the current stage 1' },
        { status: 400 },
      )
    }
    const v2 = {
      anchors: meta.anchors,
      unclustered_attended: meta.unclustered_attended,
      conversations: meta.conversations,
      boards: meta.boards,
      node_set: { keys: meta.node_set.keys, count: meta.node_set.count },
    }

    // Step 2: this function's first content read — unclustered entries that will render, and conversation endpoints
    const contentKeys = [
      ...new Set([
        ...admitUnclustered(v2.unclustered_attended).map((u) => u.key),
        ...v2.conversations.flatMap((c) => c.endpoints),
      ]),
    ]
    const content = await readNodeContent(supabase, contentKeys)

    // Step 3: render
    const userPrompt = renderNarrativePrompt(buildNarrativeInput(clusters, themed, v2, content.byKey))
    console.log(`[Narrative] ${themed.length} themes, ${contentKeys.length} content keys…`)

    // Step 4: call
    const tClaude = timer()
    const result = await callClaude(anthropicKey, NARRATIVE_SYSTEM_PROMPT_V2, userPrompt, { maxTokens: NARRATIVE_MAX_TOKENS })
    const claudeTiming = tClaude()
    if (result.text === null) {
      console.error(`[Narrative] Claude call failed: ${result.error}`)
      return Response.json({ error: `Narrative generation failed: ${result.error}` }, { status: 500 })
    }
    const narrative = result.text
    console.log(`[Narrative] Generated (${claudeTiming}ms, ${narrative.length} chars)`)

    // Step 4b: title (unchanged from v1; best-effort, never blocks the narrative write)
    let title: string | null = null
    try {
      const titleResult = await callClaude(anthropicKey, '', `${TITLE_PROMPT_TEMPLATE}${narrative}`, { model: TITLE_MODEL, maxTokens: TITLE_MAX_TOKENS })
      if (titleResult.text === null) {
        console.error(`[Narrative] phase=title_generation failed: ${titleResult.error}`)
      } else {
        const candidate = titleResult.text.trim()
        if (!candidate || candidate.length > TITLE_MAX_LENGTH) {
          console.error(`[Narrative] phase=title_validation rejected value=${JSON.stringify(candidate)}`)
        } else {
          title = candidate
        }
      }
    } catch (err) {
      console.error(`[Narrative] phase=title_generation threw: ${err instanceof Error ? err.message : String(err)}`)
    }

    // Step 5: write back
    const updatedMetadata: Record<string, unknown> = {
      ...meta,
      narrative_model: STAGE2_MODEL,
      prompt_version_narrative: PROMPT_VERSION_NARRATIVE,
      narrative_timing_ms: claudeTiming,
      narrative_input_themes: themed.length,
      narrative_content_read: { ...content.gates, missing_keys: content.missing },
      narrative_user_prompt: userPrompt,
    }
    if (title) updatedMetadata.title = title

    const { error: updateErr } = await supabase
      .from('weave_profile_snapshots')
      .update({ narrative, generation_metadata: updatedMetadata })
      .eq('id', snapshotId)
    if (updateErr) return Response.json({ error: `Failed to update snapshot: ${updateErr.message}` }, { status: 500 })

    return Response.json({ snapshot_id: snapshotId, prompt_version_narrative: PROMPT_VERSION_NARRATIVE, title, narrative })
  } catch (error) {
    console.error('[Narrative] Unexpected error:', error)
    const message = error instanceof Error ? error.message : 'Internal server error'
    return Response.json({ error: message }, { status: 500 })
  }
}

export const config = {
  path: '/api/generate-snapshot-narrative',
  timeoutSeconds: 120,
}
