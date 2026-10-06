import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Connection } from '../../api/claude'
import { supabase } from '../../services/supabaseClient'
import type { SerializedBoard, SerializedNode } from '../../types/board'
import { connectionIdentityKey } from '../../utils/connectionIdentity'
import { persistence } from '../index'
import { syncBoardToSupabase } from '../syncBoard'
import { createTestUser, hasServiceRole, type TestUser } from './setup'

/**
 * Migration 042: the node UPDATE branch of replace_board_contents merges
 * nodes.data (019) and skips unchanged nodes (020), on top of 041's body.
 * Every save here goes through the real client path (syncBoardToSupabase);
 * the "server" write is the Fly media server's own call, patch_node_data
 * under the service role.
 */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function textNode(id: string, x: number, data: Record<string, unknown> = {}): SerializedNode {
  return { id, type: 'textCard', position: { x, y: 0 }, data: { text: `node ${id}`, ...data } }
}

function connection(from: string, to: string, mode: Connection['mode'], label: string): Connection {
  return { from, to, mode, label, explanation: '', type: 'related', strength: 0.5, surprise: 0.5 }
}

describe.skipIf(!hasServiceRole())('replace_board_contents node merge + skip (042, integration)', () => {
  let user: TestUser
  const now = new Date().toISOString()
  const board: SerializedBoard = {
    id: crypto.randomUUID(),
    name: `__persistence_test_node_merge_${Date.now()}__`,
    nodes: [textNode('5', 0), textNode('7', 100), textNode('9', 200)],
    connections: [],
    nodeIdCounter: 10,
    createdAt: now,
    updatedAt: now,
  }

  async function rows() {
    const list = await persistence.nodes.listByBoard(board.id)
    const byClientId = new Map<string, (typeof list)[number]>()
    for (const r of list) {
      byClientId.set((r.data as Record<string, unknown>)._clientNodeId as string, r)
    }
    return byClientId
  }

  beforeAll(async () => {
    user = await createTestUser('node-merge')
    await syncBoardToSupabase(user.userId, board)
  })

  afterAll(async () => {
    await persistence.boards.delete(board.id).catch(() => {})
    await user.cleanup()
  })

  it('a server-written key survives a client save that omits it', async () => {
    const { error } = await user.admin.rpc('patch_node_data', {
      p_client_id: '5',
      p_board_id: board.id,
      p_user_id: user.userId,
      p_patch: { media_analysis: 'server analysis' },
    })
    expect(error).toBeNull()

    // Stale client state: no media_analysis. Move node 5 so the UPDATE
    // actually runs (an unchanged node would be skipped, proving nothing).
    const moved = { ...board, nodes: [textNode('5', 50), board.nodes[1], board.nodes[2]] }
    await syncBoardToSupabase(user.userId, moved)

    const row = (await rows()).get('5')
    expect(row?.position_x).toBe(50)
    expect((row?.data as Record<string, unknown>).media_analysis).toBe('server analysis')
  })

  it('a client-carried key change still lands', async () => {
    const v1 = { ...board, nodes: [textNode('5', 50), textNode('7', 100, { contentDescription: 'old' }), board.nodes[2]] }
    await syncBoardToSupabase(user.userId, v1)
    expect(((await rows()).get('7')?.data as Record<string, unknown>).contentDescription).toBe('old')

    const v2 = { ...board, nodes: [textNode('5', 50), textNode('7', 100, { contentDescription: 'new' }), board.nodes[2]] }
    await syncBoardToSupabase(user.userId, v2)
    expect(((await rows()).get('7')?.data as Record<string, unknown>).contentDescription).toBe('new')
  })

  it('an unchanged node is not re-dated; only the changed node is', async () => {
    const state = { ...board, nodes: [textNode('5', 50), textNode('7', 100, { contentDescription: 'new' }), board.nodes[2]] }
    await syncBoardToSupabase(user.userId, state)
    const before = await rows()

    await sleep(1100)
    await syncBoardToSupabase(user.userId, state)
    const same = await rows()
    for (const id of ['5', '7', '9']) {
      expect(same.get(id)?.updated_at, `node ${id} after identical save`).toBe(before.get(id)?.updated_at)
    }

    await sleep(1100)
    await syncBoardToSupabase(user.userId, { ...state, nodes: [state.nodes[0], state.nodes[1], textNode('9', 250)] })
    const after = await rows()
    expect(after.get('9')?.updated_at).not.toBe(before.get('9')?.updated_at)
    expect(after.get('5')?.updated_at).toBe(before.get('5')?.updated_at)
    expect(after.get('7')?.updated_at).toBe(before.get('7')?.updated_at)
  })

  it('edge return shape and (pair, mode) resolution are unchanged on a re-weave', async () => {
    if (!supabase) throw new Error('supabase client missing')
    const nodes = [textNode('5', 50), textNode('7', 100, { contentDescription: 'new' }), textNode('9', 250)]
    const first = await syncBoardToSupabase(user.userId, {
      ...board,
      nodes,
      connections: [connection('7', '5', 'weave', 'first reading')],
    })
    const key = connectionIdentityKey({ from: '5', to: '7', mode: 'weave' })
    const firstId = first.get(key)
    expect(firstId).toBeDefined()

    // Re-weave: reversed direction, new label, same pair + mode → same row.
    // Raw RPC so the 041 return shape is asserted as the server sends it.
    const payloadNode = (n: SerializedNode) => ({
      client_id: n.id,
      card_type: 'text',
      link_type: null,
      position_x: n.position.x,
      position_y: n.position.y,
      title: null,
      description: null,
      url: null,
      source: null,
      text_content: n.data.text,
      image_url: null,
      data: { ...n.data, _clientNodeId: n.id, _clientNodeType: n.type, position: n.position },
    })
    const { data, error } = await supabase.rpc('replace_board_contents', {
      p_board_id: board.id,
      p_nodes: nodes.map(payloadNode),
      p_edges: [
        {
          client_source_id: '5',
          client_target_id: '7',
          relationship_label: 'second reading',
          data: { mode: 'weave', from: '5', to: '7' },
        },
      ],
    })
    expect(error).toBeNull()
    expect(data).toEqual([{ id: firstId, client_source_id: '5', client_target_id: '7', mode: 'weave' }])

    const edges = await persistence.edges.listByBoard(board.id)
    expect(edges).toHaveLength(1)
    expect(edges[0].id).toBe(firstId)
    expect(edges[0].relationship_label).toBe('second reading')
  })
})
