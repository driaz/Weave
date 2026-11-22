import type { SupabaseClient } from '@supabase/supabase-js'
import { titleKey, type AgentRecallDeps, type AgentRecallRow } from './agentRecall.js'

/**
 * The two Supabase reads behind /api/agent-recall. Kept apart from the
 * route so the route tests can run them against a recording fake client.
 */
export function supabaseRecallReads(
  client: SupabaseClient,
): Pick<AgentRecallDeps, 'matchNodes' | 'fetchTitles'> {
  return {
    // Same call as fetchRetrievalContext (src/services/voice/retrievalContext.ts):
    // threshold 0 returns the full ranked band and the floor is applied by
    // the caller. There is no anchor edge here, so nothing is excluded, and
    // null live ids leave orphan-drop off (archived rows are already
    // filtered by the RPC, migration 038).
    async matchNodes({ queryVector, boardId, cap }, signal) {
      const { data, error } = await client
        .rpc('match_retrieval_context', {
          query_embedding: JSON.stringify(queryVector),
          p_board_id: boardId,
          p_match_threshold: 0,
          p_total_cap: cap,
          p_excluded_node_ids: [],
          p_live_node_ids: null,
        })
        .abortSignal(signal)
      if (error) throw new Error(`match_retrieval_context: ${error.message}`)
      return (data ?? []) as AgentRecallRow[]
    },

    async fetchTitles(boardIds, signal) {
      const { data, error } = await client
        .from('nodes')
        .select('title, board_id, client_id:data->>_clientNodeId')
        .in('board_id', boardIds)
        .abortSignal(signal)
      if (error) throw new Error(`nodes titles: ${error.message}`)
      const titles = new Map<string, string>()
      type Row = { title: string | null; board_id: string; client_id: string | null }
      for (const row of (data ?? []) as unknown as Row[]) {
        if (row.client_id && row.title) titles.set(titleKey(row.board_id, row.client_id), row.title)
      }
      return titles
    },
  }
}
