// ONE-TIME CORPUS SWEEP — Issue #2, PR-2.
//
// Re-embeds the existing corpus through the PR-1/PR-1.1 composition path:
// the 3 timer-race tweets, the 12 500-cap summaries, all YouTube cards
// (contentDescription never embedded, transcripts sliced at 3k), the
// media-dominated multimodal server vectors, and the archived-only nodes
// (revived via archived_at: null on write).
//
// THREE PHASES, sequential, with a plan-then-confirm gate between 1 and 2:
//
//   Phase 1 — plan (read-only). Classify every current node: card type,
//     recipe, description-gate status, sweep eligibility. Print the full
//     plan table and STOP unless --execute.
//   Phase 2 — description backfill (writes: node JSONB only). For each
//     planned backfill-description node, call the deployed Netlify
//     generate-tweet-description function (the prompt and never-throws
//     contract live there — nothing is reimplemented here) and patch
//     contentDescription via the standard patch_node_data RPC. Failures
//     log loudly, downgrade the node to embed-only, and the sweep continues.
//   Phase 3 — re-embed (writes: weave_embeddings). Compose per the PR-1
//     recipes from stored JSONB only — ZERO content fetches (no Supadata,
//     no yt-dlp, no oEmbed; stored fields are banked acquisition successes).
//     The only external calls anywhere: Gemini embeds + Phase 2's generator.
//     Upsert with archived_at: null, content_summary = full composed text,
//     embed_generation incremented, embed_trigger: 'sweep', provenance
//     flags, embed_text_chars. Appends an embed.sweep processing_log event
//     per node.
//
// HARD EXCLUSIONS (never-worse-informed invariant): imageCards, pdfCards,
// and image tweets (no transcript, no media_analysis, but a fetched tweet
// image — their current vectors carry pixels this text-only sweep can't
// match). Their rows are untouched and verified byte-identical afterward.
//
// CAMUS GUARD: if a node's composed text is SHORTER than the summary it
// would overwrite, the row is skipped and flagged for manual handling —
// never write a poorer summary over a richer one. (The known case: one
// prod row whose media-analysis prose survives only inside content_summary
// because the JSONB patch never landed.)
//
// VERIFICATION SUITE runs automatically after Phase 3 (read-only) and its
// results land in the results JSON for the run record.
//
// ENVIRONMENT — reads .env in the repo root (process.env overrides):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY  — target database
//   VITE_GEMINI_API_KEY                      — Gemini embeds
//   WEAVE_NETLIFY_FN_URL                     — full URL of the deployed
//     generate-tweet-description function (same convention as the Fly
//     secret), e.g. https://<site>/.netlify/functions/generate-tweet-description
//     Required in --execute mode when the plan contains backfill-description
//     nodes; plan-only mode just warns.
//
// The .env defaults point at DEV. The PROD run happens from Daniel's
// terminal with prod credentials passed EXPLICITLY — this script never
// ships with, nor assumes, a prod write credential:
//
//   # plan only (read-only), prod:
//   SUPABASE_URL=<prod-url> SUPABASE_SERVICE_ROLE_KEY=<prod-service-key> \
//     WEAVE_NETLIFY_FN_URL=<prod-fn-url> node scripts/sweep-corpus-embeddings.mjs
//
//   # full run, prod (prints the plan again, then asks for the word "sweep"):
//   SUPABASE_URL=<prod-url> SUPABASE_SERVICE_ROLE_KEY=<prod-service-key> \
//     WEAVE_NETLIFY_FN_URL=<prod-fn-url> node scripts/sweep-corpus-embeddings.mjs --execute
//
// Flags:
//   --execute   run phases 2+3 and verification after an interactive confirm
//   --yes       skip the interactive confirm (dev rehearsal convenience)
//   --out-dir   where plan/results JSON artifacts go (default tmp/sweep/<ts>)
//
// Idempotent: re-running re-embeds the same rows at the next generation.
// Safe to re-run after a partial failure.

import { createClient } from '@supabase/supabase-js'
import { GoogleGenAI } from '@google/genai'
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline/promises'
import { join } from 'node:path'

// --- Env (backfill-edge-embeddings.mjs pattern) -----------------------------
const env = Object.fromEntries(
  readFileSync(new URL('../.env', import.meta.url), 'utf8')
    .split('\n')
    .filter((l) => l.includes('=') && !l.trimStart().startsWith('#'))
    .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]),
)

