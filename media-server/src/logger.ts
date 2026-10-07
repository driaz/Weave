/**
 * Structured logger for the Weave media server.
 *
 * Two surfaces:
 *   - debug/info/warn/error — stdout-only, dropped below threshold
 *   - persist                — same shape, but the entry is also written as
 *                              a node_processing_log row (migration 043) via
 *                              append_node_processing_log. The server never
 *                              writes nodes.data.processing_log — that array
 *                              is client-owned.
 *
 * Threshold comes from LOG_LEVEL; defaults to 'debug' off-prod, 'info' on
 * NODE_ENV=production. Events below the threshold are dropped silently.
 *
 * Why a table: replace_board_contents merges nodes.data key-by-key, so any
 * server entry inside nodes.data.processing_log was replaced by the client's
 * copy of the array on the next save.
 */

import { appendNodeProcessingLog, logUnresolvedWrite, resolveNodeUuid } from './supabase.js'

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
  correlationId?: string
  parentCorrelationId?: string
}

export interface CorrelationIds {
  correlationId?: string
  parentCorrelationId?: string
}

export interface NodeLogger {
  debug(phase: string, outcome: Outcome, detail?: Record<string, unknown>, durationMs?: number, correlationIds?: CorrelationIds): void
  info(phase: string, outcome: Outcome, detail?: Record<string, unknown>, durationMs?: number, correlationIds?: CorrelationIds): void
  warn(phase: string, outcome: Outcome, detail?: Record<string, unknown>, durationMs?: number, correlationIds?: CorrelationIds): void
  error(phase: string, outcome: Outcome, detail?: Record<string, unknown>, durationMs?: number, correlationIds?: CorrelationIds): void
  persist(phase: string, outcome: Outcome, detail?: Record<string, unknown>, durationMs?: number, correlationIds?: CorrelationIds): Promise<void>
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
  correlationIds: CorrelationIds | undefined,
): LogEvent {
  const event: LogEvent = {
    phase,
    source: SOURCE,
    outcome,
    ts: new Date().toISOString(),
  }
  if (typeof durationMs === 'number') event.durationMs = durationMs
  if (detail) event.detail = detail
  if (correlationIds?.correlationId) event.correlationId = correlationIds.correlationId
  if (correlationIds?.parentCorrelationId) event.parentCorrelationId = correlationIds.parentCorrelationId
  return event
}

function emit(level: LogLevel, nodeId: string, boardId: string, event: LogEvent): void {
  if (LEVEL_RANK[level] < LEVEL_RANK[THRESHOLD]) return
  process.stdout.write(JSON.stringify({ level, nodeId, boardId, ...event }) + '\n')
}

/**
 * node_processing_log has phase/ts/outcome/detail columns; the rest of the
 * event (source, durationMs, correlation ids) rides inside detail.
 */
function toDetail(event: LogEvent): Record<string, unknown> {
  const detail: Record<string, unknown> = { ...event.detail, source: event.source }
  if (event.durationMs !== undefined) detail.durationMs = event.durationMs
  if (event.correlationId) detail.correlationId = event.correlationId
  if (event.parentCorrelationId) detail.parentCorrelationId = event.parentCorrelationId
  return detail
}

/**
 * Build a logger scoped to a single node. `userId` is required because the
 * node lookup is scoped by user_id as a defense-in-depth check (service role
 * bypasses RLS, so the WHERE clause is the only thing stopping cross-user
 * writes).
 */
export function createNodeLogger(nodeId: string, boardId: string, userId: string): NodeLogger {
  const make = (level: LogLevel) =>
    (phase: string, outcome: Outcome, detail?: Record<string, unknown>, durationMs?: number, correlationIds?: CorrelationIds) =>
      emit(level, nodeId, boardId, buildEvent(phase, outcome, detail, durationMs, correlationIds))

  return {
    debug: make('debug'),
    info: make('info'),
    warn: make('warn'),
    error: make('error'),
    async persist(phase, outcome, detail, durationMs, correlationIds) {
      const event = buildEvent(phase, outcome, detail, durationMs, correlationIds)
      // Echo to stdout at info so persist events are visible in fly logs
      // even when the RPC fails.
      emit('info', nodeId, boardId, event)
      const ref = { nodeId, boardId, userId }
      const resolution = await resolveNodeUuid(ref)
      const error = resolution.ok
        ? await appendNodeProcessingLog(resolution.uuid, event.phase, event.outcome, toDetail(event))
        : await logUnresolvedWrite(ref, resolution, 'fly.logger.persist', 'processing_log', {
            intended_phase: event.phase,
          })
      if (error) {
        emit(
          'warn',
          nodeId,
          boardId,
          buildEvent(
            'logger.persist',
            'failed',
            { error, originalPhase: phase },
            undefined,
            undefined,
          ),
        )
      }
    },
  }
}
