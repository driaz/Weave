import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * logger.persist's unresolved branch: the write.unresolved row carries the
 * run's outcome and duration, and nothing is written against a node.
 * Unit-level (supabase mocked) so it runs without dev credentials; the
 * integration counterpart is T2 in nodeProcessingLog.test.ts.
 */

const rows: Array<{ nodeUuid: string | null; phase: string; outcome: string | null; detail: Record<string, unknown> }> = []
const resolveNodeUuid = vi.fn()

vi.mock('../supabase.js', async () => {
  const { WRITE_UNRESOLVED_PHASE } = await import('../phases.js')
  const appendNodeProcessingLog = vi.fn(
    async (nodeUuid: string | null, phase: string, outcome: string | null, detail: Record<string, unknown>) => {
      rows.push({ nodeUuid, phase, outcome, detail })
      return null
    },
  )
  return {
    resolveNodeUuid: (...args: unknown[]) => resolveNodeUuid(...args),
    appendNodeProcessingLog,
    // Same shape as the real logUnresolvedWrite, routed through the mock append.
    logUnresolvedWrite: (
      ref: { nodeId: string; boardId: string; userId: string },
      resolution: { matchCount: number | null },
      caller: string,
      intendedKey: string,
      extra: Record<string, unknown> = {},
    ) =>
      appendNodeProcessingLog(null, WRITE_UNRESOLVED_PHASE, 'skipped', {
        board_id: ref.boardId,
        node_id: ref.nodeId,
        user_id: ref.userId,
        caller,
        intended_key: intendedKey,
        match_count: resolution.matchCount,
        ...extra,
      }),
  }
})

const { createNodeLogger } = await import('../logger')

describe('logger.persist — unresolved node', () => {
  beforeEach(() => {
    rows.length = 0
    resolveNodeUuid.mockReset()
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  })

  it('writes exactly one write.unresolved row carrying intended_outcome and duration_ms, and no node row', async () => {
    resolveNodeUuid.mockResolvedValue({ ok: false, matchCount: 0 })
    await createNodeLogger('5', 'board-1', 'user-1').persist('media.pipeline', 'failed', { tier: 'short' }, 1234)

    expect(rows).toHaveLength(1)
    const [row] = rows
    expect(row.nodeUuid).toBeNull()
    expect(row.phase).toBe('write.unresolved')
    expect(row.outcome).toBe('skipped')
    expect(row.detail).toMatchObject({
      board_id: 'board-1',
      node_id: '5',
      user_id: 'user-1',
      caller: 'fly.logger.persist',
      intended_key: 'processing_log',
      intended_phase: 'media.pipeline',
      intended_outcome: 'failed',
      duration_ms: 1234,
      match_count: 0,
    })
  })

  it('records a success outcome as-is (the reopen gate for the parked options)', async () => {
    resolveNodeUuid.mockResolvedValue({ ok: false, matchCount: 2 })
    await createNodeLogger('7', 'board-1', 'user-1').persist('media.pipeline', 'success', undefined, 20000)

    expect(rows).toHaveLength(1)
    expect(rows[0].detail).toMatchObject({ intended_outcome: 'success', duration_ms: 20000, match_count: 2 })
  })

  it('omits duration_ms when the event has no duration', async () => {
    resolveNodeUuid.mockResolvedValue({ ok: false, matchCount: 0 })
    await createNodeLogger('5', 'board-1', 'user-1').persist('embed.server', 'degraded')

    expect(rows).toHaveLength(1)
    expect(rows[0].detail.intended_outcome).toBe('degraded')
    expect(rows[0].detail).not.toHaveProperty('duration_ms')
  })

  it('a resolved node gets its own row and no unresolved row', async () => {
    resolveNodeUuid.mockResolvedValue({ ok: true, uuid: 'uuid-1' })
    await createNodeLogger('5', 'board-1', 'user-1').persist('media.pipeline', 'success', undefined, 42)

    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ nodeUuid: 'uuid-1', phase: 'media.pipeline', outcome: 'success' })
    expect(rows[0].detail).not.toHaveProperty('intended_outcome')
  })
})
