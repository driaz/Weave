import type { Part } from '@google/genai'
import { ai } from './geminiClient'
import { supabase } from './supabaseClient'
import type { NodeLogger } from '../utils/logger'
import type { Connection } from '../api/claude'
import { connectionIdentityFields } from '../utils/connectionIdentity'
import { buildConnectionContext } from './voice/voiceContext'

/**
 * What caused an embed write. Stored in the row's metadata and in the
 * processing_log event so every vector's lifecycle is reconstructable.
 * 'sweep' is reserved for the PR-2 backfill sweep; the client never emits it.
 */
export type EmbedTrigger =
  | 'initial_drop'
  | 'transcript_arrival'
  | 'description_generated'
  | 'media_patch'
  | 'sweep'

/**
 * Hard character budget for composed embed text. The Gemini embedding
 * surface truncates silently at ~36.8k chars of English prose
 * (docs/token-limit-and-multimodal-probe.md §1.3); the margin is
 * deliberate. Overflow is otherwise invisible, so any composition that
 * exceeds this trips a persisted warn event (`embed.budget`) and gets
 * its transcript tail cut to fit. The media server carries its own copy
 * of this constant (different codebase, same value).
 */
const EMBED_TEXT_MAX_CHARS = 36000

interface ComposedParts {
  parts: Part[]
  summary: string
  hadTranscript: boolean
  hadDescription: boolean
  hadAnalysis: boolean
  /** Set when the transcript tail was cut to fit EMBED_TEXT_MAX_CHARS. */
  truncatedFromChars: number | null
}

/**
 * Parse a data URL into its mime type and raw base64 string.
 * e.g. "data:image/png;base64,iVBOR..." → { mimeType: "image/png", data: "iVBOR..." }
 */
function parseDataUrl(dataUrl: string): { mimeType: string; data: string } | null {
  const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/)
  if (!match) return null
  return { mimeType: match[1], data: match[2] }
}

function asTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * Join composition segments with the transcript last, cutting only the
 * transcript's tail if the total exceeds EMBED_TEXT_MAX_CHARS. The
 * non-transcript fields are never truncated — they are the dense,
 * hand-or-model-curated part of the composition.
 */
function joinWithBudget(
  segments: string[],
  transcript: string,
): { text: string; truncatedFromChars: number | null } {
  const all = [...segments, transcript].filter(Boolean)
  const full = all.join(' — ')
  if (full.length <= EMBED_TEXT_MAX_CHARS) {
    return { text: full, truncatedFromChars: null }
  }
  if (!transcript) {
    // Unreachable with real field sizes (non-transcript fields are ~kB
    // scale), but never slice curated fields — surface it instead.
    return { text: full, truncatedFromChars: full.length }
  }
  const prefix = segments.filter(Boolean).join(' — ')
  const transcriptBudget = EMBED_TEXT_MAX_CHARS - (prefix ? prefix.length + 3 : 0)
  const kept = transcriptBudget > 0 ? transcript.slice(0, transcriptBudget) : ''
  const text = [prefix, kept].filter(Boolean).join(' — ')
  return { text, truncatedFromChars: full.length }
}

/**
 * Build the parts array and content summary for a given node type + data.
 */
