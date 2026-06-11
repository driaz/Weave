// Deposits write path — parse / embed / insert for voice_session_deposits.
//
// Epistemic properties this pipeline is built on:
//
//   1. A generation is one draw, not the reading. Absence from a deposit
//      means unsampled, never didn't-happen.
//   2. Speaker tags are claims. Provenance pointers adjudicate; the tag is
//      never ground truth.
//   3. Summaries sample real structure. Union across draws is richer than
//      any single draw, but no draw lies.
//
// Skip-by-default during backfill is a consequence of property 1 — a second
// draw is not a better draw, so there is no correctness reason to regenerate.
//
// Three responsibilities, cleanly separable so a future server path (e.g.
// Fly) can wrap them without touching this file:
//
//   parseSummary  — raw Opus output → typed rows, fail-loud on malformed
//   embedBodies   — Gemini halfvec 3072 per body, same pipeline as utterances
//   insertGeneration — one psql transaction per session-generation
//
// Ordering contract: generate → embed → insert. The NOT NULL embedding
// column (migration 035) enforces it — an embed failure fails the whole
// generation with zero rows written. No row-before-embed ever; the utterance
// pipeline's ordering is a documented violation, not a precedent.
//
// Database access is psql via execFileSync — the established direct-Postgres
// pattern in this repo (summarizeVoiceSession.mjs). The connection string is
// passed in by the caller; this module never reads env itself.

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { GoogleGenAI } from '@google/genai'

export const EMBEDDING_DIMS = 3072
const OPEN_EDGE_MARKER = 'OPEN EDGE:'
// Dollar-quote tag for SQL string literals. Collision is checked fail-loud
// before any SQL is assembled.
const DQ = '$wvdep$'

// ---------------------------------------------------------------------------
// prompt version
// ---------------------------------------------------------------------------

// Version = SHA-256 of the exact bytes of the prompt file, truncated to 16
// hex chars (collision-safe at this scale). Always computed at runtime from
// the file the script actually read — never hardcoded — so a drifted prompt
// can never write rows under a stale version.
export function computePromptVersion(promptText) {
  return createHash('sha256').update(promptText, 'utf8').digest('hex').slice(0, 16)
}

// ---------------------------------------------------------------------------
// parse
// ---------------------------------------------------------------------------

