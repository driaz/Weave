import { createClient } from '@supabase/supabase-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { persistence } from '../../../src/persistence/index'
import { createTestUser, hasServiceRole, type TestUser } from '../../../src/persistence/__tests__/setup'
import { syncBoardToSupabase } from '../../../src/persistence/syncBoard'
import type { SerializedBoard, SerializedNode } from '../../../src/types/board'

/**
 * Migration 043: server processing provenance lives in node_processing_log,
 * not nodes.data.processing_log. Server writes go through the Fly media
 * server's own modules (logger.persist, patchNodeData) under the service
 * role; client saves go through the real client path (syncBoardToSupabase).
 * Runs against Weave-Dev with disposable harness users.
 */

type FlySupabase = typeof import('../supabase')
type FlyLogger = typeof import('../logger')

const url = (import.meta.env.SUPABASE_URL ?? import.meta.env.VITE_SUPABASE_URL) as string | undefined
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string

function textNode(id: string, x: number, data: Record<string, unknown> = {}): SerializedNode {
  return { id, type: 'textCard', position: { x, y: 0 }, data: { text: `node ${id}`, ...data } }
}

const clientEntry = (phase: string) => ({
  phase,
  source: 'client',
  outcome: 'success',
  ts: '2026-10-07T00:00:00.000Z',
  detail: { from: 'test' },
})

