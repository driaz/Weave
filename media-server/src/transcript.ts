const SUPADATA_API_KEY = process.env.SUPADATA_API_KEY

/**
 * Server-side transcript fetch via Supadata. The client also fetches the
 * same transcript for its 8s text-only embedding; these two fetches are
 * deliberately independent. Reading the client's transcript out of
 * Supabase is racy because client-side persistence is debounced 500ms
 * (and may never persist if the user navigates away). See README §2.
 *
 * Returns empty string on any failure — never throws. Every failure mode
 * logs a distinct warning so silent empty transcripts (especially common
 * on native Twitter video, where Supadata coverage is spottier than
 * YouTube) are visible in the Fly logs instead of just disappearing.
 */
export async function fetchTranscript(url: string): Promise<string> {
  if (!SUPADATA_API_KEY) {
    console.warn('[transcript] SUPADATA_API_KEY not set — skipping')
    return ''
  }
  if (!url) return ''

  const endpoint = `https://api.supadata.ai/v1/transcript?url=${encodeURIComponent(url)}`

  let res: Response
  try {
    res = await fetch(endpoint, { headers: { 'x-api-key': SUPADATA_API_KEY } })
  } catch (err) {
    console.warn(`[transcript] network error fetching ${url}:`, err)
    return ''
  }

  if (!res.ok) {
    // Try to surface the body — Supadata often returns an { error } envelope
    // on 4xx that names the actual problem (unsupported source, rate limit,
    // bad key). Bounded read so a malformed response can't blow up the log.
    let body = ''
    try { body = (await res.text()).slice(0, 300) } catch { /* ignore */ }
    console.warn(
      `[transcript] Supadata returned ${res.status} ${res.statusText} for ${url}` +
        (body ? ` — body: ${body}` : ''),
    )
    return ''
  }

  // Defensive content-type check. Supadata always returns JSON in practice,
  // but a misrouted response (gateway HTML, etc.) would otherwise blow up
  // inside res.json() and the parse-catch below would swallow it without
  // explaining what was wrong.
  const contentType = res.headers.get('content-type') ?? ''
  if (!contentType.includes('application/json')) {
    console.warn(
      `[transcript] Supadata returned 200 but content-type is "${contentType}" ` +
        `(expected application/json) for ${url}`,
    )
    return ''
  }

  let json: { transcript?: string; error?: string }
  try {
    json = (await res.json()) as { transcript?: string; error?: string }
  } catch (err) {
    console.warn(`[transcript] failed to parse Supadata JSON for ${url}:`, err)
    return ''
  }

  if (json.error) {
    console.warn(`[transcript] Supadata returned error for ${url}: ${json.error}`)
  }
  return json.transcript ?? ''
}
