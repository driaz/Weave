/**
 * Phase 10B — voice-turn retrieval.
 *
 * Consumes the 10A foundation (migration 031 edge-embedding store, migration
 * 032 `match_retrieval_context` RPC, `retrievalExclusions.ts`) to widen each
 * voice turn with material the user hasn't already connected to the edge being
 * discussed:
 *
 *   - Opening turn: query vector = the anchor edge's STORED embedding
 *     (`lookupEdgeQueryVector`). No Gemini call. Degrades to null when the edge
 *     has no embedding yet (just-created, async write not landed).
 *   - Follow-up turn: query vector = recency-weighted blend of the last two
 *     USER utterance embeddings (`blendQueryVectors`). The current turn's
 *     embedding is computed inline upstream (double-duty with the utterance
 *     row write); the prior turn's is carried in memory.
 *
 * This module owns the query-vector math, the RPC call, the once-per-session
 * novelty filter, and assembly of the `relatedMaterial` prompt block. It does
 * NOT own prompt injection (vadController) or exclusion computation
 * (`retrievalExclusions.ts`).
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '../../types/database'
import type { Connection } from '../../api/claude'
import { connectionIdentityFields } from '../../utils/connectionIdentity'

/**
 * Similarity floor and k-cap passed to the RPC. Deliberately conservative /
 * high so the related-material section is USUALLY EMPTY and only fires on
 * strong hits — the section is widening context, not a default. Tune by feel
 * once live voice sessions produce a real similarity distribution.
 */
export const RETRIEVAL_FLOOR = 0.7
export const RETRIEVAL_K = 6

/**
 * Recency weights for the follow-up query blend. The most-recent (current)
 * user turn dominates; the prior turn contributes drift context. When the
 * prior embedding is missing (first follow-up, or N-1 not yet ready) the
 * current turn is weighted alone — see `blendQueryVectors`.
 */
export const BLEND_CURRENT = 0.65
export const BLEND_PRIOR = 0.35

/** Per-item character cap so a long node summary / utterance can't bloat the
 * prompt. Blunt; tighten if the section reads long. */
const ITEM_MAX_CHARS = 300

/**
 * One ranked retrieval hit, mirroring the RPC's `returns table` columns
 * (migration 032). `speaker` / `node_type` are null for the corpus that
 * doesn't carry them.
 */
export interface RetrievalRow {
  source: 'node' | 'utterance'
  ref_id: string
  content: string
  speaker: 'user' | 'assistant' | null
  node_type: string | null
  similarity: number
  score: number
}

/**
 * Parse a halfvec embedding as read back through PostgREST. The column stores
 * `JSON.stringify(number[])` (see embeddingService) and reads back as a
 * stringified array like "[0.1,0.2,...]"; tolerate an already-parsed array
 * too. Returns null on anything unparseable rather than throwing — a missing
 * query vector degrades to "skip retrieval", never breaks the turn.
 */
export function parseStoredEmbedding(value: unknown): number[] | null {
  if (Array.isArray(value)) {
    return value.every((n) => typeof n === 'number') ? (value as number[]) : null
  }
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value)
      return Array.isArray(parsed) && parsed.every((n) => typeof n === 'number')
        ? (parsed as number[])
        : null
    } catch {
      return null
    }
  }
  return null
}

/**
 * Opening-turn query vector: the anchor connection's STORED edge embedding,
 * looked up by the shipped directionless, mode-aware identity (board + mode +
 * sorted node ids — migration 031, `connectionIdentityFields`). Returns null
 * when no row exists yet (edge just created, async embed not landed) so the
 * caller skips retrieval this turn rather than blocking. Never throws.
 */
export async function lookupEdgeQueryVector(
  client: SupabaseClient<Database>,
  boardId: string,
  conn: Pick<Connection, 'from' | 'to' | 'mode'>,
): Promise<number[] | null> {
  const { mode, lo, hi } = connectionIdentityFields(conn)
  const { data, error } = await client
    .from('weave_edge_embeddings')
    .select('embedding')
    .eq('board_id', boardId)
    .eq('mode', mode)
    .eq('node_lo', lo)
    .eq('node_hi', hi)
    .maybeSingle()

  if (error || !data) return null
  return parseStoredEmbedding(data.embedding)
}

/**
 * Follow-up query vector: recency-weighted blend of the current and prior USER
 * utterance embeddings. pgvector's `<=>` cosine distance is magnitude-
 * invariant, so the blend is left un-normalized.
 *
 * N-1-not-ready / first-follow-up fallback: a null or dimension-mismatched
 * prior collapses to the current vector alone — never stall, never reach back
 * to the edge vector (that would throw away conversational drift).
 */
export function blendQueryVectors(
  current: number[],
  prior: number[] | null,
): number[] {
  if (!prior || prior.length !== current.length) return current
  return current.map((v, i) => BLEND_CURRENT * v + BLEND_PRIOR * prior[i])
}

