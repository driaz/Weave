import { describe, expect, it } from 'vitest'
import type { Connection } from '../../api/claude'
import {
  anchorHintFor,
  applyEdgeIds,
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

describe('applyEdgeIds', () => {
  it('writes the saved id onto the matching connection, either direction', () => {
    const woven = [conn({ from: '7', to: '5', mode: 'weave' })]
    const ids = new Map([[connectionIdentityKey({ from: '5', to: '7', mode: 'weave' }), 'edge-uuid']])
    const out = applyEdgeIds(woven, ids)
    expect(out[0].id).toBe('edge-uuid')
    expect(out[0].from).toBe('7')
    expect(woven[0].id).toBeUndefined() // input not mutated
  })

  it('returns the same array when nothing changes (no render, no save)', () => {
    const held = [conn({ id: 'edge-uuid', from: '5', to: '7', mode: 'weave' })]
    const ids = new Map([[connectionIdentityKey(held[0]), 'edge-uuid']])
    expect(applyEdgeIds(held, ids)).toBe(held)
    expect(applyEdgeIds(held, new Map())).toBe(held)
  })

  it('is mode-aware and leaves unmatched connections untouched', () => {
    const weave = conn({ from: '5', to: '7', mode: 'weave' })
    const deeper = conn({ from: '5', to: '7', mode: 'deeper' })
    const later = conn({ from: '8', to: '9', mode: 'weave' })
    const ids = new Map([[connectionIdentityKey(weave), 'w-id']])
    const out = applyEdgeIds([weave, deeper, later], ids)
    expect(out.map((c) => c.id)).toEqual(['w-id', undefined, undefined])
    expect(out[1]).toBe(deeper)
    expect(out[2]).toBe(later)
  })
})

describe('anchorHintFor', () => {
  it('builds the server-resolve hint from an id-less connection', () => {
    expect(anchorHintFor('board-1', conn({ from: 'node-5', to: '7', mode: 'tensions' }))).toEqual({
      boardId: 'board-1',
      clientFrom: '5',
      clientTo: '7',
      mode: 'tensions',
    })
    expect(anchorHintFor('board-1', conn({})).mode).toBeNull()
  })
})
