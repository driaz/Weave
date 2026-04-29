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

/**
 * Cap the final content_summary string. Title + analysis can balloon for
 * Twitter (long tweetText + 4-6 sentence analysis); keep the row small
 * enough that the table view stays scannable.
 */
const SUMMARY_MAX_CHARS = 500

/**
 * Cap on tweetText inside the identifier so the analysis still has room
 * after the join. Tweets can be 280 chars; that would crowd everything
 * else out under SUMMARY_MAX_CHARS.
 */
const TWEET_TEXT_MAX_CHARS = 120

export async function upsertEmbedding(opts: {
  boardId: string
  nodeId: string
  userId: string
  nodeType: 'youtube' | 'twitter'
  fallbackUrl: string
  mediaAnalysis: string
  embedding: number[]
  hasVideo: boolean
  durationSeconds: number
}): Promise<void> {
  const identifier = await fetchNodeIdentifier({
    nodeId: opts.nodeId,
    boardId: opts.boardId,
    userId: opts.userId,
    nodeType: opts.nodeType,
    fallbackUrl: opts.fallbackUrl,
  })
  const contentSummary = formatContentSummary(identifier, opts.mediaAnalysis)

  // user_id must be set explicitly — service role bypasses RLS, so the
  // auth.uid() default on weave_embeddings.user_id (migration 014) returns
  // null and trips the NOT NULL constraint from migration 009.
  const { error } = await admin.from('weave_embeddings').upsert(
    {
      board_id: opts.boardId,
      node_id: opts.nodeId,
      user_id: opts.userId,
      node_type: 'linkCard',
      embedding: JSON.stringify(opts.embedding),
      content_summary: contentSummary,
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

/**
 * Read the node's data jsonb from Supabase and pull a human-scannable
 * identifier out of it. Same lookup path as patch_node_data — by
 * data->>'_clientNodeId' + board_id + user_id, since the server never
 * has the UUID nodes.id.
 *
 * Falls back to the URL on any failure (node not yet persisted, fields
 * missing, network error). The embedding still ships; the worst case is
 * a less-pretty content_summary — never a thrown error.
 */
async function fetchNodeIdentifier(opts: {
  nodeId: string
  boardId: string
  userId: string
  nodeType: 'youtube' | 'twitter'
  fallbackUrl: string
}): Promise<string> {
  try {
    const { data, error } = await admin
      .from('nodes')
      .select('data')
      .eq('board_id', opts.boardId)
      .eq('user_id', opts.userId)
      .eq('data->>_clientNodeId', opts.nodeId)
      .maybeSingle()

    if (error) {
      console.warn(`[supabase] node identifier lookup failed: ${error.message}`)
      return opts.fallbackUrl
    }
    if (!data?.data) return opts.fallbackUrl

    return buildIdentifier(
      data.data as Record<string, unknown>,
      opts.nodeType,
      opts.fallbackUrl,
    )
  } catch (err) {
    console.warn('[supabase] node identifier lookup threw:', err)
    return opts.fallbackUrl
  }
}

/**
 * Build the scannable identifier per node type, matching the client-side
 * embeddingService.ts pattern (joined with " — ").
 *
 *   YouTube → data.title
 *   Twitter → data.authorName — data.tweetText (tweetText truncated)
 *
 * Falls back to the URL if the relevant title fields are absent or empty.
 */
function buildIdentifier(
  blob: Record<string, unknown>,
  nodeType: 'youtube' | 'twitter',
  fallback: string,
): string {
  if (nodeType === 'youtube') {
    const title = typeof blob.title === 'string' ? blob.title.trim() : ''
    return title || fallback
  }

  const authorName = typeof blob.authorName === 'string' ? blob.authorName.trim() : ''
  const tweetTextRaw = typeof blob.tweetText === 'string' ? blob.tweetText.trim() : ''
  const tweetText = tweetTextRaw.length > TWEET_TEXT_MAX_CHARS
    ? tweetTextRaw.slice(0, TWEET_TEXT_MAX_CHARS).trimEnd() + '…'
    : tweetTextRaw

  const segments = [authorName, tweetText].filter(Boolean)
  return segments.length > 0 ? segments.join(' — ') : fallback
}

/**
 * Final summary is identifier first (so the table view scans cleanly)
 * then media_analysis after a " — " separator. Full string capped at
 * SUMMARY_MAX_CHARS with an ellipsis if it overflows.
 */
function formatContentSummary(identifier: string, mediaAnalysis: string): string {
  const combined = mediaAnalysis ? `${identifier} — ${mediaAnalysis}` : identifier
  return combined.length > SUMMARY_MAX_CHARS
    ? combined.slice(0, SUMMARY_MAX_CHARS - 1) + '…'
    : combined
}
