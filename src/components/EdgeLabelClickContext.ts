import { createContext } from 'react'
import type { Connection } from '../api/claude'

type EdgeLabelClickHandler = (
  connection: Connection,
  position: { x: number; y: number },
) => void

export const EdgeLabelClickContext = createContext<EdgeLabelClickHandler>(
  () => {},
)
