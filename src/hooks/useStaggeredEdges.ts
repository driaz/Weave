import { useMemo } from 'react'
import type { Edge } from '@xyflow/react'
import type { Connection } from '../api/claude'
import type { WeaveEdgeData } from '../components/WeaveEdge'

function stripNodePrefix(id: string): string {
  return id.replace(/^node-/, '')
}

export function useStaggeredEdges(connections: Connection[]): Edge<WeaveEdgeData>[] {
  return useMemo(
    () =>
      connections.map((conn, index) => {
        const source = stripNodePrefix(conn.from)
        const target = stripNodePrefix(conn.to)
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
          },
        }
      }),
    [connections],
  )
}
