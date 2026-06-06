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

/**
 * Regression guard for the client merge contract in App.tsx `onResult`
 * (the WeaveButton result handler). That merge is, semantically,
 * `dedupeConnectionsFirstWins([...existing, ...incoming])`: first-write-wins
 * on the shared identity key, with existing state seeded before the incoming
 * analyzeCanvas batch. The merge must dedup the incoming batch against BOTH
 * existing state AND itself — a single analyzeCanvas run can return multiple
 * genuinely-distinct same-(pair, mode) readings (confirmed by
 * edges_dedup_backup_028), and on a sparse fresh board they all land on the
 * one available pair. Without within-batch dedup, two same-(pair, mode)
 * connections would both enter client state and render as a transient
 * duplicate edge until a save/reload collapsed it.
 *
 * These cases lock that behavior so the dedup can't silently regress.
 */
describe('client merge contract (App onResult)', () => {
  // Mirrors App.tsx onResult: existing wins, so seed prev first.
  const merge = (prev: Connection[], incoming: Connection[]) =>
    dedupeConnectionsFirstWins([...prev, ...incoming])

  it('within-batch, fresh board: two same-(pair, mode) in one batch → one survives', () => {
    // The literal observed symptom: two "deeper" readings on the same pair
    // from a single analyzeCanvas run, prior state empty.
    const out = merge(
      [],
      [
        conn({ from: 'A', to: 'B', mode: 'deeper', label: 'first reading' }),
        conn({ from: 'A', to: 'B', mode: 'deeper', label: 'second reading' }),
      ],
    )
    expect(out).toHaveLength(1)
    expect(out[0].label).toBe('first reading')
  })

  it('within-batch: reversed direction in the same batch still collapses', () => {
    const out = merge(
      [],
      [
        conn({ from: 'A', to: 'B', mode: 'deeper', label: 'first' }),
        conn({ from: 'B', to: 'A', mode: 'deeper', label: 'reversed dup' }),
      ],
    )
    expect(out).toHaveLength(1)
    expect(out[0].label).toBe('first')
  })

  it('incoming-vs-existing: an incoming collision with existing state is dropped (existing wins)', () => {
    const existing = [conn({ from: 'A', to: 'B', mode: 'deeper', label: 'on canvas' })]
    const out = merge(existing, [
      conn({ from: 'B', to: 'A', mode: 'deeper', label: 'incoming dup' }),
    ])
    expect(out).toHaveLength(1)
    expect(out[0].label).toBe('on canvas')
  })

  it('cross-mode siblings on the same pair coexist through the merge', () => {
    const out = merge(
      [conn({ from: 'A', to: 'B', mode: 'deeper', label: 'deeper edge' })],
      [
        conn({ from: 'A', to: 'B', mode: 'weave', label: 'weave edge' }),
        conn({ from: 'A', to: 'B', mode: 'deeper', label: 'duplicate deeper' }),
      ],
    )
    // weave sibling is added; the second deeper reading is dropped.
    expect(out).toHaveLength(2)
    expect(out.map((c) => c.mode).sort()).toEqual(['deeper', 'weave'])
  })
})
