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
 * Similarity floor and k-cap for retrieval. The floor is now applied
 * CLIENT-SIDE (see `fetchRetrievalContext` / the consumer in vadController):
 * the RPC is called with threshold 0 and returns the full ranked band, then we
 * log the band and cut at this floor — so what we exclude stays observable and
 * tunable by eye. The k-cap still lives in the RPC (`p_total_cap`).
 */
// 0.5: surfaced material must clear this; raise if weak connections grate, lower
// if too sparse. Tuned by ear, not derived.
export const RETRIEVAL_FLOOR = 0.5
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
 * prompt. 600: tuned by ear — the 2026-06-09 read-path audit found stored
 * summaries run 200–1400 chars and the server-video write path caps at 500,
 * so 600 passes server-written content through whole. */
const ITEM_MAX_CHARS = 600

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
  k?: number
}

/**
 * Call the `match_retrieval_context` RPC (migration 034, node-only v1). The
 * query vector is serialized to the pgvector text form ("[...]") the halfvec
 * column expects, identical to how stored embeddings are written. Returns [] on
 * any error — retrieval is additive and must never break a voice turn.
 *
 * The RPC is called with `p_match_threshold => 0` so it returns the FULL ranked
 * band; the similarity floor is applied client-side by the consumer (after
 * logging the band) so what we exclude stays observable. Cheap because boards
 * are small (~17 nodes) — revisit the full-band transfer if a board ever grows
 * large. The k-cap (`p_total_cap`) still bounds the band server-side.
 */
