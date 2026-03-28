import { createContext, useContext } from 'react'
import type { Connection } from '../api/claude'

export type HighlightState =
  | { type: 'node'; nodeId: string }
  | { type: 'connection'; connection: Connection; position: { x: number; y: number } }
  | null

export const HighlightContext = createContext<HighlightState>(null)

function stripNodePrefix(id: string): string {
  return id.replace(/^node-/, '')
}

/**
 * Returns highlight status for a node:
 * - isSelected: this node was directly clicked (orange border, pulse twice)
 * - isConnected: this node is connected to a highlighted edge label (orange border, infinite pulse)
 */
export function useNodeHighlightStatus(nodeId: string): {
  isSelected: boolean
  isConnected: boolean
} {
  const state = useContext(HighlightContext)
  if (!state) return { isSelected: false, isConnected: false }

  if (state.type === 'node') {
    return { isSelected: state.nodeId === nodeId, isConnected: false }
  }

  // type === 'connection'
  const from = stripNodePrefix(state.connection.from)
  const to = stripNodePrefix(state.connection.to)
  return {
    isSelected: false,
    isConnected: nodeId === from || nodeId === to,
  }
}
