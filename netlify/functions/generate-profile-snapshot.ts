// Snapshot pipeline, stage 1 (v2): read embeddings, events and voice sessions
// globally, attribute decayed engagement to nodes, cluster, insert one
// weave_profile_snapshots row carrying the caller's user_id.
//
// SCOPE ASSUMPTION: `weave_embeddings` is the canonical source of "nodes that
// exist" for this pipeline. A node with no embedding row is invisible here.
//
// The engagement layer is pure and lives in ../lib/snapshot; this file is the
// I/O shell: verify the caller, read (paged, count-gated), generate, insert.

import { createClient } from '@supabase/supabase-js'
import { DEFAULT_RUN_OPTIONS, type RunOptions } from '../lib/snapshot/constants'
import { UnauthorizedError, verifyCaller } from '../lib/snapshot/auth'
import { generateSnapshot, type NodeSetSpec } from '../lib/snapshot/generate'
import { readEmbeddings, readEvents, readPinnedNodeSet, readVoiceSessions } from '../lib/snapshot/reads'

type RequestBody = {
  /** Free text; R2 unweighted runs use 'r2_unweighted' so they stay distinguishable from t1. */
  trigger_reason?: unknown
  anchor_count?: unknown
  /** When true, w_rule = 1 for every rule (decay and horizons unchanged). */
  uniform_weights?: unknown
  /** Read page size; default READ_PAGE_SIZE. Small values walk pagination on purpose. */
  page_size?: unknown
  /** Test-harness parameter: reuse the node set recorded on an earlier snapshot. */
  pin_node_set_from_snapshot_id?: unknown
}

function positiveInteger(v: unknown): number | null {
  return typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : null
}

function timer(): () => number {
  const start = performance.now()
  return () => Math.round(performance.now() - start)
}

export default async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204 })
  }
  if (req.method !== 'POST') {
    return Response.json({ error: 'Method not allowed' }, { status: 405 })
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
    // The row must carry a verified caller; never insert with user_id null.
    let userId: string
    try {
      userId = await verifyCaller(req, supabase)
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        return Response.json({ error: err.message }, { status: 401 })
      }
      throw err
    }

    let body: RequestBody = {}
    try {
      body = (await req.json()) as RequestBody
    } catch {
      // Empty body is fine; defaults apply.
    }
    const triggerReason = typeof body.trigger_reason === 'string' ? body.trigger_reason : 'manual'
    if (body.anchor_count !== undefined && positiveInteger(body.anchor_count) === null) {
      return Response.json({ error: 'anchor_count must be a positive integer' }, { status: 400 })
    }
    if (body.page_size !== undefined && positiveInteger(body.page_size) === null) {
      return Response.json({ error: 'page_size must be a positive integer' }, { status: 400 })
    }
    if (body.uniform_weights !== undefined && typeof body.uniform_weights !== 'boolean') {
      return Response.json({ error: 'uniform_weights must be a boolean' }, { status: 400 })
    }
    const options: RunOptions = {
      anchorCount: positiveInteger(body.anchor_count) ?? DEFAULT_RUN_OPTIONS.anchorCount,
      uniformWeights: body.uniform_weights === true,
      pageSize: positiveInteger(body.page_size) ?? DEFAULT_RUN_OPTIONS.pageSize,
    }

    const generatedAt = new Date()

    let nodeSet: NodeSetSpec = { source: 'live' }
    if (body.pin_node_set_from_snapshot_id !== undefined) {
      if (typeof body.pin_node_set_from_snapshot_id !== 'string') {
        return Response.json({ error: 'pin_node_set_from_snapshot_id must be a snapshot id' }, { status: 400 })
      }
      const keys = await readPinnedNodeSet(supabase, body.pin_node_set_from_snapshot_id)
      nodeSet = { source: `pinned:${body.pin_node_set_from_snapshot_id}`, keys }
    }

    const tEmb = timer()
    const embeddings = await readEmbeddings(supabase, options.pageSize)
    const fetchEmbeddingsTiming = tEmb()

    const tEvents = timer()
    const events = await readEvents(supabase, generatedAt, options.pageSize)
    const fetchEventsTiming = tEvents()

    const tVoice = timer()
    const voice = await readVoiceSessions(supabase, generatedAt, options.pageSize)
    const fetchVoiceTiming = tVoice()

    const tGenerate = timer()
    const out = generateSnapshot({
      generatedAt,
      options,
      nodeSet,
      embeddingRows: embeddings.rows,
      embeddingsGate: embeddings.gate,
      events: events.rows,
      eventsGate: events.gate,
      eventsByType: events.by_type,
      breadthFrom: events.breadth_from,
      voiceSessions: voice.rows,
      voiceGate: voice.gate,
      depthFrom: voice.depth_from,
      voiceAnchors: voice.anchors,
    })
    const generateTiming = tGenerate()

    const snapshotRow = {
      user_id: userId,
      board_ids: out.boardIds,
      node_count: out.nodeCount,
      event_count: out.eventCount,
      clusters: out.clusters,
      bridges: null, // Filled by next pipeline step
      narrative: null, // Filled by later pipeline step
      trigger_reason: triggerReason,
      generation_metadata: {
        ...out.generationMetadata,
        timing_ms: {
          fetch_embeddings: fetchEmbeddingsTiming,
          fetch_events: fetchEventsTiming,
          fetch_voice: fetchVoiceTiming,
          generate: generateTiming,
        },
      },
    }

    const { data: inserted, error: insertErr } = await supabase
      .from('weave_profile_snapshots')
      .insert(snapshotRow)
      .select('id')
      .single()

    if (insertErr) {
      return Response.json({ error: `Failed to insert snapshot: ${insertErr.message}` }, { status: 500 })
    }

    return Response.json({
      snapshot_id: inserted.id,
      summary: out.summary,
      attribution: out.generationMetadata.attribution,
      events_read: out.generationMetadata.events_read,
    })
  } catch (error) {
    console.error('[Snapshot] Unexpected error:', error)
    const message = error instanceof Error ? error.message : 'Internal server error'
    return Response.json({ error: message }, { status: 500 })
  }
}

export const config = {
  path: '/api/generate-profile-snapshot',
}
