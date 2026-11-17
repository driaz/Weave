/**
 * Image analysis-at-ingest helpers (#17). Pure — no env, no clients — so
 * the gate and the mime fallback are unit-testable without the server.
 */

/**
 * oEmbed tweet text carries a pic.twitter.com (or pic.x.com) link when the
 * tweet has attached media. A tweet without one can still have a stored
 * image — Microlink's pick for a text-only tweet is typically the author's
 * avatar or a link card — and that must never be analysed as "the photo".
 * Prod read 2026-11-17: 17 of 23 image-bearing tweets with no video signal
 * carry the link; the other 6 hold 2-25 KB images.
 */
const PHOTO_LINK_RE = /\bpic\.(?:twitter|x)\.com\//i

export function hasAttachedPhoto(tweetText: string): boolean {
  return PHOTO_LINK_RE.test(tweetText)
}

const MIME_BY_EXTENSION: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
}

/**
 * Storage's reported content type when it's an image, else derived from
 * the object key's extension (buildNodeImagePath writes png/jpg/gif/webp).
 * Null for anything Gemini can't read as an image (svg, bin).
 */
export function resolveImageMime(reported: string, path: string): string | null {
  if (reported.startsWith('image/') && reported !== 'image/svg+xml') return reported
  const ext = path.split('.').pop()?.toLowerCase() ?? ''
  return MIME_BY_EXTENSION[ext] ?? null
}