function buildPartsForNode(
  nodeType: string,
  data: Record<string, unknown>,
): ComposedParts | null {
  const parts: Part[] = []
  let summary = ''
  let hadTranscript = false
  let hadDescription = false
  let hadAnalysis = false
  let truncatedFromChars: number | null = null

  switch (nodeType) {
    case 'textCard': {
      const text = data.text as string | undefined
      if (!text || text.trim().length === 0) return null
      parts.push({ text })
      summary = text
      break
    }

    case 'imageCard': {
      const imageDataUrl = data.imageDataUrl as string | undefined
      const fileName = data.fileName as string | undefined
      const label = data.label as string | undefined

      if (!imageDataUrl) return null

      const parsed = parseDataUrl(imageDataUrl)
      if (parsed) {
        parts.push({
          inlineData: { data: parsed.data, mimeType: parsed.mimeType },
        })
      }

      const textLabel = label || fileName || 'Image'
      parts.push({ text: textLabel })
      summary = textLabel
      break
    }

    case 'linkCard': {
      const title = asTrimmedString(data.title)
      const description = asTrimmedString(data.description)
      const domain = asTrimmedString(data.domain)
      const linkType = data.type as string | undefined
      const authorName = asTrimmedString(data.authorName)
      const authorHandle = asTrimmedString(data.authorHandle)
      const tweetText = asTrimmedString(data.tweetText)
      const contentDescription = asTrimmedString(data.contentDescription)
      const mediaAnalysis = asTrimmedString(data.media_analysis)
      // Tweets with an embedded YouTube link store their transcript under
      // youtubeTranscript; native video under transcript. Same recipe slot.
      const transcript =
        asTrimmedString(data.transcript) || asTrimmedString(data.youtubeTranscript)

      if (linkType === 'youtube') {
        // YouTube recipe: title — authorName — contentDescription — transcript.
        // All present fields, full length; transcript-tail-only budget cut.
        const composed = joinWithBudget([title, authorName, contentDescription], transcript)
        if (!composed.text) return null
        parts.push({ text: composed.text })
        summary = composed.text
        hadTranscript = Boolean(transcript)
        hadDescription = Boolean(contentDescription)
        truncatedFromChars = composed.truncatedFromChars
        break
      }

      if (linkType === 'twitter' && tweetText) {
        if (transcript || mediaAnalysis || contentDescription) {
          // Video tweet recipe: contentDescription — authorName — tweetText —
          // media_analysis — transcript. Text-only: the multimodal parts were
          // measured as a retrieval downgrade for text queries
          // (docs/token-limit-and-multimodal-probe.md §2.3).
          const composed = joinWithBudget(
            [contentDescription, authorName, tweetText, mediaAnalysis],
            transcript,
          )
          parts.push({ text: composed.text })
          summary = composed.text
          hadTranscript = Boolean(transcript)
          hadDescription = Boolean(contentDescription)
          hadAnalysis = Boolean(mediaAnalysis)
          truncatedFromChars = composed.truncatedFromChars
          break
        }

        const imageBase64 = data.imageBase64 as string | undefined
        const imageMimeType = data.imageMimeType as string | undefined
        if (imageBase64 && imageMimeType) {
          // Image tweet: deliberately untouched in PR-1, inline image part
          // included. Text-only here would embed boilerplate (worse than
          // pixels-maybe); these convert when #17 produces analysis text.
          const textSegments = [authorName, authorHandle, tweetText, domain].filter(Boolean)
          const combinedText = textSegments.join(' — ')
          parts.push({ text: combinedText })
          parts.push({ inlineData: { data: imageBase64, mimeType: imageMimeType } })
          summary = combinedText
          break
        }

        // Text tweet recipe: authorName — tweetText, uncapped.
        const combinedText = [authorName, tweetText].filter(Boolean).join(' — ')
        parts.push({ text: combinedText })
        summary = combinedText
        break
      }

      // Generic link (and tweets without tweetText): unchanged.
      const textSegments = [title, description, domain].filter(Boolean)
      const combinedText = textSegments.join(' — ')
      if (!combinedText) return null
      parts.push({ text: combinedText })
      summary = combinedText
      break
    }

    case 'pdfCard': {
      const thumbnailDataUrl = data.thumbnailDataUrl as string | undefined
      const fileName = data.fileName as string | undefined
      const label = data.label as string | undefined

      if (!thumbnailDataUrl) return null

      const parsed = parseDataUrl(thumbnailDataUrl)
      if (parsed) {
        parts.push({
          inlineData: { data: parsed.data, mimeType: parsed.mimeType },
        })
      }

      const textLabel = label || fileName || 'PDF'
      parts.push({ text: textLabel })
      summary = textLabel
      break
    }

    default:
      return null
  }

  if (parts.length === 0) return null
  return { parts, summary, hadTranscript, hadDescription, hadAnalysis, truncatedFromChars }
}

/**
 * Embed a node's content using Gemini Embedding 2 and store the result
 * in Supabase. Completely non-blocking — failures log to console but
 * never throw.
 */
