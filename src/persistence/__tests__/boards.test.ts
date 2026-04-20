import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { persistence, NotFoundError } from '../index'
import { createTestUser, hasServiceRole, type TestUser } from './setup'

describe.skipIf(!hasServiceRole())('persistence.boards', () => {
  let user: TestUser

  beforeAll(async () => {
    user = await createTestUser('boards')
  })

  afterAll(async () => {
    await user.cleanup()
  })

  it('creates, reads, updates, and deletes a board', async () => {
    const created = await persistence.boards.create({
      name: `__persistence_test_board_${Date.now()}__`,
    })
    expect(created.id).toBeTruthy()
    expect(created.user_id).toBe(user.userId)

    const fetched = await persistence.boards.get(created.id)
    expect(fetched?.id).toBe(created.id)

    const renamed = await persistence.boards.update(created.id, {
      name: 'renamed',
    })
    expect(renamed.name).toBe('renamed')

    const all = await persistence.boards.list()
    expect(all.some((b) => b.id === created.id)).toBe(true)

    await persistence.boards.delete(created.id)
    const afterDelete = await persistence.boards.get(created.id)
    expect(afterDelete).toBeNull()
  })

  it('returns null from get() for a non-existent board', async () => {
    const result = await persistence.boards.get(
      '00000000-0000-0000-0000-000000000000',
    )
    expect(result).toBeNull()
  })

  it('throws NotFoundError when updating a non-existent board', async () => {
    await expect(
      persistence.boards.update('00000000-0000-0000-0000-000000000000', {
        name: 'ghost',
      }),
    ).rejects.toBeInstanceOf(NotFoundError)
  })
})
