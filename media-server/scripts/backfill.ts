/**
 * Backfill script — re-process every existing youtube/twitter link node
 * that doesn't yet have a server-grade embedding. Run locally against the
 * deployed Fly server.
 *
 * STUB. Wire up before running:
 *   1. Resolve the per-user JWT or a service token the Fly /process route
 *      will accept (see auth.ts — currently expects a user-issued Supabase JWT).
 *   2. Decide the filter: spec says "exclude test boards" — pass a board allowlist.
 *   3. Pick a sleep interval. 15s between requests is the spec default.
 *
 * Cost: ~$0.02-0.04 per video. Scrub test boards first.
 */

const FLY_URL = process.env.WEAVE_MEDIA_URL ?? 'http://localhost:3000'

async function main(): Promise<void> {
  console.error('backfill is not implemented — see TODOs at top of file')
  console.error('target:', FLY_URL)
  process.exit(1)
}

await main()
