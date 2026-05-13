/**
 * Build the two strings the conversation orchestrator's system prompt
 * inlines: connectionContext (one-line framing of the edge) and
 * nodeContent (per-node body). Mirrors the fixture shape used by the
 * Phase-4 STT test page.
 */

import type { Node } from '@xyflow/react'
import type { Connection } from '../../api/claude'
import { nodeToVoicePayload } from '../../utils/voicePayload'

export function buildConnectionContext(connection: Connection): string {
  const label = connection.label.trim()
  const explanation = connection.explanation.trim()
  if (!label) return explanation
  if (!explanation) return label
  return `${label} — ${explanation}`
}

export function buildNodeContent(
  node1: Node | undefined,
  node2: Node | undefined,
): string {
  const blocks: string[] = []
  if (node1) {
    const p = nodeToVoicePayload(node1)
    if (p) blocks.push(`Node 1 (${p.contentType}): ${p.title}\n${p.contentDescription}`)
  }
  if (node2) {
    const p = nodeToVoicePayload(node2)
    if (p) blocks.push(`Node 2 (${p.contentType}): ${p.title}\n${p.contentDescription}`)
  }
  return blocks.join('\n\n')
}
