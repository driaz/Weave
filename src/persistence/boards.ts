import { mapSupabaseError } from './errors'
import { sanitizePatch } from './internal'
import { requireClient, requireUserId } from './session'
import type { Board, NewBoardInput } from './types'

export async function list(): Promise<Board[]> {
  const client = requireClient()
  await requireUserId()

  const { data, error } = await client
    .from('boards')
    .select('*')
    .order('updated_at', { ascending: false })

  if (error) throw mapSupabaseError(error, 'boards.list')
  return data ?? []
}

export async function get(id: string): Promise<Board | null> {
  const client = requireClient()
  await requireUserId()

  const { data, error } = await client
    .from('boards')
    .select('*')
    .eq('id', id)
    .maybeSingle()

  if (error) throw mapSupabaseError(error, `boards.get(${id})`)
  return data
}

export async function create(input: NewBoardInput): Promise<Board> {
  const client = requireClient()
  const userId = await requireUserId()

  const { data, error } = await client
    .from('boards')
    .insert({ ...input, user_id: userId })
    .select()
    .single()

  if (error) throw mapSupabaseError(error, 'boards.create')
  return data
}

export async function update(
  id: string,
  patch: Partial<Board>,
): Promise<Board> {
  const client = requireClient()
  await requireUserId()

  const { data, error } = await client
    .from('boards')
    .update(sanitizePatch(patch))
    .eq('id', id)
    .select()
    .single()

  if (error) throw mapSupabaseError(error, `boards.update(${id})`)
  return data
}

export async function remove(id: string): Promise<void> {
  const client = requireClient()
  await requireUserId()

  const { error } = await client.from('boards').delete().eq('id', id)
  if (error) throw mapSupabaseError(error, `boards.delete(${id})`)
}