const SUPABASE_URL = process.env.SUPABASE_URL || env.SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_ROLE_KEY
const GEMINI_KEY = process.env.VITE_GEMINI_API_KEY || env.VITE_GEMINI_API_KEY
const NETLIFY_FN_URL = process.env.WEAVE_NETLIFY_FN_URL || env.WEAVE_NETLIFY_FN_URL || ''
const EXECUTE = process.argv.includes('--execute')
const SKIP_CONFIRM = process.argv.includes('--yes')
const outDirArg = process.argv.indexOf('--out-dir')
const OUT_DIR =
  outDirArg !== -1
    ? process.argv[outDirArg + 1]
    : join('tmp', 'sweep', new Date().toISOString().replace(/[:.]/g, '-'))

if (!SUPABASE_URL || !SUPABASE_KEY || !GEMINI_KEY) {
  console.error('Missing env: need SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, VITE_GEMINI_API_KEY')
  process.exit(1)
}

console.log(`[sweep] target: ${SUPABASE_URL}`)
console.log(`[sweep] mode:   ${EXECUTE ? 'EXECUTE (phases 1→2→3 + verification)' : 'plan only (read-only)'}`)
console.log(`[sweep] artifacts: ${OUT_DIR}`)

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
})
const ai = new GoogleGenAI({ apiKey: GEMINI_KEY })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// --- Composition (mirrors PR-1 recipes byte-for-byte) -----------------------
// Client: src/services/embeddingService.ts buildPartsForNode
// Server: media-server/src/supabase.ts composeEmbedText
// Same value and semantics as both codebases' EMBED_TEXT_MAX_CHARS.
const EMBED_TEXT_MAX_CHARS = 36000
// Same rule and threshold as src/services/linkEnrichment.ts and
// media-server/src/description.ts.
const TWEET_DESCRIPTION_TRANSCRIPT_MIN_CHARS = 1000

const asStr = (v) => (typeof v === 'string' ? v.trim() : '')

/** Mirrors joinWithBudget: transcript rides last; only its tail is ever cut. */
function joinWithBudget(segments, transcript) {
  const all = [...segments, transcript].filter(Boolean)
  const full = all.join(' — ')
  if (full.length <= EMBED_TEXT_MAX_CHARS) return { text: full, truncatedFromChars: null }
  if (!transcript) return { text: full, truncatedFromChars: full.length }
  const prefix = segments.filter(Boolean).join(' — ')
  const transcriptBudget = EMBED_TEXT_MAX_CHARS - (prefix ? prefix.length + 3 : 0)
  const kept = transcriptBudget > 0 ? transcript.slice(0, transcriptBudget) : ''
  return { text: [prefix, kept].filter(Boolean).join(' — '), truncatedFromChars: full.length }
}

/**
 * Compose the text-only embed for an eligible node from stored JSONB.
 * Returns null when there is nothing composable (fail-loud at the call
 * site — expected for reference rows like dev's empty-summary videos).
 */
function composeForNode(cls, data) {
  const title = asStr(data.title)
  const description = asStr(data.description)
  const domain = asStr(data.domain)
  const authorName = asStr(data.authorName)
  const tweetText = asStr(data.tweetText)
  const contentDescription = asStr(data.contentDescription)
  const mediaAnalysis = asStr(data.media_analysis)
  const transcript = asStr(data.transcript) || asStr(data.youtubeTranscript)

  let composed
  let hadAnalysis = false
  switch (cls.recipe) {
    case 'youtube':
      // title — authorName — contentDescription — transcript
      composed = joinWithBudget([title, authorName, contentDescription], transcript)
      break
    case 'video-tweet':
      // contentDescription — authorName — tweetText — media_analysis — transcript
      composed = joinWithBudget([contentDescription, authorName, tweetText, mediaAnalysis], transcript)
      hadAnalysis = Boolean(mediaAnalysis)
      break
    case 'text-tweet':
      // authorName — tweetText
      composed = joinWithBudget([authorName, tweetText], '')
      break
    case 'text-card':
      composed = { text: asStr(data.text), truncatedFromChars: null }
      break
    case 'generic-link':
      // title — description — domain (unchanged from the pre-PR-1 path)
      composed = joinWithBudget([title, description, domain], '')
      break
    default:
      return null
  }
  if (!composed.text) return null
  return {
    text: composed.text,
    truncatedFromChars: composed.truncatedFromChars,
    hadTranscript: Boolean(transcript),
    hadDescription: Boolean(contentDescription),
    hadAnalysis,
  }
}

// --- Classification ---------------------------------------------------------
/**
 * Classify a current node into recipe + gate + planned action.
 * Gate mirrors the union-view gate of the live path: fusion (analysis
 * present), compression (transcript > 1,000 chars), already-described
 * (contentDescription present in JSONB).
 */
// DB columns use short names (card_type: link/text/image, link_type:
// tweet/youtube); the JSONB carries the canonical client values
// (linkCard/textCard/imageCard, twitter/youtube) that the live composition
// path reads. Prefer the JSONB, fall back to mapped columns.
const CARD_TYPE_FROM_COLUMN = { link: 'linkCard', text: 'textCard', image: 'imageCard', pdf: 'pdfCard' }
const LINK_TYPE_FROM_COLUMN = { tweet: 'twitter', youtube: 'youtube' }

