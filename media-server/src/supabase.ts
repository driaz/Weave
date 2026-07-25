import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required')
}

export const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
})

/**
 * Merge a partial object into nodes.data via jsonb concatenation.
 * Looked up by the ReactFlow client id stashed in data->>'_clientNodeId'
 * (the server never sees the actual UUID nodes.id). Scoped by board_id +
 * user_id so a stolen JWT can't poke at other users' nodes.
 */
export async function patchNodeData(opts: {
  nodeId: string
  boardId: string
  userId: string
  patch: Record<string, unknown>
}): Promise<void> {
  const { error } = await admin.rpc('patch_node_data', {
    p_client_id: opts.nodeId,
    p_board_id: opts.boardId,
    p_user_id: opts.userId,
    p_patch: opts.patch,
  })
  if (error) throw new Error(`patchNodeData failed: ${error.message}`)
}

/**
 * Hard character budget for composed embed text. Same value and semantics
 * as EMBED_TEXT_MAX_CHARS in src/services/embeddingService.ts (duplicated
 * deliberately — different codebase): the Gemini embedding surface
 * truncates silently at ~36.8k chars of English prose
 * (docs/token-limit-and-multimodal-probe.md §1.3); the margin is
 * deliberate. Overflow trips a persisted `embed.budget` event in the
 * caller and gets the transcript tail cut to fit — never the curated
 * fields.
 */
export const EMBED_TEXT_MAX_CHARS = 36000

export interface ComposedEmbedText {
  text: string
  hadTranscript: boolean
  hadDescription: boolean
  hadAnalysis: boolean
  /** Set when the transcript tail was cut to fit EMBED_TEXT_MAX_CHARS. */
  truncatedFromChars: number | null
}