describe.skipIf(!hasServiceRole())('node_processing_log (043, integration)', () => {
  let user: TestUser
  let fly: FlySupabase
  let flyLogger: FlyLogger
  const now = new Date().toISOString()
  const board: SerializedBoard = {
    id: crypto.randomUUID(),
    name: `__persistence_test_node_log_${Date.now()}__`,
    nodes: [textNode('1', 0), textNode('2', 100)],
    connections: [],
    nodeIdCounter: 3,
    createdAt: now,
    updatedAt: now,
  }

  async function nodeRow(clientId: string) {
    const { data, error } = await user.admin
      .from('nodes')
      .select('id, data, updated_at')
      .eq('board_id', board.id)
      .eq('data->>_clientNodeId', clientId)
      .single()
    if (error) throw error
    return data as { id: string; data: Record<string, unknown>; updated_at: string }
  }

  async function boardSnapshot() {
    const { data, error } = await user.admin
      .from('nodes')
      .select('id, data, updated_at')
      .eq('board_id', board.id)
      .order('id')
    if (error) throw error
    return JSON.stringify(data)
  }

  async function logRows(nodeUuid: string) {
    const { data, error } = await user.admin
      .from('node_processing_log')
      .select('*')
      .eq('node_id', nodeUuid)
      .order('ts')
    if (error) throw error
    return data
  }

  async function unresolvedRows(clientId: string, caller: string) {
    const { data, error } = await user.admin
      .from('node_processing_log')
      .select('*')
      .is('node_id', null)
      .eq('phase', 'write.unresolved')
      .eq('detail->>board_id', board.id)
      .eq('detail->>node_id', clientId)
      .eq('detail->>caller', caller)
    if (error) throw error
    return data
  }

  beforeAll(async () => {
    // The Fly modules read process.env at import time.
    process.env.SUPABASE_URL = url
    process.env.SUPABASE_SERVICE_ROLE_KEY = import.meta.env.SUPABASE_SERVICE_ROLE_KEY as string
    fly = await import('../supabase')
    flyLogger = await import('../logger')
    user = await createTestUser('node-log')
    await syncBoardToSupabase(user.userId, board)
  })

  afterAll(async () => {
    // Null-node rows don't cascade with the user; remove this board's.
    await user.admin.from('node_processing_log').delete().is('node_id', null).eq('detail->>board_id', board.id)
    await persistence.boards.delete(board.id).catch(() => {})
    await user.cleanup()
  })

  it('T1: a server entry survives a full client save; the client array lands exactly', async () => {
    const logger = flyLogger.createNodeLogger('1', board.id, user.userId)
    await logger.persist('embed.server', 'success', { trigger: 'test' }, 42)
    const n1 = await nodeRow('1')
    const [serverRow] = await logRows(n1.id)
    expect(serverRow).toMatchObject({ phase: 'embed.server', outcome: 'success' })
    expect(serverRow.detail).toMatchObject({ trigger: 'test', source: 'server', durationMs: 42 })

    // Full board save carrying a client processing_log without the server
    // entry; node 1 moves so its UPDATE actually runs.
    const clientLog = [clientEntry('node.created')]
    await syncBoardToSupabase(user.userId, {
      ...board,
      nodes: [textNode('1', 50, { processing_log: clientLog }), board.nodes[1]],
    })

    const after = await nodeRow('1')
    expect(after.updated_at).not.toBe(n1.updated_at)
    expect(after.data.processing_log).toEqual(clientLog)
    expect((await logRows(n1.id)).map((r) => r.id)).toEqual([serverRow.id])
  })

  it('T3: client entries are byte-identical after server writers run; server entry is only in the table', async () => {
    await syncBoardToSupabase(user.userId, {
      ...board,
      nodes: [textNode('1', 50, { processing_log: [clientEntry('node.created')] }), textNode('2', 100, { processing_log: [clientEntry('card.drop')] })],
    })
    const before = await nodeRow('2')
    const beforeLog = JSON.stringify(before.data.processing_log)

    await fly.patchNodeData({ nodeId: '2', boardId: board.id, userId: user.userId, patch: { media_analysis: 'server analysis' } })
    await flyLogger.createNodeLogger('2', board.id, user.userId).persist('media.pipeline', 'success', { tier: 'short' })

    const after = await nodeRow('2')
    expect(JSON.stringify(after.data.processing_log)).toBe(beforeLog)
    expect(after.data.media_analysis).toBe('server analysis')
    const rows = await logRows(before.id)
    expect(rows.map((r) => r.phase)).toEqual(['media.pipeline'])
  })

  it('T2: zero matches → no node mutation, exactly one write.unresolved row per writer', async () => {
    const snap = await boardSnapshot()
    await expect(
      fly.patchNodeData({ nodeId: '999', boardId: board.id, userId: user.userId, patch: { media_analysis: 'x' } }),
    ).rejects.toThrow(/unresolved/)
    await flyLogger.createNodeLogger('999', board.id, user.userId).persist('media.pipeline', 'failed')
    expect(await boardSnapshot()).toBe(snap)

    const patchRows = await unresolvedRows('999', 'fly.patchNodeData')
    expect(patchRows).toHaveLength(1)
    expect(patchRows[0].detail).toMatchObject({
      board_id: board.id, node_id: '999', user_id: user.userId, intended_key: 'media_analysis', match_count: 0,
    })
    const logRowsUnresolved = await unresolvedRows('999', 'fly.logger.persist')
    expect(logRowsUnresolved).toHaveLength(1)
    expect(logRowsUnresolved[0].detail).toMatchObject({ intended_key: 'processing_log', intended_phase: 'media.pipeline', match_count: 0 })
  })

  it('T2: two matches → no node mutation, exactly one write.unresolved row per writer', async () => {
    // No unique index on (board_id, _clientNodeId): a duplicate is insertable.
    for (const x of [300, 400]) {
      const { error } = await user.admin.from('nodes').insert({
        board_id: board.id, user_id: user.userId, card_type: 'text', position_x: x,
        data: { _clientNodeId: '7', text: 'dup' },
      })
      expect(error).toBeNull()
    }
    const snap = await boardSnapshot()
    await expect(
      fly.patchNodeData({ nodeId: '7', boardId: board.id, userId: user.userId, patch: { contentDescription: 'x' } }),
    ).rejects.toThrow(/unresolved/)
    await flyLogger.createNodeLogger('7', board.id, user.userId).persist('embed.server', 'success')
    expect(await boardSnapshot()).toBe(snap)

    const patchRows = await unresolvedRows('7', 'fly.patchNodeData')
    expect(patchRows).toHaveLength(1)
    expect(patchRows[0].detail).toMatchObject({ intended_key: 'contentDescription', match_count: 2 })
    const logRowsUnresolved = await unresolvedRows('7', 'fly.logger.persist')
    expect(logRowsUnresolved).toHaveLength(1)
    expect(logRowsUnresolved[0].detail).toMatchObject({ intended_key: 'processing_log', match_count: 2 })
  })

  it('T4: RLS — owner sees own rows only; stranger and anonymous see none; null-node rows service-only', async () => {
    const { data: all } = await user.admin
      .from('node_processing_log')
      .select('id, node_id, nodes!inner(board_id)')
      .eq('nodes.board_id', board.id)
    const ownIds = (all ?? []).map((r) => r.id).sort()
    expect(ownIds.length).toBeGreaterThanOrEqual(2)

    // Owner A, through anon key + A's access token.
    await user.signIn()
    const { data: ownerSession } = await (await import('../../../src/services/supabaseClient')).supabase!.auth.getSession()
    const asOwner = createClient(url!, anonKey, {
      auth: { persistSession: false },
      global: { headers: { Authorization: `Bearer ${ownerSession.session!.access_token}` } },
    })
    const ownerView = await asOwner.from('node_processing_log').select('id, node_id')
    expect(ownerView.error).toBeNull()
    expect(ownerView.data!.map((r) => r.id).sort()).toEqual(ownIds)
    expect(ownerView.data!.some((r) => r.node_id === null)).toBe(false)
    const ownerInsert = await asOwner.rpc('append_node_processing_log', { p_node_id: null, p_phase: 'x' })
    expect(ownerInsert.error).not.toBeNull()

    // Stranger B.
    const email = `node-log-b-${Date.now()}@weave-tests.local`
    const password = `Test-${crypto.randomUUID()}`
    const { data: created, error: createErr } = await user.admin.auth.admin.createUser({ email, password, email_confirm: true })
    expect(createErr).toBeNull()
    try {
      const asStranger = createClient(url!, anonKey, { auth: { persistSession: false } })
      const { error: signErr } = await asStranger.auth.signInWithPassword({ email, password })
      expect(signErr).toBeNull()
      const strangerView = await asStranger.from('node_processing_log').select('id')
      expect(strangerView.error).toBeNull()
      expect(strangerView.data).toEqual([])
    } finally {
      await user.admin.auth.admin.deleteUser(created!.user!.id)
    }

    // Anonymous.
    const asAnon = createClient(url!, anonKey, { auth: { persistSession: false } })
    const anonView = await asAnon.from('node_processing_log').select('id')
    expect(anonView.data ?? []).toEqual([])
  })
})