function classifyNode(node) {
  const data = node.data ?? {}
  const cardType =
    asStr(data._clientNodeType) || CARD_TYPE_FROM_COLUMN[node.card_type] || node.card_type || 'unknown'
  const linkType = asStr(data.type) || LINK_TYPE_FROM_COLUMN[node.link_type] || node.link_type || ''
  const transcript = asStr(data.transcript) || asStr(data.youtubeTranscript)
  const mediaAnalysis = asStr(data.media_analysis)
  const contentDescription = asStr(data.contentDescription)
  const tweetText = asStr(data.tweetText)
  // A fetched tweet image leaves imageMimeType in JSONB (the base64 itself
  // is stripped at sync — coverage probe §2). That marker is the image-
  // presence signal for the exclusion rule.
  const hasImage = Boolean(asStr(data.imageMimeType))

  const base = { cardType, linkType, transcriptChars: transcript.length, analysisChars: mediaAnalysis.length, descriptionChars: contentDescription.length, hasImage }

  if (cardType === 'imageCard') {
    return { ...base, recipe: 'none', gate: 'n/a', action: 'excluded', reason: 'imageCard — multimodal vector kept (never-worse-informed)' }
  }
  if (cardType === 'pdfCard') {
    return { ...base, recipe: 'none', gate: 'n/a', action: 'excluded', reason: 'pdfCard — multimodal vector kept (never-worse-informed)' }
  }
  if (cardType === 'textCard') {
    return { ...base, recipe: 'text-card', gate: 'n/a', action: 'embed-only' }
  }
  if (cardType !== 'linkCard') {
    return { ...base, recipe: 'none', gate: 'n/a', action: 'excluded', reason: `unknown card type ${cardType}` }
  }

  if (linkType === 'youtube') {
    // YouTube descriptions come from a different generator at ingest; the
    // sweep never generates for YouTube (prod is 11/11 described anyway).
    const gate = contentDescription ? 'already-described' : 'no-description (composes without)'
    return { ...base, recipe: 'youtube', gate, action: 'embed-only' }
  }

  if (linkType === 'twitter') {
    if (transcript || mediaAnalysis || contentDescription) {
      let gate
      if (contentDescription) gate = 'already-described'
      else if (mediaAnalysis) gate = 'fusion'
      else if (transcript.length > TWEET_DESCRIPTION_TRANSCRIPT_MIN_CHARS) gate = 'compression'
      else gate = 'below-threshold'
      const action =
        gate === 'fusion' || gate === 'compression' ? 'backfill-description' : 'embed-only'
      return { ...base, recipe: 'video-tweet', gate, action }
    }
    if (hasImage) {
      return { ...base, recipe: 'none', gate: 'n/a', action: 'excluded', reason: 'image tweet — pixels in current vector, no rescue text (never-worse-informed)' }
    }
    if (tweetText) {
      return { ...base, recipe: 'text-tweet', gate: 'n/a', action: 'embed-only' }
    }
    return { ...base, recipe: 'generic-link', gate: 'n/a', action: 'embed-only' }
  }

  return { ...base, recipe: 'generic-link', gate: 'n/a', action: 'embed-only' }
}

// --- Phase 1: plan (read-only) ----------------------------------------------
async function buildPlan() {
  const { data: boards, error: bErr } = await supabase.from('boards').select('id, name')
  if (bErr) throw new Error(`boards load failed: ${bErr.message}`)
  const boardName = new Map((boards ?? []).map((b) => [b.id, b.name]))

  const { data: nodes, error: nErr } = await supabase
    .from('nodes')
    .select('id, board_id, user_id, card_type, link_type, data, created_at')
  if (nErr) throw new Error(`nodes load failed: ${nErr.message}`)

  // All rows, active AND archived — the join to current nodes is on
  // (node_id, board_id), the only key the store has.
  const { data: rows, error: eErr } = await supabase
    .from('weave_embeddings')
    .select('id, board_id, node_id, user_id, node_type, embedding, content_summary, archived_at, metadata')
  if (eErr) throw new Error(`embeddings load failed: ${eErr.message}`)

  const rowByKey = new Map()
  for (const r of rows ?? []) rowByKey.set(`${r.node_id}|${r.board_id}`, r)

  const plan = []
  for (const node of nodes ?? []) {
    const data = node.data ?? {}
    const clientId = asStr(data._clientNodeId)
    if (!clientId) {
      console.warn(`[plan] node ${node.id} has no _clientNodeId — cannot address its embedding row, skipping`)
      continue
    }
    const row = rowByKey.get(`${clientId}|${node.board_id}`) ?? null
    const cls = classifyNode(node)
    const preGen = Number(row?.metadata?.embed_generation) || 0
    plan.push({
      nodeUuid: node.id,
      clientId,
      boardId: node.board_id,
      board: boardName.get(node.board_id) ?? node.board_id.slice(0, 8),
      userId: node.user_id,
      title: (asStr(data.title) || asStr(data.label) || asStr(data.fileName) || asStr(data.text).slice(0, 40) || '(untitled)').slice(0, 48),
      ...cls,
      hasRow: Boolean(row),
      archivedOnly: Boolean(row?.archived_at),
      preGen,
      preSummaryChars: row?.content_summary?.length ?? 0,
      // For the byte-identical check on excluded rows (verification 4).
      preEmbeddingFingerprint:
        cls.action === 'excluded' && row ? fingerprint(row.embedding) : null,
    })
  }

  // Orphan rows (no current node) are out of scope — count them for the record.
  const nodeKeys = new Set(plan.map((p) => `${p.clientId}|${p.boardId}`))
  const orphans = (rows ?? []).filter((r) => !nodeKeys.has(`${r.node_id}|${r.board_id}`))

  return { plan, orphanCount: orphans.length, totalRows: rows?.length ?? 0 }
}

