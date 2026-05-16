/**
 * Builds the board_snapshot payload that voice_sessions.board_snapshot
 * stores at session start. The snapshot is a compact, JSON-safe view
 * of the canvas at the moment the mic modal opened — enough that a
 * replay six months later can hint at what the user was looking at
 * without having to chase down the (possibly stale or deleted) full
 * nodes/edges rows by id.
 *
 * Phase 8 only writes the snapshot; nothing reads it yet. The shape
 * is locked by the BoardSnapshot type exported from @/persistence.
 *
 * Edge IDs follow the same derived pattern used by useStaggeredEdges
 * (`weave-<source>-<target>-<index>`). The Connection type doesn't
 * carry an id, and synthesizing one from the database row would
 * require a join the snapshot doesn't have access to. The derived id
 * is stable within a single snapshot, which is the only stability
 * the snapshot needs.
 */

import type { Node } from '@xyflow/react'
import type { Connection } from '../../api/claude'
import type { BoardSnapshot } from '../../persistence'
import type { TextCardData } from '../../components/TextCardNode'
import type { ImageCardData } from '../../components/ImageCardNode'
import type { LinkCardData } from '../../components/LinkCardNode'
import type { PdfCardData } from '../../components/PdfCardNode'

const PREVIEW_MAX = 200

function stripNodePrefix(id: string): string {
  return id.replace(/^node-/, '')
}

function truncate(value: string): string {
  const trimmed = value.trim()
  return trimmed.length > PREVIEW_MAX ? trimmed.slice(0, PREVIEW_MAX) : trimmed
}

/**
 * Produce the per-node preview_text for the snapshot. Rules:
 *   - textCard: first 200 chars of the user's note text.
 *   - imageCard: label, then filename, then empty.
 *   - pdfCard: label, then filename, then empty.
 *   - linkCard (youtube): title; fall back to contentDescription (the
 *     Sonnet 2-3 sentence summary attached to YouTube nodes), then
 *     description, then url.
 *   - linkCard (twitter): tweetText, then description, then title,
 *     then url.
 *   - linkCard (generic / unset): title, then description, then url.
 *   - Anything else: empty string.
 *
 * Returns '' rather than throwing or returning null. The snapshot
 * always lists every node on the board, even ones with no useful
 * preview — position alone is sometimes enough to recognize the row.
 */
function buildPreviewText(node: Node): string {
  const data = (node.data ?? {}) as Record<string, unknown>

  switch (node.type) {
    case 'textCard': {
      const text = (data as TextCardData).text
      return typeof text === 'string' ? truncate(text) : ''
    }
    case 'imageCard': {
      const d = data as ImageCardData
      const label = typeof d.label === 'string' ? d.label.trim() : ''
      if (label) return truncate(label)
      const file = typeof d.fileName === 'string' ? d.fileName.trim() : ''
      return file ? truncate(file) : ''
    }
    case 'pdfCard': {
      const d = data as PdfCardData
      const label = typeof d.label === 'string' ? d.label.trim() : ''
      if (label) return truncate(label)
      const file = typeof d.fileName === 'string' ? d.fileName.trim() : ''
      return file ? truncate(file) : ''
    }
    case 'linkCard': {
      const d = data as LinkCardData
      const linkType = d.type ?? 'generic'
      const title = typeof d.title === 'string' ? d.title.trim() : ''
      const description =
        typeof d.description === 'string' ? d.description.trim() : ''
      const url = typeof d.url === 'string' ? d.url.trim() : ''

      if (linkType === 'youtube') {
        if (title) return truncate(title)
        const summary =
          typeof d.contentDescription === 'string'
            ? d.contentDescription.trim()
            : ''
        if (summary) return truncate(summary)
        if (description) return truncate(description)
        return url ? truncate(url) : ''
      }
      if (linkType === 'twitter') {
        const tweet =
          typeof d.tweetText === 'string' ? d.tweetText.trim() : ''
        if (tweet) return truncate(tweet)
        if (description) return truncate(description)
        if (title) return truncate(title)
        return url ? truncate(url) : ''
      }
      if (title) return truncate(title)
      if (description) return truncate(description)
      return url ? truncate(url) : ''
    }
    default:
      return ''
  }
}

export interface BuildBoardSnapshotInput {
  nodes: Node[]
  connections: Connection[]
  /** Optional capture timestamp; defaults to now. Exposed for tests. */
  now?: () => Date
}

/**
 * Pure function — no React, no store reads. Callers (Prompt B2) pull
 * `nodes` and `connections` from App-level state and hand them in.
 *
 * Empty boards return `{ nodes: [], edges: [], captured_at: <iso> }`
 * — never throws. The persistence layer accepts the empty arrays.
 */
export function buildBoardSnapshot(input: BuildBoardSnapshotInput): BoardSnapshot {
  const { nodes, connections } = input
  const now = input.now ? input.now() : new Date()

  const snapshotNodes = nodes.map((node) => ({
    id: node.id,
    type: typeof node.type === 'string' ? node.type : 'unknown',
    position: {
      x: typeof node.position?.x === 'number' ? node.position.x : 0,
      y: typeof node.position?.y === 'number' ? node.position.y : 0,
    },
    preview_text: buildPreviewText(node),
  }))

  const snapshotEdges = connections.map((conn, index) => {
    const source = stripNodePrefix(conn.from)
    const target = stripNodePrefix(conn.to)
    return {
      id: `weave-${source}-${target}-${index}`,
      source,
      target,
    }
  })

  return {
    nodes: snapshotNodes,
    edges: snapshotEdges,
    captured_at: now.toISOString(),
  }
}
