// ONE-SHOT PROBE — voice session summarization (v1, read-only).
//
// Generates ONE summary from a real voice session so we can read it and
// decide the atomic unit for #3. This is an instrument, not a feature:
// no DB writes of any kind. The summary prints to stdout and is saved to
// tmp/session-summary-<session_id>.txt. Persisting to
// voice_sessions.summary is explicitly deferred.
//
// Usage:
//   node scripts/summarizeVoiceSession.mjs <session_id>
//
// ENVIRONMENT — reads .env in the repo root:
//   WEAVE_PROD_RO_DATABASE_URL   read-only (SELECT-only) prod role, via psql
//   ANTHROPIC_API_KEY            falls back to VITE_ANTHROPIC_API_KEY
//
// The DB role is SELECT-only by design. A "permission denied" from psql is
// the role boundary working — this script reports it and exits; it never
// escalates to another credential.

import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'

const env = Object.fromEntries(
  readFileSync(new URL('../.env', import.meta.url), 'utf8')
    .split('\n')
    .filter((l) => l.includes('=') && !l.trimStart().startsWith('#'))
    .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]),
)

const DB_URL = process.env.WEAVE_PROD_RO_DATABASE_URL || env.WEAVE_PROD_RO_DATABASE_URL
const API_KEY =
  process.env.ANTHROPIC_API_KEY ||
  env.ANTHROPIC_API_KEY ||
  process.env.VITE_ANTHROPIC_API_KEY ||
  env.VITE_ANTHROPIC_API_KEY

if (!DB_URL) {
  console.error('Missing env: WEAVE_PROD_RO_DATABASE_URL (read-only prod connection string)')
  process.exit(1)
}
if (!API_KEY) {
  console.error('Missing env: checked ANTHROPIC_API_KEY and VITE_ANTHROPIC_API_KEY — neither set')
  process.exit(1)
}

const sessionId = process.argv[2]
if (!sessionId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionId)) {
  console.error('Usage: node scripts/summarizeVoiceSession.mjs <session_id (uuid)>')
  process.exit(1)
}

// ------- 1. read the transcript (SELECT only; embedding column untouched —
//            vector-less rows are a known valid state) -------

const sql = `
  SELECT coalesce(json_agg(json_build_object(
    'speaker', speaker,
    'text', text,
    'utterance_index', utterance_index
  ) ORDER BY utterance_index), '[]'::json)
  FROM voice_utterances
  WHERE session_id = '${sessionId}'
`

let raw
try {
  raw = execFileSync('psql', [DB_URL, '-t', '-A', '-c', sql], { encoding: 'utf8' })
} catch (err) {
  const stderr = err.stderr?.toString() ?? String(err)
  if (stderr.includes('permission denied')) {
    console.error('psql: permission denied — the read-only role boundary. Stopping; not retrying with other credentials.')
  } else {
    console.error('psql query failed:', stderr.trim())
  }
  process.exit(1)
}

const rows = JSON.parse(raw.trim())

// ------- 2. fail-loud transcript checks -------

if (rows.length === 0) {
  console.error(`No utterance rows for session ${sessionId} — nothing to summarize.`)
  process.exit(1)
}

const gaps = []
for (let i = 0; i < rows.length; i++) {
  if (rows[i].utterance_index !== i) gaps.push(`expected index ${i}, found ${rows[i].utterance_index}`)
}
if (gaps.length > 0) {
  console.error(`Non-contiguous utterance_index for session ${sessionId}:\n  ${gaps.join('\n  ')}`)
  process.exit(1)
}

const empty = rows.filter((r) => !r.text || r.text.trim().length === 0)
if (empty.length > 0) {
  console.error(
    `Empty/whitespace-only text in session ${sessionId} at index(es): ${empty.map((r) => r.utterance_index).join(', ')}`,
  )
  process.exit(1)
}

// ------- 3. assemble the transcript -------

const transcript = rows.map((r) => `${r.speaker.toUpperCase()}: ${r.text}`).join('\n')
console.error(`[summarize] ${rows.length} utterances, ${transcript.length} chars assembled`)

// ------- 4. load the summarization prompt -------

let systemPrompt
try {
  systemPrompt = readFileSync(new URL('../prompts/voiceSessionSummary.txt', import.meta.url), 'utf8')
} catch {
  console.error('Missing prompts/voiceSessionSummary.txt — the summarization prompt file is required.')
  process.exit(1)
}

// ------- 5. call the Anthropic API -------

const resp = await fetch('https://api.anthropic.com/v1/messages', {
  method: 'POST',
  headers: {
    'x-api-key': API_KEY,
    'anthropic-version': '2023-06-01',
    'content-type': 'application/json',
  },
  body: JSON.stringify({
    model: 'claude-opus-4-6',
    max_tokens: 16000,
    thinking: { type: 'adaptive' },
    system: systemPrompt,
    messages: [{ role: 'user', content: transcript }],
  }),
})

if (!resp.ok) {
  console.error(`Anthropic API error ${resp.status}: ${await resp.text()}`)
  process.exit(1)
}

const message = await resp.json()
const summary = message.content
  .filter((b) => b.type === 'text')
  .map((b) => b.text)
  .join('\n')

if (!summary.trim()) {
  console.error(`API returned no text content (stop_reason: ${message.stop_reason})`)
  process.exit(1)
}

// ------- 6. print + save locally (no DB write) -------

console.log(summary)

mkdirSync(new URL('../tmp/', import.meta.url), { recursive: true })
const outPath = new URL(`../tmp/session-summary-${sessionId}.txt`, import.meta.url)
writeFileSync(outPath, summary)
console.error(`[summarize] saved to tmp/session-summary-${sessionId}.txt`)
