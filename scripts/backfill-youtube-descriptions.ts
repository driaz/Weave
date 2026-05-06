// Standalone backfill for YouTube nodes missing `contentDescription`.
//
// The Netlify-function variant (netlify/functions/backfill-youtube-descriptions.ts)
// can't run under Vite, so this script exists for local iteration against
// Weave-Dev. Reuses the shared prompt + Sonnet helper at
// netlify/lib/youtubeDescription.ts so the backfill logic stays in one place.
//
// Run with:
//   npx tsx scripts/backfill-youtube-descriptions.ts --dry-run --limit 2
//   npx tsx scripts/backfill-youtube-descriptions.ts --limit 50
//   npx tsx scripts/backfill-youtube-descriptions.ts                # full pass
//
// Reads SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, and ANTHROPIC_API_KEY
// from .env.local (preferred) or .env in the project root. Uses the
// service role so RLS is bypassed for the table scan + jsonb merge.
//
// SAFETY: this hits whichever Supabase project your local env points at.
// Per CLAUDE.md the local .env is wired to Weave-Dev — if you've re-linked
// the CLI for a prod migration, double-check before running.

import { createClient } from '@supabase/supabase-js'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { generateYouTubeDescription } from '../netlify/lib/youtubeDescription.ts'

const RATE_LIMIT_MS = 500

// ---------------------------------------------------------------------------
// Env loading
// ---------------------------------------------------------------------------

const projectRoot = resolve(fileURLToPath(import.meta.url), '../..')

/**
 * Minimal .env loader that overrides any existing process.env entries.
 *
 * We can't use Node's built-in `process.loadEnvFile()` because it refuses
 * to overwrite values that already exist in process.env — and the Claude
 * Code shell exports an empty `ANTHROPIC_API_KEY=""` for proxy routing,
 * which silently shadows the real key from .env. Hand-rolled is the
 * smaller fix than asking every user to `unset ANTHROPIC_API_KEY` first.
 *
 * Supports `KEY=value` and `KEY="value"` lines. No interpolation, no
 * multi-line — same surface as the existing .env files in this repo.
 */
function loadEnvFileOverride(filename: string): boolean {
  const path = resolve(projectRoot, filename)
  if (!existsSync(path)) return false
  const text = readFileSync(path, 'utf8')
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq === -1) continue
    const key = line.slice(0, eq).trim()
    let value = line.slice(eq + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    if (key) process.env[key] = value
  }
  return true
}

// .env loaded first so .env.local can override individual keys
// (Vite-style precedence).
const loadedEnv = loadEnvFileOverride('.env')
const loadedEnvLocal = loadEnvFileOverride('.env.local')
console.log(
  `[backfill] env: .env=${loadedEnv ? 'loaded' : 'missing'} ` +
    `.env.local=${loadedEnvLocal ? 'loaded' : 'missing'}`,
)

const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !ANTHROPIC_API_KEY) {
  console.error(
    'Missing required env vars. Need SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ANTHROPIC_API_KEY.',
  )
  process.exit(1)
}

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): { dryRun: boolean; limit: number | null } {
  let dryRun = false
  let limit: number | null = null
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--dry-run') {
      dryRun = true
    } else if (arg === '--limit') {
      const next = argv[i + 1]
      const n = Number(next)
      if (!Number.isFinite(n) || n <= 0) {
        console.error(`--limit requires a positive number, got: ${next}`)
        process.exit(1)
      }
      limit = Math.floor(n)
      i++
    } else if (arg.startsWith('--limit=')) {
      const n = Number(arg.slice('--limit='.length))
      if (!Number.isFinite(n) || n <= 0) {
        console.error(`--limit requires a positive number, got: ${arg}`)
        process.exit(1)
      }
      limit = Math.floor(n)
    } else {
      console.error(`Unknown arg: ${arg}`)
      console.error('Usage: backfill-youtube-descriptions.ts [--dry-run] [--limit N]')
      process.exit(1)
    }
  }
  return { dryRun, limit }
}

const { dryRun, limit } = parseArgs(process.argv.slice(2))

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const supabase = createClient(SUPABASE_URL!, SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  // Surface which project we're hitting before any writes happen — same
  // confirmation pattern as the in-app DEV pill.
  const projectRef = SUPABASE_URL!.match(/https:\/\/([a-z0-9]+)\./)?.[1] ?? '<unknown>'
  console.log(
    `[backfill] connected to Supabase project: ${projectRef} ` +
      `(dry_run=${dryRun}, limit=${limit ?? 'none'})`,
  )

  let query = supabase
    .from('nodes')
    .select('id, board_id, data')
    .eq('card_type', 'link')
    .eq('link_type', 'youtube')
    .is('data->>contentDescription', null)

  if (limit !== null) {
    query = query.limit(limit)
  }

  const { data: rows, error } = await query
  if (error) {
    console.error(`[backfill] query failed: ${error.message}`)
    process.exit(1)
  }

  const candidates = ((rows ?? []) as NodeRow[]).filter((row) => {
    const blob = row.data ?? {}
    if (typeof blob !== 'object') return false
    if (getString(blob, 'contentDescription').trim().length > 0) return false
    return pickTranscript(blob).trim().length > 0
  })

  console.log(`[backfill] found ${candidates.length} candidate YouTube node(s)`)

  let generated = 0
  let written = 0
  let failed = 0
  let skipped = 0

  for (let i = 0; i < candidates.length; i++) {
    const row = candidates[i]
    const blob = row.data
    const title = getString(blob, 'title').trim()
    const channel = getString(blob, 'authorName').trim() || null
    const transcript = pickTranscript(blob)
    const tonalContext = pickTonalContext(blob)

    if (!title) {
      console.warn(`[backfill] node ${row.id}: skipped — no title`)
      skipped++
      continue
    }

    const result = await generateYouTubeDescription(ANTHROPIC_API_KEY!, {
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
    } else {
      generated++
      const description = result.description
      console.log(
        `Generated description for node ${row.id}: ${description.slice(0, 50)}...`,
      )

      if (!dryRun) {
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
        } else {
          written++
        }
      }
    }

    if (i < candidates.length - 1) {
      await sleep(RATE_LIMIT_MS)
    }
  }

  console.log(
    `[backfill] done — examined=${candidates.length} generated=${generated} ` +
      `written=${written} failed=${failed} skipped=${skipped} ` +
      `(dry_run=${dryRun})`,
  )
}

main().catch((err) => {
  console.error('[backfill] unexpected error:', err)
  process.exit(1)
})
