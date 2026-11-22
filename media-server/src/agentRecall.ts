import { createHash, timingSafeEqual } from 'node:crypto'
import type { FastifyInstance } from 'fastify'

// Read-only recall for the ElevenLabs "Weave Agent Test" agent (a webhook
// tool called mid-conversation). A test surface, not part of the voice
// pipeline: it embeds the query, calls match_retrieval_context the way a
// follow-up voice turn does, applies the same floor, and returns the top
// nodes. It writes nothing: no surfaced marking, no working memory.

// Mirror RETRIEVAL_FLOOR / RETRIEVAL_K in src/services/voice/retrievalContext.ts
// (different package, same values; agentRecall.test.ts fails if they drift).
export const AGENT_RECALL_FLOOR = 0.5
export const AGENT_RECALL_RPC_CAP = 6

export const AGENT_RECALL_TOP_N = 5
export const AGENT_RECALL_SNIPPET_MAX_CHARS = 600
export const AGENT_RECALL_RESPONSE_MAX_CHARS = 4000
export const AGENT_RECALL_TIMEOUT_MS = 5000
const QUERY_MAX_CHARS = 2000
const MAX_BOARDS = 20
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The match_retrieval_context columns this route reads (migration 038). */
export interface AgentRecallRow {
  ref_id: string
  content: string
  similarity: number
}

/** A row tagged with the board it came from; client node ids are only unique within a board. */
export interface BoardRecallRow extends AgentRecallRow {
  boardId: string
}

/** Key for the titles map. */
export function titleKey(boardId: string, nodeId: string): string {
  return `${boardId}:${nodeId}`
}

export interface AgentRecallResult {
  title: string | null
  snippet: string
  similarity: number
}

export interface AgentRecallDeps {
  getEnv: () => { enabled?: string; key?: string; boardId?: string }
  /** Same Gemini model, task type and dims as Weave's embedText. */
  embedQuery: (text: string, signal: AbortSignal) => Promise<number[]>
  /** match_retrieval_context for one board. Throws on an RPC error. */
  matchNodes: (
    args: { queryVector: number[]; boardId: string; cap: number },
    signal: AbortSignal,
  ) => Promise<AgentRecallRow[]>
  /** `titleKey(boardId, clientNodeId)` → title for the given boards. Throws on a query error. */
  fetchTitles: (boardIds: string[], signal: AbortSignal) => Promise<Map<string, string>>
  timeoutMs?: number
}

class RecallTimeout extends Error {}

/** Run `fn` with an abort signal; reject with RecallTimeout after `ms` even if `fn` ignores the signal. */
async function withTimeout<T>(ms: number, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController()
  let timer: NodeJS.Timeout | undefined
  const timedOut = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort()
      reject(new RecallTimeout())
    }, ms)
  })
  try {
    return await Promise.race([fn(controller.signal), timedOut])
  } finally {
    clearTimeout(timer)
  }
}

/** Constant-time comparison; hashing first makes the lengths equal. */
export function keysMatch(given: string, expected: string): boolean {
  const a = createHash('sha256').update(given).digest()
  const b = createHash('sha256').update(expected).digest()
  return timingSafeEqual(a, b)
}

/**
 * Trim to at most AGENT_RECALL_SNIPPET_MAX_CHARS including the ellipsis.
 * Break preference follows retrievalContext.ts `truncate`: last full
 * sentence if it lands past the halfway point, else last word boundary.
 */
export function trimSnippet(text: string, max: number = AGENT_RECALL_SNIPPET_MAX_CHARS): string {
  const t = text.trim()
  if (t.length <= max) return t
  const clipped = t.slice(0, max - 1)
  const sentenceEnd = Math.max(
    clipped.lastIndexOf('.'),
    clipped.lastIndexOf('!'),
    clipped.lastIndexOf('?'),
  )
  if (sentenceEnd > max / 2) return `${clipped.slice(0, sentenceEnd + 1)}…`
  const lastSpace = Math.max(clipped.lastIndexOf(' '), clipped.lastIndexOf('\n'))
  if (lastSpace > 0) return `${clipped.slice(0, lastSpace).trimEnd()}…`
  return `${clipped.trimEnd()}…`
}

/**
 * Rank across boards, floor, top N, trim, then drop trailing results until
 * the JSON fits the budget. With one board the sort is a no-op (the RPC
 * already returns its band ranked); with several, each board's band is
 * scored against the same query vector, so similarities compare directly.
 */
export function buildRecallResponse(
  rows: BoardRecallRow[],
  titles: Map<string, string>,
): { results: AgentRecallResult[] } {
  const results = [...rows]
    .sort((a, b) => b.similarity - a.similarity)
    .filter((r) => r.similarity >= AGENT_RECALL_FLOOR)
    .slice(0, AGENT_RECALL_TOP_N)
    .map((r) => ({
      title: titles.get(titleKey(r.boardId, r.ref_id))?.trim().slice(0, 200) || null,
      snippet: trimSnippet(r.content),
      similarity: Number(r.similarity.toFixed(4)),
    }))
  while (results.length > 0 && JSON.stringify({ results }).length > AGENT_RECALL_RESPONSE_MAX_CHARS) {
    results.pop()
  }
  return { results }
}

