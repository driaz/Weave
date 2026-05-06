// One-shot backfill for YouTube nodes that landed before
// description-on-ingest shipped. Idempotent — skips any node whose data
// blob already has `contentDescription`. Safe to re-run.
//
// Usage:
//   POST /.netlify/functions/backfill-youtube-descriptions
//     ?dry_run=true      → log what would be written, no writes
//     ?limit=50          → cap how many nodes to touch this run
//
// Reads service-role from env so RLS is bypassed for the table scan +
// jsonb merge UPDATE. Writes are a direct UPDATE on `nodes.data` rather
// than the patch_node_data RPC because that RPC keys on
// `data->>'_clientNodeId'`, which isn't always present on legacy rows
// and isn't necessary when we already have `nodes.id` in hand.

import { createClient } from '@supabase/supabase-js'
import { generateYouTubeDescription } from '../lib/youtubeDescription'

const RATE_LIMIT_MS = 500
const DEFAULT_LIMIT = 200

type NodeRow = {
  id: string
  board_id: string
  data: Record<string, unknown>
}

function getString(blob: Record<string, unknown>, key: string): string {
  const v = blob[key]
  return typeof v === 'string' ? v : ''
}

function pickTranscript(blob: Record<string, unknown>): string {
  const t = getString(blob, 'transcript')
  if (t.trim().length > 0) return t
  return getString(blob, 'youtubeTranscript')
}

function pickTonalContext(blob: Record<string, unknown>): string | null {
  const ma = blob['media_analysis']
  if (typeof ma === 'string' && ma.trim().length > 0) return ma
  if (ma && typeof ma === 'object') return JSON.stringify(ma)

  const tm = blob['tonal_metadata']
  if (typeof tm === 'string' && tm.trim().length > 0) return tm
  if (tm && typeof tm === 'object') return JSON.stringify(tm)

  return null
}

export default async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204 })
  }

  const anthropicKey = process.env.VITE_ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY
  const supabaseUrl = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!anthropicKey || !supabaseUrl || !supabaseServiceKey) {
    return Response.json(
      {
        error:
          'ANTHROPIC_API_KEY, SUPABASE_URL, and SUPABASE_SERVICE_ROLE_KEY must all be configured',
      },
      { status: 500 },
    )
  }

  const params = new URL(req.url).searchParams
  const dryRun = params.get('dry_run') === 'true' || params.get('dry_run') === '1'
  const limitParam = Number(params.get('limit'))
  const limit =
    Number.isFinite(limitParam) && limitParam > 0 ? Math.floor(limitParam) : DEFAULT_LIMIT

  const supabase = createClient(supabaseUrl, supabaseServiceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  // Pull candidate rows. We can't express "transcript OR youtubeTranscript
  // is non-null AND contentDescription is null" cleanly via the JS client's
  // `.or()` chain on jsonb path operators, so filter the bulk in SQL via
  // PostgREST's `not.is` on `data->>...` and finish the few residual
  // checks in JS. The contentDescription gate is the idempotency guard —
  // re-running this function never overwrites.
  const { data: rows, error } = await supabase
    .from('nodes')
    .select('id, board_id, data')
    .eq('card_type', 'link')
    .eq('link_type', 'youtube')
    .is('data->>contentDescription', null)
    .limit(limit)

  if (error) {
    return Response.json(
      { error: `Failed to query nodes: ${error.message}` },
      { status: 500 },
    )
  }

  const candidates = ((rows ?? []) as NodeRow[]).filter((row) => {
    const blob = row.data ?? {}
    if (typeof blob !== 'object') return false
    if (getString(blob, 'contentDescription').trim().length > 0) return false
    return pickTranscript(blob).trim().length > 0
  })

  console.log(
    `[backfill] found ${candidates.length} candidate YouTube nodes (dry_run=${dryRun}, limit=${limit})`,
  )

  let generated = 0
  let written = 0
  let failed = 0
  const results: Array<{
    node_id: string
    status: 'written' | 'dry_run' | 'failed' | 'skipped'
    description?: string
    error?: string
  }> = []

  for (let i = 0; i < candidates.length; i++) {
    const row = candidates[i]
    const blob = row.data
    const title = getString(blob, 'title').trim()
    const channel = getString(blob, 'authorName').trim() || null
    const transcript = pickTranscript(blob)
    const tonalContext = pickTonalContext(blob)

    if (!title) {
      results.push({ node_id: row.id, status: 'skipped', error: 'no title' })
      continue
    }

    const result = await generateYouTubeDescription(anthropicKey, {
      title,
      channel,
      transcript,
      tonalContext,
    })

    if (result.error || !result.description) {
      failed++
      console.warn(
        `[backfill] node ${row.id}: generation failed — ${result.error ?? 'empty'}`,
      )
      results.push({
        node_id: row.id,
        status: 'failed',
        error: result.error ?? 'empty',
      })
    } else {
      generated++
      const description = result.description
      console.log(
        `[backfill] Generated description for node ${row.id}: ${description.slice(0, 50)}...`,
      )

      if (dryRun) {
        results.push({ node_id: row.id, status: 'dry_run', description })
      } else {
        // Direct jsonb merge keeps every other key in `data` intact while
        // adding contentDescription. Equivalent to the `data || patch`
        // pattern in patch_node_data, but keyed on the actual UUID
        // nodes.id rather than the client_id stash.
        const nextData = { ...blob, contentDescription: description }
        const { error: updateErr } = await supabase
          .from('nodes')
          .update({ data: nextData })
          .eq('id', row.id)

        if (updateErr) {
          failed++
          console.warn(
            `[backfill] node ${row.id}: update failed — ${updateErr.message}`,
          )
          results.push({
            node_id: row.id,
            status: 'failed',
            error: `update: ${updateErr.message}`,
          })
        } else {
          written++
          results.push({ node_id: row.id, status: 'written', description })
        }
      }
    }

    if (i < candidates.length - 1) {
      await new Promise((r) => setTimeout(r, RATE_LIMIT_MS))
    }
  }

  return Response.json({
    dry_run: dryRun,
    examined: candidates.length,
    generated,
    written,
    failed,
    results,
  })
}

export const config = {
  path: '/.netlify/functions/backfill-youtube-descriptions',
  // Each Sonnet call ~1-2s plus 500ms rate-limit delay; default 200 nodes
  // could need 5-7 minutes. Bump well past the 10s default.
  timeoutSeconds: 600,
}
