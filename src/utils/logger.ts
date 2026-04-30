/**
 * Structured logger for the Weave client.
 *
 * Two surfaces:
 *   - debug/info/warn/error — console-only, dropped below threshold
 *   - persist                — same shape, but the entry is appended to
 *                              the node's data.processing_log via setNodes.
 *                              The full array rides along on the next
 *                              debounced board save (replace_board_contents
 *                              merges data jsonb, so existing log entries
 *                              survive). The client does not call the
 *                              append_processing_log RPC — that's the
 *                              server's path because patch_node_data does
 *                              a top-level merge that would clobber the array.
 *
 * Threshold comes from VITE_LOG_LEVEL; defaults to 'debug' in dev, 'info'
 * in prod. Events below the threshold are dropped silently.
 */

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

export type LogAppender = (entry: LogEvent) => void

export interface NodeLogger {
  debug(phase: string, outcome: Outcome, detail?: Record<string, unknown>, durationMs?: number): void
  info(phase: string, outcome: Outcome, detail?: Record<string, unknown>, durationMs?: number): void
  warn(phase: string, outcome: Outcome, detail?: Record<string, unknown>, durationMs?: number): void
  error(phase: string, outcome: Outcome, detail?: Record<string, unknown>, durationMs?: number): void
  persist(phase: string, outcome: Outcome, detail?: Record<string, unknown>, durationMs?: number): void
}

const LEVEL_RANK: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 }
const SOURCE: Source = 'client'

function resolveThreshold(): LogLevel {
  const raw = (import.meta.env.VITE_LOG_LEVEL as string | undefined)?.toLowerCase()
  if (raw === 'debug' || raw === 'info' || raw === 'warn' || raw === 'error') return raw
  return import.meta.env.DEV ? 'debug' : 'info'
}

const THRESHOLD = resolveThreshold()

// One-time visibility marker so you can confirm the active threshold in
// the console without grepping the source. Emit at info so it shows in
// the Default-levels filter.
console.info('[Weave Logger]', { threshold: THRESHOLD, source: SOURCE })

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
  // Tag + structured object as a separate arg so DevTools renders it as an
  // expandable object (much more readable than a stringified blob). Debug
  // routes through console.log rather than console.debug — Chrome DevTools
  // hides console.debug under the Verbose level filter, which is off by
  // default, so debug events would otherwise be silently invisible.
  const tag = '[Weave]'
  const payload = { level, nodeId, boardId, ...event }
  if (level === 'error') console.error(tag, payload)
  else if (level === 'warn') console.warn(tag, payload)
  else if (level === 'info') console.info(tag, payload)
  else console.log(tag, payload)
}

/**
 * Build a logger scoped to a single node. Pass an `append` callback to enable
 * persist(); without it, persist() falls back to console-only with a warning.
 */
export function createNodeLogger(
  nodeId: string,
  boardId: string,
  append?: LogAppender,
): NodeLogger {
  const make = (level: LogLevel) =>
    (phase: string, outcome: Outcome, detail?: Record<string, unknown>, durationMs?: number) =>
      emit(level, nodeId, boardId, buildEvent(phase, outcome, detail, durationMs))

  return {
    debug: make('debug'),
    info: make('info'),
    warn: make('warn'),
    error: make('error'),
    persist(phase, outcome, detail, durationMs) {
      const event = buildEvent(phase, outcome, detail, durationMs)
      // Always echo persisted entries to the console at info so dev sees them
      // regardless of whether the appender succeeded.
      emit('info', nodeId, boardId, event)
      if (!append) {
        emit('warn', nodeId, boardId, buildEvent(
          'logger.persist',
          'skipped',
          { reason: 'no-appender', originalPhase: phase },
          undefined,
        ))
        return
      }
      append(event)
    },
  }
}

type NodeLike = { id: string; data?: Record<string, unknown> }
type SetNodesLike<N extends NodeLike> = (updater: (prev: N[]) => N[]) => void

/**
 * Returns a LogAppender that pushes the entry into `data.processing_log` on
 * the matching node via setNodes. The entry is persisted to Supabase by the
 * next debounced board save (migration 019's jsonb merge keeps the array
 * intact across saves).
 */
export function buildProcessingLogAppender<N extends NodeLike>(
  nodeId: string,
  setNodes: SetNodesLike<N>,
): LogAppender {
  return (entry) => {
    setNodes((prev) =>
      prev.map((n) => {
        if (n.id !== nodeId) return n
        const data = n.data ?? {}
        const existing = Array.isArray(data.processing_log)
          ? (data.processing_log as LogEvent[])
          : []
        return {
          ...n,
          data: { ...data, processing_log: [...existing, entry] },
        } as N
      }),
    )
  }
}
