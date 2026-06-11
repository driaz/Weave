// Voice session summarization — probe (default) and deposits write path.
//
// Modes:
//   node scripts/summarizeVoiceSession.mjs <session_id>
//       PROBE (default, read-only): Opus call, summary to stdout and
//       tmp/session-summary-<uuid>-<timestamp>.txt, parser dry-run report.
//       No DB writes of any kind.
//
//   node scripts/summarizeVoiceSession.mjs <session_id> --write
//       Full generate → parse → embed → insert flow, one transaction per
//       session-generation. Skip-by-default: if the session has any active
//       (non-superseded) generation, skips without calling Opus.
//
//   node scripts/summarizeVoiceSession.mjs <session_id> --write --regenerate
//       Flips skip semantics to supersede semantics: inserts generation N+1
//       and stamps superseded_at on generation N in the same transaction.
//
//   node scripts/summarizeVoiceSession.mjs --all --write
//       Iterates every session in voice_sessions (started_at order).
//       Respects skip-by-default. One log line per session; failures are
//       logged and skipped, no retries — rerun to pick up casualties.
//
//   node scripts/summarizeVoiceSession.mjs --register-prompt
//       Inserts (version, body) of the current prompt file into
//       summarization_prompts, insert-if-absent. version = sha256 of the
//       file bytes, first 16 hex chars, computed at runtime.
//
// ENVIRONMENT — reads .env in the repo root for read-only config:
//   WEAVE_PROD_RO_DATABASE_URL   read-only (SELECT-only) prod role, via psql
//   ANTHROPIC_API_KEY            falls back to VITE_ANTHROPIC_API_KEY
//   VITE_GEMINI_API_KEY          embeddings (write mode only)
//
//   WEAVE_PROD_RW_DATABASE_URL   write-capable connection string. Read from
//       process.env ONLY — never from .env, never committed, never logged.
//       Required by --write and --register-prompt; prepend it to the command
//       at runtime. The script fails loud if it is absent in those modes.
//
// The RO role is SELECT-only by design. A "permission denied" from psql is
// the role boundary working — this script reports it and exits; it never
// escalates to another credential.

import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import {
  computePromptVersion,
  embedBodies,
  insertGeneration,
  parseSummary,
  registerPrompt,
} from './lib/depositsWritePath.mjs'

const env = Object.fromEntries(
  readFileSync(new URL('../.env', import.meta.url), 'utf8')
    .split('\n')
    .filter((l) => l.includes('=') && !l.trimStart().startsWith('#'))
    .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]),
)

const RO_DB_URL = process.env.WEAVE_PROD_RO_DATABASE_URL || env.WEAVE_PROD_RO_DATABASE_URL
// VITE_ fallback is a workaround for the client-bundled key (backlog #6); goes away when keys route through Fly.
const API_KEY =
  process.env.ANTHROPIC_API_KEY ||
  env.ANTHROPIC_API_KEY ||
  process.env.VITE_ANTHROPIC_API_KEY ||
  env.VITE_ANTHROPIC_API_KEY
const GEMINI_KEY = process.env.VITE_GEMINI_API_KEY || env.VITE_GEMINI_API_KEY
// Write-capable URL: process.env ONLY, deliberately not read from .env — it
// must never live in a file in this repo.
const RW_DB_URL = process.env.WEAVE_PROD_RW_DATABASE_URL

const MODEL = 'claude-opus-4-6'

// ------- argument parsing -------

const args = process.argv.slice(2)
const flags = new Set(args.filter((a) => a.startsWith('--')))
const positional = args.filter((a) => !a.startsWith('--'))
const WRITE = flags.has('--write')
const REGENERATE = flags.has('--regenerate')
const ALL = flags.has('--all')
const REGISTER = flags.has('--register-prompt')

const known = new Set(['--write', '--regenerate', '--all', '--register-prompt'])
for (const f of flags) {
  if (!known.has(f)) {
    console.error(`Unknown flag: ${f}`)
    process.exit(1)
  }
}
if (REGENERATE && !WRITE) {
  console.error('--regenerate is only meaningful with --write')
  process.exit(1)
}
if (ALL && !WRITE) {
  console.error('--all requires --write (probe mode takes a single session id)')
  process.exit(1)
}
if (ALL && REGENERATE) {
  console.error('--all --regenerate is refused: regeneration is a per-session decision, not a bulk one')
  process.exit(1)
}

if (!RO_DB_URL) {
  console.error('Missing env: WEAVE_PROD_RO_DATABASE_URL (read-only prod connection string)')
  process.exit(1)
}
if ((WRITE || REGISTER) && !RW_DB_URL) {
  console.error(
    'Missing env: WEAVE_PROD_RW_DATABASE_URL — write mode requires the write-capable connection string, set in process.env at runtime (never in .env).',
  )
  process.exit(1)
}
if (WRITE && !GEMINI_KEY) {
  console.error('Missing env: VITE_GEMINI_API_KEY — write mode embeds deposits before insert.')
  process.exit(1)
}

