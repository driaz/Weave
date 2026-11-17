// Seed the DEV test user's data so an opener exercises the same reads it does
// in prod: a profile snapshot with a prod-sized narrative, a stored edge
// embedding for every connection on the board (the opening query vector), and
// node embeddings for the node band. Vectors are random 3072-d: retrieval
// RANKING is meaningless, but payload sizes and round trips match prod.
//
// Deposits are NOT seeded: voice_session_deposits has no insert policy for
// `authenticated`, so the test user can't write them, and no service key goes
// in a cloud session. run.mjs --deposit-fixture stands in for them instead.
//
// Idempotent: skips anything already present. Dev only — refuses to run
// against the prod project ref.
//
//   node scripts/opener-timing/seed-dev.mjs [--board <uuid>]

import { parseArgs } from 'node:util'
import { createClient } from '@supabase/supabase-js'

const PROD_REF = 'wndfikmpifyqkgivmnwv'
const DIMS = 3072
const NARRATIVE_CHARS = 4100 // latest prod snapshot narrative ≈ 4162 chars

const { values: args } = parseArgs({ options: { board: { type: 'string' } } })
const url = process.env.VITE_SUPABASE_URL
if (!url || new URL(url).hostname.startsWith(PROD_REF)) {
  console.error('VITE_SUPABASE_URL must point at Weave-Dev')
  process.exit(2)
}
const c = createClient(url, process.env.VITE_SUPABASE_ANON_KEY)
const { data: auth, error: authErr } = await c.auth.signInWithPassword({
  email: process.env.E2E_DEV_EMAIL,
  password: process.env.E2E_DEV_PASSWORD,
})
if (authErr) throw authErr
const userId = auth.user.id

const randVec = () => {
  const v = Array.from({ length: DIMS }, () => Math.random() * 2 - 1)
  const n = Math.hypot(...v)
  return `[${v.map((x) => (x / n).toFixed(6)).join(',')}]`
}

const boardId =
  args.board ?? (await c.from('boards').select('id').order('created_at').limit(1).single()).data.id
console.log('board', boardId)

// 1. Profile snapshot
const { count: snapCount } = await c
  .from('weave_profile_snapshots')
  .select('id', { count: 'exact', head: true })
if (!snapCount) {
  const sentence =
    'Lately the board keeps returning to systems that remember without a centre, and to the cost of keeping redundancy alive. '
  const narrative = sentence.repeat(Math.ceil(NARRATIVE_CHARS / sentence.length)).slice(0, NARRATIVE_CHARS)
  const { error } = await c.from('weave_profile_snapshots').insert({
    user_id: userId,
    board_ids: [boardId],
    event_count: 0,
    node_count: 15,
    narrative,
    trigger_reason: 'opener_timing_seed',
  })
  console.log('snapshot', error?.message ?? 'inserted')
} else console.log('snapshot present')

// 2. Edge embeddings (one per connection identity)
const { data: edges } = await c.from('edges').select('data, mode').eq('board_id', boardId)
const { data: haveEdges } = await c
  .from('weave_edge_embeddings')
  .select('mode,node_lo,node_hi')
  .eq('board_id', boardId)
const haveEdge = new Set((haveEdges ?? []).map((e) => `${e.mode}|${e.node_lo}|${e.node_hi}`))
let edgeInserts = 0
for (const e of edges ?? []) {
  const a = String(e.data.from).replace(/^node-/, '')
  const b = String(e.data.to).replace(/^node-/, '')
  const [lo, hi] = a <= b ? [a, b] : [b, a]
  const mode = e.mode ?? e.data.mode ?? ''
  const key = `${mode}|${lo}|${hi}`
  if (haveEdge.has(key)) continue
  haveEdge.add(key)
  const { error } = await c.from('weave_edge_embeddings').insert({
    user_id: userId,
    board_id: boardId,
    mode,
    node_lo: lo,
    node_hi: hi,
    embedding: randVec(),
    content_summary: 'opener-timing seed',
  })
  if (error) console.log('edge', key, error.message)
  else edgeInserts++
}
console.log('edge embeddings inserted', edgeInserts, 'of', edges?.length ?? 0, 'edges')

// 3. Node embeddings (node band)
const { data: nodes } = await c.from('nodes').select('data, card_type').eq('board_id', boardId)
const { data: haveNodes } = await c.from('weave_embeddings').select('node_id').eq('board_id', boardId)
const haveNode = new Set((haveNodes ?? []).map((n) => n.node_id))
let nodeInserts = 0
for (const n of nodes ?? []) {
  const id = String(n.data?._clientNodeId ?? '').replace(/^node-/, '')
  if (!id || haveNode.has(id)) continue
  const { error } = await c.from('weave_embeddings').insert({
    user_id: userId,
    board_id: boardId,
    node_id: id,
    node_type: n.card_type ?? 'text',
    embedding: randVec(),
    content_summary: 'opener-timing seed',
  })
  if (error) console.log('node', id, error.message)
  else nodeInserts++
}
console.log('node embeddings inserted', nodeInserts, 'of', nodes?.length ?? 0, 'nodes')