function blobString(blob: Record<string, unknown> | null, key: string): string {
  const value = blob?.[key]
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * Read the node's full data jsonb from Supabase. Same lookup path as
 * patch_node_data — by data->>'_clientNodeId' + board_id + user_id, since
 * the server never has the UUID nodes.id. This is the server's window
 * onto client-written fields (title, authorName, tweetText,
 * contentDescription) for embed composition.
 *
 * Returns null on any failure (node not yet persisted, network error) —
 * composition falls back to the URL; never a thrown error.
 */
export async function fetchNodeBlob(opts: {
  nodeId: string
  boardId: string
  userId: string
}): Promise<Record<string, unknown> | null> {
  try {
    const { data, error } = await admin
      .from('nodes')
      .select('data')
      .eq('board_id', opts.boardId)
      .eq('user_id', opts.userId)
      .eq('data->>_clientNodeId', opts.nodeId)
      .maybeSingle()

    if (error) {
      console.warn(`[supabase] node blob lookup failed: ${error.message}`)
      return null
    }
    return (data?.data as Record<string, unknown> | null) ?? null
  } catch (err) {
    console.warn('[supabase] node blob lookup threw:', err)
    return null
  }
}

/**
 * The union view of a node's composition inputs (PR-1.1 Fix B): per recipe
 * field, this run's own freshly-generated artifact if present, else the
 * stored JSONB value. Never own-fetch-only when the store holds more —
 * observed live: a server embed with hadTranscript: false because its own
 * Supadata fetch missed, while the client's successful fetch had put an
 * 877-char transcript in JSONB 26 seconds earlier.
 *
 * The same view feeds the composition, the description gate, and the
 * description generator's inputs, so none of them can be blind to words
 * the database holds.
 */
export interface NodeUnionView {
  title: string
  authorName: string
  authorHandle: string
  tweetText: string
  transcript: string
  mediaAnalysis: string
  contentDescription: string
}

export function buildUnionView(
  blob: Record<string, unknown> | null,
  own: { transcript?: string; mediaAnalysis?: string; contentDescription?: string },
): NodeUnionView {
  return {
    title: blobString(blob, 'title'),
    authorName: blobString(blob, 'authorName'),
    authorHandle: blobString(blob, 'authorHandle'),
    tweetText: blobString(blob, 'tweetText'),
    // Tweets with an embedded YouTube link store the client's transcript
    // under youtubeTranscript — same recipe slot (mirrors the client).
    transcript:
      (own.transcript ?? '').trim() ||
      blobString(blob, 'transcript') ||
      blobString(blob, 'youtubeTranscript'),
    mediaAnalysis: (own.mediaAnalysis ?? '').trim() || blobString(blob, 'media_analysis'),
    contentDescription:
      (own.contentDescription ?? '').trim() || blobString(blob, 'contentDescription'),
  }
}

/**
 * Compose the embed text for a server-side re-embed from the union view.
 * Mirrors the client recipes in src/services/embeddingService.ts
 * (duplicated deliberately — different codebase — with identical field
 * order):
 *
 *   YouTube:     title — authorName — contentDescription — transcript
 *   Video tweet: contentDescription — authorName — tweetText —
 *                media_analysis — transcript
 *
 * All present fields, full length; the transcript rides last so a budget
 * overflow only ever cuts its tail. content_summary IS this text —
 * uncapped, exactly what was embedded. The had* flags derive from the
 * actually-composed text.
 */
export function composeEmbedText(opts: {
  nodeType: 'youtube' | 'twitter'
  view: NodeUnionView
  fallbackUrl: string
}): ComposedEmbedText {
  const { transcript, mediaAnalysis, contentDescription, authorName, tweetText } = opts.view

  let segments: string[]
  if (opts.nodeType === 'youtube') {
    const title = opts.view.title || opts.fallbackUrl
    segments = [title, authorName, contentDescription]
  } else {
    // Blob unavailable → keep the row identifiable by URL, like the old
    // identifier fallback.
    const identity = authorName || tweetText ? '' : opts.fallbackUrl
    segments = [contentDescription, identity, authorName, tweetText, mediaAnalysis]
  }

  const present = segments.filter(Boolean)
  const full = [...present, transcript].filter(Boolean).join(' — ')

  let text = full
  let truncatedFromChars: number | null = null
  if (full.length > EMBED_TEXT_MAX_CHARS) {
    truncatedFromChars = full.length
    if (transcript) {
      const prefix = present.join(' — ')
      const transcriptBudget = EMBED_TEXT_MAX_CHARS - (prefix ? prefix.length + 3 : 0)
      const kept = transcriptBudget > 0 ? transcript.slice(0, transcriptBudget) : ''
      text = [prefix, kept].filter(Boolean).join(' — ')
    }
    // No transcript to cut (unreachable with real field sizes): leave the
    // text intact and let the caller's embed.budget event surface it.
  }

  return {
    text,
    hadTranscript: Boolean(transcript),
    hadDescription: Boolean(contentDescription),
    // "In this embed's text" — the youtube recipe never composes analysis,
    // so its flag must not claim otherwise.
    hadAnalysis: opts.nodeType === 'twitter' && Boolean(mediaAnalysis),
    truncatedFromChars,
  }
}

export async function upsertEmbedding(opts: {
  boardId: string
  nodeId: string
  userId: string
  composed: ComposedEmbedText
  embedding: number[]
  hasVideo: boolean
  durationSeconds: number
}): Promise<{ embedGeneration: number }> {
  // Lifecycle provenance: read the previous generation counter off the
  // existing row. Never gates the write — last-write-wins by design.
  let embedGeneration = 1
  try {
    const { data: existing, error } = await admin
      .from('weave_embeddings')
      .select('metadata')
      .eq('board_id', opts.boardId)
      .eq('node_id', opts.nodeId)
      .maybeSingle()
    if (error) {
      console.warn(`[supabase] generation lookup failed: ${error.message}`)
    }
    const previous = (existing?.metadata as { embed_generation?: number } | null)
      ?.embed_generation
    if (typeof previous === 'number' && Number.isFinite(previous)) {
      embedGeneration = previous + 1
    }
  } catch (err) {
    console.warn('[supabase] generation lookup threw:', err)
  }

  // user_id must be set explicitly — service role bypasses RLS, so the
  // auth.uid() default on weave_embeddings.user_id (migration 014) returns
  // null and trips the NOT NULL constraint from migration 009.
  const { error } = await admin.from('weave_embeddings').upsert(
    {
      board_id: opts.boardId,
      node_id: opts.nodeId,
      user_id: opts.userId,
      node_type: 'linkCard',
      embedding: JSON.stringify(opts.embedding),
      // Full composed text, uncapped — content_summary is exactly what
      // was embedded.
      content_summary: opts.composed.text,
      // An embed write means a live card owns this row.
      archived_at: null,
      metadata: {
        processing: 'server',
        has_video: opts.hasVideo,
        duration_seconds: opts.durationSeconds,
        embed_generation: embedGeneration,
        embed_trigger: 'media_patch',
        had_transcript: opts.composed.hadTranscript,
        had_description: opts.composed.hadDescription,
        had_analysis: opts.composed.hadAnalysis,
        embed_text_chars: opts.composed.text.length,
      },
    },
    { onConflict: 'board_id,node_id' },
  )
  if (error) throw new Error(`upsertEmbedding failed: ${error.message}`)
  return { embedGeneration }
}
