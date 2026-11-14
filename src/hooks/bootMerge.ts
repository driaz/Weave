/**
 * Pure store steps for the boot fetch (docs/reads/cold-load-gate.md).
 *
 * The boot fetch loads the current board first and opens that board's save
 * gate when it lands; the other boards load afterwards, one store step each.
 * When a fetch replaces a board the user is looking at, nodes created during
 * this page load are kept: they never reached the server (their saves were
 * dropped at the gate), so there is nothing to conflict with. Everything else
 * is replaced by server state.
 */
import type { Connection } from '../api/claude'
import type { Board } from '../persistence/types'
import type { SerializedBoard, WeaveBoardsStore } from '../types/board'
import { connectionIdentityKey } from '../utils/connectionIdentity'

/**
 * The store that replaces the hydrated one when the boot fetch lands:
 * always the fetch result, whatever the cache held. One exception — the
 * snap-back guard: `fetched.lastActiveBoard` was frozen as
 * `preferredActiveId` when the fetch started. If the user switched boards
 * during the await, keep their choice — but only if Supabase still knows
 * about that board (otherwise fall through to whatever Supabase returned
 * rather than render an undefined board).
 */
export function storeAfterBootFetch(
  prev: WeaveBoardsStore,
  fetched: WeaveBoardsStore,
): WeaveBoardsStore {
  return prev.lastActiveBoard !== fetched.lastActiveBoard &&
    fetched.boards[prev.lastActiveBoard]
    ? { ...fetched, lastActiveBoard: prev.lastActiveBoard }
    : fetched
}

/** The board to fetch first: the one on screen, if the server knows it. */
export function pickFirstBoard(
  serverBoards: ReadonlyArray<Pick<Board, 'id'>>,
  onScreen: string,
): string {
  return serverBoards.some((b) => b.id === onScreen) ? onScreen : serverBoards[0].id
}

/**
 * The store once the board list and the first board have landed. The board
 * set follows the server list. The first board is the fetch result; the
 * others keep their cached content (or start empty) until their own fetch
 * lands, with the server's name and timestamps.
 */
export function storeAfterFirstBoard(
  prev: WeaveBoardsStore,
  serverBoards: ReadonlyArray<Board>,
  first: SerializedBoard,
): WeaveBoardsStore {
  const boards: WeaveBoardsStore['boards'] = {}
  for (const meta of serverBoards) {
    if (meta.id === first.id) {
      boards[meta.id] = first
      continue
    }
    const cached = prev.boards[meta.id]
    boards[meta.id] = {
      id: meta.id,
      name: meta.name,
      nodes: cached?.nodes ?? [],
      connections: cached?.connections ?? [],
      nodeIdCounter: cached?.nodeIdCounter ?? 1,
      createdAt: meta.created_at,
      updatedAt: meta.updated_at,
    }
  }
  return storeAfterBootFetch(prev, {
    version: prev.version,
    lastActiveBoard: first.id,
    boards,
  })
}

/**
 * One later board landing: replace it with the fetch result. A board that
 * left the store while it loaded (deleted mid-fetch) is not brought back.
 */
export function storeWithFetchedBoard(
  prev: WeaveBoardsStore,
  fetched: SerializedBoard,
): WeaveBoardsStore {
  if (!prev.boards[fetched.id]) return prev
  return { ...prev, boards: { ...prev.boards, [fetched.id]: fetched } }
}

/**
 * Canvas state after a fetch replaces the board on screen. `seededIds` is
 * the board as the store held it before the fetch. Nothing is saved before
 * a board's first fetch, so the store still holds exactly the cache seed.
 * A local node whose id is in neither the seed nor the fetch was created in
 * this page load and is kept. A connection is kept when it touches a kept
 * node and both its ends survive. Everything else comes from the fetch,
 * including the positions of pre-existing nodes (a move inside the window is
 * lost, by decision).
 */
export function keepLocalCreations<N extends { id: string }>(opts: {
  localNodes: ReadonlyArray<N>
  localConnections: ReadonlyArray<Connection>
  seededIds: Iterable<string>
  fetchedNodes: ReadonlyArray<N>
  fetchedConnections: ReadonlyArray<Connection>
}): { nodes: N[]; connections: Connection[]; keptIds: string[] } {
  const seeded = new Set(opts.seededIds)
  const fetchedIds = new Set(opts.fetchedNodes.map((n) => n.id))
  const kept = opts.localNodes.filter((n) => !seeded.has(n.id) && !fetchedIds.has(n.id))
  const keptIds = new Set(kept.map((n) => n.id))

  const nodes = [...opts.fetchedNodes, ...kept]
  const surviving = new Set(nodes.map((n) => n.id))
  const fetchedKeys = new Set(opts.fetchedConnections.map(connectionIdentityKey))
  const keptConnections = opts.localConnections.filter(
    (c) =>
      (keptIds.has(c.from) || keptIds.has(c.to)) &&
      surviving.has(c.from) &&
      surviving.has(c.to) &&
      !fetchedKeys.has(connectionIdentityKey(c)),
  )

  return {
    nodes,
    connections: [...opts.fetchedConnections, ...keptConnections],
    keptIds: [...keptIds],
  }
}
