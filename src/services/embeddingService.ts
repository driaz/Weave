import type { Part } from '@google/genai'
import { ai } from './geminiClient'
import { supabase } from './supabaseClient'
import type { NodeLogger } from '../utils/logger'
import type { Connection } from '../api/claude'
import { connectionIdentityFields } from '../utils/connectionIdentity'
import { buildConnectionContext } from './voice/voiceContext'

/**
 * Parse a data URL into its mime type and raw base64 string.
 * e.g. "data:image/png;base64,iVBOR..." → { mimeType: "image/png", data: "iVBOR..." }
 */
function parseDataUrl(dataUrl: string): { mimeType: string; data: string } | null {
  const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/)
  if (!match) return null
  return { mimeType: match[1], data: match[2] }
}

/**
 * Build the parts array and content summary for a given node type + data.
 */
function buildPartsForNode(
  nodeType: string,
  data: Record<string, unknown>,
): { parts: Part[]; summary: string } | null {
  const parts: Part[] = []
  let summary = ''

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
      const title = data.title as string | undefined
      const description = data.description as string | undefined
      const domain = data.domain as string | undefined
      const linkType = data.type as string | undefined
      const authorName = data.authorName as string | undefined
      const authorHandle = data.authorHandle as string | undefined
      const tweetText = data.tweetText as string | undefined

      const textSegments: string[] = []

      // For tweets, title/description from oEmbed duplicate the tweet text.
      // Use tweetText as the authoritative source when available.
      if (linkType === 'twitter' && tweetText) {
        if (authorName) textSegments.push(authorName)
        if (authorHandle) textSegments.push(authorHandle)
        textSegments.push(tweetText)
        if (domain) textSegments.push(domain)
      } else {
        if (title) textSegments.push(title)
        if (description) textSegments.push(description)
        if (domain) textSegments.push(domain)
      }

      // YouTube transcript
      if (linkType === 'youtube') {
        const transcript = data.transcript as string | undefined
        if (transcript) {
          const truncated = transcript.length > 3000 ? transcript.slice(0, 3000) : transcript
          textSegments.push(truncated)
        }
      }

      // Tweet video transcript (native video)
      if (linkType === 'twitter') {
        const transcript = data.transcript as string | undefined
        if (transcript) {
          const truncated = transcript.length > 3000 ? transcript.slice(0, 3000) : transcript
          textSegments.push(truncated)
        }
      }

      // Tweet with embedded YouTube transcript
      if (linkType === 'twitter') {
        const youtubeTranscript = data.youtubeTranscript as string | undefined
        if (youtubeTranscript) {
          const truncated = youtubeTranscript.length > 3000 ? youtubeTranscript.slice(0, 3000) : youtubeTranscript
          textSegments.push(truncated)
        }
      }

      const combinedText = textSegments.join(' — ')
      if (!combinedText) return null

      parts.push({ text: combinedText })

      // Include tweet image if available (fetched and stored as base64)
      const imageBase64 = data.imageBase64 as string | undefined
      const imageMimeType = data.imageMimeType as string | undefined
      if (linkType === 'twitter' && imageBase64 && imageMimeType) {
        parts.push({
          inlineData: { data: imageBase64, mimeType: imageMimeType },
        })
      }

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
  return { parts, summary }
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
): Promise<void> {
  if (!ai || !supabase) return

  const startedAt = Date.now()
  const result = buildPartsForNode(nodeType, nodeData)
  if (!result) {
    logger?.debug('embed.client', 'skipped', { reason: 'no-content', nodeType })
    return
  }

  const { parts, summary } = result
  logger?.debug('embed.client.start', 'success', { nodeType, partsCount: parts.length, summaryLen: summary.length })

  // Don't downgrade a server-written multimodal embedding with a client text-only one.
  // The Fly media server stamps metadata.processing = 'server'; the client never sets it.
  // Checked before the Gemini call so we don't pay for an embedding we'd discard.
  const { data: existing, error: fetchError } = await supabase
    .from('weave_embeddings')
    .select('metadata')
    .eq('board_id', boardId)
    .eq('node_id', nodeId)
    .maybeSingle()

  if (fetchError) {
    logger?.warn('embed.client.precheck', 'failed', { error: fetchError.message })
  }

  const existingProcessing = (existing?.metadata as { processing?: string } | null)?.processing
  if (existingProcessing === 'server') {
    logger?.persist('embed.client', 'skipped', { reason: 'server-embedding-exists' })
    return
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
      metadata: { parts_count: parts.length },
    },
    { onConflict: 'board_id,node_id' },
  )

  if (error) {
    logger?.persist(
      'embed.client',
      'failed',
      { error: error.message, embeddingDims: embedding.length, contentLen: summary.length },
      Date.now() - startedAt,
    )
    return
  }

  logger?.persist(
    'embed.client',
    'success',
    { embeddingDims: embedding.length, contentLen: summary.length, partsCount: parts.length },
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
): void {
  embedNode(boardId, nodeId, nodeType, nodeData, logger).catch((err) => {
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