// Split raw Opus output into typed rows { ordinal, type, body, provenance }.
// Contract (mirrors the prompt's "Output format" footnote): deposits
// separated by a line of exactly "---", final segment prefixed "OPEN EDGE:".
// "OPEN EDGE: none" means no open-edge row — the absence of an edge is not a
// deposit and must not be embedded into the retrieval space.
//
// Zero-delimiter output is valid: single-deposit draws have nothing to
// separate, so honest thin output may emit no "---" at all (backfill
// 2026-06-11, 13 of 13 such failures were this shape). The whole text is one
// deposit, with the trailing OPEN EDGE section still required.
//
// Fail-loud (throws) on: speaker-tagged dialogue lines (fabricated
// continuation — see observation log entry 3), missing open-edge marker,
// empty bodies, open edge not last, more than one open edge.
export function parseSummary(raw) {
  const text = raw.trim()
  if (!text) throw new Error('parse: empty summary')

  // Tripwire for the fabricated-continuation failure mode: a summary is
  // analytical prose and must never contain speaker-tagged dialogue lines.
  // One observed instance (session 72a855bd) invented a multi-turn dialogue
  // and summarized it; only an accidental formatting artifact kept it out of
  // prod. This makes that containment deliberate.
  if (/^(USER|ASSISTANT):/m.test(text)) {
    throw new Error(
      'parse: fabricated dialogue / transcript echo detected — output contains speaker-tagged lines ("USER:"/"ASSISTANT:" at line start); this is not a summary',
    )
  }

  const segments = []
  let current = []
  for (const line of text.split('\n')) {
    if (line.trim() === '---') {
      segments.push(current.join('\n').trim())
      current = []
    } else {
      current.push(line)
    }
  }
  segments.push(current.join('\n').trim())

  let deposits
  let last
  if (segments.length === 1) {
    // Zero-delimiter draw: carve the trailing OPEN EDGE section out of the
    // single block; everything before it is the one deposit.
    const marker = text.match(/^OPEN EDGE:/m)
    if (!marker) {
      throw new Error(`parse: no "${OPEN_EDGE_MARKER}" marker found — every summary ends with an open-edge section (or "${OPEN_EDGE_MARKER} none")`)
    }
    deposits = [text.slice(0, marker.index).trim()]
    last = text.slice(marker.index).trim()
  } else {
    deposits = segments.slice(0, -1)
    last = segments[segments.length - 1]
    if (!last.startsWith(OPEN_EDGE_MARKER)) {
      throw new Error(`parse: final segment does not start with "${OPEN_EDGE_MARKER}"`)
    }
  }

  for (const [i, seg] of deposits.entries()) {
    if (!seg) throw new Error(`parse: empty deposit body at segment ${i + 1}`)
    if (seg.includes(OPEN_EDGE_MARKER)) {
      throw new Error(`parse: "${OPEN_EDGE_MARKER}" appears in segment ${i + 1} — open edge must be the final segment only`)
    }
  }

  const edgeBody = last.slice(OPEN_EDGE_MARKER.length).trim()
  if (!edgeBody) throw new Error('parse: open edge marker present but body is empty')
  if (edgeBody.includes(OPEN_EDGE_MARKER)) {
    throw new Error(`parse: more than one "${OPEN_EDGE_MARKER}" in the final segment`)
  }

  const rows = deposits.map((body, i) => ({
    ordinal: i + 1,
    type: 'deposit',
    body,
    provenance: null,
  }))

  if (!/^none\.?$/i.test(edgeBody)) {
    rows.push({ ordinal: rows.length + 1, type: 'open_edge', body: edgeBody, provenance: null })
  }

  if (rows.length === 0) {
    throw new Error('parse: zero deposits and no open edge — nothing to insert')
  }

  return rows
}

// ---------------------------------------------------------------------------
// embed
// ---------------------------------------------------------------------------

// Same Gemini pipeline as utterances and edges: gemini-embedding-2-preview,
// SEMANTIC_SIMILARITY, 3072 dims — byte-identical config to embedText()
// (src/services/embeddingService.ts) and the script-side embed() in
// backfill-edge-embeddings.mjs, so deposits live in the shared vector space.
// (The client TS module can't be imported from a node script — it pulls in
// the browser supabase client — so this mirrors it; keep in lockstep.)
//
// Sequential, no retries: any embed failure throws and the caller abandons
// the whole generation. Returns new row objects with `embedding` attached.
export async function embedBodies(rows, geminiApiKey) {
  const ai = new GoogleGenAI({ apiKey: geminiApiKey })
  const out = []
  for (const row of rows) {
    const res = await ai.models.embedContent({
      model: 'gemini-embedding-2-preview',
      contents: { parts: [{ text: row.body }] },
      config: { taskType: 'SEMANTIC_SIMILARITY' },
    })
    const values = res.embeddings?.[0]?.values
    if (!values) throw new Error(`embed: Gemini returned no embedding for ordinal ${row.ordinal}`)
    if (values.length !== EMBEDDING_DIMS) {
      throw new Error(`embed: expected ${EMBEDDING_DIMS} dims, got ${values.length} for ordinal ${row.ordinal}`)
    }
    out.push({ ...row, embedding: values })
  }
  return out
}

// ---------------------------------------------------------------------------
// insert
// ---------------------------------------------------------------------------

function assertUuid(value, name) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error(`${name} is not a uuid: ${value}`)
  }
}

