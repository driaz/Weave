import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { persistence } from '../index'
import { createTestUser, hasServiceRole, type TestUser } from './setup'

describe.skipIf(!hasServiceRole())('persistence.voiceSessions', () => {
  let user: TestUser

  beforeAll(async () => {
    user = await createTestUser('voice-sessions')
  })

  afterAll(async () => {
    // Cleanup deletes the test user, which cascades through user_id FKs
    // on every voice_sessions and voice_utterances row owned by them.
    await user.cleanup()
  })

  it('creates, fetches, and ends a voice session', async () => {
    const created = await persistence.voiceSessions.createSession({
      anchor_edge_id: null,
      board_snapshot: {
        nodes: [],
        edges: [],
        captured_at: new Date().toISOString(),
      } as unknown as never,
      started_at: new Date().toISOString(),
      processing_log: [] as unknown as never,
      end_reason: null,
      ended_at: null,
      summary: null,
    })
    expect(created.user_id).toBe(user.userId)
    expect(created.ended_at).toBeNull()
    expect(created.end_reason).toBeNull()

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
    expect(Array.isArray(ended.processing_log)).toBe(true)
  })

  it('getSession returns null for unknown ids', async () => {
    const gone = await persistence.voiceSessions.getSession(crypto.randomUUID())
    expect(gone).toBeNull()
  })
})
