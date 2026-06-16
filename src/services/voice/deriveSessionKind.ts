/**
 * Classify a voice session as a genuine reflection session ('real') or a
 * QA / smoke-test session ('qa'), from the page's hostname at create time.
 *
 * `session_kind` (migration 036) scopes the deposit corpus: real sessions feed
 * `real_voice_session_deposits`; QA sessions are flagged out (but stay
 * queryable via `active_voice_session_deposits`). The row is minted in the
 * browser (`persistence/voiceSessions.ts` → `createSession`), so
 * `window.location.hostname` is natively in scope — no server origin to thread.
 *
 * Predicate is a BLACKLIST, defaulting to 'real' — we never hardcode the
 * production hostname (it isn't referenced anywhere in the repo, and a custom
 * domain or a renamed Netlify slug would silently fall out of an allowlist).
 * A host is 'qa' when it carries a Netlify deploy/preview marker or is a local
 * dev host; everything else — the bare production domain, a custom domain — is
 * 'real'.
 *
 *   - `--`        Netlify deploy/preview subdomain marker. Branch previews
 *                 (`feat-036-session-kind--<slug>.netlify.app`) and deploy
 *                 previews (`deploy-preview-12--<slug>.netlify.app`) both
 *                 contain it; production (`<slug>.netlify.app` or a custom
 *                 domain) never does. This is what makes the QA preview I
 *                 deploy to test migration 036 self-classify as 'qa'.
 *   - local hosts `localhost`, `127.*` (IPv4 loopback), `::1` (IPv6 loopback),
 *                 `*.local` (mDNS / Bonjour). A local session is definitionally
 *                 not a real reflection session for the corpus.
 */
export type SessionKind = 'real' | 'qa'

export function deriveSessionKind(hostname: string): SessionKind {
  const host = hostname.trim().toLowerCase()

  // Netlify deploy/preview marker — branch previews and deploy previews.
  if (host.includes('--')) return 'qa'

  // Local dev hosts.
  if (
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host.startsWith('127.') ||
    host === '::1' ||
    host === '[::1]' ||
    host.endsWith('.local')
  ) {
    return 'qa'
  }

  return 'real'
}
