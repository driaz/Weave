import type { Connection } from '../api/claude'

/**
 * Compute the set of client node ids to EXCLUDE from retrieval, given the
 * anchor nodes a retrieval is centered on (e.g. the two endpoints of the edge a
 * voice session is anchored to) and the current in-memory graph.
 *
 * The excluded set is: the anchor nodes themselves PLUS every node directly
 * graph-adjacent to any of them (a node that shares a connection with an
 * anchor, in either direction, in any mode). The intent is to retrieve material
 * the user hasn't *already* connected to what they're looking at — surfacing an
 * already-adjacent node tells them nothing new.
 *
 * This is the client half of the RPC's exclusion contract: the RPC takes the
 * resulting array as `p_excluded_node_ids` and collapses what would otherwise
 * be a hard client-id <-> server-uuid graph join in SQL into a simple
 * `node_id <> all(:excluded)`. See migration 032.
 *
 * Ids are returned bare (any `node-` prefix stripped) so they compare equal to
 * `weave_embeddings.node_id`, which stores the bare client id. The anchor ids
 * are normalized the same way on the way in.
 */
export function computeRetrievalExclusions(
  connections: Connection[],
  anchorNodeIds: string[],
): string[] {
  const strip = (id: string) => id.replace(/^node-/, '')
  // Membership is tested against the FIXED anchor set, never the growing
  // excluded set — otherwise a B added as A's neighbor would pull in B's own
  // neighbors, leaking 2-hop nodes. We want direct adjacency only.
  const anchors = new Set<string>(anchorNodeIds.map(strip))
  const excluded = new Set<string>(anchors)

  for (const c of connections) {
    const from = strip(c.from)
    const to = strip(c.to)
    if (anchors.has(from)) excluded.add(to)
    if (anchors.has(to)) excluded.add(from)
  }

  return [...excluded]
}
