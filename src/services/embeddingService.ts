import type { Part } from '@google/genai'
import { ai } from './geminiClient'
import { supabase } from './supabaseClient'

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
      summary = text.slice(0, 100)
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
      summary = textLabel.slice(0, 100)
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

      if (title) textSegments.push(title)
      if (description) textSegments.push(description)
      if (domain) textSegments.push(domain)

      // Twitter-specific fields
      if (linkType === 'twitter') {
        if (authorName) textSegments.push(authorName)
        if (authorHandle) textSegments.push(authorHandle)
        if (tweetText) textSegments.push(tweetText)
      }

      // YouTube transcript
      if (linkType === 'youtube') {
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

      summary = combinedText.slice(0, 100)
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
      summary = textLabel.slice(0, 100)
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
): Promise<void> {
  if (!ai || !supabase) return

  const result = buildPartsForNode(nodeType, nodeData)
  if (!result) return

  const { parts, summary } = result

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
    console.warn('[Weave Embeddings] No embedding returned for node', nodeId)
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
    console.warn('[Weave Embeddings] Failed to store embedding:', error.message)
  }
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
): void {
  embedNode(boardId, nodeId, nodeType, nodeData).catch((err) => {
    console.warn('[Weave Embeddings] Embedding failed:', err)
  })
}