function fingerprint(embedding) {
  // The embedding comes back as a string (pgvector serialization) — hash it
  // cheaply for the byte-identical comparison.
  const s = typeof embedding === 'string' ? embedding : JSON.stringify(embedding)
  let h1 = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h1 ^= s.charCodeAt(i)
    h1 = Math.imul(h1, 0x01000193)
  }
  return `${s.length}:${(h1 >>> 0).toString(16)}`
}

function printPlan(plan, orphanCount, totalRows) {
  const pad = (s, n) => String(s ?? '').padEnd(n).slice(0, n)
  console.log('\n=== SWEEP PLAN ===')
  console.log(
    pad('board', 20), pad('title', 48), pad('type', 12), pad('recipe', 12),
    pad('gate', 26), pad('action', 22), pad('gen', 4), pad('sumCh', 6), 'flags',
  )
  for (const p of plan) {
    const flags = [
      p.archivedOnly ? 'ARCHIVED-ONLY' : '',
      !p.hasRow ? 'NO-ROW' : '',
      p.transcriptChars ? `tr:${p.transcriptChars}` : '',
      p.analysisChars ? `an:${p.analysisChars}` : '',
      p.descriptionChars ? `de:${p.descriptionChars}` : '',
      p.hasImage ? 'img' : '',
    ].filter(Boolean).join(' ')
    console.log(
      pad(p.board, 20), pad(p.title, 48), pad(p.cardType === 'linkCard' ? p.linkType : p.cardType, 12),
      pad(p.recipe, 12), pad(p.gate, 26), pad(p.action, 22), pad(p.preGen, 4),
      pad(p.preSummaryChars, 6), flags,
    )
  }
  const by = (a) => plan.filter((p) => p.action === a).length
  console.log(`\n[plan] ${plan.length} current nodes | backfill-description: ${by('backfill-description')} | embed-only: ${by('embed-only')} | excluded: ${by('excluded')}`)
  console.log(`[plan] embedding rows: ${totalRows} total, ${orphanCount} orphaned (untouched — no current node)`)
  console.log(`[plan] archived-only current nodes to revive: ${plan.filter((p) => p.archivedOnly).length}`)
}

// --- Phase 2: description backfill ------------------------------------------
async function backfillDescriptions(plan, record) {
  const targets = plan.filter((p) => p.action === 'backfill-description')
  console.log(`\n=== PHASE 2: description backfill (${targets.length} nodes) ===`)
  if (targets.length > 0 && !NETLIFY_FN_URL) {
    throw new Error('WEAVE_NETLIFY_FN_URL is required: the plan contains backfill-description nodes')
  }

  for (const p of targets) {
    const { data: nodeRow, error } = await supabase
      .from('nodes')
      .select('data')
      .eq('id', p.nodeUuid)
      .single()
    if (error) {
      console.error(`[phase2] ${p.title}: node re-read failed: ${error.message} — downgrading to embed-only`)
      p.action = 'embed-only'
      record.phase2.push({ node: p.title, clientId: p.clientId, outcome: 'failed', error: error.message })
      continue
    }
    const data = nodeRow.data ?? {}
    const startedAt = Date.now()
    try {
      const payload = JSON.stringify({
        authorName: asStr(data.authorName),
        authorHandle: asStr(data.authorHandle) || null,
        tweetText: asStr(data.tweetText),
        transcript: (asStr(data.transcript) || asStr(data.youtubeTranscript)) || null,
        mediaAnalysis: asStr(data.media_analysis) || null,
      })
      // One retry on transport failure — the function itself never throws
      // (always-200 contract), so a rejection here is network-level.
      let res
      try {
        res = await fetch(NETLIFY_FN_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: payload })
      } catch {
        await sleep(2000)
        res = await fetch(NETLIFY_FN_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: payload })
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const body = await res.json()
      if (body.error) throw new Error(body.error)
      const description = asStr(body.description)
      if (!description) throw new Error('empty description')

      const { error: patchErr } = await supabase.rpc('patch_node_data', {
        p_client_id: p.clientId,
        p_board_id: p.boardId,
        p_user_id: p.userId,
        p_patch: { contentDescription: description },
      })
      if (patchErr) throw new Error(`patch_node_data failed: ${patchErr.message}`)

      p.descriptionBackfilled = true
      console.log(`[phase2] ${p.title}: description generated (${description.length} chars, ${Date.now() - startedAt}ms) and patched`)
      record.phase2.push({ node: p.title, clientId: p.clientId, outcome: 'success', descriptionChars: description.length })
    } catch (err) {
      console.error(`[phase2] ⚠️  ${p.title}: ${err.message} — downgrading to embed-only`)
      p.action = 'embed-only'
      record.phase2.push({ node: p.title, clientId: p.clientId, outcome: 'failed', error: err.message })
    }
    await sleep(1000)
  }
}

