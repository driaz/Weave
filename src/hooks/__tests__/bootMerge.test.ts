import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Connection } from '../../api/claude'
import type { Board } from '../../persistence/types'
import type { SerializedBoard, SerializedNode, WeaveBoardsStore } from '../../types/board'
import {
  keepLocalCreations,
  pickFirstBoard,
  storeAfterFirstBoard,
  storeWithFetchedBoard,
} from '../bootMerge'
import { createSaveGate, type SaveGate } from '../saveGate'
import { computeSaveSignature } from '../saveSignature'

/**
 * The cold-load drop window (docs/reads/cold-load-gate.md): the board on
 * screen is fetched first and opens its own gate; nodes created before a
 * board's fetch lands survive it and are saved after.
 */

const T = '2026-11-13T00:00:00.000Z'
const node = (id: string, x = 0, data: Record<string, unknown> = {}): SerializedNode => ({
  id,
  type: 'textCard',
  position: { x, y: 0 },
  data: { text: `node ${id}`, ...data },
})
const board = (id: string, nodes: SerializedNode[], connections: Connection[] = []): SerializedBoard => ({
  id,
  name: id,
  nodes,
  connections,
  nodeIdCounter: 10,
  createdAt: T,
  updatedAt: T,
})
const store = (lastActiveBoard: string, boards: SerializedBoard[]): WeaveBoardsStore => ({
  version: 1,
  lastActiveBoard,
  boards: Object.fromEntries(boards.map((b) => [b.id, b])),
})
const meta = (id: string, name = id): Board =>
  ({ id, name, created_at: T, updated_at: '2026-11-13T01:00:00.000Z' }) as Board
const conn = (from: string, to: string, label = 'x'): Connection => ({
  from,
  to,
  label,
  explanation: '',
  type: 'related',
  strength: 0.5,
  surprise: 0.5,
  mode: 'weave',
})

describe('pickFirstBoard', () => {
  it('fetches the board on screen first when the server knows it', () => {
    expect(pickFirstBoard([meta('A'), meta('B')], 'B')).toBe('B')
  })
  it('falls back to the first server board when the screen board is unknown', () => {
    expect(pickFirstBoard([meta('A'), meta('B')], 'GONE')).toBe('A')
  })
})

describe('storeAfterFirstBoard', () => {
  const cachedA = board('A', [node('1')])
  const cachedB = board('B', [node('7')])
  const fetchedA = board('A', [node('1', 0, { media_analysis: 'server' })])

  it('replaces the first board with the fetch; others keep cache content until their own fetch', () => {
    const next = storeAfterFirstBoard(store('A', [cachedA, cachedB]), [meta('A'), meta('B', 'B renamed')], fetchedA)
    expect(next.boards.A).toBe(fetchedA)
    expect(next.boards.B.nodes).toBe(cachedB.nodes)
    expect(next.boards.B.name).toBe('B renamed')
    expect(next.lastActiveBoard).toBe('A')
  })

  it('follows the server board set: a server board missing from cache starts empty, a cache-only board is dropped', () => {
    const next = storeAfterFirstBoard(store('A', [cachedA, board('OLD', [])]), [meta('A'), meta('NEW')], fetchedA)
    expect(Object.keys(next.boards).sort()).toEqual(['A', 'NEW'])
    expect(next.boards.NEW.nodes).toEqual([])
  })

  it('keeps a mid-fetch switch (snap-back guard)', () => {
    const next = storeAfterFirstBoard(store('B', [cachedA, cachedB]), [meta('A'), meta('B')], fetchedA)
    expect(next.lastActiveBoard).toBe('B')
    expect(next.boards.A).toBe(fetchedA)
  })
})

describe('storeWithFetchedBoard', () => {
  it('replaces a later board without touching the active one', () => {
    const prev = store('A', [board('A', [node('1')]), board('B', [node('7')])])
    const fetchedB = board('B', [node('7', 5)])
    const next = storeWithFetchedBoard(prev, fetchedB)
    expect(next.boards.B).toBe(fetchedB)
    expect(next.boards.A).toBe(prev.boards.A)
    expect(next.lastActiveBoard).toBe('A')
  })
  it('does not resurrect a board deleted while it loaded', () => {
    const prev = store('A', [board('A', [])])
    expect(storeWithFetchedBoard(prev, board('B', []))).toBe(prev)
  })
})

