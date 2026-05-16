import { mapSupabaseError } from './errors'
import { requireClient, requireUserId } from './session'
import type {
  NewVoiceUtteranceInput,
  SentinelEvent,
  Speaker,
  VoiceUtterance,
  WriteUtteranceContext,
  WriteUtteranceResult,
} from './types'

/**
 * Phase 8 voice utterance persistence.
 *
 * Sentinel detection is centralized here: the controller passes the
 * context required to evaluate the strip rule, and this module
 * decides whether to write the row or skip it. The decision (and any
 * warning) is returned to the controller via the `event` field on
 * `WriteUtteranceResult` so the controller can append it to the
 * session's in-memory `processing_log`. The persistence layer does
 * not own the buffer — that belongs to the controller.
 *
 * Embeddings are written nullable. The controller fires a background
 * Gemini call after a successful insert and updates the row via
 * `updateUtteranceEmbedding`. A failed embedding is logged but never
 * retried (per the design doc).
 */

const SENTINEL_TEXT = 'Begin.'

/**
 * Pure sentinel-detection rule. Exported for unit testing — production
 * callers should use `writeUtterance` instead.
 *
 * Strip when *all* hold: speaker is `'user'`, this is utterance_index
 * 0 within the session, the assistant has not yet spoken, and the
 * text matches the literal sentinel string `'Begin.'` exactly.
 *
 * Near-misses (lowercase, missing period, wrong speaker, wrong
 * position) intentionally do not strip. They emit a warning event
 * so the failure is visible in `processing_log`, but the utterance
 * is written as-is — losing legitimate user text to an overzealous
 * detector is worse than occasionally letting a malformed sentinel
 * through to retrieval.
 */
export function detectSentinel(
  text: string,
  context: { speaker: Speaker; utteranceIndex: number; assistantHasSpokenInSession: boolean },
): { action: 'strip' | 'pass'; event?: SentinelEvent } {
  const isExact = text === SENTINEL_TEXT
  const isFirstUserSlot =
    context.speaker === 'user' &&
    context.utteranceIndex === 0 &&
    !context.assistantHasSpokenInSession

  if (isExact && isFirstUserSlot) {
    return {
      action: 'strip',
      event: {
        phase: 'voice.sentinel.stripped',
        outcome: 'success',
        detail: { text: SENTINEL_TEXT },
        ts: new Date().toISOString(),
      },
    }
  }

  // Near-miss detection: anything that looks like the sentinel but doesn't
  // satisfy the full rule. The check is intentionally narrow (text
  // approximates "begin" with optional punctuation, or exact match in the
  // wrong slot) so we don't false-positive on conversational uses of the
  // word "begin".
  const normalised = text.trim().toLowerCase().replace(/[.!?]$/, '')
  const looksLikeSentinel = normalised === 'begin'

  if (isExact && !isFirstUserSlot) {
    return {
      action: 'pass',
      event: {
        phase: 'voice.sentinel.detection_warning',
        outcome: 'degraded',
        detail: {
          reason: 'sentinel_in_unexpected_slot',
          speaker: context.speaker,
          utteranceIndex: context.utteranceIndex,
          assistantHasSpokenInSession: context.assistantHasSpokenInSession,
        },
        ts: new Date().toISOString(),
      },
    }
  }

  if (looksLikeSentinel && isFirstUserSlot && !isExact) {
    return {
      action: 'pass',
      event: {
        phase: 'voice.sentinel.detection_warning',
        outcome: 'degraded',
        detail: {
          reason: 'sentinel_malformed',
          observed: text,
          expected: SENTINEL_TEXT,
        },
        ts: new Date().toISOString(),
      },
    }
  }

  return { action: 'pass' }
}

export async function writeUtterance(
  input: NewVoiceUtteranceInput,
  context: WriteUtteranceContext,
): Promise<WriteUtteranceResult> {
  const detection = detectSentinel(input.text, {
    speaker: input.speaker,
    utteranceIndex: input.utterance_index,
    assistantHasSpokenInSession: context.assistantHasSpokenInSession,
  })

  if (detection.action === 'strip') {
    return { utteranceId: null, stripped: true, event: detection.event }
  }

  const client = requireClient()
  const userId = await requireUserId()

  const { data, error } = await client
    .from('voice_utterances')
    .insert({ ...input, user_id: userId, embedding: null })
    .select('id')
    .single()

  if (error) throw mapSupabaseError(error, 'voiceUtterances.writeUtterance')

  return { utteranceId: data.id, stripped: false, event: detection.event }
}

export async function updateUtteranceEmbedding(
  utteranceId: string,
  embedding: number[],
): Promise<void> {
  const client = requireClient()
  await requireUserId()

  // pgvector accepts a JSON array literal for both vector and halfvec
  // columns; this is the same serialization embeddingService uses for
  // weave_embeddings.
  const { error } = await client
    .from('voice_utterances')
    .update({ embedding: JSON.stringify(embedding) as unknown as never })
    .eq('id', utteranceId)

  if (error) {
    throw mapSupabaseError(error, `voiceUtterances.updateUtteranceEmbedding(${utteranceId})`)
  }
}

export async function listUtterancesBySession(
  sessionId: string,
): Promise<VoiceUtterance[]> {
  const client = requireClient()
  await requireUserId()

  const { data, error } = await client
    .from('voice_utterances')
    .select('*')
    .eq('session_id', sessionId)
    .order('utterance_index', { ascending: true })

  if (error) {
    throw mapSupabaseError(error, `voiceUtterances.listUtterancesBySession(${sessionId})`)
  }
  return data ?? []
}
