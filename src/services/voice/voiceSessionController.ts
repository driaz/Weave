/**
 * Voice session persistence controller (Phase 8).
 *
 * Bridges the Voice v2 audio pipeline (vadController + orchestrator)
 * to the durable persistence layer. The mic modal opens, this
 * controller's startSession() creates a voice_sessions row; the
 * pipeline reports each utterance as it lands, the controller writes
 * it to voice_utterances and kicks off a background embedding call;
 * on mic-modal close the controller flushes its in-memory
 * processing_log buffer and stamps end_reason on the session row.
 *
 * Design notes:
 *   - Module-with-factory pattern matching voiceSessionStore — one
 *     active session at a time, exposed as a module-level singleton.
 *     The factory is exported so tests can spin up isolated
 *     controllers without touching the singleton.
 *   - The controller owns processing_log buffering. Persistence
 *     functions return events to append; the controller's logEvent
 *     handles the writes. This keeps persistence pure.
 *   - utterance_index is *not* advanced for stripped sentinels. The
 *     index reflects the rows that actually landed in Postgres, so
 *     replay reads cleanly.
 *   - Embedding is fire-and-forget: a failure logs to the buffer but
 *     never throws into the caller. The utterance row keeps
 *     embedding = null and is recoverable later by re-embedding from
 *     `text`.
 *   - This controller does NOT touch the voiceSessionStore /
 *     vadController state machine. Wiring those together lives in
 *     Prompt B (mic-modal integration).
 */

import { embedText } from '../embeddingService'
import { persistence } from '../../persistence'
import type {
  BoardSnapshot,
  EndReason,
  SentinelEvent,
  Speaker,
} from '../../persistence'

export interface ProcessingLogEvent {
  phase: string
  outcome: 'success' | 'failed' | 'degraded' | 'skipped'
  ts: string
  detail?: Record<string, unknown>
  correlationId?: string
  parentCorrelationId?: string
  durationMs?: number
}

export interface StartSessionInput {
  anchorEdgeId: string | null
  boardSnapshot: BoardSnapshot
}

export interface RecordUtteranceInput {
  speaker: Speaker
  text: string
  startedAt: string
  endedAt: string
}

export interface RecordUtteranceResult {
  utteranceId: string | null
  stripped: boolean
}

export interface EndSessionInput {
  endReason: EndReason
}

export interface VoiceSessionController {
  /** True when a session is currently open. */
  isActive(): boolean
  /** Active session id, or null when idle. */
  getSessionId(): string | null
  /** Snapshot of the in-memory event buffer. Test-only. */
  getProcessingLog(): readonly ProcessingLogEvent[]

  startSession(input: StartSessionInput): Promise<string>
  recordUtterance(input: RecordUtteranceInput): Promise<RecordUtteranceResult>
  logEvent(event: ProcessingLogEvent): void
  endSession(input: EndSessionInput): Promise<void>
}

/**
 * Optional dependency injection seam. Production passes nothing and
 * uses the real persistence module + Gemini embedText. Tests pass
 * stubs.
 */
export interface VoiceSessionControllerDeps {
  createSession?: typeof persistence.voiceSessions.createSession
  endSession?: typeof persistence.voiceSessions.endSession
  writeUtterance?: typeof persistence.voiceUtterances.writeUtterance
  updateUtteranceEmbedding?: typeof persistence.voiceUtterances.updateUtteranceEmbedding
  embedText?: typeof embedText
}

interface SessionState {
  sessionId: string
  nextUtteranceIndex: number
  assistantHasSpokenInSession: boolean
  processingLog: ProcessingLogEvent[]
}

function nowIso(): string {
  return new Date().toISOString()
}

function sentinelEventToLog(event: SentinelEvent): ProcessingLogEvent {
  return {
    phase: event.phase,
    outcome: event.outcome,
    ts: event.ts,
    detail: event.detail,
  }
}