// ------- shared helpers -------

function roQuery(sql) {
  try {
    return execFileSync('psql', [RO_DB_URL, '-X', '-t', '-A', '-v', 'ON_ERROR_STOP=1', '-c', sql], {
      encoding: 'utf8',
    })
  } catch (err) {
    const stderr = err.stderr?.toString() ?? String(err)
    if (stderr.includes('permission denied')) {
      console.error('psql: permission denied — the read-only role boundary. Stopping; not retrying with other credentials.')
      process.exit(1)
    }
    throw new Error(`psql query failed: ${stderr.trim()}`)
  }
}

function loadPrompt() {
  try {
    return readFileSync(new URL('../prompts/voiceSessionSummary.txt', import.meta.url), 'utf8')
  } catch {
    console.error('Missing prompts/voiceSessionSummary.txt — the summarization prompt file is required.')
    process.exit(1)
  }
}

// Transcript fetch + the fail-loud checks (SELECT only; embedding column
// untouched — vector-less rows are a known valid state). Throws instead of
// exiting so --all can log the casualty and continue.
function fetchTranscript(sessionId) {
  const sql = `
    SELECT coalesce(json_agg(json_build_object(
      'speaker', speaker,
      'text', text,
      'utterance_index', utterance_index
    ) ORDER BY utterance_index), '[]'::json)
    FROM voice_utterances
    WHERE session_id = '${sessionId}'
  `
  const rows = JSON.parse(roQuery(sql).trim())

  if (rows.length === 0) throw new Error(`no utterance rows — nothing to summarize`)

  const gaps = []
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].utterance_index !== i) gaps.push(`expected index ${i}, found ${rows[i].utterance_index}`)
  }
  if (gaps.length > 0) throw new Error(`non-contiguous utterance_index:\n  ${gaps.join('\n  ')}`)

  const empty = rows.filter((r) => !r.text || r.text.trim().length === 0)
  if (empty.length > 0) {
    throw new Error(`empty/whitespace-only text at index(es): ${empty.map((r) => r.utterance_index).join(', ')}`)
  }

  return rows.map((r) => `${r.speaker.toUpperCase()}: ${r.text}`).join('\n')
}

async function callOpus(systemPrompt, transcript) {
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 16000,
      thinking: { type: 'adaptive' },
      system: systemPrompt,
      messages: [{ role: 'user', content: transcript }],
    }),
  })

  if (!resp.ok) throw new Error(`Anthropic API error ${resp.status}: ${await resp.text()}`)

  const message = await resp.json()
  const summary = message.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
  if (!summary.trim()) throw new Error(`API returned no text content (stop_reason: ${message.stop_reason})`)

  return { summary, usage: message.usage ?? null }
}

function saveSummary(sessionId, summary) {
  mkdirSync(new URL('../tmp/', import.meta.url), { recursive: true })
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  const relPath = `tmp/session-summary-${sessionId}-${timestamp}.txt`
  writeFileSync(new URL(`../${relPath}`, import.meta.url), summary)
  return relPath
}

function hasActiveGeneration(sessionId) {
  const out = roQuery(
    `SELECT count(*) FROM active_voice_session_deposits WHERE session_id = '${sessionId}'`,
  ).trim()
  return Number(out) > 0
}

function formatUsage(usage) {
  if (!usage) return 'tokens n/a'
  return `tokens in=${usage.input_tokens ?? '?'} out=${usage.output_tokens ?? '?'}`
}

// Full write flow for one session. Returns a result object for the log line.
// Throws on any failure — caller decides whether that exits (single) or
// continues (--all). No retries by design.
async function writeSession(sessionId, { systemPrompt, promptVersion, regenerate }) {
  if (!regenerate && hasActiveGeneration(sessionId)) {
    return { outcome: 'skipped (active generation exists)', deposits: 0, usage: null }
  }

  const transcript = fetchTranscript(sessionId)
  console.error(`[write] ${sessionId}: ${transcript.length} chars assembled`)

  const { summary, usage } = await callOpus(systemPrompt, transcript)
  const saved = saveSummary(sessionId, summary)
  console.error(`[write] ${sessionId}: raw output saved to ${saved}`)

  const rows = parseSummary(summary)
  const embedded = await embedBodies(rows, GEMINI_KEY)
  const generation = insertGeneration({
    dbUrl: RW_DB_URL,
    sessionId,
    rows: embedded,
    model: MODEL,
    promptVersion,
    regenerate,
  })

  return { outcome: `written gen ${generation}`, deposits: rows.length, usage }
}

// ------- mode: --register-prompt -------

