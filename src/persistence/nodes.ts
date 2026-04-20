import { mapSupabaseError } from './errors'
import { sanitizePatch } from './internal'
import { requireClient, requireUserId } from './session'
import type { NewNodeInput, Node } from './types'

export async function listByBoard(boardId: string): Promise<Node[]> {
  const client = requireClient()
  await requireUserId()

  const { data, error } = await client
    .from('nodes')
    .select('*')
    .eq('board_id', boardId)
    .order('created_at', { ascending: true })

  if (error) throw mapSupabaseError(error, `nodes.listByBoard(${boardId})`)
  return data ?? []
}

export async function get(id: string): Promise<Node | null> {
  const client = requireClient()
  await requireUserId()

  const { data, error } = await client
    .from('nodes')
    .select('*')
    .eq('id', id)
    .maybeSingle()

  if (error) throw mapSupabaseError(error, `nodes.get(${id})`)
  return data
}

export async function create(
  boardId: string,
  input: NewNodeInput,
): Promise<Node> {
  const client = requireClient()
  const userId = await requireUserId()

  const { data, error } = await client
    .from('nodes')
    .insert({ ...input, board_id: boardId, user_id: userId })
    .select()
    .single()

  if (error) throw mapSupabaseError(error, 'nodes.create')
  return data
}

export async function update(
  id: string,
  patch: Partial<Node>,
): Promise<Node> {
  const client = requireClient()
  await requireUserId()

  const { data, error } = await client
    .from('nodes')
    .update(sanitizePatch(patch))
    .eq('id', id)
    .select()
    .single()

  if (error) throw mapSupabaseError(error, `nodes.update(${id})`)
  return data
}

export async function remove(id: string): Promise<void> {
  const client = requireClient()
  await requireUserId()

  const { error } = await client.from('nodes').delete().eq('id', id)
  if (error) throw mapSupabaseError(error, `nodes.delete(${id})`)
}

export async function batchCreate(
  boardId: string,
  inputs: NewNodeInput[],
): Promise<Node[]> {
  if (inputs.length === 0) return []

  const client = requireClient()
  const userId = await requireUserId()

  const rows = inputs.map((input) => ({
    ...input,
    board_id: boardId,
    user_id: userId,
  }))

  const { data, error } = await client.from('nodes').insert(rows).select()
  if (error) throw mapSupabaseError(error, 'nodes.batchCreate')
  return data ?? []
}

/**
 * Apply many partial patches in parallel. There's no single-statement
 * bulk UPDATE in PostgREST, so this fans out to one round-trip per row.
 * Supabase opens an HTTP/2 multiplexed connection, so in practice this
 * is fast enough for the ~50-node boards Weave expects.
 *
 * Throws on the first failure; successful updates before the failure
 * are not rolled back. Callers needing atomicity should wrap this in
 * a board-level "delete all + insert all" pattern instead.
 */
export async function batchUpdate(
  updates: Array<{ id: string; patch: Partial<Node> }>,
): Promise<void> {
  if (updates.length === 0) return
  await Promise.all(updates.map(({ id, patch }) => update(id, patch)))
}
