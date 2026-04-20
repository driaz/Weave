import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { persistence, type Node } from '../index'
import { createTestUser, hasServiceRole, type TestUser } from './setup'

describe.skipIf(!hasServiceRole())('persistence.edges', () => {
  let user: TestUser
  let boardId: string
  let a: Node
  let b: Node
  let c: Node

  beforeAll(async () => {
    user = await createTestUser('edges')
    const board = await persistence.boards.create({
      name: `__persistence_test_edges_${Date.now()}__`,
    })
    boardId = board.id
    const created = await persistence.nodes.batchCreate(boardId, [
      { card_type: 'text', text_content: 'a' },
      { card_type: 'text', text_content: 'b' },
      { card_type: 'text', text_content: 'c' },
    ])
    ;[a, b, c] = created
  })

  afterAll(async () => {
    await persistence.boards.delete(boardId).catch(() => {})
    await user.cleanup()
  })

  it('creates, updates, and deletes an edge', async () => {
    const edge = await persistence.edges.create(boardId, {
      source_node_id: a.id,
      target_node_id: b.id,
      relationship_label: 'related-to',
    })
    expect(edge.user_id).toBe(user.userId)
    expect(edge.relationship_label).toBe('related-to')

    const updated = await persistence.edges.update(edge.id, {
      relationship_label: 'contradicts',
    })
    expect(updated.relationship_label).toBe('contradicts')

    await persistence.edges.delete(edge.id)
    const list = await persistence.edges.listByBoard(boardId)
    expect(list.find((e) => e.id === edge.id)).toBeUndefined()
  })

  it('batch-creates edges and deleteByBoard wipes them all', async () => {
    await persistence.edges.batchCreate(boardId, [
      { source_node_id: a.id, target_node_id: b.id, relationship_label: 'x' },
      { source_node_id: b.id, target_node_id: c.id, relationship_label: 'y' },
      { source_node_id: a.id, target_node_id: c.id, relationship_label: 'z' },
    ])

    const before = await persistence.edges.listByBoard(boardId)
    expect(before.length).toBeGreaterThanOrEqual(3)

    await persistence.edges.deleteByBoard(boardId)
    const after = await persistence.edges.listByBoard(boardId)
    expect(after).toHaveLength(0)
  })

  it('empty batchCreate is a no-op', async () => {
    await expect(persistence.edges.batchCreate(boardId, [])).resolves.toEqual([])
  })
})