// --- Phase 3: re-embed ------------------------------------------------------
async function reembed(plan, record) {
  const targets = plan.filter((p) => p.action === 'backfill-description' || p.action === 'embed-only')
  console.log(`\n=== PHASE 3: re-embed (${targets.length} nodes) ===`)

  for (const p of targets) {
    const startedAt = Date.now()
    // Re-read the node so Phase 2's contentDescription patch is in view.
    const { data: nodeRow, error } = await supabase
      .from('nodes')
      .select('data, card_type')
      .eq('id', p.nodeUuid)
      .single()
    if (error) {
      console.error(`[phase3] ⚠️  ${p.title}: node re-read failed: ${error.message} — skipping`)
      record.phase3.push({ node: p.title, clientId: p.clientId, outcome: 'failed', error: error.message })
      continue
    }
    const data = nodeRow.data ?? {}

    const composed = composeForNode(p, data)
    if (!composed) {
      // Fail-loud, no write — e.g. a node with no composable text.
      console.error(`[phase3] ⚠️  ${p.title}: NOTHING COMPOSABLE (recipe ${p.recipe}) — skipping, flagged`)
      record.phase3.push({ node: p.title, clientId: p.clientId, outcome: 'skipped-empty', recipe: p.recipe })
      continue
    }

    // CAMUS GUARD — never write a poorer summary over a richer one. The
    // union-rule alternative (splicing analysis prose back out of a
    // 500-cap-truncated summary) was judged too fragile; skip-and-flag is
    // the sanctioned fallback.
    //
    // Exception: a shorter composition is NOT poorer when the existing
    // summary is byte-reconstructable from JSONB fields the sweep still
    // holds — the pre-PR-1 client wrote tweet summaries as
    // authorName — authorHandle — tweetText — domain, and the new recipe
    // deliberately drops the handle/domain boilerplate. If the old summary
    // matches that reconstruction exactly, it provably contains nothing the
    // node has lost (rehearsal caught this: every legacy text tweet was
    // ~25 chars "richer" on boilerplate alone, which would have blocked
    // reviving the archived-only text tweets).
    if (composed.text.length < p.preSummaryChars) {
      const { data: existingRow } = await supabase
        .from('weave_embeddings')
        .select('content_summary')
        .eq('board_id', p.boardId)
        .eq('node_id', p.clientId)
        .maybeSingle()
      const existingSummary = existingRow?.content_summary ?? ''
      const legacyTranscript = (asStr(data.transcript) || asStr(data.youtubeTranscript)).slice(0, 3000)
      const legacyReconstructions = [
        // pre-PR-1 client tweet format (text and image tweets alike)
        [asStr(data.authorName), asStr(data.authorHandle), asStr(data.tweetText), asStr(data.domain)].filter(Boolean).join(' — '),
        // pre-PR-1 client tweet format with transcript (3,000-char slice rode
        // after the domain — confirmed against 864f087's composition code).
        // Added after the prod run's gomi/shouko skips: delta was pure
        // handle+domain boilerplate.
        [asStr(data.authorName), asStr(data.authorHandle), asStr(data.tweetText), asStr(data.domain), legacyTranscript].filter(Boolean).join(' — '),
        // pre-PR-1 generic link format
        [asStr(data.title), asStr(data.description), asStr(data.domain)].filter(Boolean).join(' — '),
      ]
      if (legacyReconstructions.includes(existingSummary)) {
        console.log(`[phase3] ${p.title}: composed ${composed.text.length} < existing ${p.preSummaryChars}, but existing is legacy boilerplate reconstruction — sweeping`)
        p.legacySwept = true
        record.legacySweeps.push({ node: p.title, clientId: p.clientId, composedChars: composed.text.length, preSummaryChars: p.preSummaryChars })
      } else {
        console.error(
          `[phase3] ⚠️  CAMUS GUARD: ${p.title}: composed ${composed.text.length} < existing summary ${p.preSummaryChars} — skipping, flag for manual handling`,
        )
        record.camusGuard.push({ node: p.title, clientId: p.clientId, boardId: p.boardId, composedChars: composed.text.length, preSummaryChars: p.preSummaryChars })
        record.phase3.push({ node: p.title, clientId: p.clientId, outcome: 'skipped-camus-guard' })
        continue
      }
    }

    if (composed.truncatedFromChars !== null) {
      console.warn(`[phase3] ⚠️  BUDGET TRIPWIRE: ${p.title}: composed ${composed.truncatedFromChars} chars → cut to ${composed.text.length}`)
      record.budgetTripwires.push({ node: p.title, clientId: p.clientId, composedChars: composed.truncatedFromChars, keptChars: composed.text.length })
      await appendLog(p, 'embed.budget', 'degraded', {
        composedChars: composed.truncatedFromChars,
        cap: EMBED_TEXT_MAX_CHARS,
        droppedChars: composed.truncatedFromChars - composed.text.length,
        trigger: 'sweep',
      })
    }

    try {
      const response = await ai.models.embedContent({
        model: 'gemini-embedding-2-preview',
        contents: { parts: [{ text: composed.text }] },
        config: { taskType: 'SEMANTIC_SIMILARITY' },
      })
      const embedding = response.embeddings?.[0]?.values
      if (!embedding) throw new Error('Gemini returned no embedding')

      // Generation: strictly greater than the Phase-1 number, resilient to
      // a concurrent write between plan and now.
      const { data: existing } = await supabase
        .from('weave_embeddings')
        .select('metadata')
        .eq('board_id', p.boardId)
        .eq('node_id', p.clientId)
        .maybeSingle()
      const currentGen = Number(existing?.metadata?.embed_generation) || 0
      const embedGeneration = Math.max(currentGen, p.preGen) + 1

      const { error: upErr } = await supabase.from('weave_embeddings').upsert(
        {
          board_id: p.boardId,
          node_id: p.clientId,
          user_id: p.userId,
          node_type: p.cardType,
          embedding: JSON.stringify(embedding),
          content_summary: composed.text,
          // An embed write means a live card owns this row.
          archived_at: null,
          metadata: {
            parts_count: 1,
            embed_generation: embedGeneration,
            embed_trigger: 'sweep',
            had_transcript: composed.hadTranscript,
            had_description: composed.hadDescription,
            had_analysis: composed.hadAnalysis,
            embed_text_chars: composed.text.length,
          },
        },
        { onConflict: 'board_id,node_id' },
      )
      if (upErr) throw new Error(`upsert failed: ${upErr.message}`)

      await appendLog(p, 'embed.sweep', 'success', {
        trigger: 'sweep',
        embedGeneration,
        embeddingDims: embedding.length,
        embedTextChars: composed.text.length,
        hadTranscript: composed.hadTranscript,
        hadDescription: composed.hadDescription,
        hadAnalysis: composed.hadAnalysis,
        descriptionBackfilled: Boolean(p.descriptionBackfilled),
      }, Date.now() - startedAt)

      p.sweptGen = embedGeneration
      p.sweptChars = composed.text.length
      console.log(`[phase3] ${p.title}: gen ${p.preGen} → ${embedGeneration}, ${composed.text.length} chars (${Date.now() - startedAt}ms)`)
      record.phase3.push({ node: p.title, clientId: p.clientId, outcome: 'success', gen: embedGeneration, chars: composed.text.length })
    } catch (err) {
      console.error(`[phase3] ⚠️  ${p.title}: ${err.message} — continuing`)
      record.phase3.push({ node: p.title, clientId: p.clientId, outcome: 'failed', error: err.message })
    }
    await sleep(500)
  }
}

