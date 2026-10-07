/**
 * Phase names introduced by the media server for node_processing_log
 * (migration 043). Existing phases (embed.budget, embed.server,
 * media.pipeline, …) stay at their call sites unchanged.
 */

/** A write was skipped because (board_id, user_id, _clientNodeId) did not resolve to exactly one node. */
export const WRITE_UNRESOLVED_PHASE = 'write.unresolved'
