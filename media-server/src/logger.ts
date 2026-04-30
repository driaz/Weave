/**
 * Structured logger for the Weave media server.
 *
 * Two surfaces:
 *   - debug/info/warn/error — stdout-only, dropped below threshold
 *   - persist                — same shape, but the entry is also appended to
 *                              the node's data.processing_log via the
 *                              append_processing_log RPC (atomic array
 *                              concatenation; survives concurrent writes).
 *
 * Threshold comes from LOG_LEVEL; defaults to 'debug' off-prod, 'info' on
 * NODE_ENV=production. Events below the threshold are dropped silently.
 *
 * Why a dedicated RPC: patch_node_data (migration 016) does `data || patch`,
 * which merges top-level keys — that would replace the entire processing_log
 * array on every persist instead of appending to it.
 */

import { admin } from './supabase.js'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'
export type Outcome = 'success' | 'failed' | 'degraded' | 'skipped'
export type Source = 'client' | 'server'

export interface LogEvent {
  phase: string
  source: Source
  outcome: Outcome
  ts: string
  durationMs?: number
  detail?: Record<string, unknown>
}

export interface NodeLogger {
  debug(phase: string, outcome: Outcome, detail?: Record<string, unknown>, durationMs?: number): void
  info(phase: string, outcome: Outcome, detail?: Record<string, unknown>, durationMs?: number): void
  warn(phase: string, outcome: Outcome, detail?: Record<string, unknown>, durationMs?: number): void
  error(phase: string, outcome: Outcome, detail?: Record<string, unknown>, durationMs?: number): void
  persist(phase: string, outcome: Outcome, detail?: Record<string, unknown>, durationMs?: number): Promise<void>
}

const LEVEL_RANK: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 }
const SOURCE: Source = 'server'

function resolveThreshold(): LogLevel {
  const raw = process.env.LOG_LEVEL?.toLowerCase()
  if (raw === 'debug' || raw === 'info' || raw === 'warn' || raw === 'error') return raw as LogLevel
  return process.env.NODE_ENV === 'production' ? 'info' : 'debug'
}

const THRESHOLD = resolveThreshold()

function buildEvent(
  phase: string,
  outcome: Outcome,
  detail: Record<string, unknown> | undefined,
  durationMs: number | undefined,
): LogEvent {
  const event: LogEvent = {
    phase,
    source: SOURCE,
    outcome,
    ts: new Date().toISOString(),
  }
  if (typeof durationMs === 'number') event.durationMs = durationMs
  if (detail) event.detail = detail
  return event
}

function emit(level: LogLevel, nodeId: string, boardId: string, event: LogEvent): void {
  if (LEVEL_RANK[level] < LEVEL_RANK[THRESHOLD]) return
  process.stdout.write(JSON.stringify({ level, nodeId, boardId, ...event }) + '\n')
}

/**
 * Build a logger scoped to a single node. `userId` is required because
 * append_processing_log scopes its UPDATE by user_id as a defense-in-depth
 * check on top of RLS (service role bypasses RLS, so the WHERE clause is
 * the only thing stopping cross-user writes).
 */
export function createNodeLogger(nodeId: string, boardId: string, userId: string): NodeLogger {
  const make = (level: LogLevel) =>
    (phase: string, outcome: Outcome, detail?: Record<string, unknown>, durationMs?: number) =>
      emit(level, nodeId, boardId, buildEvent(phase, outcome, detail, durationMs))

  return {
    debug: make('debug'),
    info: make('info'),
    warn: make('warn'),
    error: make('error'),
    async persist(phase, outcome, detail, durationMs) {
      const event = buildEvent(phase, outcome, detail, durationMs)
      // Echo to stdout at info so persist events are visible in fly logs
      // even when the RPC fails.
      emit('info', nodeId, boardId, event)
      const { error } = await admin.rpc('append_processing_log', {
        p_client_id: nodeId,
        p_board_id: boardId,
        p_user_id: userId,
        p_entry: event,
      })
      if (error) {
        emit(
          'warn',
          nodeId,
          boardId,
          buildEvent(
            'logger.persist',
            'failed',
            { error: error.message, originalPhase: phase },
            undefined,
          ),
        )
      }
    },
  }
}
