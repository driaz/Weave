import type { Part } from '@google/genai'
import { ai } from './geminiClient'
import { supabase } from './supabaseClient'
import type { NodeLogger } from '../utils/logger'

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
