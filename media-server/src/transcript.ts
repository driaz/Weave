const SUPADATA_API_KEY = process.env.SUPADATA_API_KEY

/**
 * Server-side transcript fetch via Supadata. The client also fetches the
 * same transcript for its 8s text-only embedding; these two fetches are
 * deliberately independent. Reading the client's transcript out of
 * Supabase is racy because client-side persistence is debounced 500ms
 * (and may never persist if the user navigates away). See README §2.
 *
 * Returns empty string on any failure — never throws.
 */
export async function fetchTranscript(url: string): Promise<string> {
  if (!SUPADATA_API_KEY) {
    console.warn('[transcript] SUPADATA_API_KEY not set — skipping')
    return ''
  }
  if (!url) return ''

  try {
    const res = await fetch(`https://api.supadata.ai/v1/transcript?url=${encodeURIComponent(url)}`, {
      headers: { 'x-api-key': SUPADATA_API_KEY },
    })
    if (!res.ok) return ''
    const json = (await res.json()) as { transcript?: string }
    return json.transcript ?? ''
  } catch {
    return ''
  }
}