export interface FetchRetrievalParams {
  queryVector: number[]
  boardId: string
  /** Anchor endpoints + graph-adjacent nodes, from `computeRetrievalExclusions`. */
  excludedNodeIds: string[]
  /**
   * Live board membership (bare client node ids) for orphan-drop. The RPC keeps
   * only rows whose node_id is in this set, dropping weave_embeddings rows whose
   * source node was deleted but never reconciled. Same in-memory-graph source as
   * `excludedNodeIds` (migration 034, Option B). Null DISABLES orphan-drop (the
   * RPC's null-guard) — a safe degrade if a caller can't supply membership,
   * never the "drop everything" an empty array would mean.
   */
  liveNodeIds: string[] | null
  floor?: number
  k?: number
}

/**
 * Call the `match_retrieval_context` RPC (migration 034, node-only v1). The
 * query vector is serialized to the pgvector text form ("[...]") the halfvec
 * column expects, identical to how stored embeddings are written. Returns [] on
 * any error — retrieval is additive and must never break a voice turn.
 */
export async function fetchRetrievalContext(
  client: SupabaseClient<Database>,
  params: FetchRetrievalParams,
): Promise<RetrievalRow[]> {
  const { data, error } = await client.rpc('match_retrieval_context', {
    // halfvec arg: same stringified-array form as the stored column writes.
    query_embedding: JSON.stringify(params.queryVector) as unknown as never,
    p_board_id: params.boardId,
    p_match_threshold: params.floor ?? RETRIEVAL_FLOOR,
    p_total_cap: params.k ?? RETRIEVAL_K,
    p_excluded_node_ids: params.excludedNodeIds,
    // RPC tolerates null (disables orphan-drop); the generated Args type is
    // non-nullable, so cast.
    p_live_node_ids: (params.liveNodeIds ?? null) as unknown as string[],
  })

  if (error || !data) return []
  return data as RetrievalRow[]
}

/**
 * Once-per-session novelty filter. Drops rows whose ref_id has already
 * surfaced this session. Pure — does NOT mutate `seen`; the caller records
 * what actually surfaces (the whole returned block is injected) by adding the
 * survivors' ref_ids after assembly.
 *
 * Filtering post-RPC (rather than feeding surfaced ids back into
 * `p_excluded_node_ids`) is the clean choice: 10A's exclusion array only
 * covers the NODE corpus (`node_id <> all(...)`), so it can't suppress an
 * already-surfaced UTTERANCE. A post-RPC ref_id filter covers both corpora
 * uniformly.
 */
export function filterUnseen(
  rows: RetrievalRow[],
  seen: ReadonlySet<string>,
): RetrievalRow[] {
  return rows.filter((r) => !seen.has(r.ref_id))
}

function truncate(text: string): string {
  const t = text.trim()
  return t.length > ITEM_MAX_CHARS ? `${t.slice(0, ITEM_MAX_CHARS).trimEnd()}…` : t
}

/**
 * Constant framing for the related-material section. Subordinates it to the
 * current edge, licenses natural cross-canvas reference when the link is real,
 * and forbids list-recitation / confabulation from weak hits.
 */
export const RELATED_MATERIAL_FRAMING =
  'Material from elsewhere on the canvas, and from your own earlier thinking, ' +
  'that may bear on the edge above. The edge is still the subject — this is ' +
  'widening context, not a new topic. Where a genuine connection exists you ' +
  'may reach for it naturally, as a person would notice something across the ' +
  'room. Do NOT recite this as a list, name it as "related material", or ' +
  'manufacture a link that isn\'t really there. If nothing here truly ' +
  'connects, let it go unsaid.'

const CURATED_HEADER = 'Things you saved that relate to this edge:'
const PRIOR_USER_HEADER =
  'Your earlier reflections — ground to build on, not lines to repeat:'
const PRIOR_ASSISTANT_HEADER =
  'Connections already drawn in earlier sessions — go further rather than restate:'

/**
 * Assemble the `relatedMaterial` block from filtered, ranked rows, or null
 * when there's nothing to surface (caller then omits the section entirely,
 * exactly like Phase 9's empty-snapshot path).
 *
 * Two framed subsections per the design: curated material (saved nodes) and
 * prior reasoning (past utterances), the latter speaker-aware — the user's own
 * utterances framed as their prior thinking, assistant utterances demoted to
 * "already drawn, go further". The constant framing is prepended; the caller
 * adds the section header / separator.
 */
export function buildRelatedMaterial(rows: RetrievalRow[]): string | null {
  if (rows.length === 0) return null

  const curated = rows.filter((r) => r.source === 'node')
  const priorUser = rows.filter(
    (r) => r.source === 'utterance' && r.speaker !== 'assistant',
  )
  const priorAssistant = rows.filter(
    (r) => r.source === 'utterance' && r.speaker === 'assistant',
  )

  const parts: string[] = [RELATED_MATERIAL_FRAMING]

  const pushBlock = (header: string, items: RetrievalRow[]): void => {
    if (items.length === 0) return
    const lines = items.map((r) => `- ${truncate(r.content)}`).join('\n')
    parts.push(`${header}\n${lines}`)
  }

  pushBlock(CURATED_HEADER, curated)
  pushBlock(PRIOR_USER_HEADER, priorUser)
  pushBlock(PRIOR_ASSISTANT_HEADER, priorAssistant)

  // Only framing survived — every row was empty/whitespace. Treat as nothing.
  if (parts.length === 1) return null

  return parts.join('\n\n')
}
