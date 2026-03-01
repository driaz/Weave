import { createContext, useContext } from 'react'

export const NodeHighlightContext = createContext<Set<string>>(new Set())

/**
 * Returns true if this node should show the pulsing highlight.
 */
export function useNodeHighlight(nodeId: string): boolean {
  const nodeIds = useContext(NodeHighlightContext)
  return nodeIds.has(nodeId)
}
