import { describe, expect, it } from 'vitest'
import { READ_PAGE_SIZE } from '../constants'
import { clientNodeId, horizonStart, readEvents } from '../reads'

/**
 * A minimal PostgREST-shaped fake: `rows` is what paged reads return in
 * total, `count` is what a head count request reports. Every filter method
 * returns the chain; `range` resolves a page; awaiting a head-count chain
 * resolves `{ count }`.
 */
function fakeClient(rows: unknown[], count: number) {
  return {
    from: () => {
      let head = false
      const chain = {
        select: (_cols: string, opts?: { count?: string; head?: boolean }) => {
          head = Boolean(opts?.head)
          return chain
        },
        in: () => chain,
        gte: () => chain,
        eq: () => chain,
        not: () => chain,
        order: () => chain,
        range: async (from: number, to: number) => ({ data: rows.slice(from, to + 1), error: null }),
        then: (resolve: (v: unknown) => void) => resolve(head ? { count, error: null } : { data: rows, error: null }),
      }
      return chain
    },
  }
}

describe('readEvents gate', () => {
  it('throws when rows_expected differs from rows_returned', async () => {
    const rows = Array.from({ length: 3 }, (_, i) => ({ id: `e${i}`, event_type: 'item_added' }))
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(readEvents(fakeClient(rows, 4) as any, new Date())).rejects.toThrow(/count\(\*\) on the identical predicate is 4/)
  })
  it('pages until a short page and passes when the count agrees', async () => {
    const n = READ_PAGE_SIZE + 7
    const rows = Array.from({ length: n }, (_, i) => ({ id: `e${i}`, event_type: i % 2 ? 'item_added' : 'lightbox_closed' }))
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = await readEvents(fakeClient(rows, n) as any, new Date())
    expect(out.gate).toEqual({ rows_returned: n, rows_expected: n })
    expect(out.by_type.item_added + out.by_type.lightbox_closed).toBe(n)
  })
})

describe('helpers', () => {
  it('horizonStart subtracts whole days', () => {
    expect(horizonStart(new Date('2026-09-05T00:00:00Z'), 70)).toBe('2026-06-27T00:00:00.000Z')
  })
  it('clientNodeId mirrors hydration: data._clientNodeId, else the row uuid', () => {
    expect(clientNodeId({ id: 'uuid-1', board_id: 'b', data: { _clientNodeId: '12' } })).toBe('12')
    expect(clientNodeId({ id: 'uuid-1', board_id: 'b', data: {} })).toBe('uuid-1')
    expect(clientNodeId({ id: 'uuid-1', board_id: 'b', data: null })).toBe('uuid-1')
  })
})
