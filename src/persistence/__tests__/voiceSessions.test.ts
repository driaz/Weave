import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { persistence } from '../index'
import { createTestUser, hasServiceRole, type TestUser } from './setup'

describe.skipIf(!hasServiceRole())('persistence.voiceSessions', () => {
  let user: TestUser
  let boardId: string

  beforeAll(async () => {
    user = await createTestUser('voice')
    const board = await persistence.boards.create({
      name: `__persistence_test_voice_${Date.now()}__`,
    })
    boardId = board.id
  })

  afterAll(async () => {
    await persistence.boards.delete(boardId).catch(() => {})
    await user.cleanup()
  })

  it('creates, reads, updates, and deletes a voice session', async () => {
    const session = await persistence.voiceSessions.create({
      board_id: boardId,
      connection_context: { foo: 'bar' },
      started_at: new Date().toISOString(),
    })
    expect(session.user_id).toBe(user.userId)
    expect(session.board_id).toBe(boardId)

    const fetched = await persistence.voiceSessions.get(session.id)
    expect(fetched?.id).toBe(session.id)

    const ended = await persistence.voiceSessions.update(session.id, {
      ended_at: new Date().toISOString(),
      transcript: [{ role: 'user', text: 'hi' }],
    })
    expect(ended.ended_at).toBeTruthy()

    const list = await persistence.voiceSessions.listByBoard(boardId)
    expect(list.some((v) => v.id === session.id)).toBe(true)

    await persistence.voiceSessions.delete(session.id)
    const gone = await persistence.voiceSessions.get(session.id)
    expect(gone).toBeNull()
  })
})
