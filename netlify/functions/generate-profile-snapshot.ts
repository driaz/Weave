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
import { ANCHOR_COUNT } from '../lib/snapshot/constants'
import { UnauthorizedError, verifyCaller } from '../lib/snapshot/auth'
import { generateSnapshot, type NodeSetSpec } from '../lib/snapshot/generate'
import { readEmbeddings, readEvents, readPinnedNodeSet, readVoiceSessions } from '../lib/snapshot/reads'

type RequestBody = {
  trigger_reason?: unknown
  anchor_count?: unknown
  /** Test-harness parameter: reuse the node set recorded on an earlier snapshot. */
  pin_node_set_from_snapshot_id?: unknown
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
    const anchorCount =
      typeof body.anchor_count === 'number' && Number.isInteger(body.anchor_count) && body.anchor_count > 0
        ? body.anchor_count
        : ANCHOR_COUNT

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
    const embeddings = await readEmbeddings(supabase)
    const fetchEmbeddingsTiming = tEmb()

    const tEvents = timer()
    const events = await readEvents(supabase, generatedAt)
    const fetchEventsTiming = tEvents()

    const tVoice = timer()
    const voice = await readVoiceSessions(supabase, generatedAt)
    const fetchVoiceTiming = tVoice()

    const tGenerate = timer()
    const out = generateSnapshot({
      generatedAt,
      anchorCount,
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