describe('per-board gates', () => {
  let gate: SaveGate
  let debug: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    gate = createSaveGate()
    debug = vi.spyOn(console, 'debug').mockImplementation(() => {})
  })
  afterEach(() => debug.mockRestore())

  const attempt = (id: string) =>
    gate.decide({ boardId: id, path: 'debounce', signature: 's', lastSavedSignature: undefined })

  it('the first board opens on its own fetch; the others stay closed until theirs', () => {
    gate.markFetched(['A'])
    expect(attempt('A')).toBe('save')
    expect(attempt('B')).toBe('dropped-before-fetch')
    gate.markFetched(['B'])
    expect(attempt('B')).toBe('save')
    // Never reset on switch: A stays open.
    expect(attempt('A')).toBe('save')
  })
})

describe('keepLocalCreations', () => {
  const seeded = [node('1'), node('2')]

  it('keeps a node created before the fetch landed and replaces everything else', () => {
    const local = [node('1', 99), node('2'), node('3', 40)] // 1 moved, 3 added
    const fetched = [node('1', 0, { media_analysis: 'server' }), node('2')]
    const out = keepLocalCreations({
      localNodes: local,
      localConnections: [],
      seededIds: seeded.map((n) => n.id),
      fetchedNodes: fetched,
      fetchedConnections: [],
    })
    expect(out.keptIds).toEqual(['3'])
    expect(out.nodes.map((n) => n.id)).toEqual(['1', '2', '3'])
    // Server state wins for pre-existing nodes; the move inside the window is lost (accepted).
    expect(out.nodes[0]).toBe(fetched[0])
    // The kept node keeps its local position (the move after the add survives).
    expect(out.nodes[2].position.x).toBe(40)
  })

  it('does not resurrect a node deleted on the server (it was in the seed)', () => {
    const out = keepLocalCreations({
      localNodes: [node('1'), node('2')],
      localConnections: [],
      seededIds: ['1', '2'],
      fetchedNodes: [node('1')],
      fetchedConnections: [],
    })
    expect(out.nodes.map((n) => n.id)).toEqual(['1'])
    expect(out.keptIds).toEqual([])
  })

  it('takes the server copy when a local id also arrived from the server', () => {
    const fromServer = node('3', 0, { text: 'server' })
    const out = keepLocalCreations({
      localNodes: [...seeded, node('3', 40)],
      localConnections: [],
      seededIds: ['1', '2'],
      fetchedNodes: [...seeded, fromServer],
      fetchedConnections: [],
    })
    expect(out.keptIds).toEqual([])
    expect(out.nodes[2]).toBe(fromServer)
  })

  it('keeps a connection touching a kept node only when both ends survive', () => {
    const out = keepLocalCreations({
      localNodes: [...seeded, node('3')],
      localConnections: [conn('1', '3'), conn('2', '1'), conn('3', 'GONE')],
      seededIds: ['1', '2', 'GONE'],
      fetchedNodes: seeded,
      fetchedConnections: [conn('1', '2')],
    })
    expect(out.connections.map((c) => `${c.from}-${c.to}`)).toEqual(['1-2', '1-3'])
  })

  it('a kept node makes the canvas differ from clean server state, so the next debounce saves it', () => {
    const fetched = board('A', seeded)
    const out = keepLocalCreations({
      localNodes: [...seeded, node('3')],
      localConnections: [],
      seededIds: ['1', '2'],
      fetchedNodes: fetched.nodes,
      fetchedConnections: [],
    })
    const clean = computeSaveSignature(fetched.nodes, fetched.connections)
    const gate = createSaveGate()
    gate.markFetched(['A'])
    expect(
      gate.decide({
        boardId: 'A',
        path: 'debounce',
        signature: computeSaveSignature(out.nodes, out.connections),
        lastSavedSignature: clean,
      }),
    ).toBe('save')
  })

  it('with nothing created locally, the canvas is exactly the fetch', () => {
    const fetched = [node('1', 0, { media_analysis: 'server' }), node('2')]
    const out = keepLocalCreations({
      localNodes: seeded,
      localConnections: [],
      seededIds: ['1', '2'],
      fetchedNodes: fetched,
      fetchedConnections: [],
    })
    expect(out.nodes).toEqual(fetched)
    expect(out.keptIds).toEqual([])
  })
})
