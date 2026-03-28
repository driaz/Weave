import { useMemo } from 'react'
import type { Edge } from '@xyflow/react'
import type { Connection } from '../api/claude'
import type { WeaveEdgeData } from '../components/WeaveEdge'
import type { WeaveMode } from '../types/board'
import type { HighlightState } from './useSelectedNode'

function stripNodePrefix(id: string): string {
  return id.replace(/^node-/, '')
}

export function useStaggeredEdges(
  connections: Connection[],
  activeLayer: WeaveMode = 'weave',
  highlightState: HighlightState = null,
): Edge<WeaveEdgeData>[] {
  return useMemo(() => {
    // Group by normalised source-target pair to detect parallel edges
    const pairGroups = new Map<string, number[]>()
    connections.forEach((conn, index) => {
      const source = stripNodePrefix(conn.from)
      const target = stripNodePrefix(conn.to)
      const key = [source, target].sort().join('::')
      if (!pairGroups.has(key)) pairGroups.set(key, [])
      pairGroups.get(key)!.push(index)
    })

    // Pre-compute highlight match values
    const hlNodeId =
      highlightState?.type === 'node' ? highlightState.nodeId : null
    const hlFrom =
      highlightState?.type === 'connection'
        ? stripNodePrefix(highlightState.connection.from)
        : null
    const hlTo =
      highlightState?.type === 'connection'
        ? stripNodePrefix(highlightState.connection.to)
        : null

    return connections.map((conn, index) => {
      const source = stripNodePrefix(conn.from)
      const target = stripNodePrefix(conn.to)
      const key = [source, target].sort().join('::')
      const group = pairGroups.get(key)!
      const posInGroup = group.indexOf(index)
      const total = group.length
      // Center offsets: 1 edge → 0, 2 edges → -0.5/+0.5, 3 → -1/0/+1
      const edgeOffset =
        total <= 1 ? 0 : posInGroup - (total - 1) / 2

      const onActiveLayer = (conn.mode ?? 'weave') === activeLayer
      let isHighlighted = false
      if (hlNodeId != null) {
        isHighlighted =
          onActiveLayer && (source === hlNodeId || target === hlNodeId)
      } else if (hlFrom != null && hlTo != null) {
        isHighlighted = source === hlFrom && target === hlTo
      }

      return {
        id: `weave-${source}-${target}-${index}`,
        source,
        target,
        type: 'weave' as const,
        data: {
          label: conn.label,
          explanation: conn.explanation,
          type: conn.type,
          strength: conn.strength,
          surprise: conn.surprise,
          mode: conn.mode,
          connectionIndex: index,
          edgeOffset,
          activeLayer,
          connection: conn,
          isHighlighted,
        },
      }
    })
  }, [connections, activeLayer, highlightState])
}
