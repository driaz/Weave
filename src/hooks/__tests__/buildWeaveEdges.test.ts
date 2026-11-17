import { describe, expect, it } from 'vitest'
import type { Connection } from '../../api/claude'
import { buildWeaveEdges } from '../useStaggeredEdges'

const conn = (from: string, to: string, mode?: Connection['mode']) =>
  ({ from, to, mode, label: '', explanation: '', type: '', strength: 0.5, surprise: 0.5 }) as Connection

const connections = [conn('a', 'b'), conn('c', 'a'), conn('b', 'c'), conn('a', 'd', 'tensions')]

const flags = (edges: ReturnType<typeof buildWeaveEdges>) =>
  edges.map((e) => [e.source, e.target, e.data?.isHighlighted, e.data?.isDimmed])

describe('buildWeaveEdges highlight flags', () => {
  it('neither highlights nor dims with no selection', () => {
    expect(flags(buildWeaveEdges(connections, 'weave', null))).toEqual([
      ['a', 'b', false, false],
      ['c', 'a', false, false],
      ['b', 'c', false, false],
      ['a', 'd', false, false],
    ])
  })

  it('highlights the clicked node’s active-layer edges and dims the rest', () => {
    expect(
      flags(buildWeaveEdges(connections, 'weave', { type: 'node', nodeId: 'a' })),
    ).toEqual([
      ['a', 'b', true, false],
      ['c', 'a', true, false],
      ['b', 'c', false, true],
      // other layer: not highlighted; WeaveEdge ignores isDimmed off-layer
      ['a', 'd', false, true],
    ])
  })

  it('highlights only the clicked connection on a label click', () => {
    const hl = { type: 'connection' as const, connection: conn('b', 'c'), position: { x: 0, y: 0 } }
    expect(flags(buildWeaveEdges(connections, 'weave', hl)).map((f) => f[2])).toEqual([
      false,
      false,
      true,
      false,
    ])
  })
})
