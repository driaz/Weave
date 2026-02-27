import type { Connection } from '../api/claude'

export type BoardId = string

export type WeaveMode = 'weave' | 'deeper' | 'tensions'

export type SerializedNode = {
  id: string
  type: string
  position: { x: number; y: number }
  data: Record<string, unknown>
}

export type SerializedBoard = {
  id: BoardId
  name: string
  nodes: SerializedNode[]
  connections: Connection[]
  nodeIdCounter: number
  createdAt: string
  updatedAt: string
}

export type WeaveBoardsStore = {
  version: number
  lastActiveBoard: BoardId
  boards: Record<BoardId, SerializedBoard>
}
