import { describe, expect, it } from 'vitest'
import type { Connection } from '../../api/claude'
import { getLitNodeIds } from '../edgeHighlight'

const conn = (from: string, to: string, mode?: Connection['mode']) =>
  ({ from, to, mode, label: '', explanation: '', type: '', strength: 0.5, surprise: 0.5 }) as Connection

describe('getLitNodeIds', () => {
  const connections = [
    conn('a', 'b'),
    conn('node-c', 'a'),
    conn('a', 'd', 'tensions'),
    conn('e', 'f'),
  ]

  it('returns null with no highlight', () => {
    expect(getLitNodeIds(connections, 'weave', null)).toBeNull()
  })

  it('lights the clicked node and its active-layer neighbours', () => {
    const lit = getLitNodeIds(connections, 'weave', { type: 'node', nodeId: 'a' })
    expect([...lit!].sort()).toEqual(['a', 'b', 'c'])
  })

  it('respects the active layer', () => {
    const lit = getLitNodeIds(connections, 'tensions', { type: 'node', nodeId: 'a' })
    expect([...lit!].sort()).toEqual(['a', 'd'])
  })

  it('lights both ends of a clicked connection', () => {
    const lit = getLitNodeIds(connections, 'weave', {
      type: 'connection',
      connection: conn('node-e', 'f'),
      position: { x: 0, y: 0 },
    })
    expect([...lit!].sort()).toEqual(['e', 'f'])
  })
})
