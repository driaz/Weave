import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required')
}

export const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
})

/**
 * Merge a partial object into nodes.data via jsonb concatenation.
 * Looked up by the ReactFlow client id stashed in data->>'_clientNodeId'
 * (the server never sees the actual UUID nodes.id). Scoped by board_id +
 * user_id so a stolen JWT can't poke at other users' nodes.
 */
export async function patchNodeData(opts: {
  nodeId: string
  boardId: string
  userId: string
  patch: Record<string, unknown>
}): Promise<void> {
  const { error } = await admin.rpc('patch_node_data', {
    p_client_id: opts.nodeId,
    p_board_id: opts.boardId,
    p_user_id: opts.userId,
    p_patch: opts.patch,
  })
  if (error) throw new Error(`patchNodeData failed: ${error.message}`)
}

export async function upsertEmbedding(opts: {
  boardId: string
  nodeId: string
  embedding: number[]
  contentSummary: string
  hasVideo: boolean
  durationSeconds: number
}): Promise<void> {
  const { error } = await admin.from('weave_embeddings').upsert(
    {
      board_id: opts.boardId,
      node_id: opts.nodeId,
      node_type: 'linkCard',
      embedding: JSON.stringify(opts.embedding),
      content_summary: opts.contentSummary,
      metadata: {
        processing: 'server',
        has_video: opts.hasVideo,
        duration_seconds: opts.durationSeconds,
      },
    },
    { onConflict: 'board_id,node_id' },
  )
  if (error) throw new Error(`upsertEmbedding failed: ${error.message}`)
}