if (REGISTER) {
  const promptText = loadPrompt()
  const { version, inserted } = registerPrompt({ dbUrl: RW_DB_URL, promptText })
  console.log(`prompt version ${version}: ${inserted ? 'registered' : 'already registered (no-op)'}`)
  process.exit(0)
}

// ------- session id validation (probe and single-session write) -------

const sessionId = positional[0]
if (!ALL) {
  if (!sessionId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionId)) {
    console.error('Usage: node scripts/summarizeVoiceSession.mjs <session_id (uuid)> [--write] [--regenerate]')
    console.error('       node scripts/summarizeVoiceSession.mjs --all --write')
    console.error('       node scripts/summarizeVoiceSession.mjs --register-prompt')
    process.exit(1)
  }
}

const systemPrompt = loadPrompt()
const promptVersion = computePromptVersion(systemPrompt)

if (!API_KEY) {
  console.error('Missing env: checked ANTHROPIC_API_KEY and VITE_ANTHROPIC_API_KEY — neither set')
  process.exit(1)
}

// ------- mode: probe (default — read-only, no DB writes) -------

if (!WRITE) {
  let transcript
  try {
    transcript = fetchTranscript(sessionId)
  } catch (err) {
    console.error(`Session ${sessionId}: ${err.message}`)
    process.exit(1)
  }
  console.error(`[summarize] ${transcript.length} chars assembled`)

  let result
  try {
    result = await callOpus(systemPrompt, transcript)
  } catch (err) {
    console.error(err.message)
    process.exit(1)
  }

  console.log(result.summary)
  const saved = saveSummary(sessionId, result.summary)
  console.error(`[summarize] saved to ${saved} (${formatUsage(result.usage)})`)

  // Parser dry-run: shows the typed rows this output would produce. A parse
  // failure here is loud but the raw output is already saved above.
  try {
    const rows = parseSummary(result.summary)
    console.error(`[parse] ${rows.length} row(s):`)
    for (const r of rows) {
      console.error(`  ${r.ordinal}. [${r.type}] ${r.body.length} chars: ${r.body.slice(0, 80).replace(/\n/g, ' ')}…`)
    }
  } catch (err) {
    console.error(`[parse] FAILED: ${err.message}`)
    process.exit(1)
  }
  process.exit(0)
}

// ------- write modes -------

// Prompt registration is checked before any Opus spend (the insert
// transaction re-checks authoritatively).
const registered = roQuery(
  `SELECT count(*) FROM summarization_prompts WHERE version = '${promptVersion}'`,
).trim()
if (Number(registered) === 0) {
  console.error(
    `Prompt version ${promptVersion} is not registered in summarization_prompts — the running prompt text is unregistered. Run --register-prompt first.`,
  )
  process.exit(1)
}

if (!ALL) {
  try {
    const result = await writeSession(sessionId, { systemPrompt, promptVersion, regenerate: REGENERATE })
    console.log(`${sessionId}: ${result.outcome}, ${result.deposits} row(s), ${formatUsage(result.usage)}`)
  } catch (err) {
    console.error(`${sessionId}: FAILED — ${err.message}`)
    process.exit(1)
  }
  process.exit(0)
}

// ------- mode: --all (backfill) -------

const sessionIds = roQuery(`SELECT id FROM voice_sessions ORDER BY started_at`)
  .trim()
  .split('\n')
  .filter(Boolean)

console.error(`=== deposits backfill ===`)
console.error(`sessions:        ${sessionIds.length} (skip-by-default — sessions with an active generation are not re-run)`)
console.error(`prompt version:  ${promptVersion}`)
console.error(`model:           ${MODEL}`)
console.error(`expectations:    QA stubs produce honest thin output — one deposit, not an error.`)
console.error(`                 Budget order-of-magnitude: a few dollars total, ~5 cents per rich session.`)
console.error(`                 Sequential, no retries — failures are logged and skipped; rerun to pick up casualties.`)
console.error(``)

let written = 0
let skipped = 0
let failed = 0

for (const id of sessionIds) {
  try {
    const result = await writeSession(id, { systemPrompt, promptVersion, regenerate: false })
    if (result.outcome.startsWith('skipped')) skipped++
    else written++
    console.log(`${id}  ${result.outcome}  deposits=${result.deposits}  ${formatUsage(result.usage)}`)
  } catch (err) {
    failed++
    console.log(`${id}  FAILED — ${err.message.split('\n')[0]}`)
  }
}

console.error(``)
console.error(`=== backfill summary ===`)
console.error(`written: ${written}   skipped: ${skipped}   failed: ${failed}`)

const coverage = roQuery(
  `SELECT (SELECT count(DISTINCT session_id) FROM active_voice_session_deposits) || ' / ' || (SELECT count(*) FROM voice_sessions)`,
).trim()
console.error(`coverage: ${coverage} sessions have active deposits`)

process.exit(failed > 0 ? 1 : 0)
