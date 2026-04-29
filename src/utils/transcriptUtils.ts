/**
 * Fetch a transcript for any supported URL via the Supadata API proxy.
 * Works with YouTube videos, Twitter/X video tweets, and other platforms.
 *
 * Returns the transcript text, or empty string on any failure. Failures
 * never throw — the contract callers depend on. But every failure mode
 * now logs to the console so the silent-empty-string regression that
 * burned us in dev (Vite SPA fallback returning HTML for the function
 * path, JSON.parse exploding, bare catch returning '') is loud next time.
 */
export async function fetchTranscript(url: string): Promise<string> {
  if (!url) return ''

  const endpoint = `/.netlify/functions/youtube-transcript?url=${encodeURIComponent(url)}`

  let response: Response
  try {
    response = await fetch(endpoint)
  } catch (err) {
    console.warn(`[transcript] network error fetching ${endpoint}:`, err)
    return ''
  }

  if (!response.ok) {
    console.warn(
      `[transcript] ${endpoint} returned ${response.status} ${response.statusText}`,
    )
    return ''
  }

  // The most common reason for an OK response with no transcript is the
  // Vite dev server's SPA fallback handing back index.html for unmatched
  // routes (i.e. when the Netlify function isn't running locally — try
  // `netlify dev` instead of plain `npm run dev`). Without this guard,
  // the next line would throw inside JSON.parse and the bare catch below
  // would swallow it without a clue why transcripts never persist.
  const contentType = response.headers.get('content-type') ?? ''
  if (!contentType.includes('application/json')) {
    console.warn(
      `[transcript] ${endpoint} returned 200 but content-type is "${contentType}" ` +
        `(expected application/json). The Netlify function may not be running ` +
        `— try \`netlify dev\` instead of plain \`vite\`.`,
    )
    return ''
  }

  try {
    const data = (await response.json()) as { transcript?: string; error?: string }
    if (data.error) {
      console.warn(`[transcript] ${endpoint} returned error: ${data.error}`)
    }
    return data.transcript || ''
  } catch (err) {
    console.warn(`[transcript] failed to parse JSON from ${endpoint}:`, err)
    return ''
  }
}

/** @deprecated Use fetchTranscript instead */
export const fetchYouTubeTranscript = fetchTranscript
