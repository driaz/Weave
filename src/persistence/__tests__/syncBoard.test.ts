import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Connection } from '../../api/claude'
import type { SerializedBoard } from '../../types/board'
import { anchorHintFor, applyEdgeIds, connectionIdentityKey } from '../../utils/connectionIdentity'
import { persistence } from '../index'
import { edgeIdsFromRpcResult, syncBoardToSupabase } from '../syncBoard'
import { createTestUser, hasServiceRole, type TestUser } from './setup'

describe('edgeIdsFromRpcResult', () => {
  it('keys ids on the client directionless identity', () => {
    const ids = edgeIdsFromRpcResult([
      { id: 'a', client_source_id: '7', client_target_id: '5', mode: 'weave' },
      { id: 'b', client_source_id: '5', client_target_id: '7', mode: null },
    ])
    expect(ids.get(connectionIdentityKey({ from: '5', to: '7', mode: 'weave' }))).toBe('a')
    expect(ids.get(connectionIdentityKey({ from: '7', to: '5' }))).toBe('b')
  })

  it('tolerates a pre-041 void result and malformed rows', () => {
    expect(edgeIdsFromRpcResult(null).size).toBe(0)
    expect(edgeIdsFromRpcResult([{ id: 1 }, null, 'x']).size).toBe(0)
  })
})

function connection(from: string, to: string, mode: Connection['mode']): Connection {
  return { from, to, mode, label: `${from}-${to}`, explanation: '', type: 'related', strength: 0.5, surprise: 0.5 }
}

describe.skipIf(!hasServiceRole())('syncBoardToSupabase edge ids (integration)', () => {
  let user: TestUser
  const now = new Date().toISOString()
  // Claude-derived connections, exactly as a weave hands them over: no id.
  const woven = [connection('7', '5', 'weave'), connection('5', '9', 'deeper')]
  const board: SerializedBoard = {
    id: crypto.randomUUID(),
    name: `__persistence_test_sync_edge_ids_${Date.now()}__`,
    nodes: ['5', '7', '9'].map((id, i) => ({
      id,
      type: 'textCard',
      position: { x: i * 100, y: 0 },
      data: { text: `node ${id}` },
    })),
    connections: woven,
    nodeIdCounter: 10,
    createdAt: now,
    updatedAt: now,
  }

  beforeAll(async () => {
    user = await createTestUser('sync-edge-ids')
  })

  afterAll(async () => {
    await persistence.boards.delete(board.id).catch(() => {})
    await user.cleanup()
  })

  it('a weave holds its edges.id after one save, without a reload', async () => {
    const ids = await syncBoardToSupabase(user.userId, board)
    const held = applyEdgeIds(woven, ids)

    const rows = await persistence.edges.listByBoard(board.id)
    expect(rows).toHaveLength(2)
    for (const c of held) {
      const row = rows.find((r) => r.id === c.id)
      expect(row, `connection ${c.from}-${c.to} has a real edges.id`).toBeDefined()
      expect(row?.mode).toBe(c.mode)
    }

    // A second save of the id-carrying connections keeps the same rows.
    const again = await syncBoardToSupabase(user.userId, { ...board, connections: held })
    expect(applyEdgeIds(held, again)).toBe(held)
  })

  it('Speak during the boot window (cache-era, id-less connection) still anchors', async () => {
    // The popup's object from a warm cache: no id. handleSpeak passes
    // anchorEdgeId null plus anchorHintFor(boardId, connection).
    const cacheEra = woven[0]
    const session = await persistence.voiceSessions.createSession({
      anchor_edge_id: null,
      anchor_hint: anchorHintFor(board.id, cacheEra),
      board_snapshot: { nodes: [], edges: [], captured_at: now } as unknown as never,
      started_at: new Date().toISOString(),
    })
    const rows = await persistence.edges.listByBoard(board.id)
    const expected = rows.find((r) => r.mode === 'weave')
    expect(session.anchor_edge_id).toBe(expected?.id)
  })
})
