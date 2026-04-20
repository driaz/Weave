import { mapSupabaseError } from './errors'
import { sanitizePatch } from './internal'
import { requireClient, requireUserId } from './session'
import type { Edge, NewEdgeInput } from './types'

export async function listByBoard(boardId: string): Promise<Edge[]> {
  const client = requireClient()
  await requireUserId()

  const { data, error } = await client
    .from('edges')
    .select('*')
    .eq('board_id', boardId)
    .order('created_at', { ascending: true })

  if (error) throw mapSupabaseError(error, `edges.listByBoard(${boardId})`)
  return data ?? []
}

export async function create(
  boardId: string,
  input: NewEdgeInput,
): Promise<Edge> {
  const client = requireClient()
  const userId = await requireUserId()

  const { data, error } = await client
    .from('edges')
    .insert({ ...input, board_id: boardId, user_id: userId })
    .select()
    .single()

  if (error) throw mapSupabaseError(error, 'edges.create')
  return data
}

export async function update(
  id: string,
  patch: Partial<Edge>,
): Promise<Edge> {
  const client = requireClient()
  await requireUserId()

  const { data, error } = await client
    .from('edges')
    .update(sanitizePatch(patch))
    .eq('id', id)
    .select()
    .single()

  if (error) throw mapSupabaseError(error, `edges.update(${id})`)
  return data
}

export async function remove(id: string): Promise<void> {
  const client = requireClient()
  await requireUserId()

  const { error } = await client.from('edges').delete().eq('id', id)
  if (error) throw mapSupabaseError(error, `edges.delete(${id})`)
}

export async function batchCreate(
  boardId: string,
  inputs: NewEdgeInput[],
): Promise<Edge[]> {
  if (inputs.length === 0) return []

  const client = requireClient()
  const userId = await requireUserId()

  const rows = inputs.map((input) => ({
    ...input,
    board_id: boardId,
    user_id: userId,
  }))

  const { data, error } = await client.from('edges').insert(rows).select()
  if (error) throw mapSupabaseError(error, 'edges.batchCreate')
  return data ?? []
}

/**
 * Delete every edge on a board. Used during dual-write (Prompt 5) to
 * replace the full edge set on save — easier than diffing.
 */
export async function deleteByBoard(boardId: string): Promise<void> {
  const client = requireClient()
  await requireUserId()

  const { error } = await client.from('edges').delete().eq('board_id', boardId)
  if (error) throw mapSupabaseError(error, `edges.deleteByBoard(${boardId})`)
}
