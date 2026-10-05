import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { persistence } from '../index'
import { createTestUser, hasServiceRole, type TestUser } from './setup'

type LogEntry = { phase: string; outcome: string; detail?: Record<string, unknown> }

const snapshot = () =>
  ({
    nodes: [],
    edges: [],
    captured_at: new Date().toISOString(),
  }) as unknown as never

describe.skipIf(!hasServiceRole())('persistence.voiceSessions', () => {
  let user: TestUser
  let boardId: string
  let weaveEdgeId: string

  beforeAll(async () => {
    user = await createTestUser('voice-sessions')
    // A board with client-id'd nodes and one 'weave' edge 5 ⟷ 7, mirroring
    // what replace_board_contents writes (data._clientNodeId).
    const board = await persistence.boards.create({
      name: `__persistence_test_voice_sessions_${Date.now()}__`,
    })
    boardId = board.id
    const [n5, n7] = await persistence.nodes.batchCreate(boardId, [
      { card_type: 'text', text_content: 'five', data: { _clientNodeId: '5' } },
      { card_type: 'text', text_content: 'seven', data: { _clientNodeId: '7' } },
      { card_type: 'text', text_content: 'nine', data: { _clientNodeId: '9' } },
    ])
    const edge = await persistence.edges.create(boardId, {
      source_node_id: n5.id,
      target_node_id: n7.id,
      relationship_label: 'test',
      mode: 'weave',
    })
    weaveEdgeId = edge.id
  })

  afterAll(async () => {
    await persistence.boards.delete(boardId).catch(() => {})
    // Cleanup deletes the test user, which cascades through user_id FKs
    // on every voice_sessions and voice_utterances row owned by them.
    await user.cleanup()
  })

  it('creates, fetches, and ends a voice session', async () => {
    const created = await persistence.voiceSessions.createSession({
      anchor_edge_id: null,
      board_snapshot: snapshot(),
      started_at: new Date().toISOString(),
    })
    expect(created.user_id).toBe(user.userId)
    expect(created.ended_at).toBeNull()
    expect(created.end_reason).toBeNull()
    // No hint → no resolution attempt → no server log entry.
    expect(created.processing_log).toEqual([])

    const fetched = await persistence.voiceSessions.getSession(created.id)
    expect(fetched?.id).toBe(created.id)

    const ended = await persistence.voiceSessions.endSession(created.id, {
      ended_at: new Date().toISOString(),
      end_reason: 'user_closed',
      processing_log: [
        { phase: 'voice.session.test', outcome: 'success', ts: new Date().toISOString() },
      ],
    })
    expect(ended.ended_at).toBeTruthy()
    expect(ended.end_reason).toBe('user_closed')
    expect((ended.processing_log as LogEntry[]).map((e) => e.phase)).toEqual([
      'voice.session.test',
    ])
  })

  it('resolves a null anchor server-side from the launch pair (reversed direction)', async () => {
    const created = await persistence.voiceSessions.createSession({
      anchor_edge_id: null,
      anchor_hint: { boardId, clientFrom: '7', clientTo: '5', mode: 'weave' },
      board_snapshot: snapshot(),
      started_at: new Date().toISOString(),
    })
    expect(created.anchor_edge_id).toBe(weaveEdgeId)
    const log = created.processing_log as LogEntry[]
    expect(log).toHaveLength(1)
    expect(log[0].phase).toBe('launch.anchor_edge_resolved')
    expect(log[0].detail?.source).toBe('server_resolve')
    expect(log[0].detail?.anchorEdgeId).toBe(weaveEdgeId)
  })

  it('leaves the anchor null and logs unresolved when no edge matches', async () => {
    // Same pair, different mode → distinct identity, no row.
    const wrongMode = await persistence.voiceSessions.createSession({
      anchor_edge_id: null,
      anchor_hint: { boardId, clientFrom: '5', clientTo: '7', mode: 'deeper' },
      board_snapshot: snapshot(),
      started_at: new Date().toISOString(),
    })
    expect(wrongMode.anchor_edge_id).toBeNull()
    const log = wrongMode.processing_log as LogEntry[]
    expect(log).toHaveLength(1)
    expect(log[0].phase).toBe('launch.anchor_edge_unresolved')
    expect(log[0].detail).toMatchObject({
      reason: 'edge_not_found',
      boardId,
      clientFrom: '5',
      clientTo: '7',
      mode: 'deeper',
    })

    const missingNode = await persistence.voiceSessions.createSession({
      anchor_edge_id: null,
      anchor_hint: { boardId, clientFrom: '5', clientTo: '404', mode: 'weave' },
      board_snapshot: snapshot(),
      started_at: new Date().toISOString(),
    })
    expect(missingNode.anchor_edge_id).toBeNull()
    expect((missingNode.processing_log as LogEntry[])[0].detail?.reason).toBe(
      'to_node_not_found',
    )
  })

  it('a client-supplied anchor wins and is not re-resolved', async () => {
    const created = await persistence.voiceSessions.createSession({
      anchor_edge_id: weaveEdgeId,
      anchor_hint: { boardId, clientFrom: '5', clientTo: '9', mode: 'weave' },
      board_snapshot: snapshot(),
      started_at: new Date().toISOString(),
    })
    expect(created.anchor_edge_id).toBe(weaveEdgeId)
    expect(created.processing_log).toEqual([])
  })

  it('a server-written log entry survives session end (append, never replace)', async () => {
    const created = await persistence.voiceSessions.createSession({
      anchor_edge_id: null,
      anchor_hint: { boardId, clientFrom: '5', clientTo: '7', mode: 'weave' },
      board_snapshot: snapshot(),
      started_at: new Date().toISOString(),
    })
    const ended = await persistence.voiceSessions.endSession(created.id, {
      ended_at: new Date().toISOString(),
      end_reason: 'user_closed',
      processing_log: [
        { phase: 'voice.session.started', outcome: 'success', ts: new Date().toISOString() },
        { phase: 'voice.session.ended', outcome: 'success', ts: new Date().toISOString() },
      ],
    })
    expect((ended.processing_log as LogEntry[]).map((e) => e.phase)).toEqual([
      'launch.anchor_edge_resolved',
      'voice.session.started',
      'voice.session.ended',
    ])
    expect(ended.anchor_edge_id).toBe(weaveEdgeId)
  })

  it('getSession returns null for unknown ids', async () => {
    const gone = await persistence.voiceSessions.getSession(crypto.randomUUID())
    expect(gone).toBeNull()
  })
})
