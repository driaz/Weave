import { useState, useEffect, useCallback } from 'react'
import { supabase } from '../services/supabaseClient'

type ClusterObj = {
  cluster_id: string
  member_node_ids: string[]
  anchor_node_ids: string[]
  theme_description: string
  engagement_weight: number
  size: number
  boards_touched: string[]
}

type Snapshot = {
  id: string
  created_at: string
  node_count: number
  clusters: ClusterObj[] | null
  narrative: string | null
}

type ContentEntry = {
  nodeType: string
  summary: string | null
}

type Props = {
  onBack: (target?: { boardId: string; nodeId: string }) => void
}

export function ReflectView({ onBack }: Props) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [contentLookup, setContentLookup] = useState<Map<string, ContentEntry>>(new Map())
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [expandedClusters, setExpandedClusters] = useState<Set<string>>(new Set())
  const [expandedNodes, setExpandedNodes] = useState<Set<string>>(new Set())

  useEffect(() => {
    if (!supabase) {
      setError('Supabase not configured')
      setLoading(false)
      return
    }

    async function load() {
      const { data: snap, error: snapErr } = await supabase!
        .from('weave_profile_snapshots')
        .select('id, created_at, node_count, clusters, narrative')
        .order('created_at', { ascending: false })
        .limit(1)
        .single()

      if (snapErr || !snap) {
        setError('No snapshots found')
        setLoading(false)
        return
      }

      setSnapshot(snap as Snapshot)

      // Fetch content summaries for all member nodes
      const clusters = (snap.clusters ?? []) as ClusterObj[]
      const allKeys = new Set<string>()
      for (const c of clusters) {
        for (const key of c.member_node_ids) allKeys.add(key)
      }

      const boardIds = [...new Set([...allKeys].map((k) => k.slice(0, k.indexOf(':'))))]
      if (boardIds.length > 0) {
        const { data: embRows } = await supabase!
          .from('weave_embeddings')
          .select('board_id, node_id, node_type, content_summary')
          .in('board_id', boardIds)
          .is('archived_at', null)

        const lookup = new Map<string, ContentEntry>()
        for (const row of embRows ?? []) {
          lookup.set(`${row.board_id}:${row.node_id}`, {
            nodeType: row.node_type,
            summary: row.content_summary,
          })
        }
        setContentLookup(lookup)
      }

      setLoading(false)
    }

    load()
  }, [])

  const toggleCluster = useCallback((clusterId: string) => {
    setExpandedClusters((prev) => {
      const next = new Set(prev)
      if (next.has(clusterId)) next.delete(clusterId)
      else next.add(clusterId)
      return next
    })
  }, [])

  const toggleNode = useCallback((nodeKey: string) => {
    setExpandedNodes((prev) => {
      const next = new Set(prev)
      if (next.has(nodeKey)) next.delete(nodeKey)
      else next.add(nodeKey)
      return next
    })
  }, [])

  if (loading) {
    return (
      <div className="w-screen h-screen flex items-center justify-center bg-white">
        <p className="text-gray-400 text-lg">Loading...</p>
      </div>
    )
  }

  if (error || !snapshot) {
    return (
      <div className="w-screen h-screen flex flex-col items-center justify-center bg-white gap-4">
        <p className="text-gray-400 text-lg">{error ?? 'Something went wrong'}</p>
        <button
          onClick={() => onBack()}
          className="text-sm text-gray-500 hover:text-gray-700 underline cursor-pointer"
        >
          Back to canvas
        </button>
      </div>
    )
  }

  const clusters = (snapshot.clusters ?? []) as ClusterObj[]
  const hasThemes = clusters.some((c) => c.theme_description && c.theme_description.length > 0)

  if (clusters.length === 0 || !hasThemes) {
    return (
      <div className="w-screen h-screen flex flex-col items-center justify-center bg-white gap-4">
        <p className="text-gray-400 text-lg">
          No reflections yet. Run the reasoning layer to generate themes.
        </p>
        <button
          onClick={() => onBack()}
          className="text-sm text-gray-500 hover:text-gray-700 underline cursor-pointer"
        >
          Back to canvas
        </button>
      </div>
    )
  }

  // Sort by size descending
  const sorted = [...clusters].sort((a, b) => b.size - a.size)
  const totalPieces = sorted.reduce((sum, c) => sum + c.size, 0)
  const snapshotDate = new Date(snapshot.created_at)
  const formattedDate = snapshotDate.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })

  return (
    <div className="w-screen h-screen bg-white overflow-y-auto">
      <div className="max-w-2xl mx-auto px-6 py-12">
        {/* Header */}
        <div className="mb-12">
          <button
            onClick={() => onBack()}
            className="text-sm text-gray-400 hover:text-gray-600 mb-6 cursor-pointer"
          >
            &larr; Back to canvas
          </button>
          <h1 className="text-2xl font-light text-gray-900 mb-2">Reflect</h1>
          <p className="text-sm text-gray-400">
            {sorted.length} threads found across {totalPieces} pieces
            <span className="mx-2">&middot;</span>
            {formattedDate}
          </p>
        </div>

        {/* Narrative synthesis — shown above the cluster evidence */}
        {snapshot.narrative && snapshot.narrative.trim().length > 0 && (
          <div className="mb-16 space-y-4">
            {snapshot.narrative
              .split(/\n\s*\n/)
              .map((para) => para.trim())
              .filter((para) => para.length > 0)
              .map((para, i) => (
                <p
                  key={i}
                  className="text-base text-gray-800 leading-relaxed"
                >
                  {decodeHtmlEntities(para)}
                </p>
              ))}
          </div>
        )}

        {/* Clusters */}
        <div className="space-y-10">
          {sorted.map((cluster) => {
            const isExpanded = expandedClusters.has(cluster.cluster_id)
            const anchorSet = new Set(cluster.anchor_node_ids)

            return (
              <div key={cluster.cluster_id} className="border-t border-gray-100 pt-8">
                {/* Theme description */}
                <p className="text-base text-gray-800 leading-relaxed mb-3">
                  {decodeHtmlEntities(cluster.theme_description)}
                </p>

                {/* Metadata line */}
                <p className="text-xs text-gray-400 mb-2">
                  {cluster.size} pieces across{' '}
                  {cluster.boards_touched.length} board{cluster.boards_touched.length !== 1 ? 's' : ''}
                </p>

                {/* Expand/collapse toggle */}
                <button
                  onClick={() => toggleCluster(cluster.cluster_id)}
                  className="text-xs text-gray-400 hover:text-gray-600 cursor-pointer"
                >
                  {isExpanded ? 'Hide pieces' : 'Show pieces'}
                </button>

                {/* Member nodes (collapsed by default) */}
                {isExpanded && (
                  <div className="mt-4 space-y-3 pl-3 border-l border-gray-100">
                    {cluster.member_node_ids.map((key) => {
                      const entry = contentLookup.get(key)
                      const isAnchor = anchorSet.has(key)
                      const summary = entry?.summary ?? null
                      const nodeType = entry?.nodeType ?? 'unknown'
                      const isLong = summary !== null && summary.length > 200
                      const isNodeExpanded = expandedNodes.has(key)

                      const colonIdx = key.indexOf(':')
                      const boardId = key.slice(0, colonIdx)
                      const nodeId = key.slice(colonIdx + 1)

                      return (
                        <div key={key} className="text-sm">
                          <span className="text-xs text-gray-300 mr-1">
                            {isAnchor ? '★' : ''}
                          </span>
                          <button
                            onClick={() => onBack({ boardId, nodeId })}
                            className="text-xs text-gray-400 hover:text-gray-600 hover:underline mr-2 cursor-pointer"
                            title="Go to this node on the canvas"
                          >
                            [{nodeType}]
                          </button>
                          {summary ? (
                            <>
                              <span className="text-gray-600">
                                {isLong && !isNodeExpanded
                                  ? decodeHtmlEntities(summary.slice(0, 200)) + '...'
                                  : decodeHtmlEntities(summary)}
                              </span>
                              {isLong && (
                                <button
                                  onClick={() => toggleNode(key)}
                                  className="text-xs text-gray-400 hover:text-gray-600 ml-1 cursor-pointer"
                                >
                                  {isNodeExpanded ? 'show less' : 'show more'}
                                </button>
                              )}
                            </>
                          ) : (
                            <span className="text-gray-400 italic">
                              visual content — no text description
                            </span>
                          )}
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
            )
          })}
        </div>

        {/* Footer spacer */}
        <div className="h-24" />
      </div>
    </div>
  )
}

/**
 * Decode common HTML entities that appear in tweet text and web content.
 */
function decodeHtmlEntities(text: string): string {
  const textarea = document.createElement('textarea')
  textarea.innerHTML = text
  return textarea.value
}