export async function embedNode(
  boardId: string,
  nodeId: string,
  nodeType: string,
  nodeData: Record<string, unknown>,
  logger?: NodeLogger,
  trigger: EmbedTrigger = 'initial_drop',
): Promise<void> {
  if (!ai || !supabase) return

  const startedAt = Date.now()
  const result = buildPartsForNode(nodeType, nodeData)
  if (!result) {
    logger?.debug('embed.client', 'skipped', { reason: 'no-content', nodeType })
    return
  }

  const { parts, summary, hadTranscript, hadDescription, hadAnalysis, truncatedFromChars } = result
  logger?.debug('embed.client.start', 'success', { nodeType, trigger, partsCount: parts.length, summaryLen: summary.length })

  // Budget tripwire: composition overflowed EMBED_TEXT_MAX_CHARS and the
  // transcript tail was cut. The API truncates silently past the budget,
  // so this persisted event is the only trace overflow leaves.
  if (truncatedFromChars !== null) {
    logger?.warn('embed.budget', 'degraded', {
      composedChars: truncatedFromChars,
      cap: EMBED_TEXT_MAX_CHARS,
      droppedChars: truncatedFromChars - summary.length,
      trigger,
    })
    logger?.persist('embed.budget', 'degraded', {
      composedChars: truncatedFromChars,
      cap: EMBED_TEXT_MAX_CHARS,
      droppedChars: truncatedFromChars - summary.length,
      trigger,
    })
  }

  // Lifecycle provenance: read the previous generation counter off the
  // existing row. This read never gates the embed — whatever it returns
  // (or fails with), the write below proceeds. Last-write-wins by design;
  // the old "server-embedding-exists" precheck is gone because the
  // hierarchy it protected was measured backwards
  // (docs/embedding-coverage-probe.md §4, token-limit probe §2.3).
  let embedGeneration = 1
  const { data: existing, error: generationError } = await supabase
    .from('weave_embeddings')
    .select('metadata')
    .eq('board_id', boardId)
    .eq('node_id', nodeId)
    .maybeSingle()
  if (generationError) {
    logger?.warn('embed.client.generation', 'degraded', { error: generationError.message })
  }
  const previousGeneration = (existing?.metadata as { embed_generation?: number } | null)
    ?.embed_generation
  if (typeof previousGeneration === 'number' && Number.isFinite(previousGeneration)) {
    embedGeneration = previousGeneration + 1
  }

  const response = await ai.models.embedContent({
    model: 'gemini-embedding-2-preview',
    contents: {
      parts,
    },
    config: {
      taskType: 'SEMANTIC_SIMILARITY',
    },
  })

  const embedding = response.embeddings?.[0]?.values
  if (!embedding) {
    logger?.warn('embed.client', 'failed', { reason: 'no-embedding-returned' }, Date.now() - startedAt)
    return
  }

  const { error } = await supabase.from('weave_embeddings').upsert(
    {
      board_id: boardId,
      node_id: nodeId,
      node_type: nodeType,
      embedding: JSON.stringify(embedding),
      content_summary: summary,
      // An embed write means a live card owns this row.
      archived_at: null,
      metadata: {
        parts_count: parts.length,
        embed_generation: embedGeneration,
        embed_trigger: trigger,
        had_transcript: hadTranscript,
        had_description: hadDescription,
        had_analysis: hadAnalysis,
        embed_text_chars: summary.length,
      },
    },
    { onConflict: 'board_id,node_id' },
  )

  if (error) {
    logger?.persist(
      'embed.client',
      'failed',
      { error: error.message, embeddingDims: embedding.length, contentLen: summary.length, trigger },
      Date.now() - startedAt,
    )
    return
  }

  logger?.persist(
    'embed.client',
    'success',
    {
      embeddingDims: embedding.length,
      contentLen: summary.length,
      partsCount: parts.length,
      trigger,
      embedGeneration,
      hadTranscript,
      hadDescription,
      hadAnalysis,
    },
    Date.now() - startedAt,
  )
}

/**
 * Fire-and-forget wrapper for embedNode.
 * Call this from UI code — it will never throw or block.
 */
