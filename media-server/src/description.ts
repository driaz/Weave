import type { NodeUnionView } from './supabase.js'
import type { NodeLogger } from './logger.js'

/**
 * Server-side leg of the tweet description gate (PR-1.1 Fix C).
 *
 * The gate first runs client-side at transcript arrival, but media_analysis
 * always lands later (the Fly pipeline takes 30-90s vs ~22s for the client
 * transcript fetch), so the fusion arm of the gate can never trigger on a
 * live drop from the client. After analysis generation succeeds here, the
 * gate is re-evaluated against the union view (own artifacts ⊕ stored
 * JSONB) and, when it passes with no description in the union, the EXISTING
 * Netlify generator is called over HTTP — the prompt and generator are
 * deliberately not duplicated on Fly; one prompt, one generator, one place
 * to amend.
 *
 * WEAVE_NETLIFY_FN_URL is the full URL of the generate-tweet-description
 * function (e.g. https://<site>/.netlify/functions/generate-tweet-description).
 * Unset → the step logs a warn and is skipped; a missing description
 * degrades the embed, never fails the pipeline.
 */
const WEAVE_NETLIFY_FN_URL = process.env.WEAVE_NETLIFY_FN_URL

/**
 * Same rule and threshold as the client gate in
 * src/services/linkEnrichment.ts (duplicated deliberately — different
 * codebase): fusion (analysis present) or compression (transcript long
 * enough that a description buys density).
 */
const TWEET_DESCRIPTION_TRANSCRIPT_MIN_CHARS = 1000

export function shouldGenerateTweetDescription(view: NodeUnionView): boolean {
  if (view.mediaAnalysis) return true
  return view.transcript.length > TWEET_DESCRIPTION_TRANSCRIPT_MIN_CHARS
}

/**
 * Call the Netlify generate-tweet-description function with the UNION
 * inputs — tweetText + analysis + stored transcript even when this run's
 * own transcript fetch missed — so descriptions are never written blind
 * to words the database holds.
 *
 * Never throws: any failure (no URL configured, network, non-200, error
 * envelope, empty result) logs a warn and returns '' — the caller
 * continues with analysis-led composition.
 */
export async function fetchTweetDescription(
  view: NodeUnionView,
  logger: NodeLogger,
): Promise<string> {
  if (!WEAVE_NETLIFY_FN_URL) {
    logger.warn('media.description', 'skipped', { reason: 'no-netlify-fn-url' })
    return ''
  }

  const startedAt = Date.now()
  try {
    const res = await fetch(WEAVE_NETLIFY_FN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        authorName: view.authorName,
        authorHandle: view.authorHandle || null,
        tweetText: view.tweetText,
        transcript: view.transcript || null,
        mediaAnalysis: view.mediaAnalysis || null,
      }),
    })

    if (!res.ok) {
      logger.warn('media.description', 'failed', { status: res.status }, Date.now() - startedAt)
      return ''
    }

    const data = (await res.json()) as { description?: string; error?: string }
    if (data.error) {
      logger.warn('media.description', 'failed', { error: data.error }, Date.now() - startedAt)
      return ''
    }
    const description = (data.description ?? '').trim()
    if (!description) {
      logger.warn('media.description', 'degraded', { reason: 'empty-result' }, Date.now() - startedAt)
      return ''
    }
    logger.debug('media.description', 'success', { len: description.length }, Date.now() - startedAt)
    return description
  } catch (err) {
    logger.warn(
      'media.description',
      'failed',
      { error: err instanceof Error ? err.message : String(err) },
      Date.now() - startedAt,
    )
    return ''
  }
}