async function appendLog(p, phase, outcome, detail, durationMs = 0) {
  const { error } = await supabase.rpc('append_processing_log', {
    p_client_id: p.clientId,
    p_board_id: p.boardId,
    p_user_id: p.userId,
    p_entry: {
      ts: new Date().toISOString(),
      phase,
      source: 'script',
      outcome,
      durationMs,
      detail,
    },
  })
  if (error) console.warn(`[log] append_processing_log failed for ${p.title}: ${error.message}`)
}

// --- Verification suite (read-only) -----------------------------------------
async function verify(plan, record) {
  console.log('\n=== VERIFICATION (read-only) ===')
  const v = record.verification

  const { data: rows } = await supabase
    .from('weave_embeddings')
    .select('board_id, node_id, embedding, content_summary, archived_at, metadata')
  const rowByKey = new Map((rows ?? []).map((r) => [`${r.node_id}|${r.board_id}`, r]))

  const { data: nodes } = await supabase.from('nodes').select('id, board_id, data')
  const nodeKeys = new Set(
    (nodes ?? []).map((n) => `${asStr(n.data?._clientNodeId)}|${n.board_id}`),
  )
  const nodeByKey = new Map(
    (nodes ?? []).map((n) => [`${asStr(n.data?._clientNodeId)}|${n.board_id}`, n]),
  )

  // 1. Zero current nodes with only-archived embedding rows.
  const archivedOnly = (rows ?? []).filter(
    (r) => r.archived_at && nodeKeys.has(`${r.node_id}|${r.board_id}`),
  )
  v.archivedOnlyCurrentNodes = archivedOnly.map((r) => `${r.node_id}|${r.board_id}`)
  report('1. current nodes with only-archived rows', archivedOnly.length === 0, `${archivedOnly.length} (expect 0)`)

  // 2. Every swept row: archived_at null, trigger sweep, chars match, gen > pre.
  const swept = plan.filter((p) => p.sweptGen)
  let bad2 = []
  for (const p of swept) {
    const r = rowByKey.get(`${p.clientId}|${p.boardId}`)
    const m = r?.metadata ?? {}
    const ok =
      r &&
      r.archived_at === null &&
      m.embed_trigger === 'sweep' &&
      m.embed_text_chars === r.content_summary.length &&
      m.embed_generation > p.preGen
    if (!ok) bad2.push({ node: p.title, archived: r?.archived_at, trigger: m.embed_trigger, chars: [m.embed_text_chars, r?.content_summary?.length], gen: [m.embed_generation, p.preGen] })
  }
  v.sweptRowInvariants = { swept: swept.length, violations: bad2 }
  report(`2. swept-row invariants (${swept.length} rows)`, bad2.length === 0, `${bad2.length} violations`)

  // 3. No 500-cap summaries, no 3,000-boundary artifacts, none over budget.
  //    Transcript-bearing recipes place the transcript last, so the summary
  //    must end with the transcript's tail (unless the budget tripwire cut it).
  let bad3 = []
  for (const p of swept) {
    const r = rowByKey.get(`${p.clientId}|${p.boardId}`)
    if (!r) continue
    const s = r.content_summary
    if (s.length === 500) bad3.push({ node: p.title, why: 'exactly 500 chars' })
    if (s.length > EMBED_TEXT_MAX_CHARS) bad3.push({ node: p.title, why: `over budget: ${s.length}` })
    const node = nodeByKey.get(`${p.clientId}|${p.boardId}`)
    const tr = asStr(node?.data?.transcript) || asStr(node?.data?.youtubeTranscript)
    const wasTruncated = record.budgetTripwires.some((t) => t.clientId === p.clientId)
    if (tr && (p.recipe === 'youtube' || p.recipe === 'video-tweet') && !wasTruncated) {
      if (!s.endsWith(tr.slice(-60))) bad3.push({ node: p.title, why: 'summary does not end with transcript tail (truncation artifact?)' })
    }
  }
  v.summaryShape = bad3
  report('3. summary shape (no 500-cap / 3k artifacts / over-budget)', bad3.length === 0, `${bad3.length} violations`)

  // 4. Excluded nodes: vectors byte-identical to pre-sweep.
  let bad4 = []
  for (const p of plan.filter((x) => x.action === 'excluded' && x.preEmbeddingFingerprint)) {
    const r = rowByKey.get(`${p.clientId}|${p.boardId}`)
    const now = r ? fingerprint(r.embedding) : null
    if (now !== p.preEmbeddingFingerprint) bad4.push({ node: p.title, pre: p.preEmbeddingFingerprint, post: now })
  }
  v.excludedUntouched = bad4
  report('4. excluded rows byte-identical', bad4.length === 0, `${bad4.length} changed`)

  // 5. Spot-checks — full summaries into the results JSON, heads printed.
  const spotNames = ['RUST COHLE', 'King Arthur Fan', 'The Driven Man', 'Camus']
  v.spotChecks = []
  for (const name of spotNames) {
    const p = plan.find((x) => x.title.toLowerCase().includes(name.toLowerCase()))
    if (!p) { v.spotChecks.push({ name, note: 'not present in this corpus' }); continue }
    const r = rowByKey.get(`${p.clientId}|${p.boardId}`)
    v.spotChecks.push({ name, title: p.title, action: p.action, gen: r?.metadata?.embed_generation, archived: r?.archived_at, summary: r?.content_summary })
    console.log(`\n[spot] ${p.title} (${p.action}, gen ${r?.metadata?.embed_generation}, archived ${r?.archived_at}):\n  ${String(r?.content_summary).slice(0, 300)}…`)
  }
  // One YouTube card with contentDescription leading and transcript > 3,000 present.
  const yt = plan.find((x) => x.recipe === 'youtube' && x.transcriptChars > 3000 && x.descriptionChars > 0 && x.sweptGen)
  if (yt) {
    const r = rowByKey.get(`${yt.clientId}|${yt.boardId}`)
    const node = nodeByKey.get(`${yt.clientId}|${yt.boardId}`)
    const tr = asStr(node?.data?.transcript)
    const desc = asStr(node?.data?.contentDescription)
    const descLeads = r.content_summary.indexOf(desc) !== -1 && r.content_summary.indexOf(desc) < r.content_summary.indexOf(tr.slice(0, 60))
    const beyond3k = r.content_summary.includes(tr.slice(3000, 3060))
    v.spotChecks.push({ name: 'youtube >3k', title: yt.title, descriptionInSummary: descLeads, transcriptBeyond3k: beyond3k, summary: r.content_summary })
    console.log(`\n[spot] ${yt.title}: description-before-transcript=${descLeads}, transcript-beyond-3k-present=${beyond3k}`)
  } else {
    v.spotChecks.push({ name: 'youtube >3k', note: 'no swept youtube node with description + >3k transcript in this corpus' })
  }

  // 6. Zero rows where composed text is shorter than the pre-sweep summary
  //    (excluding flagged camus-guard skips — those rows were not written —
  //    and legacy-reconstruction sweeps, whose old summary was provably
  //    boilerplate-only longer).
  let bad6 = []
  for (const p of swept) {
    if (p.legacySwept) continue
    const r = rowByKey.get(`${p.clientId}|${p.boardId}`)
    if (r && r.content_summary.length < p.preSummaryChars) bad6.push({ node: p.title, pre: p.preSummaryChars, post: r.content_summary.length })
  }
  v.neverWorse = { violations: bad6, flaggedSkips: record.camusGuard.length, legacySweeps: record.legacySweeps.length }
  report(`6. never-worse (${record.camusGuard.length} flagged skips, ${record.legacySweeps.length} legacy-reconstruction sweeps excluded)`, bad6.length === 0, `${bad6.length} violations`)
}