function dollarQuote(text, what) {
  if (text.includes(DQ)) {
    throw new Error(`${what} contains the dollar-quote tag ${DQ} — cannot safely quote for SQL`)
  }
  return `${DQ}${text}${DQ}`
}

function runPsql(dbUrl, sql) {
  // -X skips psqlrc; ON_ERROR_STOP makes any statement failure abort with a
  // non-zero exit (and, inside BEGIN/COMMIT, roll the transaction back).
  return execFileSync('psql', [dbUrl, '-X', '-v', 'ON_ERROR_STOP=1', '-f', '-'], {
    encoding: 'utf8',
    input: sql,
    maxBuffer: 64 * 1024 * 1024,
  })
}

// One transaction per session-generation:
//   1. prompt-version check — refuses to write rows under an unregistered
//      prompt (hash-is-version, self-enforcing)
//   2. --regenerate only: stamp superseded_at on every active row
//   3. compute generation = max + 1 under the same transaction
//   4. insert all rows
// The unique (session_id, generation, ordinal) constraint backstops races.
export function insertGeneration({ dbUrl, sessionId, rows, model, promptVersion, regenerate }) {
  assertUuid(sessionId, 'sessionId')
  if (!/^[0-9a-f]{16}$/.test(promptVersion)) {
    throw new Error(`promptVersion is not a 16-hex hash: ${promptVersion}`)
  }
  if (rows.length === 0) throw new Error('insert: no rows')
  for (const row of rows) {
    if (!row.embedding || row.embedding.length !== EMBEDDING_DIMS) {
      throw new Error(`insert: ordinal ${row.ordinal} has no ${EMBEDDING_DIMS}-dim embedding — generate → embed → insert ordering violated`)
    }
  }

  const inserts = rows
    .map((row) => {
      const vector = `'[${row.embedding.join(',')}]'::extensions.halfvec(${EMBEDDING_DIMS})`
      const provenance = row.provenance === null ? 'NULL' : `${dollarQuote(JSON.stringify(row.provenance), `provenance ordinal ${row.ordinal}`)}::jsonb`
      return `INSERT INTO voice_session_deposits
  (session_id, generation, ordinal, type, body, provenance, embedding, model, prompt_version)
VALUES
  ('${sessionId}', :gen, ${row.ordinal}, '${row.type}', ${dollarQuote(row.body, `body ordinal ${row.ordinal}`)}, ${provenance}, ${vector}, ${dollarQuote(model, 'model')}, '${promptVersion}');`
    })
    .join('\n')

  const supersede = regenerate
    ? `UPDATE voice_session_deposits SET superseded_at = now() WHERE session_id = '${sessionId}' AND superseded_at IS NULL;`
    : ''

  const sql = `BEGIN;
DO $pv$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM summarization_prompts WHERE version = '${promptVersion}') THEN
    RAISE EXCEPTION 'prompt version ${promptVersion} is not registered in summarization_prompts — the running prompt text is unregistered; run --register-prompt first';
  END IF;
END
$pv$;
${supersede}
SELECT coalesce(max(generation), 0) + 1 AS gen FROM voice_session_deposits WHERE session_id = '${sessionId}' \\gset
${inserts}
SELECT :gen AS written_generation;
COMMIT;`

  const output = runPsql(dbUrl, sql)
  const match = output.match(/written_generation[\s\S]*?\n\s*(\d+)/)
  if (!match) throw new Error(`insert: could not read written_generation from psql output:\n${output}`)
  return Number(match[1])
}

// Insert-if-absent registration of (version, body) into summarization_prompts.
// Returns { version, inserted }.
export function registerPrompt({ dbUrl, promptText }) {
  const version = computePromptVersion(promptText)
  const sql = `INSERT INTO summarization_prompts (version, body)
VALUES ('${version}', ${dollarQuote(promptText, 'prompt body')})
ON CONFLICT (version) DO NOTHING;`
  const output = runPsql(dbUrl, sql)
  return { version, inserted: output.includes('INSERT 0 1') }
}
