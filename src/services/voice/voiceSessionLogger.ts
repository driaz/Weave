/**
 * Voice-specific logger wrapper. Sits on top of createNodeLogger and
 * adds three voice-only policies:
 *
 *   1. Verbosity gating. Some events are noisy and should only fire
 *      when the user has explicitly opted in via
 *      localStorage.getItem('weave.voice.logLevel') === 'verbose'.
 *      Default (no flag set) suppresses them.
 *
 *   2. weave_events persistence for session lifecycle events
 *      (voice.session.started / .ended).
 *
 *   3. Phase 8: every event emitted (after the verbose gate) is also
 *      appended to the active voiceSessionController's in-memory
 *      processing_log, which flushes to voice_sessions.processing_log
 *      on session end. The mirror is a no-op when no session is
 *      active, so existing call sites (which fire all the time) are
 *      safe.
 *
 * Verbosity policy is hard-coded here rather than added to the shared
 * logger because it's a voice concern; the shared logger's audit
 * recommended deferring a generic per-namespace filter.
 */

import {
  createNodeLogger,
  type CorrelationIds,
  type Outcome,
} from '../../utils/logger'
import { trackEvent } from '../eventTracker'
import { voiceSessionController } from './voiceSessionController'

const VERBOSE_ONLY_PHASES = new Set<string>([
  'voice.vad.speech_started',
  'voice.vad.silence_started',
  'voice.vad.chunk_received',
  'voice.vad.config_applied',
  'voice.vad.worklet_ready',
  // High-volume per-turn diagnostic events for sentence-chunked TTS.
  // Each Claude push that emits N sentences fires N segmenter.emitted;
  // segment_queued fires for each sentence held back by the concurrency
  // cap. Visible only under localStorage weave.voice.logLevel='verbose'.
  'voice.segmenter.emitted',
  'voice.tts.segment_queued',
])

const WEAVE_EVENTS_PHASES = new Set<string>([
  'voice.session.started',
  'voice.session.ended',
])

const LOG_LEVEL_KEY = 'weave.voice.logLevel'

function isVerbose(): boolean {
  try {
    return localStorage.getItem(LOG_LEVEL_KEY) === 'verbose'
  } catch {
    return false
  }
}

export interface VoiceSessionLogger {
  event(
    phase: string,
    outcome: Outcome,
    detail?: Record<string, unknown>,
    correlationIds?: CorrelationIds,
  ): void
}

export interface VoiceSessionLoggerOptions {
  scope: string
  boardId: string
}

export function createVoiceSessionLogger(
  opts: VoiceSessionLoggerOptions,
): VoiceSessionLogger {
  const base = createNodeLogger(opts.scope, opts.boardId)

  return {
    event(phase, outcome, detail, correlationIds) {
      if (VERBOSE_ONLY_PHASES.has(phase) && !isVerbose()) return

      base.info(phase, outcome, detail, undefined, correlationIds)

      if (WEAVE_EVENTS_PHASES.has(phase)) {
        trackEvent(phase, {
          boardId: opts.boardId,
          metadata: {
            ...detail,
            correlationId: correlationIds?.correlationId,
            parentCorrelationId: correlationIds?.parentCorrelationId,
            outcome,
          },
        })
      }

      // Phase 8: mirror to the active session's in-memory processing_log
      // buffer. Same payload shape as the console / weave_events sinks
      // above; differs only in clock — durable ts (wall-clock ISO)
      // instead of performance.now() so the row reads correctly when
      // played back later. No-op when no session is active.
      if (voiceSessionController.isActive()) {
        voiceSessionController.logEvent({
          phase,
          outcome,
          ts: new Date().toISOString(),
          detail,
          correlationId: correlationIds?.correlationId,
          parentCorrelationId: correlationIds?.parentCorrelationId,
        })
      }
    },
  }
}
