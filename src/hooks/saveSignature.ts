import type { Node } from '@xyflow/react'
import type { Connection } from '../api/claude'

/**
 * Keys inside a node's `data` blob whose *value* isn't meaningful for
 * save purposes — only "is it present or not" matters. They get
 * replaced with a `_has_<key>` boolean in the signature so swaps
 * like base64 → signed URL (which happen every hydrate) don't look
 * like real edits.
 */
const TRANSIENT_DATA_KEYS = new Set<string>([
  'imageDataUrl',
  'imageBase64',
  'imageUrl',
  'pdfDataUrl',
  'thumbnailDataUrl',
  'loading',
  '_imageStoragePath',
])

/**
 * Canonical, deterministic stringify — key-sorted at every object
 * level. JSON.stringify's natural insertion-order output would
 * usually match across renders, but React Flow occasionally hands
 * back node `data` objects with keys in a different order after a
 * mutation. Sorting sidesteps that foot-gun.
 */
function sortedStringify(value: unknown): string {
  if (value === null || value === undefined) return 'null'
  if (typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) {
    return '[' + value.map(sortedStringify).join(',') + ']'
  }
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj).sort()
  return (
    '{' +
    keys
      .map((k) => JSON.stringify(k) + ':' + sortedStringify(obj[k]))
      .join(',') +
    '}'
  )
}

function normalizeData(
  data: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(data)) {
    if (TRANSIENT_DATA_KEYS.has(key)) {
      out[`_has_${key}`] =
        typeof value === 'string' && value.length > 0
      continue
    }
    out[key] = value
  }
  return out
}

/**
 * Stable signature of a board's user-meaningful state. Two calls
 * with the same semantic content (even if references differ, or if
 * hydrate has swapped a base64 blob for a signed URL) produce the
 * same string. The debounced save short-circuits when the current
 * signature matches the last-saved one for this board.
 *
 * Works on both React Flow `Node` (from App.tsx state) and the
 * `SerializedNode`-shaped objects useBoardStorage holds — both have
 * `{ id, type, position, data }` that matters here.
 */
export function computeSaveSignature(
  nodes: Array<Pick<Node, 'id' | 'type' | 'position' | 'data'>>,
  connections: Connection[],
): string {
  const normNodes = nodes.map((node) => ({
    id: node.id,
    type: node.type ?? 'textCard',
    position: node.position,
    data: normalizeData((node.data ?? {}) as Record<string, unknown>),
  }))
  return sortedStringify({ nodes: normNodes, connections })
}
