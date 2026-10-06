import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SerializedBoard, SerializedNode, WeaveBoardsStore } from '../../types/board'
import { createSaveGate, type SaveGate } from '../saveGate'
import { computeSaveSignature } from '../saveSignature'
import { storeAfterBootFetch } from '../useBoardStorage'

/**
 * The warm-boot stale-save gate (docs/reads/warm-boot-save.md). Each test
 * walks the sequence the hook runs: hydrate, attempted saves, fetch lands
 * (store replaced, App re-seeds and marks the board clean), then edits.
 * `clean` stands in for lastSavedSignatures.
 */

const node = (id: string, data: Record<string, unknown> = {}, x = 0): SerializedNode => ({
  id,
  type: 'linkCard',
  position: { x, y: 0 },
  data: { title: `node ${id}`, ...data },
})

const board = (id: string, nodes: SerializedNode[], updatedAt: string): SerializedBoard => ({
  id,
  name: id,
  nodes,
  connections: [],
  nodeIdCounter: 10,
  createdAt: updatedAt,
  updatedAt,
})

const store = (lastActiveBoard: string, boards: SerializedBoard[]): WeaveBoardsStore => ({
  version: 2,
  lastActiveBoard,
  boards: Object.fromEntries(boards.map((b) => [b.id, b])),
})

const sig = (b: SerializedBoard) => computeSaveSignature(b.nodes, b.connections)

// Same board id and updatedAt; only the server-written key differs —
// exactly the case the old content-blind comparison could not see.
const T = '2026-09-28T04:31:38.796176+00:00'
const cached = board('A', [node('15')], T)
const fetched = board('A', [node('15', { media_analysis: 'server analysis' })], T)

let gate: SaveGate
let debug: ReturnType<typeof vi.spyOn>
const clean = new Map<string, string>()

beforeEach(() => {
  gate = createSaveGate()
  clean.clear()
  debug = vi.spyOn(console, 'debug').mockImplementation(() => {})
})
afterEach(() => debug.mockRestore())

function attempt(b: SerializedBoard, path: Parameters<SaveGate['decide']>[0]['path']) {
  return gate.decide({ boardId: b.id, path, signature: sig(b), lastSavedSignature: clean.get(b.id) })
}

describe('warm boot', () => {
  it('drops saves before the fetch, adopts the fetch, then saves fresh content on a real edit', () => {
    const hydrated = store('A', [cached])

    // Mount debounce fires on the cache-seeded state: no request.
    expect(attempt(cached, 'debounce')).toBe('dropped-before-fetch')
    expect(gate.dropped().debounce).toBe(1)
    expect(debug).toHaveBeenCalledWith(expect.stringContaining('path=debounce board=A'))

    // Fetch lands: the store becomes the fetch result, not the cache.
    const next = storeAfterBootFetch(hydrated, store('A', [fetched]))
    gate.markFetched(Object.keys(next.boards))
    expect(next.boards.A).toBe(fetched)
    expect(next.boards.A.nodes[0].data.media_analysis).toBe('server analysis')

    // App re-seeds from the replaced store and marks it clean: the
    // replacement itself triggers no save.
    clean.set('A', sig(next.boards.A))
    expect(attempt(next.boards.A, 'debounce')).toBe('unchanged')

    // A real edit saves — with the fetched content in the payload.
    const edited = board('A', [node('15', { media_analysis: 'server analysis' }, 50)], T)
    expect(attempt(edited, 'debounce')).toBe('save')
    expect(edited.nodes[0].data.media_analysis).toBe('server analysis')
  })

  it('a fetch identical to the cache still replaces the store, and still saves nothing', () => {
    const fromServer = board('A', [node('15')], T)
    const next = storeAfterBootFetch(store('A', [cached]), store('A', [fromServer]))
    expect(next.boards.A).toBe(fromServer)
    expect(next.boards.A).not.toBe(cached)

    gate.markFetched(['A'])
    clean.set('A', sig(next.boards.A))
    expect(attempt(next.boards.A, 'debounce')).toBe('unchanged')
  })

  it('a failed fetch leaves the gate shut: saves stay dropped', () => {
    expect(attempt(cached, 'debounce')).toBe('dropped-before-fetch')
    const edited = board('A', [node('15', {}, 50)], T)
    expect(attempt(edited, 'debounce')).toBe('dropped-before-fetch')
    expect(gate.dropped().debounce).toBe(2)
    expect(gate.isOpen('A')).toBe(false)
  })
})

describe('cold boot', () => {
  it('no save before the fetch; behaves normally after', () => {
    const empty = board('A', [], T)
    expect(attempt(empty, 'debounce')).toBe('dropped-before-fetch')

    gate.markFetched(['A'])
    clean.set('A', sig(fetched))
    expect(attempt(fetched, 'debounce')).toBe('unchanged')
    expect(attempt(board('A', [node('15', { media_analysis: 'server analysis' }, 9)], T), 'debounce')).toBe('save')
  })
})

describe('board switch', () => {
  it('checks the flag of the board being left, not the one entered', () => {
    gate.markFetched(['B'])
    expect(attempt(cached, 'switch')).toBe('dropped-before-fetch')
    expect(gate.dropped().switch).toBe(1)
    expect(debug).toHaveBeenCalledWith(expect.stringContaining('path=switch board=A'))
  })

  it('saves the departing board once it has been fetched', () => {
    gate.markFetched(['A', 'B'])
    expect(attempt(board('A', [node('15', {}, 70)], T), 'switch')).toBe('save')
  })

  it('preserves a mid-fetch switch when the fetch lands (snap-back guard)', () => {
    const prev = store('B', [cached, board('B', [], T)])
    const next = storeAfterBootFetch(prev, store('A', [fetched, board('B', [], T)]))
    expect(next.lastActiveBoard).toBe('B')
    expect(next.boards.A).toBe(fetched)
  })
})

describe('create board', () => {
  it('a new board is open on creation; the departing unfetched board is not saved', () => {
    expect(attempt(cached, 'create-board')).toBe('dropped-before-fetch')
    expect(gate.dropped()['create-board']).toBe(1)

    gate.markCreated('NEW')
    expect(
      gate.decide({
        boardId: 'NEW',
        path: 'new-board',
        signature: computeSaveSignature([], []),
        lastSavedSignature: undefined,
      }),
    ).toBe('save')
    expect(gate.dropped()['new-board']).toBe(0)
  })
})
