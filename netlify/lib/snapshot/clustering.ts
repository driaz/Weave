// Embedding parsing and agglomerative clustering. Unchanged v1 logic, moved
// out of the handler so the generation core is pure.

import type { EmbeddingRow, NodeEntry } from './types'

export function parseEmbedding(raw: unknown): number[] | null {
  // Primary format: pgvector returns a JSON-parseable string like "[-0.004,0.017,...]"
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed)) return parsed as number[]
    } catch {
      // fall through
    }
    console.warn('[Snapshot] Embedding string was not JSON-parseable, skipping node')
    return null
  }
  if (Array.isArray(raw)) {
    console.warn('[Snapshot] Embedding returned as native array (unexpected; expected string). Using it, but investigate format drift.')
    return raw as number[]
  }
  console.warn('[Snapshot] Embedding has unexpected type:', typeof raw)
  return null
}

/** Parse rows into node entries; rows whose embedding will not parse are counted, not kept. */
export function nodesFromEmbeddingRows(rows: EmbeddingRow[]): {
  nodes: NodeEntry[]
  nodesExcludedNoEmbedding: number
} {
  const nodes: NodeEntry[] = []
  let nodesExcludedNoEmbedding = 0
  for (const row of rows) {
    const embedding = parseEmbedding(row.embedding)
    if (!embedding) {
      console.warn(`[Snapshot] Excluding node ${row.board_id}:${row.node_id}: missing or unparseable embedding`)
      nodesExcludedNoEmbedding++
      continue
    }
    nodes.push({
      compositeKey: `${row.board_id}:${row.node_id}`,
      boardId: row.board_id,
      nodeId: row.node_id,
      nodeType: row.node_type,
      embedding,
      contentSummary: row.content_summary,
    })
  }
  return { nodes, nodesExcludedNoEmbedding }
}

export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB)
  return denom === 0 ? 0 : dot / denom
}

// PERFORMANCE NOTE: O(n^3) worst case. Each merge scans all remaining cluster
// pairs and averages over member pairs. Acceptable to ~500 nodes.
export function agglomerativeClustering(nodes: NodeEntry[], threshold: number): number[][] {
  const n = nodes.length
  if (n === 0) return []

  const sim: number[][] = Array.from({ length: n }, () => new Array(n).fill(0))
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const s = cosineSimilarity(nodes[i].embedding, nodes[j].embedding)
      sim[i][j] = s
      sim[j][i] = s
    }
  }

  const clusters: number[][] = nodes.map((_, i) => [i])

  while (clusters.length > 1) {
    let bestSim = -Infinity
    let bestI = -1
    let bestJ = -1
    for (let i = 0; i < clusters.length; i++) {
      for (let j = i + 1; j < clusters.length; j++) {
        let total = 0
        for (const a of clusters[i]) {
          for (const b of clusters[j]) {
            total += sim[a][b]
          }
        }
        const avg = total / (clusters[i].length * clusters[j].length)
        if (avg > bestSim) {
          bestSim = avg
          bestI = i
          bestJ = j
        }
      }
    }
    if (bestSim < threshold) break
    clusters[bestI] = clusters[bestI].concat(clusters[bestJ])
    clusters.splice(bestJ, 1)
  }

  return clusters
}
