import { createContext, useContext } from 'react'

/**
 * Context to make the current board ID available to deeply nested components
 * without prop-drilling. Used by the event tracking system.
 */
export const BoardIdContext = createContext<string>('')

export function useBoardId(): string {
  return useContext(BoardIdContext)
}
