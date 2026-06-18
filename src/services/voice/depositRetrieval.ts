/**
 * Deposit retrieval band (board-agnostic v1).
 *
 * The net-new working-memory arm: prior voice-session DEPOSITS scored against
 * the same per-turn query vector the node band uses (the anchor edge embedding
 * on the opening turn, the recency-weighted user-utterance blend on follow-ups).
 * It lives ALONGSIDE the node band as a second, independently-scored band — the
 * two are never merged into one ranked list, because deposits are 380–1307-char
 * third-person prose while nodes are short summaries / edge labels, so the two
 * sit on different cosine scales. That drift is genre/length-driven, NOT a
 * different embedding family: all corpora are gemini-embedding-2 /
 * SEMANTIC_SIMILARITY / halfvec(3072), one shared space, so cosine is meaningful
 * across them. The split + the full-ranking log exist to MEASURE whether the
 * genre drift is large enough to bury one band under the other.
 *
 * v1 is BOARD-AGNOSTIC by decision: read across ALL real sessions, no board
 * filter, and let the logs (the per-deposit cross-board flag) decide whether
 * scope ever needs to come back. The corpus is small (~72 rows for one user),
 * so client-side cosine over the full corpus — loaded once per controller and
 * reused across turns — is both simpler to instrument and cheaper to reason
 * about than a sibling RPC.
 *
 * Reads `real_voice_session_deposits` (migration 036 view: already kind-filtered
 * to real + active-generation-only — do NOT re-filter here). Board resolution
 * for the cross-board LOG field is a best-effort soft join
 * (`voice_sessions.anchor_edge_id → edges.board_id`); unresolved degrades to
 * null, never a migration.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '../../types/database'
import { parseStoredEmbedding } from './retrievalContext'

/**
 * Per-turn admission cap for the deposit band. Deliberately GENEROUS so it
 * barely binds: the experiment is to observe the full score distribution (the
 * band log emits every candidate, admitted or not) and derive a floor from real
 * sessions later — a blind floor is the 0.7-vs-actual-0.43–0.63 miss. The real
 * backstop on what reaches the prompt is the working-memory char guard
 * (`WORKING_MEMORY_MAX_CHARS`), not this cap. There is intentionally NO floor.
 */
export const DEPOSIT_K = 12

/**
 * A deposit as scored client-side: body, kind, parsed embedding, and the
 * best-effort source board (null when unresolved). `open_edge` rows are carried
 * in this same band undifferentiated — the log's per-row `type` is what lets the
 * open_edge-band question be adjudicated later.
 */
export interface DepositCorpusRow {
  id: string
  sessionId: string
  /** 'deposit' | 'open_edge'. Carried verbatim for the open_edge-position log. */
  type: string
  body: string
  embedding: number[]
  /** Source board via the soft anchor join; null when the session has no anchor
   * edge or the edge was deleted. LOG-only — never gates retrieval. */
  sourceBoard: string | null
}

/** A scored deposit: corpus row + cosine similarity vs the query vector. */
export interface ScoredDeposit extends DepositCorpusRow {
  similarity: number
}

/**
 * Cosine similarity, normalizing both vectors (Gemini embeddings are not
 * guaranteed unit-length). This mirrors pgvector's cosine operator (`<=>`), so
 * deposit scores land on the same scale as the node band's
 * `1 - (embedding <=> query)` — the precondition for comparing the two bands'
 * distributions by eye. Returns -1 (sorts last) on dimension mismatch or a
 * zero-norm vector rather than throwing.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return -1
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  if (na === 0 || nb === 0) return -1
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

/**
 * Score the whole cached corpus against the query vector and return ALL rows
 * ranked similarity-desc (id tiebreak for determinism). No cap, no floor here —
 * the caller logs the full ranking, then caps for admission. Pure.
 */
export function scoreDeposits(
  corpus: DepositCorpusRow[],
  queryVector: number[],
): ScoredDeposit[] {
  return corpus
    .map((row) => ({ ...row, similarity: cosineSimilarity(row.embedding, queryVector) }))
    .sort(
      (x, y) =>
        y.similarity - x.similarity || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0),
    )
}

/** Outcome of a corpus load: the usable rows plus the counts needed to log
 * what was scanned vs dropped (an embedding that won't parse is dropped — HNSW
 * would skip it too). */
export interface DepositCorpusLoad {
  corpus: DepositCorpusRow[]
  scanned: number
  dropped: number
}

/**
 * Load the board-agnostic deposit corpus once: every real-session deposit with
 * a parseable embedding, each tagged with its best-effort source board. Returns
 * an empty corpus on any query error — the deposit band is additive and must
 * never break a turn.
 *
 * `real_voice_session_deposits` is absent from the generated Database types
 * (pre-existing migration-036 type-regen gap), so the table handle is cast
 * locally and the row shape is validated into DepositCorpusRow here.
 */
export async function loadDepositCorpus(
  client: SupabaseClient<Database>,
): Promise<DepositCorpusLoad> {
  // View not in generated types (036 gap) — localized cast; shape validated below.
  const { data, error } = await (client as SupabaseClient)
    .from('real_voice_session_deposits')
    .select('id, session_id, type, body, embedding')

  if (error || !data) return { corpus: [], scanned: 0, dropped: 0 }

  const rows: DepositCorpusRow[] = []
  let dropped = 0
  for (const raw of data as Array<Record<string, unknown>>) {
    const embedding = parseStoredEmbedding(raw.embedding)
    if (!embedding || typeof raw.id !== 'string' || typeof raw.body !== 'string') {
      dropped += 1
      continue
    }
    rows.push({
      id: raw.id,
      sessionId: typeof raw.session_id === 'string' ? raw.session_id : '',
      type: typeof raw.type === 'string' ? raw.type : 'deposit',
      body: raw.body,
      embedding,
      sourceBoard: null, // filled by resolveDepositBoards
    })
  }

  await resolveDepositBoards(client, rows)
  return { corpus: rows, scanned: data.length, dropped }
}

/**
 * Best-effort fill of `sourceBoard` via the soft anchor join: two cheap reads
 * (`voice_sessions` → anchor_edge_id, `edges` → board_id) joined in memory. Any
 * error or missing anchor leaves the board null — the cross-board flag degrades
 * to "unresolved", never blocks the band. Mutates `rows` in place.
 */
export async function resolveDepositBoards(
  client: SupabaseClient<Database>,
  rows: DepositCorpusRow[],
): Promise<void> {
  const sessionIds = [...new Set(rows.map((r) => r.sessionId).filter(Boolean))]
  if (sessionIds.length === 0) return

  const { data: sessions } = await client
    .from('voice_sessions')
    .select('id, anchor_edge_id')
    .in('id', sessionIds)
  if (!sessions) return

  const anchorBySession = new Map<string, string>()
  const anchorIds: string[] = []
  for (const s of sessions) {
    if (s.anchor_edge_id) {
      anchorBySession.set(s.id, s.anchor_edge_id)
      anchorIds.push(s.anchor_edge_id)
    }
  }
  if (anchorIds.length === 0) return

  const { data: edges } = await client
    .from('edges')
    .select('id, board_id')
    .in('id', anchorIds)
  if (!edges) return

  const boardByAnchor = new Map<string, string>()
  for (const e of edges) boardByAnchor.set(e.id, e.board_id)

  for (const row of rows) {
    const anchor = anchorBySession.get(row.sessionId)
    row.sourceBoard = anchor ? boardByAnchor.get(anchor) ?? null : null
  }
}
