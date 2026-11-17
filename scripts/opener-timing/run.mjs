// Opener timing harness: drives a real opening voice turn in headless Chromium
// as the dev test user, with a fake microphone, and reports where the time goes
// between the Speak click and the first audio byte reaching the player.
//
// It reads the app's own voice telemetry (the `[Weave]` console sink of
// voiceSessionLogger), so every mark below is an existing event, plus one mark
// the app doesn't log: the Speak click itself.
//
// Prerequisites (README.md in this folder has the full recipe):
//   - `npm run dev` with VITE_CLAUDE_PROXY_URL / VITE_WEAVE_MEDIA_URL pointing
//     wherever Claude and TTS should come from (mock-claude.mjs, local
//     media-server, or unset for Fly)
//   - VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, E2E_DEV_EMAIL, E2E_DEV_PASSWORD
//   - Playwright resolvable (`require('playwright')`)
//
//   node scripts/opener-timing/run.mjs [--runs 5] [--label "distributed memory"]
//        [--app http://localhost:5173] [--dwell 2000] [--json out.json]

import { createRequire } from 'node:module'
import { parseArgs } from 'node:util'
import { writeFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'

const require = createRequire(import.meta.url)
const { chromium } = require('playwright')

const { values: args } = parseArgs({
  options: {
    runs: { type: 'string', default: '5' },
    label: { type: 'string' },
    app: { type: 'string', default: 'http://localhost:5173' },
    dwell: { type: 'string', default: '2000' },
    timeout: { type: 'string', default: '45000' },
    json: { type: 'string' },
    headed: { type: 'boolean', default: false },
    // Serve a prod-shaped deposit corpus (72 rows × 3072-d, ≈2.8 MB of
    // embedding text, the prod size on 2026-11-17) in place of dev's empty
    // one, held for --deposit-delay ms. SYNTHETIC: the delay stands in for
    // the prod download (rd→deposit_corpus median ≈ 2.06 s, minus the edge
    // lookup and the two board-resolution reads, which still run for real).
    'deposit-fixture': { type: 'boolean', default: false },
    'deposit-delay': { type: 'string', default: '1400' },
    'deposit-rows': { type: 'string', default: '72' },
  },
})

function buildDepositFixture(rows) {
  const vec = () => `[${Array.from({ length: 3072 }, () => (Math.random() * 2 - 1).toFixed(6)).join(',')}]`
  return JSON.stringify(
    Array.from({ length: rows }, (_, i) => ({
      id: crypto.randomUUID(),
      session_id: crypto.randomUUID(),
      type: i % 5 === 0 ? 'open_edge' : 'deposit',
      body: `Synthetic deposit ${i}: `.padEnd(745, 'a thought that surfaced in an earlier session. '),
      embedding: vec(),
    })),
  )
}
const depositFixture = args['deposit-fixture'] ? buildDepositFixture(Number(args['deposit-rows'])) : null

// Gaps reported, in pipeline order. Each is [name, fromMark, toMark].
// `speak.click` is recorded by the harness; everything else is a voice event.
// "first_audio" is voice.mux.segment_writing (first PCM bytes handed to the
// player): voice.mux.first_audio is not routed through the logger, and
// segment_writing is the mark prod processing_log also carries, so local and
// prod numbers line up.
export const GAPS = [
  ['click→session.started', 'speak.click', 'voice.session.started'],
  ['session.started→ready', 'voice.session.started', 'voice.session.ready'],
  ['ready→turn.started (snapshot+retrieval)', 'voice.session.ready', 'voice.turn.started'],
  ['turn.started→request_sent', 'voice.turn.started', 'voice.claude.request_sent'],
  ['request_sent→first_text (TTFT)', 'voice.claude.request_sent', 'voice.claude.first_text_delta'],
  ['first_text→tts.requested (1st sentence)', 'voice.claude.first_text_delta', 'voice.tts.segment_requested'],
  ['tts.requested→segment_added (TTS TTFB)', 'voice.tts.segment_requested', 'voice.mux.segment_added'],
  ['segment_added→first_audio', 'voice.mux.segment_added', 'voice.mux.segment_writing'],
  ['TOTAL click→first_audio', 'speak.click', 'voice.mux.segment_writing'],
]

const required = ['VITE_SUPABASE_URL', 'VITE_SUPABASE_ANON_KEY', 'E2E_DEV_EMAIL', 'E2E_DEV_PASSWORD']
const missing = required.filter((k) => !process.env[k])
if (missing.length) {
  console.error(`missing env: ${missing.join(', ')}`)
  process.exit(2)
}

const supabase = createClient(process.env.VITE_SUPABASE_URL, process.env.VITE_SUPABASE_ANON_KEY)
const projectRef = new URL(process.env.VITE_SUPABASE_URL).hostname.split('.')[0]

async function freshSession() {
  const { data, error } = await supabase.auth.signInWithPassword({
    email: process.env.E2E_DEV_EMAIL,
    password: process.env.E2E_DEV_PASSWORD,
  })
  if (error) throw new Error(`dev sign-in failed: ${error.message}`)
  return data.session
}

// Runs in the page before any app code: capture every `[Weave]` console
// payload with a performance.now() stamp (first occurrence per phase wins,
// which is the opener's for every phase we read).
function installMarkCapture() {
  const marks = {}
  const details = {}
  window.__openerMarks = marks
  window.__openerDetails = details
  for (const level of ['info', 'log', 'warn']) {
    const orig = console[level].bind(console)
    console[level] = (...a) => {
      try {
        if (a[0] === '[Weave]' && a[1] && typeof a[1].phase === 'string') {
          const phase = a[1].phase
          if (!(phase in marks)) {
            marks[phase] = performance.now()
            details[phase] = a[1].detail ?? null
          }
        }
      } catch {
        /* never break the app */
      }
      orig(...a)
    }
  }
}

async function runOnce(browser, i) {
  const session = await freshSession()
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } })
  await context.addInitScript(
    ([key, value]) => {
      localStorage.setItem(key, value)
      localStorage.setItem('weave.voice.logLevel', 'verbose')
    },
    [`sb-${projectRef}-auth-token`, JSON.stringify(session)],
  )
  await context.addInitScript(installMarkCapture)
  if (depositFixture) {
    await context.route('**/rest/v1/real_voice_session_deposits*', async (route) => {
      await new Promise((r) => setTimeout(r, Number(args['deposit-delay'])))
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { 'access-control-allow-origin': '*' },
        body: depositFixture,
      })
    })
  }
  const page = await context.newPage()
  const pageErrors = []
  page.on('pageerror', (e) => pageErrors.push(e.message))

  await page.goto(args.app)
  const label = args.label
    ? page.getByText(args.label, { exact: true }).first()
    : page.locator('.react-flow__edgelabel-renderer [class*="cursor-pointer"], .react-flow__edgelabel-renderer button').first()
  await label.waitFor({ state: 'visible', timeout: 20000 })
  // Dwell: time a person spends on the board before clicking Speak. Matters
  // once anything is prefetched at board load.
  await page.waitForTimeout(Number(args.dwell))
  await label.click()
  const speak = page.getByRole('button', { name: 'Speak', exact: true })
  await speak.waitFor({ state: 'visible', timeout: 10000 })
  await page.evaluate(() => {
    window.__openerMarks['speak.click'] = performance.now()
  })
  await speak.click()

  const done = await page
    .waitForFunction(
      () => 'voice.mux.segment_writing' in window.__openerMarks || 'voice.session.error' in window.__openerMarks,
      null,
      { timeout: Number(args.timeout), polling: 50 },
    )
    .then(() => true)
    .catch(() => false)

  const { marks, details } = await page.evaluate(() => ({
    marks: window.__openerMarks,
    details: window.__openerDetails,
  }))

  // End the session cleanly so the next run starts from idle.
  await page
    .getByRole('button', { name: 'End voice session' })
    .click({ timeout: 3000 })
    .catch(() => {})
  await page.waitForTimeout(500)
  await context.close()

  const gaps = {}
  for (const [name, from, to] of GAPS) {
    gaps[name] = from in marks && to in marks ? Math.round(marks[to] - marks[from]) : null
  }
  const turn = details['voice.turn.started'] ?? {}
  const corpus = details['voice.retrieval.deposit_corpus']
  const shape = {
    snapshotPresent: Boolean(turn.snapshotId),
    relatedMaterialPresent: Boolean(turn.relatedMaterialPresent),
    depositCorpus: corpus ? corpus.loaded : null,
    nodeBandRan: 'voice.retrieval.band' in marks,
  }
  console.log(
    `run ${i + 1}: ${done ? 'ok' : 'TIMEOUT'} total=${gaps['TOTAL click→first_audio']}ms ` +
      `gap1=${gaps['ready→turn.started (snapshot+retrieval)']}ms ${JSON.stringify(shape)}` +
      (pageErrors.length ? ` pageErrors=${pageErrors.length}` : ''),
  )
  return { ok: done, gaps, shape, marks }
}

function stats(xs) {
  const v = xs.filter((x) => typeof x === 'number').sort((a, b) => a - b)
  if (!v.length) return null
  const q = (p) => v[Math.min(v.length - 1, Math.max(0, Math.round(p * (v.length - 1))))]
  return { n: v.length, median: q(0.5), min: v[0], max: v[v.length - 1] }
}

const browser = await chromium.launch({
  headless: !args.headed,
  args: [
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
  ],
})
const runs = []
for (let i = 0; i < Number(args.runs); i++) runs.push(await runOnce(browser, i))
await browser.close()

const summary = {}
console.log('\n| gap | median | min | max | n |\n|---|---:|---:|---:|---:|')
for (const [name] of GAPS) {
  const s = stats(runs.map((r) => r.gaps[name]))
  summary[name] = s
  console.log(s ? `| ${name} | ${s.median} | ${s.min} | ${s.max} | ${s.n} |` : `| ${name} | – | – | – | 0 |`)
}
if (args.json) writeFileSync(args.json, JSON.stringify({ args, summary, runs }, null, 2))