export function embedNodeAsync(
  boardId: string,
  nodeId: string,
  nodeType: string,
  nodeData: Record<string, unknown>,
  logger?: NodeLogger,
  trigger: EmbedTrigger = 'initial_drop',
): void {
  embedNode(boardId, nodeId, nodeType, nodeData, logger, trigger).catch((err) => {
    if (logger) {
      logger.error('embed.client', 'failed', { error: String(err) })
    } else {
      console.warn('[Weave Embeddings] Embedding failed:', err)
    }
  })
}

/**
 * Embed a plain text string and return the raw 3072-dim vector. Same
 * Gemini call as `embedNode` (model + taskType + dimensionality) so
 * board-node and voice-utterance embeddings live in a single vector
 * space and unified retrieval (Phase 10) can compare them directly.
 *
 * Throws on any failure (no Gemini client configured, empty text,
 * Gemini returns no embedding). Callers handle the failure — for
 * voice this means logging an `embedding_failed` event to the
 * session's processing_log and leaving the utterance row's embedding
 * column null.
 */
export async function embedText(text: string): Promise<number[]> {
  if (!ai) throw new Error('Gemini client not configured (VITE_GEMINI_API_KEY missing)')
  if (!text.trim()) throw new Error('embedText: empty text')

  const response = await ai.models.embedContent({
    model: 'gemini-embedding-2-preview',
    contents: { parts: [{ text }] },
    config: { taskType: 'SEMANTIC_SIMILARITY' },
  })

  const embedding = response.embeddings?.[0]?.values
  if (!embedding) throw new Error('embedText: Gemini returned no embedding')
  return embedding
}

/**
 * Embed a single connection's relationship text and store it in the
 * edge-embedding store (`weave_edge_embeddings`), keyed on the SHIPPED
 * directionless, mode-aware identity.
 *
 * The edge analogue of `embedNode`. Write-once: under first-write-wins dedup an
 * edge's label/explanation is permanent, so there's no re-embed or staleness
 * logic — the upsert on the identity key simply collapses any directionless
 * duplicate (e.g. a transient A->B / B->A pair) to one row.
 *
 * What we embed is exactly the text `buildConnectionContext` assembles
 * ("label — explanation") — the same string the voice layer injects — so the
 * edge vector is comparable to how the relationship is later surfaced. Node
 * summaries are intentionally NOT concatenated in v1: each node is already
 * embedded and retrievable on its own, and keeping the edge vector to the
 * relationship text keeps the write simple.
 *
 * Non-blocking and fail-loud: failures are logged, never thrown to the caller.
 */
export async function embedEdge(
  boardId: string,
  connection: Connection,
  logger?: NodeLogger,
): Promise<void> {
  if (!ai || !supabase) return

  const startedAt = Date.now()
  const text = buildConnectionContext(connection).trim()
  if (!text) {
    logger?.debug('embed.edge.client', 'skipped', { reason: 'no-text' })
    return
  }

  const { mode, lo, hi } = connectionIdentityFields(connection)
  const embedding = await embedText(text)

  const { error } = await supabase.from('weave_edge_embeddings').upsert(
    {
      board_id: boardId,
      mode,
      node_lo: lo,
      node_hi: hi,
      embedding: JSON.stringify(embedding),
      content_summary: text,
      metadata: { label: connection.label, edge_mode: connection.mode ?? null },
    },
    { onConflict: 'board_id,mode,node_lo,node_hi' },
  )

  // Edge events log to the console rather than persist() — unlike a node,
  // an edge has no row-scoped processing_log to append to.
  if (error) {
    logger?.error(
      'embed.edge.client',
      'failed',
      { error: error.message, embeddingDims: embedding.length, contentLen: text.length },
      Date.now() - startedAt,
    )
    return
  }

  logger?.info(
    'embed.edge.client',
    'success',
    { embeddingDims: embedding.length, contentLen: text.length, mode },
    Date.now() - startedAt,
  )
}

/**
 * Fire-and-forget wrapper for embedEdge. Call this from UI code at
 * connection creation — it will never throw or block.
 */
export function embedEdgeAsync(
  boardId: string,
  connection: Connection,
  logger?: NodeLogger,
): void {
  embedEdge(boardId, connection, logger).catch((err) => {
    if (logger) {
      logger.error('embed.edge.client', 'failed', { error: String(err) })
    } else {
      console.warn('[Weave Embeddings] Edge embedding failed:', err)
    }
  })
}