export async function fetchRetrievalContext(
  client: SupabaseClient<Database>,
  params: FetchRetrievalParams,
): Promise<RetrievalRow[]> {
  const { data, error } = await client.rpc('match_retrieval_context', {
    // halfvec arg: same stringified-array form as the stored column writes.
    query_embedding: JSON.stringify(params.queryVector) as unknown as never,
    p_board_id: params.boardId,
    // 0 → full band; floor applied client-side (see consumer in vadController).
    p_match_threshold: 0,
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
 *
 * Bare-refId identity is correct while retrieval is single-board: the
 * candidate set can't contain a cross-board collision. #5 cross-board must
 * move this to namespaced identity (`workingMemoryKey`).
 */
export function filterUnseen(
  rows: RetrievalRow[],
  seen: ReadonlySet<string>,
): RetrievalRow[] {
  return rows.filter((r) => !seen.has(r.ref_id))
}

/**
 * Clip to ITEM_MAX_CHARS, preferring clean break points: end of the last full
 * sentence within budget (only if it lands past the halfway point — earlier
 * than that sacrifices too much content for tidiness), else the last word
 * boundary, else a hard substring. "…" is appended only when content was
 * actually clipped.
 */
function truncate(text: string): string {
  const t = text.trim()
  if (t.length <= ITEM_MAX_CHARS) return t

  const clipped = t.slice(0, ITEM_MAX_CHARS)
  const sentenceEnd = Math.max(
    clipped.lastIndexOf('.'),
    clipped.lastIndexOf('!'),
    clipped.lastIndexOf('?'),
  )
  if (sentenceEnd > ITEM_MAX_CHARS / 2) {
    return `${clipped.slice(0, sentenceEnd + 1)}…`
  }

  const lastSpace = Math.max(clipped.lastIndexOf(' '), clipped.lastIndexOf('\n'))
  if (lastSpace > 0) {
    return `${clipped.slice(0, lastSpace).trimEnd()}…`
  }

  return `${clipped.trimEnd()}…`
}

/**
 * One rendered retrieval line: "- <budget-truncated content>". Shared by
 * `buildRelatedMaterial` and working-memory admission so the line stored in
 * working memory is byte-identical to the line RELATED MATERIAL rendered the
 * turn the item surfaced.
 */
export function formatRetrievalBullet(content: string): string {
  return `- ${truncate(content)}`
}

// ------- session working memory (surfaced-material persistence) -------

/**
 * What a working-memory entry refers to. Only 'node' is produced today (the
 * v1 retrieval corpus is node-only, migration 034); the other members name
 * the future corpora so renderers fail loud instead of guessing.
 */
export type WorkingMemoryRefType = 'node' | 'voice_session' | 'edge' | 'cross_board_node'

export interface WorkingMemoryEntry {
  refType: WorkingMemoryRefType
  refId: string
  /** Board the entry came from. Identity/ledger metadata — client node ids
   * are only unique within one board, so cross-board entries need it to not
   * collide. NOT rendered into the prompt today. */
  sourceBoard: string
  /** The formatted bullet, post-truncate — the same 600-char-budget line
   * RELATED MATERIAL rendered when this entry surfaced (`formatRetrievalBullet`). */
  content: string
  /** Turn ordinal at admission; orders eviction under the overflow guard. */
  surfacedAtTurn: number
}

/**
 * The store's Map key: namespaced identity. Bare refIds are board-scoped
 * client node ids and collide across boards (and across future refTypes), so
 * the key carries all three identity parts. Single construction point — no
 * inline template strings elsewhere.
 */
export function workingMemoryKey(
  refType: WorkingMemoryRefType,
  sourceBoard: string,
  refId: string,
): string {
  return `${refType}:${sourceBoard}:${refId}`
}

/**
 * Fail-loud guard on the store's total content chars — NOT an eviction
 * policy. Expected never to fire at current board scale (~17 nodes × ≤601
 * chars per bullet, and the novelty filter admits each ref once); if it
 * fires, the overflow log is the signal that scale assumptions broke.
 */
export const WORKING_MEMORY_MAX_CHARS = 8000

/** Detail payload for the overflow log event (vadController owns the emit). */
export interface WorkingMemoryOverflowInfo {
  /** Store size in content chars BEFORE the incoming entry. */
  sizeChars: number
  entryCount: number
  incomingChars: number
}

/** Detail payload for the per-entry admission log (vadController owns the
 * emit). No content bodies — refs and sizes only. */
export interface WorkingMemoryAdmitInfo {
  refId: string
  refType: WorkingMemoryRefType
  sourceBoard: string
  surfacedAtTurn: number
  /** Chars of this entry's stored bullet. */
  chars: number
  /** Store size in content chars AFTER this entry landed (cumulative). */
  storeSizeAfterChars: number
  entryCountAfter: number
}

/**
 * Admit surfaced rows into the working-memory store. Mutates `memory` in
 * place; no I/O (the caller supplies `onOverflow` / `onAdmit` for logging)
 * so the cap/eviction behavior is unit-testable without a controller
 * instance. `onAdmit` fires once per entry, after it lands, with cumulative
 * store stats.
 *
 * A ref_id enters at most once: the caller's novelty filter guarantees
 * `rows` excludes everything previously surfaced, so there is deliberately
 * no second dedupe path here.
 *
 * Overflow guard: if an admission would push total content chars past
 * WORKING_MEMORY_MAX_CHARS, report it via `onOverflow`, then drop oldest
 * entries (by surfacedAtTurn) until the new entry fits. Fail-loud guard,
 * not an eviction policy — expected never to fire at current board scale.
 */
export function admitToWorkingMemory(
  memory: Map<string, WorkingMemoryEntry>,
  rows: RetrievalRow[],
  sourceBoard: string,
  surfacedAtTurn: number,
  onOverflow?: (info: WorkingMemoryOverflowInfo) => void,
  onAdmit?: (info: WorkingMemoryAdmitInfo) => void,
): void {
  for (const row of rows) {
    const entry: WorkingMemoryEntry = {
      // v1 retrieval corpus is node-only (migration 034), so every row is a
      // board node. A future corpus must add its refType and renderer.
      refType: 'node',
      refId: row.ref_id,
      sourceBoard,
      content: formatRetrievalBullet(row.content),
      surfacedAtTurn,
    }

    let totalChars = entry.content.length
    for (const e of memory.values()) totalChars += e.content.length

    if (totalChars > WORKING_MEMORY_MAX_CHARS) {
      onOverflow?.({
        sizeChars: totalChars - entry.content.length,
        entryCount: memory.size,
        incomingChars: entry.content.length,
      })
      const byAge = [...memory.values()].sort(
        (a, b) => a.surfacedAtTurn - b.surfacedAtTurn,
      )
      for (const victim of byAge) {
        if (totalChars <= WORKING_MEMORY_MAX_CHARS) break
        memory.delete(workingMemoryKey(victim.refType, victim.sourceBoard, victim.refId))
        totalChars -= victim.content.length
      }
    }

    memory.set(workingMemoryKey(entry.refType, entry.sourceBoard, entry.refId), entry)
    // totalChars already reflects this entry (computed pre-set, post-eviction).
    onAdmit?.({
      refId: entry.refId,
      refType: entry.refType,
      sourceBoard: entry.sourceBoard,
      surfacedAtTurn: entry.surfacedAtTurn,
      chars: entry.content.length,
      storeSizeAfterChars: totalChars,
      entryCountAfter: memory.size,
    })
  }
}

/**
 * Constant framing for the SURFACED THIS SESSION section: material already
 * named aloud — re-grounding, not news.
 */
export const WORKING_MEMORY_FRAMING =
  "Connections you've already named aloud in this conversation. Don't " +
  're-introduce them as if new — but when the conversation genuinely returns ' +
  'to one, weave it back in through its specifics rather than repeating what ' +
  'you said before.'

/**
 * Assemble the SURFACED THIS SESSION body from working-memory entries, or
 * null when the store is empty (the caller omits the section, keeping
 * prompts byte-identical to pre-working-memory behavior). Renders by
 * refType; only 'node' has a renderer today — an entry of any other type
 * throws rather than rendering wrong, so a future corpus must bring its
 * renderer with it.
 */
export function buildWorkingMemoryBlock(entries: WorkingMemoryEntry[]): string | null {
  if (entries.length === 0) return null

  const lines = entries.map((e) => {
    switch (e.refType) {
      case 'node':
        // Stored pre-formatted at admission (formatRetrievalBullet).
        return e.content
      default:
        throw new Error(
          `buildWorkingMemoryBlock: no renderer for refType "${e.refType}"`,
        )
    }
  })

  return `${WORKING_MEMORY_FRAMING}\n\n${lines.join('\n')}`
}

/**
 * Constant framing for the related-material section. Directs EXPLICIT, specific
 * surfacing — name the actual piece so the listener recognizes the thread across
 * their own collection — while guarding against listing, forcing, or
 * over-surfacing weak hits.
 */
export const RELATED_MATERIAL_FRAMING =
  'When something here genuinely connects to the edge, name it explicitly and ' +
  'specifically — point to the actual piece (e.g. \'this connects to the gomi ' +
  'post about courage being the thing that expands or shrinks your life\') so ' +
  'the listener recognizes the thread across their own collection. Surface the ' +
  'connection out loud; the value is the listener seeing links they\'d ' +
  'forgotten they made. But reach for it only where the connection is real and ' +
  'earned — one or two at most, never a list, never a forced link. If nothing ' +
  'here truly connects, let it go unsaid.'

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
    const lines = items.map((r) => formatRetrievalBullet(r.content)).join('\n')
    parts.push(`${header}\n${lines}`)
  }

  pushBlock(CURATED_HEADER, curated)
  pushBlock(PRIOR_USER_HEADER, priorUser)
  pushBlock(PRIOR_ASSISTANT_HEADER, priorAssistant)

  // Only framing survived — every row was empty/whitespace. Treat as nothing.
  if (parts.length === 1) return null

  return parts.join('\n\n')
}
