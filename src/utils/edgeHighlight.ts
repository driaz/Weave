import type { Connection } from '../api/claude'
import type { WeaveMode } from '../types/board'
import type { HighlightState } from '../hooks/useSelectedNode'

function strip(id: string): string {
  return id.replace(/^node-/, '')
}

/**
 * Node ids that stay lit while a highlight is active: the clicked node
 * plus its neighbours on the active layer, or the two ends of a clicked
 * connection. Returns null when nothing is highlighted.
 */
export function getLitNodeIds(
  connections: Connection[],
  activeLayer: WeaveMode,
  highlightState: HighlightState,
): Set<string> | null {
  if (!highlightState) return null
  if (highlightState.type === 'connection') {
    return new Set([
      strip(highlightState.connection.from),
      strip(highlightState.connection.to),
    ])
  }
  const id = highlightState.nodeId
  const lit = new Set([id])
  for (const c of connections) {
    if ((c.mode ?? 'weave') !== activeLayer) continue
    const from = strip(c.from)
    const to = strip(c.to)
    if (from === id) lit.add(to)
    if (to === id) lit.add(from)
  }
  return lit
}