function report(label, ok, detail) {
  console.log(`${ok ? '✓' : '✗ FAIL'} ${label}: ${detail}`)
}

// --- Main -------------------------------------------------------------------
const { plan, orphanCount, totalRows } = await buildPlan()
printPlan(plan, orphanCount, totalRows)

mkdirSync(OUT_DIR, { recursive: true })
writeFileSync(join(OUT_DIR, 'sweep-plan.json'), JSON.stringify({ target: SUPABASE_URL, generatedAt: new Date().toISOString(), orphanCount, totalRows, plan }, null, 2))
console.log(`\n[sweep] plan written to ${join(OUT_DIR, 'sweep-plan.json')}`)

if (!EXECUTE) {
  console.log('[sweep] plan-only mode — no writes performed. Re-run with --execute to sweep.')
  if (plan.some((p) => p.action === 'backfill-description') && !NETLIFY_FN_URL) {
    console.warn('[sweep] note: WEAVE_NETLIFY_FN_URL is not set — it will be required at execute time.')
  }
  process.exit(0)
}

if (!SKIP_CONFIRM) {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const answer = await rl.question(`\nAbout to WRITE to ${SUPABASE_URL}. Type "sweep" to proceed: `)
  rl.close()
  if (answer.trim() !== 'sweep') {
    console.log('[sweep] aborted — nothing written.')
    process.exit(1)
  }
}

const record = {
  target: SUPABASE_URL,
  startedAt: new Date().toISOString(),
  phase2: [],
  phase3: [],
  camusGuard: [],
  legacySweeps: [],
  budgetTripwires: [],
  verification: {},
}

await backfillDescriptions(plan, record)
await reembed(plan, record)
await verify(plan, record)

record.finishedAt = new Date().toISOString()
writeFileSync(join(OUT_DIR, 'sweep-results.json'), JSON.stringify({ record, plan }, null, 2))
console.log(`\n[sweep] results written to ${join(OUT_DIR, 'sweep-results.json')}`)

const failures = record.phase3.filter((r) => r.outcome === 'failed').length
console.log(`\n=== SWEEP COMPLETE === phase2 failures: ${record.phase2.filter((r) => r.outcome === 'failed').length}, phase3 failures: ${failures}, camus-guard skips: ${record.camusGuard.length}, budget tripwires: ${record.budgetTripwires.length}`)
