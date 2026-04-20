import { mapSupabaseError } from './errors'
import { sanitizePatch } from './internal'
import { requireClient, requireUserId } from './session'
import type { NewVoiceSessionInput, VoiceSession } from './types'

/**
 * Phase 2 placeholder — the voice feature isn't wired up yet, but the
 * table and API exist so consumers can start integrating without a
 * second migration.
 */

export async function listByBoard(boardId: string): Promise<VoiceSession[]> {
  const client = requireClient()
  await requireUserId()

  const { data, error } = await client
    .from('voice_sessions')
    .select('*')
    .eq('board_id', boardId)
    .order('created_at', { ascending: false })

  if (error) throw mapSupabaseError(error, `voiceSessions.listByBoard(${boardId})`)
  return data ?? []
}

export async function get(id: string): Promise<VoiceSession | null> {
  const client = requireClient()
  await requireUserId()

  const { data, error } = await client
    .from('voice_sessions')
    .select('*')
    .eq('id', id)
    .maybeSingle()

  if (error) throw mapSupabaseError(error, `voiceSessions.get(${id})`)
  return data
}

export async function create(
  input: NewVoiceSessionInput,
): Promise<VoiceSession> {
  const client = requireClient()
  const userId = await requireUserId()

  const { data, error } = await client
    .from('voice_sessions')
    .insert({ ...input, user_id: userId })
    .select()
    .single()

  if (error) throw mapSupabaseError(error, 'voiceSessions.create')
  return data
}

export async function update(
  id: string,
  patch: Partial<VoiceSession>,
): Promise<VoiceSession> {
  const client = requireClient()
  await requireUserId()

  const { data, error } = await client
    .from('voice_sessions')
    .update(sanitizePatch(patch))
    .eq('id', id)
    .select()
    .single()

  if (error) throw mapSupabaseError(error, `voiceSessions.update(${id})`)
  return data
}

export async function remove(id: string): Promise<void> {
  const client = requireClient()
  await requireUserId()

  const { error } = await client.from('voice_sessions').delete().eq('id', id)
  if (error) throw mapSupabaseError(error, `voiceSessions.delete(${id})`)
}
