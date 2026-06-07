import { describe, expect, it } from 'vitest'
import type { Connection } from '../../api/claude'
import { computeRetrievalExclusions } from '../retrievalExclusions'

function conn(partial: Partial<Connection>): Connection {
  return {
    from: 'a',
    to: 'b',
    label: '',
    explanation: '',
    type: 'related',
    strength: 0,
    surprise: 0,
    ...partial,
  }
}

describe('computeRetrievalExclusions', () => {
  it('always includes the anchor nodes themselves', () => {
    const out = computeRetrievalExclusions([], ['a', 'b'])
    expect(new Set(out)).toEqual(new Set(['a', 'b']))
  })

  it('includes nodes directly adjacent to an anchor (either direction)', () => {
    const connections = [
      conn({ from: 'a', to: 'c' }), // c adjacent to anchor a (a is `from`)
      conn({ from: 'd', to: 'b' }), // d adjacent to anchor b (b is `to`)
    ]
    const out = computeRetrievalExclusions(connections, ['a', 'b'])
    expect(new Set(out)).toEqual(new Set(['a', 'b', 'c', 'd']))
  })

  it('does NOT leak 2-hop neighbors', () => {
    // a — c — e : e is two hops from anchor a, must not be excluded.
    const connections = [conn({ from: 'a', to: 'c' }), conn({ from: 'c', to: 'e' })]
    const out = computeRetrievalExclusions(connections, ['a'])
    expect(new Set(out)).toEqual(new Set(['a', 'c']))
    expect(out).not.toContain('e')
  })

  it('is order-independent (2-hop guard holds when edges are reversed in the list)', () => {
    const connections = [conn({ from: 'c', to: 'e' }), conn({ from: 'a', to: 'c' })]
    const out = computeRetrievalExclusions(connections, ['a'])
    expect(out).not.toContain('e')
  })

  it('strips node- prefixes on both anchors and connection endpoints', () => {
    const connections = [conn({ from: 'node-a', to: 'node-c' })]
    const out = computeRetrievalExclusions(connections, ['node-a'])
    expect(new Set(out)).toEqual(new Set(['a', 'c']))
  })

  it('ignores connections unrelated to any anchor', () => {
    const connections = [conn({ from: 'x', to: 'y' })]
    const out = computeRetrievalExclusions(connections, ['a'])
    expect(new Set(out)).toEqual(new Set(['a']))
  })

  it('dedupes when a node is adjacent to multiple anchors', () => {
    const connections = [conn({ from: 'a', to: 'shared' }), conn({ from: 'b', to: 'shared' })]
    const out = computeRetrievalExclusions(connections, ['a', 'b'])
    expect(out.filter((id) => id === 'shared')).toHaveLength(1)
  })
})