/**
 * POST /api/agent-recall, body `{ query, boardId? }`. 404 unless
 * AGENT_RECALL_ENABLED=1; 401 without a matching X-Agent-Recall-Key.
 * AGENT_RECALL_BOARD_ID may be a comma-separated list: each board is
 * searched with the same RPC and the bands are merged by similarity.
 */
export function registerAgentRecallRoute(app: FastifyInstance, deps: AgentRecallDeps): void {
  app.post('/api/agent-recall', async (req, reply) => {
    const env = deps.getEnv()
    if (env.enabled !== '1') return reply.code(404).send({ error: 'not found' })

    const headerVal = req.headers['x-agent-recall-key']
    const given = Array.isArray(headerVal) ? headerVal[0] : headerVal
    if (!env.key || !given || !keysMatch(given, env.key)) {
      return reply.code(401).send({ error: 'unauthorized' })
    }

    const body = (req.body ?? {}) as { query?: unknown; boardId?: unknown }
    const query = typeof body.query === 'string' ? body.query.trim() : ''
    if (!query || query.length > QUERY_MAX_CHARS) {
      return reply.code(400).send({ error: `query must be 1-${QUERY_MAX_CHARS} characters` })
    }
    if (body.boardId !== undefined && typeof body.boardId !== 'string') {
      return reply.code(400).send({ error: 'boardId must be a string' })
    }
    const fromBody = Boolean(body.boardId)
    const boardIds = [
      ...new Set(
        (body.boardId || env.boardId || '')
          .split(',')
          .map((id) => id.trim().toLowerCase())
          .filter(Boolean),
      ),
    ]
    if (boardIds.length === 0) {
      return reply.code(500).send({ error: 'AGENT_RECALL_BOARD_ID not configured' })
    }
    if (boardIds.length > MAX_BOARDS || !boardIds.every((id) => UUID_RE.test(id))) {
      return fromBody
        ? reply.code(400).send({ error: `boardId must be 1-${MAX_BOARDS} uuids` })
        : reply.code(500).send({ error: 'AGENT_RECALL_BOARD_ID is not a list of uuids' })
    }

    const timeoutMs = deps.timeoutMs ?? AGENT_RECALL_TIMEOUT_MS
    const startedAt = Date.now()
    let embedMs: number | null = null
    let rpcMs: number | null = null
    let phase: 'embed' | 'rpc' = 'embed'

    // Titles are decoration, fetched alongside the embed so they add no wall
    // time; a failure degrades to null titles rather than failing the recall.
    const titlesPromise = withTimeout(timeoutMs, (signal) => deps.fetchTitles(boardIds, signal)).catch(
      (err: unknown) => {
        req.log.warn({ event: 'agent_recall.titles_failed', err: String(err) }, 'agent_recall.titles_failed')
        return new Map<string, string>()
      },
    )

    try {
      const queryVector = await withTimeout(timeoutMs, (signal) => deps.embedQuery(query, signal))
      embedMs = Date.now() - startedAt

      phase = 'rpc'
      const rpcStartedAt = Date.now()
      // One RPC per board, in parallel, under a single timeout.
      const bands = await withTimeout(timeoutMs, (signal) =>
        Promise.all(
          boardIds.map(async (boardId) => {
            const band = await deps.matchNodes({ queryVector, boardId, cap: AGENT_RECALL_RPC_CAP }, signal)
            return band.map((r) => ({ ...r, boardId }))
          }),
        ),
      )
      const rows = bands.flat()
      rpcMs = Date.now() - rpcStartedAt

      const response = buildRecallResponse(rows, await titlesPromise)
      req.log.info(
        {
          event: 'agent_recall.completed',
          boardIds,
          queryChars: query.length,
          embedMs,
          rpcMs,
          totalMs: Date.now() - startedAt,
          band: rows.map((r) => Number(r.similarity.toFixed(4))).sort((a, b) => b - a),
          returned: response.results.length,
        },
        'agent_recall.completed',
      )
      return reply.header('Cache-Control', 'no-store').send(response)
    } catch (err) {
      const timedOut = err instanceof RecallTimeout
      req.log.error(
        {
          event: 'agent_recall.error',
          boardIds,
          phase,
          timedOut,
          embedMs,
          rpcMs,
          totalMs: Date.now() - startedAt,
          detail: timedOut ? `timed out after ${timeoutMs} ms` : String(err),
        },
        'agent_recall.error',
      )
      return reply
        .code(timedOut ? 504 : 502)
        .send({ error: timedOut ? `${phase} timed out` : `${phase} failed` })
    }
  })
}
