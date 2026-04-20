import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { persistence } from '../index'
import { createTestUser, hasServiceRole, type TestUser } from './setup'

describe.skipIf(!hasServiceRole())('persistence.nodes', () => {
  let user: TestUser
  let boardId: string

  beforeAll(async () => {
    user = await createTestUser('nodes')
    const board = await persistence.boards.create({
      name: `__persistence_test_nodes_${Date.now()}__`,
    })
    boardId = board.id
  })

  afterAll(async () => {
    await persistence.boards.delete(boardId).catch(() => {})
    await user.cleanup()
  })

  it('creates, reads, updates, and deletes a node', async () => {
    const created = await persistence.nodes.create(boardId, {
      card_type: 'text',
      text_content: 'hello',
      position_x: 10,
      position_y: 20,
    })
    expect(created.board_id).toBe(boardId)
    expect(created.user_id).toBe(user.userId)
    expect(created.text_content).toBe('hello')

    const fetched = await persistence.nodes.get(created.id)
    expect(fetched?.id).toBe(created.id)

    const moved = await persistence.nodes.update(created.id, {
      position_x: 100,
    })
    expect(moved.position_x).toBe(100)
    expect(moved.position_y).toBe(20)

    await persistence.nodes.delete(created.id)
    const gone = await persistence.nodes.get(created.id)
    expect(gone).toBeNull()
  })

  it('batch-creates and lists nodes by board', async () => {
    const inputs = [
      { card_type: 'text', text_content: 'a' },
      { card_type: 'text', text_content: 'b' },
      { card_type: 'text', text_content: 'c' },
    ]
    const created = await persistence.nodes.batchCreate(boardId, inputs)
    expect(created).toHaveLength(3)

    const listed = await persistence.nodes.listByBoard(boardId)
    const createdIds = new Set(created.map((n) => n.id))
    expect(listed.filter((n) => createdIds.has(n.id))).toHaveLength(3)

    await Promise.all(created.map((n) => persistence.nodes.delete(n.id)))
  })

  it('applies many updates in batch', async () => {
    const created = await persistence.nodes.batchCreate(boardId, [
      { card_type: 'text', text_content: 'one' },
      { card_type: 'text', text_content: 'two' },
    ])

    await persistence.nodes.batchUpdate(
      created.map((n, i) => ({ id: n.id, patch: { position_x: 50 + i } })),
    )

    const updated = await Promise.all(
      created.map((n) => persistence.nodes.get(n.id)),
    )
    expect(updated[0]?.position_x).toBe(50)
    expect(updated[1]?.position_x).toBe(51)

    await Promise.all(created.map((n) => persistence.nodes.delete(n.id)))
  })

  it('rejects a node with an invalid card_type via ValidationError', async () => {
    await expect(
      persistence.nodes.create(boardId, {
        card_type: 'not-a-real-type',
      }),
    ).rejects.toThrow()
  })

  it('empty batch calls are no-ops', async () => {
    await expect(persistence.nodes.batchCreate(boardId, [])).resolves.toEqual([])
    await expect(persistence.nodes.batchUpdate([])).resolves.toBeUndefined()
  })
})
