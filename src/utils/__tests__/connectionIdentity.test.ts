import { describe, expect, it } from 'vitest'
import type { Connection } from '../../api/claude'
import {
  connectionIdentityKey,
  dedupeConnectionsFirstWins,
} from '../connectionIdentity'

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

describe('connectionIdentityKey', () => {
  it('is directionless — A->B and B->A share a key', () => {
    expect(connectionIdentityKey(conn({ from: 'a', to: 'b', mode: 'weave' }))).toBe(
      connectionIdentityKey(conn({ from: 'b', to: 'a', mode: 'weave' })),
    )
  })

  it('is mode-aware — same pair in different modes is distinct', () => {
    expect(
      connectionIdentityKey(conn({ from: 'a', to: 'b', mode: 'weave' })),
    ).not.toBe(
      connectionIdentityKey(conn({ from: 'a', to: 'b', mode: 'tensions' })),
    )
  })

  it('strips a node- prefix so prefixed/bare ids collide', () => {
    expect(
      connectionIdentityKey(conn({ from: 'node-a', to: 'b', mode: 'weave' })),
    ).toBe(connectionIdentityKey(conn({ from: 'a', to: 'b', mode: 'weave' })))
  })

  it('treats undefined mode consistently (coalesces to empty)', () => {
    expect(connectionIdentityKey(conn({ from: 'a', to: 'b' }))).toBe(
      connectionIdentityKey(conn({ from: 'b', to: 'a' })),
    )
  })
})

describe('dedupeConnectionsFirstWins', () => {
  it('keeps the first of a reversed-direction same-mode collision', () => {
    const first = conn({ from: 'a', to: 'b', mode: 'weave', label: 'first' })
    const reversed = conn({ from: 'b', to: 'a', mode: 'weave', label: 'second' })
    const out = dedupeConnectionsFirstWins([first, reversed])
    expect(out).toHaveLength(1)
    expect(out[0].label).toBe('first')
  })

  it('preserves cross-mode siblings on the same pair', () => {
    const out = dedupeConnectionsFirstWins([
      conn({ from: 'a', to: 'b', mode: 'weave' }),
      conn({ from: 'a', to: 'b', mode: 'deeper' }),
      conn({ from: 'b', to: 'a', mode: 'tensions' }),
    ])
    expect(out).toHaveLength(3)
  })

  it('is idempotent', () => {
    const input = [
      conn({ from: 'a', to: 'b', mode: 'weave', label: 'keep' }),
      conn({ from: 'b', to: 'a', mode: 'weave', label: 'drop' }),
    ]
    const once = dedupeConnectionsFirstWins(input)
    const twice = dedupeConnectionsFirstWins(once)
    expect(twice).toEqual(once)
  })
})