export function createVoiceSessionController(
  deps: VoiceSessionControllerDeps = {},
): VoiceSessionController {
  const createSession = deps.createSession ?? persistence.voiceSessions.createSession
  const endSessionPersist = deps.endSession ?? persistence.voiceSessions.endSession
  const writeUtterance = deps.writeUtterance ?? persistence.voiceUtterances.writeUtterance
  const updateUtteranceEmbedding =
    deps.updateUtteranceEmbedding ?? persistence.voiceUtterances.updateUtteranceEmbedding
  const embedTextFn = deps.embedText ?? embedText

  let session: SessionState | null = null

  function requireSession(action: string): SessionState {
    if (!session) {
      throw new Error(
        `VoiceSessionController: ${action}() called with no active session`,
      )
    }
    return session
  }

  function appendEvent(event: ProcessingLogEvent): void {
    if (!session) {
      // Pre-session / post-session events have nowhere to land. Surface
      // to console rather than silently dropping.
      console.warn('[VoiceSessionController] logEvent dropped (no active session):', event)
      return
    }
    session.processingLog.push(event)
  }

  function kickOffEmbedding(utteranceId: string, text: string, speaker: Speaker): void {
    const startedAt = Date.now()
    // Snapshot the session id so a late embedding finishing after
    // endSession() doesn't write to a fresh session's controller state.
    const ownerSessionId = session?.sessionId ?? null

    embedTextFn(text)
      .then(async (embedding) => {
        await updateUtteranceEmbedding(utteranceId, embedding)
        if (session?.sessionId === ownerSessionId) {
          appendEvent({
            phase: 'voice.utterance.embedded',
            outcome: 'success',
            ts: nowIso(),
            detail: { utteranceId, speaker, dims: embedding.length },
            durationMs: Date.now() - startedAt,
          })
        }
      })
      .catch((err) => {
        const event: ProcessingLogEvent = {
          phase: 'voice.utterance.embedding_failed',
          outcome: 'failed',
          ts: nowIso(),
          detail: {
            utteranceId,
            speaker,
            error: err instanceof Error ? err.message : String(err),
          },
          durationMs: Date.now() - startedAt,
        }
        // If the embedding completes after the session has ended,
        // the buffer is gone — surface to console so the failure is
        // still visible in dev.
        if (session?.sessionId === ownerSessionId) {
          appendEvent(event)
        } else {
          console.warn('[VoiceSessionController] embedding failed post-session:', event)
        }
      })
  }

  return {
    isActive: () => session !== null,
    getSessionId: () => session?.sessionId ?? null,
    getProcessingLog: () => (session ? session.processingLog : []),

    async startSession({ anchorEdgeId, boardSnapshot }) {
      if (session) {
        throw new Error(
          `VoiceSessionController: startSession() called while session ${session.sessionId} is already active`,
        )
      }
      const row = await createSession({
        anchor_edge_id: anchorEdgeId,
        board_snapshot: boardSnapshot as unknown as never,
        started_at: nowIso(),
        processing_log: [] as unknown as never,
        end_reason: null,
        ended_at: null,
        summary: null,
      })
      session = {
        sessionId: row.id,
        nextUtteranceIndex: 0,
        assistantHasSpokenInSession: false,
        processingLog: [],
      }
      return row.id
    },

    async recordUtterance({ speaker, text, startedAt, endedAt }) {
      const s = requireSession('recordUtterance')
      const utteranceIndex = s.nextUtteranceIndex

      let result
      try {
        result = await writeUtterance(
          {
            session_id: s.sessionId,
            speaker,
            text,
            utterance_index: utteranceIndex,
            started_at: startedAt,
            ended_at: endedAt,
          },
          { assistantHasSpokenInSession: s.assistantHasSpokenInSession },
        )
      } catch (err) {
        // Fail loud, but don't abort the session. The controller logs
        // the failure and returns a result the caller can ignore.
        appendEvent({
          phase: 'voice.utterance.insert_failed',
          outcome: 'failed',
          ts: nowIso(),
          detail: {
            speaker,
            utteranceIndex,
            textLen: text.length,
            error: err instanceof Error ? err.message : String(err),
          },
        })
        return { utteranceId: null, stripped: false }
      }

      if (result.event) {
        appendEvent(sentinelEventToLog(result.event))
      }

      if (result.stripped) {
        // Sentinel rows don't advance the counter; the next real
        // utterance still gets index 0.
        return { utteranceId: null, stripped: true }
      }

      s.nextUtteranceIndex = utteranceIndex + 1
      if (speaker === 'assistant') s.assistantHasSpokenInSession = true

      if (result.utteranceId) {
        kickOffEmbedding(result.utteranceId, text, speaker)
      }

      return { utteranceId: result.utteranceId, stripped: false }
    },

    logEvent(event) {
      appendEvent(event)
    },

    async endSession({ endReason }) {
      const s = requireSession('endSession')
      const captured = s
      session = null
      try {
        await endSessionPersist(captured.sessionId, {
          ended_at: nowIso(),
          end_reason: endReason,
          processing_log: captured.processingLog,
        })
      } catch (err) {
        // Restoring the session would invite a write-loop. Log to
        // console so the loss is visible; the utterances themselves
        // are already persisted.
        console.error(
          '[VoiceSessionController] endSession persist failed:',
          err,
          'lost processing_log entries:',
          captured.processingLog.length,
        )
        throw err
      }
    },
  }
}

export const voiceSessionController: VoiceSessionController =
  createVoiceSessionController()
