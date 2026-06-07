import { describe, expect, it } from 'vitest'
import type { Connection } from '../../api/claude'
import {
  connectionIdentityFields,
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

describe('connectionIdentityFields', () => {
  it('sorts the pair (lo <= hi) regardless of direction', () => {
    expect(connectionIdentityFields(conn({ from: 'b', to: 'a', mode: 'weave' }))).toEqual({
      mode: 'weave',
      lo: 'a',
      hi: 'b',
    })
    expect(connectionIdentityFields(conn({ from: 'a', to: 'b', mode: 'weave' }))).toEqual({
      mode: 'weave',
      lo: 'a',
      hi: 'b',
    })
  })

  it('coalesces undefined mode to empty string (mirrors SQL coalesce)', () => {
    expect(connectionIdentityFields(conn({ from: 'a', to: 'b' })).mode).toBe('')
  })

  it('strips a node- prefix before sorting', () => {
    expect(connectionIdentityFields(conn({ from: 'node-b', to: 'node-a', mode: 'deeper' }))).toEqual(
      { mode: 'deeper', lo: 'a', hi: 'b' },
    )
  })

  it('agrees with connectionIdentityKey (same canonicalization)', () => {
    const c = conn({ from: 'node-z', to: 'm', mode: 'tensions' })
    const { mode, lo, hi } = connectionIdentityFields(c)
    expect(connectionIdentityKey(c)).toBe(`${mode}\0${lo}\0${hi}`)
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
