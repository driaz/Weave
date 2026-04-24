import { createContext, useContext } from 'react'

/**
 * Lets deep components (e.g. lightbox open handlers) cancel a
 * pending `node_selected` event that handleNodeClick scheduled.
 * Double-clicks fire two clicks before the dblclick event arrives;
 * without cancellation, opening a lightbox would attribute two
 * spurious node_selected events to the node first.
 */
export const CancelNodeSelectContext = createContext<() => void>(() => {})

export function useCancelNodeSelect(): () => void {
  return useContext(CancelNodeSelectContext)
}
