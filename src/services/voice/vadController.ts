/**
 * Voice session controller (a.k.a. "the VAD controller" per the design
 * doc, though it owns more than just VAD — it drives the full
 * STT → Claude → TTS pipeline for one voice session).
 *
 * Responsibilities:
 *   - Owns AudioContext, MediaStream, AudioWorkletNode lifecycle.
 *   - Translates worklet messages into voiceSessionStore actions.
 *   - Owns the 1.5s silence timer that decides when the user is done.
 *   - On user-turn completion: assembles WAV, calls /api/stt, hands the
 *     transcript to the conversation orchestrator, segments Claude's
 *     streamed response into sentences as it arrives, fires one
 *     /api/tts-stream per sentence (capped concurrency), and feeds the
 *     resulting PCM streams to a PcmMultiplexer for gapless playback.
 *   - Owns conversation history (messages[]) for the session.
 *   - Idempotent teardownSession() called from every error and idle exit.
 *
 * The session store is the source of truth for status; this file is the
 * code that drives it from the world (mic, worklet, network) and the UI.
 * UI methods (start, userClickedStop, userClickedClose) drive the right
 * store transitions internally so callers don't have to remember which
 * action to call from which state.
 */

import { PcmMultiplexer, type MuxEvent } from './pcmMultiplexer'
import {
  runConversationTurn,
  type ConversationMessage,
} from './conversationOrchestrator'
import { createSentenceSegmenter } from './sentenceSegmenter'
import { transcribeAudio, type TranscribeAudioOutput } from './sttClient'
import { fetchTtsStream } from './ttsStreamClient'
import { encodeWav } from './wavEncode'
import {
  voiceSessionStore,
  type VoiceSessionError,
  type VoiceSessionErrorKind,
  type VoiceSessionStore,
} from './voiceSessionStore'
import {
  createVoiceSessionLogger,
  type VoiceSessionLogger,
} from './voiceSessionLogger'

const WORKLET_URL = '/voice/vad-processor.js'
const WORKLET_PROCESSOR_NAME = 'vad-processor'
const WORKLET_READY_TIMEOUT_MS = 1000
const SILENCE_TIMER_MS = 1500
const VAD_RMS_THRESHOLD = 0.02
const VAD_MIN_SPEECH_DURATION_MS = 200
const VAD_PRE_ROLL_MS = 300
const STT_MIN_DURATION_MS = 500
const STT_MIN_WORDS = 2

/**
 * Cap on concurrent in-flight TTS work for a single turn. "In flight" =
 * fetched/fetching but the segment hasn't yet drained in the multiplexer
 * (drain = mux has finished enqueuing the segment's PCM to the shared
 * stream, which is when the ElevenLabs response body fully closes).
 *
 * Bounds: ElevenLabs concurrent connections per turn, plus wasted work
 * if the user clicks Stop. The mux's write-coordinator enforces playback
 * order regardless, so this is purely a throttle. 3 deep gives plenty of
 * head start for the cascade.
 */
const MAX_INFLIGHT_TTS = 3

type WorkletInbound =
  | { type: 'ready'; sampleRate: number }
  | { type: 'speech_started'; timestamp: number; rms: number }
  | { type: 'silence_started'; timestamp: number; rms: number }
  | {
      type: 'audio_chunk'
      samples: Float32Array
      isPreRoll: boolean
      sequence: number
    }
  | { type: 'error'; message: string; fatal: boolean }

class VoiceError extends Error {
  kind: VoiceSessionErrorKind
  recoverable: boolean
  substep?: 'stt' | 'claude' | 'tts'
  constructor(
    kind: VoiceSessionErrorKind,
    message: string,
    recoverable: boolean,
    substep?: 'stt' | 'claude' | 'tts',
  ) {
    super(message)
    this.kind = kind
    this.recoverable = recoverable
    this.substep = substep
  }
}

function toVoiceError(
  err: unknown,
  fallbackKind: VoiceSessionErrorKind,
  substep?: 'stt' | 'claude' | 'tts',
): VoiceSessionError {
  if (err instanceof VoiceError) {
    return {
      kind: err.kind,
      message: err.message,
      recoverable: err.recoverable,
      substep: err.substep ?? substep,
      originalError: err,
    }
  }
  const message = err instanceof Error ? err.message : String(err)
  return {
    kind: fallbackKind,
    message,
    recoverable: true,
    substep,
    originalError: err,
  }
}

function mergeFloat32(chunks: Float32Array[]): Float32Array {
  let total = 0
  for (const c of chunks) total += c.length
  const out = new Float32Array(total)
  let pos = 0
  for (const c of chunks) {
    out.set(c, pos)
    pos += c.length
  }
  return out
}

export interface VadControllerOptions {
  boardId: string
  connectionContext: string
  nodeContent: string
  /** Optional pre-spoken assistant turn, e.g. the opening insight. */
  initialAssistantMessage?: string
  /** Override the singleton store (useful for tests / multi-session). */
  store?: VoiceSessionStore
}

export class VadController {
  private readonly store: VoiceSessionStore
  private readonly opts: VadControllerOptions
  private readonly logger: VoiceSessionLogger

  private audioContext: AudioContext | null = null
  private mediaStream: MediaStream | null = null
  private workletNode: AudioWorkletNode | null = null
  private sourceNode: MediaStreamAudioSourceNode | null = null

  private silenceTimer: number | null = null
  private chunkAccumulator: Float32Array[] = []
  private lastSequence = -1

  private currentTurnAbort: AbortController | null = null
  private pcmMultiplexer: PcmMultiplexer | null = null

  private messages: ConversationMessage[] = []

  private teardownInProgress = false

  constructor(opts: VadControllerOptions) {
    this.opts = opts
    this.store = opts.store ?? voiceSessionStore
    this.logger = createVoiceSessionLogger({
      scope: 'voice-session',
      boardId: opts.boardId,
    })
    if (opts.initialAssistantMessage) {
      this.messages.push({
        role: 'assistant',
        content: opts.initialAssistantMessage,
      })
    }
  }

  /**
   * Open the session. Transitions store idle → initializing →
   * assistant_speaking on success (Claude opens the conversation
   * unprompted), or → error on failure. Throws nothing; surface errors
   * through the store.
   */
  async start(): Promise<void> {
    this.store.userClickedSpeak()
    const sessionId = this.store.getState().sessionId ?? ''

    this.logger.event(
      'voice.session.started',
      'success',
      { boardId: this.opts.boardId },
      { correlationId: sessionId },
    )

    try {
      await this.setupAudioPipeline()
      this.store.initComplete()
      this.logger.event(
        'voice.session.ready',
        'success',
        { sampleRate: this.audioContext?.sampleRate ?? null },
        { correlationId: sessionId },
      )
      this.kickOffOpeningTurn()
    } catch (err) {
      const vErr = toVoiceError(err, 'unknown')
      this.logger.event(
        'voice.session.init_failed',
        'failed',
        { kind: vErr.kind, message: vErr.message },
        { correlationId: sessionId },
      )
      this.store.initFailed(vErr)
      this.teardownSession()
    }
  }

  /**
   * User clicked the stop button. Behavior depends on the current
   * status: cuts a user turn early, or interrupts assistant playback.
   * No-op when not in a state that supports it.
   */
  userClickedStop(): void {
    const state = this.store.getState()
    if (state.status === 'user_speaking') {
      this.cancelSilenceTimer()
      this.sendToWorklet({ type: 'stop' })
      this.store.userClickedStop()
      this.store.setSubstep('stt')
      this.logger.event(
        'voice.turn.user_ended',
        'success',
        { source: 'user_clicked_stop' },
        {
          correlationId: state.turnId ?? undefined,
          parentCorrelationId: state.sessionId ?? undefined,
        },
      )
      void this.processUserTurn()
    } else if (state.status === 'assistant_speaking') {
      // Order matters: abort producers (Claude SSE + N in-flight TTS
      // fetches all share the same turn-level signal) BEFORE stopping
      // the multiplexer, so no new PCM arrives mid-teardown.
      if (this.currentTurnAbort) {
        this.currentTurnAbort.abort()
        this.currentTurnAbort = null
      }
      this.pcmMultiplexer?.stop()
      this.pcmMultiplexer = null
      this.store.userClickedStop()
      this.rearmWorklet()
      this.logger.event(
        'voice.turn.interrupted',
        'success',
        { source: 'user_clicked_stop' },
        {
          correlationId: state.turnId ?? undefined,
          parentCorrelationId: state.sessionId ?? undefined,
        },
      )
    }
  }

  /**
   * User closed the session (or pressed Esc). Tears everything down and
   * returns the store to idle from any state.
   */
  userClickedClose(): void {
    const state = this.store.getState()
    const correlationIds = {
      correlationId: state.turnId ?? undefined,
      parentCorrelationId: state.sessionId ?? undefined,
    }
    if (state.status === 'idle') return

    if (state.status === 'initializing') {
      this.store.userClickedCancel()
    } else if (state.status === 'error') {
      this.store.userClickedDismiss()
    } else {
      this.store.userClickedClose()
    }

    this.logger.event('voice.session.ended', 'success', undefined, correlationIds)
    this.teardownSession()
  }

  /** User clicked retry on the error UI. Re-runs initialization. */
  async userClickedRetry(): Promise<void> {
    const state = this.store.getState()
    if (state.status !== 'error') return
    const sessionId = state.sessionId ?? ''
    this.store.userClickedRetry()
    this.logger.event(
      'voice.session.retry',
      'success',
      undefined,
      { correlationId: sessionId },
    )
    try {
      await this.setupAudioPipeline()
      this.store.initComplete()
      this.kickOffOpeningTurn()
    } catch (err) {
      const vErr = toVoiceError(err, 'unknown')
      this.logger.event(
        'voice.session.init_failed',
        'failed',
        { kind: vErr.kind, message: vErr.message },
        { correlationId: sessionId },
      )
      this.store.initFailed(vErr)
      this.teardownSession()
    }
  }

  /**
   * Log voice.turn.started for the opening (initComplete just generated
   * the turnId) and fire-and-forget the opening turn. Shared by start()
   * and userClickedRetry() so retry doesn't accidentally diverge.
   */
  private kickOffOpeningTurn(): void {
    const state = this.store.getState()
    const correlationIds = {
      correlationId: state.turnId ?? undefined,
      parentCorrelationId: state.sessionId ?? undefined,
    }
    this.logger.event(
      'voice.turn.started',
      'success',
      { isOpening: true },
      correlationIds,
    )
    void this.runOpeningTurn()
  }

  // ------- setup -------

  private async setupAudioPipeline(): Promise<void> {
    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
        },
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      throw new VoiceError('mic_denied', `getUserMedia failed: ${message}`, true)
    }
    this.mediaStream = stream

    for (const track of stream.getAudioTracks()) {
      track.addEventListener('ended', () => this.handleMicLost())
    }

    let ctx: AudioContext
    try {
      ctx = new AudioContext()
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      throw new VoiceError(
        'audio_context_failed',
        `AudioContext construction failed: ${message}`,
        true,
      )
    }
    this.audioContext = ctx

    ctx.addEventListener('statechange', () => this.handleAudioContextStateChange())

    if (ctx.state === 'suspended') {
      try {
        await ctx.resume()
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        throw new VoiceError(
          'audio_context_failed',
          `AudioContext.resume failed: ${message}`,
          true,
        )
      }
    }
    if (ctx.state !== 'running') {
      throw new VoiceError(
        'audio_context_suspended',
        `AudioContext stuck in state ${ctx.state}`,
        false,
      )
    }

    try {
      await ctx.audioWorklet.addModule(WORKLET_URL)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      throw new VoiceError(
        'worklet_load_failed',
        `addModule(${WORKLET_URL}) failed: ${message}`,
        true,
      )
    }

    const node = new AudioWorkletNode(ctx, WORKLET_PROCESSOR_NAME, {
      channelCount: 1,
      channelCountMode: 'explicit',
      numberOfInputs: 1,
      numberOfOutputs: 0,
    })
    this.workletNode = node

    await this.waitForWorkletReady(node, WORKLET_READY_TIMEOUT_MS)

    // After 'ready', swap in the long-lived handler.
    node.port.onmessage = (e) => this.handleWorkletMessage(e.data as WorkletInbound)

    node.port.postMessage({
      type: 'configure',
      rmsThreshold: VAD_RMS_THRESHOLD,
      minSpeechDurationMs: VAD_MIN_SPEECH_DURATION_MS,
      preRollMs: VAD_PRE_ROLL_MS,
    })
    this.logger.event(
      'voice.vad.config_applied',
      'success',
      {
        rmsThreshold: VAD_RMS_THRESHOLD,
        minSpeechDurationMs: VAD_MIN_SPEECH_DURATION_MS,
        preRollMs: VAD_PRE_ROLL_MS,
      },
      { correlationId: this.store.getState().sessionId ?? undefined },
    )

    const source = ctx.createMediaStreamSource(stream)
    source.connect(node)
    this.sourceNode = source

    // No 'start' yet. The worklet stays passive while Claude delivers
    // the opening turn; rearmWorklet() activates VAD once the opening
    // playback ends (or is interrupted via userClickedStop).
  }

  private waitForWorkletReady(
    node: AudioWorkletNode,
    timeoutMs: number,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        node.port.onmessage = null
        reject(
          new VoiceError(
            'worklet_init_timeout',
            `worklet did not emit 'ready' within ${timeoutMs}ms`,
            false,
          ),
        )
      }, timeoutMs)

      node.port.onmessage = (e) => {
        const msg = e.data as WorkletInbound
        if (msg.type === 'ready') {
          window.clearTimeout(timer)
          this.logger.event(
            'voice.vad.worklet_ready',
            'success',
            { sampleRate: msg.sampleRate },
            { correlationId: this.store.getState().sessionId ?? undefined },
          )
          resolve()
        } else if (msg.type === 'error' && msg.fatal) {
          window.clearTimeout(timer)
          reject(
            new VoiceError('worklet_runtime_error', msg.message, false),
          )
        }
      }
    })
  }

  // ------- worklet message handling -------

  private handleWorkletMessage(msg: WorkletInbound): void {
    switch (msg.type) {
      case 'ready':
        // Handled by waitForWorkletReady; ignore duplicates.
        return
      case 'speech_started':
        this.handleSpeechStarted(msg.rms)
        return
      case 'silence_started':
        this.handleSilenceStarted(msg.rms)
        return
      case 'audio_chunk':
        this.handleAudioChunk(msg.samples, msg.isPreRoll, msg.sequence)
        return
      case 'error':
        if (msg.fatal) {
          this.handleFatal({
            kind: 'worklet_runtime_error',
            message: msg.message,
            recoverable: false,
          })
        }
        return
    }
  }

  private handleSpeechStarted(rms: number): void {
    this.cancelSilenceTimer()
    const state = this.store.getState()
    if (state.status === 'listening') {
      this.store.vadSpeechStarted()
      this.chunkAccumulator = []
      this.lastSequence = -1
      const next = this.store.getState()
      this.logger.event(
        'voice.turn.started',
        'success',
        { rms },
        {
          correlationId: next.turnId ?? undefined,
          parentCorrelationId: next.sessionId ?? undefined,
        },
      )
      this.logger.event(
        'voice.vad.speech_started',
        'success',
        { rms },
        {
          correlationId: next.turnId ?? undefined,
          parentCorrelationId: next.sessionId ?? undefined,
        },
      )
      return
    }
    // user_speaking re-trigger after a brief dip — verbose only
    this.logger.event(
      'voice.vad.speech_started',
      'success',
      { rms, note: 'mid-turn' },
      {
        correlationId: state.turnId ?? undefined,
        parentCorrelationId: state.sessionId ?? undefined,
      },
    )
    // Other states (processing_user_turn, assistant_speaking): no
    // barge-in in v1. Worklet should be stopped during those states
    // anyway; if a message slips through, ignore it.
  }

  private handleSilenceStarted(rms: number): void {
    const state = this.store.getState()
    if (state.status !== 'user_speaking') return
    this.startSilenceTimer()
    this.logger.event(
      'voice.vad.silence_started',
      'success',
      { rms },
      {
        correlationId: state.turnId ?? undefined,
        parentCorrelationId: state.sessionId ?? undefined,
      },
    )
    this.logger.event(
      'voice.vad.silence_timer_started',
      'success',
      { delayMs: SILENCE_TIMER_MS },
      {
        correlationId: state.turnId ?? undefined,
        parentCorrelationId: state.sessionId ?? undefined,
      },
    )
  }

  private handleAudioChunk(
    samples: Float32Array,
    isPreRoll: boolean,
    sequence: number,
  ): void {
    const expected = this.lastSequence + 1
    if (sequence !== expected) {
      const state = this.store.getState()
      this.logger.event(
        'voice.vad.chunk_sequence_gap',
        'failed',
        { expected, got: sequence },
        {
          correlationId: state.turnId ?? undefined,
          parentCorrelationId: state.sessionId ?? undefined,
        },
      )
      this.handleFatal({
        kind: 'audio_stream_corruption',
        message: `chunk sequence gap: expected ${expected}, got ${sequence}`,
        recoverable: false,
      })
      return
    }
    this.lastSequence = sequence
    this.chunkAccumulator.push(samples)
    const state = this.store.getState()
    this.logger.event(
      'voice.vad.chunk_received',
      'success',
      { sequence, isPreRoll, samples: samples.length },
      {
        correlationId: state.turnId ?? undefined,
        parentCorrelationId: state.sessionId ?? undefined,
      },
    )
  }

  // ------- silence timer & turn processing -------

  private startSilenceTimer(): void {
    this.cancelSilenceTimer()
    this.silenceTimer = window.setTimeout(() => {
      this.silenceTimer = null
      const state = this.store.getState()
      if (state.status !== 'user_speaking') return
      this.logger.event(
        'voice.vad.silence_timer_expired',
        'success',
        undefined,
        {
          correlationId: state.turnId ?? undefined,
          parentCorrelationId: state.sessionId ?? undefined,
        },
      )
      this.sendToWorklet({ type: 'stop' })
      this.store.vadSpeechEnded()
      this.store.setSubstep('stt')
      void this.processUserTurn()
    }, SILENCE_TIMER_MS)
  }

  private cancelSilenceTimer(): void {
    if (this.silenceTimer === null) return
    window.clearTimeout(this.silenceTimer)
    this.silenceTimer = null
    const state = this.store.getState()
    this.logger.event(
      'voice.vad.silence_timer_cancelled',
      'success',
      undefined,
      {
        correlationId: state.turnId ?? undefined,
        parentCorrelationId: state.sessionId ?? undefined,
      },
    )
  }

  private async processUserTurn(): Promise<void> {
    const initialState = this.store.getState()
    if (initialState.status !== 'processing_user_turn') return

    const sessionId = initialState.sessionId ?? ''
    const turnId = initialState.turnId ?? ''
    const correlationIds = { correlationId: turnId, parentCorrelationId: sessionId }

    const sampleRate = this.audioContext?.sampleRate ?? 48000
    const merged = mergeFloat32(this.chunkAccumulator)
    this.chunkAccumulator = []
    this.lastSequence = -1

    if (merged.length === 0) {
      this.logger.event(
        'voice.stt.empty_result',
        'skipped',
        { reason: 'no_audio_captured' },
        correlationIds,
      )
      this.store.sttReturnedEmpty()
      this.rearmWorklet()
      return
    }

    const wav = encodeWav(merged, sampleRate)
    this.logger.event(
      'voice.stt.upload_started',
      'success',
      { sizeBytes: wav.size, samples: merged.length, sampleRate },
      correlationIds,
    )

    const abort = new AbortController()
    this.currentTurnAbort = abort

    let sttResult: TranscribeAudioOutput
    try {
      sttResult = await transcribeAudio({ audioBlob: wav, recordingId: turnId })
      if (abort.signal.aborted) return
    } catch (err) {
      if (abort.signal.aborted) return
      const vErr = toVoiceError(err, 'stt_failed', 'stt')
      this.logger.event(
        'voice.stt.failed',
        'failed',
        { error: vErr.message },
        correlationIds,
      )
      this.store.sttFailed(vErr)
      this.teardownSession()
      return
    }

    this.logger.event(
      'voice.stt.response_received',
      'success',
      {
        transcriptLength: sttResult.transcript.length,
        durationMs: sttResult.durationMs,
      },
      correlationIds,
    )

    const transcript = sttResult.transcript.trim()
    const wordCount = transcript.split(/\s+/).filter(Boolean).length
    if (!transcript) {
      this.logger.event('voice.stt.empty_result', 'skipped', undefined, correlationIds)
      this.store.sttReturnedEmpty()
      this.logger.event(
        'voice.turn.rejected',
        'skipped',
        { reason: 'empty_transcript' },
        correlationIds,
      )
      this.rearmWorklet()
      return
    }
    if (sttResult.durationMs < STT_MIN_DURATION_MS || wordCount < STT_MIN_WORDS) {
      this.logger.event(
        'voice.stt.short_result',
        'skipped',
        { transcript, durationMs: sttResult.durationMs, wordCount },
        correlationIds,
      )
      this.store.sttReturnedTooShort()
      this.logger.event(
        'voice.turn.rejected',
        'skipped',
        { reason: 'short_transcript', durationMs: sttResult.durationMs, wordCount },
        correlationIds,
      )
      this.rearmWorklet()
      return
    }

    // Claude → segmenter → N TTS fetches → multiplexer (sentence-chunked).
    // setSubstep('claude') first so the substep telemetry covers the
    // Claude-streaming portion of the cascade; setSubstep('tts') flips
    // once the first sentence has been emitted to TTS (driven from the
    // helper, see below).
    this.store.setSubstep('claude')
    this.messages.push({ role: 'user', content: transcript })

    try {
      await this.runSentenceChunkedSpeech({
        turnId,
        abort,
        claudeMessages: this.messages,
        isOpening: false,
        correlationIds,
      })
    } catch (err) {
      if (abort.signal.aborted) return
      const vErr = toVoiceError(err, 'tts_failed', 'tts')
      if (vErr.kind === 'claude_failed') {
        this.logger.event(
          'voice.turn.claude_failed',
          'failed',
          { error: vErr.message },
          correlationIds,
        )
        this.store.claudeFailed(vErr)
      } else {
        this.logger.event(
          'voice.turn.tts_failed',
          'failed',
          { error: vErr.message },
          correlationIds,
        )
        this.store.ttsFailed(vErr)
      }
      this.teardownSession()
    }
  }

  /**
   * Drive the opening turn through the sentence-chunked cascade. State
   * is already `assistant_speaking` from initComplete; the helper's
   * voice.mux.first_audio handler is a no-op for that state.
   *
   * Failures use handleFatal because the opening never enters
   * processing_user_turn, so claudeFailed/ttsFailed (which require it)
   * would throw.
   */
  private async runOpeningTurn(): Promise<void> {
    const initialState = this.store.getState()
    if (initialState.status !== 'assistant_speaking') return

    const sessionId = initialState.sessionId ?? ''
    const turnId = initialState.turnId ?? ''
    const correlationIds = { correlationId: turnId, parentCorrelationId: sessionId }

    const abort = new AbortController()
    this.currentTurnAbort = abort

    try {
      // Anthropic Messages API rejects an empty messages array. Send a
      // synthetic "Begin." user turn as a programmatic trigger; role.txt
      // tells Claude to ignore it and open with its observation. The
      // orchestrator's hasPriorAssistant check stays false (no assistant
      // message yet), so cadence-opening.txt still drives the response.
      await this.runSentenceChunkedSpeech({
        turnId,
        abort,
        claudeMessages: [{ role: 'user', content: 'Begin.' }],
        isOpening: true,
        correlationIds,
      })
    } catch (err) {
      if (abort.signal.aborted) return
      const vErr = toVoiceError(err, 'tts_failed', 'tts')
      const phase =
        vErr.kind === 'claude_failed'
          ? 'voice.turn.claude_failed'
          : 'voice.turn.tts_failed'
      this.logger.event(
        phase,
        'failed',
        { error: vErr.message, isOpening: true },
        correlationIds,
      )
      this.handleFatal(vErr)
    }
  }

  /**
   * Sentence-chunked speech pipeline. Replaces the old
   * accumulate-then-fire-one-TTS waterfall.
   *
   * Flow:
   *   1. Create a per-turn segmenter and PcmMultiplexer; start the mux.
   *   2. Stream Claude (with abort signal threaded into the fetch).
   *   3. For each chunk: push into segmenter; for every complete sentence,
   *      queue it; the firing pump drains the queue under MAX_INFLIGHT_TTS
   *      concurrency. Each fired sentence's PCM stream is handed to the
   *      mux via addSegment(seq, stream).
   *   4. When Claude completes: segmenter.flush() emits the final sentence
   *      (whose terminating period had no trailing whitespace, so the
   *      segmenter held it back). Critical — without flush(), every turn
   *      silently drops its last sentence.
   *   5. Wait for the pending queue + all fetches to settle, then signal
   *      mux.endOfSegments() so it knows when to fire voice.mux.complete.
   *   6. Await muxPromise (sink consume loop finishes when the merged
   *      stream closes).
   *
   * Abort: the turn-level AbortController is threaded into every fetch
   * (Claude SSE + N fetchTtsStream calls). One abort() cascades to all.
   * mux.stop() is the caller's responsibility (teardownSession does it).
   *
   * Failure: any TTS fetch error or voice.mux.error sets storedError,
   * triggers abort(), and the helper throws after the drain unblocks.
   * Caller dispatches the store transition.
   */
  private async runSentenceChunkedSpeech(args: {
    turnId: string
    abort: AbortController
    claudeMessages: ConversationMessage[]
    isOpening: boolean
    correlationIds: { correlationId: string; parentCorrelationId: string }
  }): Promise<void> {
    const { turnId, abort, claudeMessages, isOpening, correlationIds } = args

    const segmenter = createSentenceSegmenter()
    const pending: string[] = []
    const activeSegments = new Set<number>()
    let nextSeq = 0
    let storedError: VoiceError | null = null
    let claudeComplete = false
    let ttsSubstepEntered = false

    let drainResolve: (() => void) | null = null
    const drainPromise = new Promise<void>((resolve) => {
      drainResolve = resolve
    })

    const unblockDrain = (): void => {
      if (drainResolve) {
        const r = drainResolve
        drainResolve = null
        r()
      }
    }

    const checkDrain = (): void => {
      if (
        claudeComplete &&
        pending.length === 0 &&
        activeSegments.size === 0
      ) {
        unblockDrain()
      }
    }

    const recordTtsFailure = (seq: number, err: unknown): void => {
      if (storedError !== null) return
      const message = err instanceof Error ? err.message : String(err)
      storedError = new VoiceError('tts_failed', message, true, 'tts')
      this.logger.event(
        'voice.tts.segment_failed',
        'failed',
        { sequence: seq, error: message },
        correlationIds,
      )
      abort.abort()
      unblockDrain()
    }

    const fireTts = async (seq: number, text: string): Promise<void> => {
      // Flip the substep telemetry once we know TTS work is active.
      // (Follow-up turn only — the opening doesn't track substeps.)
      if (!isOpening && !ttsSubstepEntered) {
        ttsSubstepEntered = true
        this.store.setSubstep('tts')
      }
      this.logger.event(
        'voice.tts.segment_requested',
        'success',
        { sequence: seq, textLength: text.length },
        correlationIds,
      )
      try {
        const stream = await fetchTtsStream({
          text,
          playbackId: turnId,
          signal: abort.signal,
        })
        if (abort.signal.aborted) {
          activeSegments.delete(seq)
          checkDrain()
          return
        }
        mux.addSegment(seq, stream)
        // activeSegments stays — removed on voice.mux.segment_drained.
      } catch (err) {
        activeSegments.delete(seq)
        if (abort.signal.aborted) {
          checkDrain()
          return
        }
        recordTtsFailure(seq, err)
        checkDrain()
      }
    }

    const tryFireNext = (): void => {
      while (
        pending.length > 0 &&
        activeSegments.size < MAX_INFLIGHT_TTS &&
        storedError === null &&
        !abort.signal.aborted
      ) {
        const sentence = pending.shift()!
        const seq = nextSeq++
        activeSegments.add(seq)
        void fireTts(seq, sentence)
      }
    }

    const handleMuxEvent = (event: MuxEvent): void => {
      switch (event.type) {
        case 'voice.mux.first_audio': {
          // Follow-up: drives processing_user_turn → assistant_speaking.
          // Opening: state is already assistant_speaking — no transition.
          if (this.store.getState().status === 'processing_user_turn') {
            this.store.firstAudioChunkArrived()
          }
          this.logger.event(
            'voice.turn.processing_complete',
            'success',
            {
              scheduledLatencyMs: event.scheduledLatencyMs,
              audibleLatencyMs: event.audibleLatencyMs,
              isOpening,
            },
            correlationIds,
          )
          return
        }
        case 'voice.mux.complete': {
          if (this.store.getState().status === 'assistant_speaking') {
            this.store.playbackEndedNaturally()
            this.logger.event(
              'voice.turn.completed',
              'success',
              { isOpening },
              correlationIds,
            )
            this.pcmMultiplexer = null
            this.rearmWorklet()
          }
          return
        }
        case 'voice.mux.segment_drained': {
          activeSegments.delete(event.sequence)
          tryFireNext()
          checkDrain()
          return
        }
        case 'voice.mux.underrun': {
          // Fail-loud: indicates the sink ran out of samples mid-playback
          // with segments still pending. Should never happen on the normal
          // path; if it fires, the pipeline starved.
          this.logger.event(
            'voice.mux.underrun',
            'failed',
            { sequence: event.sequence, phase: event.phase },
            correlationIds,
          )
          return
        }
        case 'voice.mux.handoff_stall': {
          // Fail-loud: previous segment drained but the next wasn't yet at
          // the prebuffer floor — Claude/ElevenLabs was slow. Audio gapped.
          this.logger.event(
            'voice.mux.handoff_stall',
            'failed',
            { sequence: event.sequence, waitMs: event.waitMs },
            correlationIds,
          )
          return
        }
        case 'voice.mux.error': {
          this.logger.event(
            'voice.mux.error',
            'failed',
            {
              sequence: event.sequence,
              phase: event.phase,
              error: event.error,
            },
            correlationIds,
          )
          if (storedError === null) {
            storedError = new VoiceError(
              'tts_failed',
              event.error || event.phase,
              true,
              'tts',
            )
            abort.abort()
            unblockDrain()
          }
          return
        }
        // segment_added / segment_ready / segment_writing — internal
        // lifecycle; intentionally not logged at the controller level.
        default:
          return
      }
    }

    const abortListener = (): void => unblockDrain()
    abort.signal.addEventListener('abort', abortListener, { once: true })
    const cleanupAbortListener = (): void => {
      abort.signal.removeEventListener('abort', abortListener)
    }

    const mux = new PcmMultiplexer({
      playbackId: turnId,
      onEvent: handleMuxEvent,
    })
    this.pcmMultiplexer = mux
    const muxPromise = mux.start()
    // We await muxPromise at the end of the success path; mark it handled
    // pre-emptively so a rejection during the Claude phase doesn't trip
    // an unhandled-rejection warning. The actual throw still surfaces via
    // the later await.
    muxPromise.catch(() => {
      /* swallowed here; re-surfaced via await below or via storedError */
    })

    let assistantText = ''
    try {
      for await (const chunk of runConversationTurn({
        connectionContext: this.opts.connectionContext,
        nodeContent: this.opts.nodeContent,
        messages: claudeMessages,
        signal: abort.signal,
      })) {
        if (abort.signal.aborted) break
        assistantText += chunk
        const sentences = segmenter.push(chunk)
        if (sentences.length > 0) {
          pending.push(...sentences)
          tryFireNext()
        }
      }
    } catch (err) {
      cleanupAbortListener()
      if (storedError !== null) throw storedError
      if (abort.signal.aborted) return
      const message = err instanceof Error ? err.message : String(err)
      throw new VoiceError('claude_failed', message, true, 'claude')
    }

    // Claude stream completed (or aborted with no stored TTS error).
    // Persist the assistant message before the late checks so that, as
    // today, a TTS failure that lands after Claude finished still leaves
    // the assistant turn in conversation history.
    if (assistantText.length > 0) {
      this.messages.push({ role: 'assistant', content: assistantText })
    }

    if (storedError !== null) {
      cleanupAbortListener()
      throw storedError
    }
    if (abort.signal.aborted) {
      cleanupAbortListener()
      return
    }

    // CRITICAL: flush() emits the final sentence the segmenter has held
    // back because its terminating period had no trailing whitespace to
    // confirm the boundary. Without this, the last sentence of every
    // turn would be silently dropped.
    const trailing = segmenter.flush()
    if (trailing.length > 0) {
      pending.push(...trailing)
    }
    claudeComplete = true
    tryFireNext()
    checkDrain()

    await drainPromise

    if (storedError !== null) {
      cleanupAbortListener()
      throw storedError
    }
    if (abort.signal.aborted) {
      cleanupAbortListener()
      return
    }

    mux.endOfSegments()

    try {
      await muxPromise
    } catch (err) {
      cleanupAbortListener()
      if (storedError !== null) throw storedError
      if (abort.signal.aborted) return
      const message = err instanceof Error ? err.message : String(err)
      throw new VoiceError('tts_failed', message, true, 'tts')
    }

    cleanupAbortListener()
    if (storedError !== null) throw storedError
  }

  // ------- helpers -------

  private rearmWorklet(): void {
    if (!this.workletNode) return
    this.chunkAccumulator = []
    this.lastSequence = -1
    this.workletNode.port.postMessage({ type: 'start' })
  }

  private sendToWorklet(message: { type: 'start' } | { type: 'stop' }): void {
    if (!this.workletNode) return
    try {
      this.workletNode.port.postMessage(message)
    } catch {
      // Port may be closed during teardown; safe to ignore.
    }
  }

  private handleFatal(error: VoiceSessionError): void {
    const state = this.store.getState()
    const correlationIds = {
      correlationId: state.turnId ?? undefined,
      parentCorrelationId: state.sessionId ?? undefined,
    }
    this.logger.event(
      'voice.session.error',
      'failed',
      { kind: error.kind, message: error.message },
      correlationIds,
    )
    try {
      this.store.fatalError(error)
    } catch {
      // If we're somehow in a state that doesn't accept fatalError,
      // fall back to a synthetic init failure so the UI shows the error.
    }
    this.teardownSession()
  }

  private handleMicLost(): void {
    const state = this.store.getState()
    if (state.status === 'idle' || state.status === 'error') return
    this.handleFatal({
      kind: 'mic_lost',
      message: 'Microphone track ended unexpectedly',
      recoverable: false,
    })
  }

  private handleAudioContextStateChange(): void {
    const ctx = this.audioContext
    if (!ctx) return
    if (ctx.state === 'suspended') {
      // Try to resume; if it fails, treat as fatal.
      ctx.resume().catch(() => {
        const state = this.store.getState()
        if (state.status === 'idle' || state.status === 'error') return
        this.handleFatal({
          kind: 'audio_context_lost',
          message: 'AudioContext suspended and resume failed',
          recoverable: false,
        })
      })
    } else if (ctx.state === 'closed') {
      const state = this.store.getState()
      if (state.status === 'idle' || state.status === 'error') return
      this.handleFatal({
        kind: 'audio_context_lost',
        message: 'AudioContext closed unexpectedly',
        recoverable: false,
      })
    }
  }

  private teardownSession(): void {
    if (this.teardownInProgress) return
    this.teardownInProgress = true

    this.cancelSilenceTimer()

    if (this.currentTurnAbort) {
      this.currentTurnAbort.abort()
      this.currentTurnAbort = null
    }

    if (this.pcmMultiplexer) {
      try {
        this.pcmMultiplexer.stop()
      } catch {
        // ignore
      }
      this.pcmMultiplexer = null
    }

    if (this.workletNode) {
      try {
        this.workletNode.port.postMessage({ type: 'stop' })
      } catch {
        // ignore
      }
      this.workletNode.port.onmessage = null
      try {
        this.workletNode.disconnect()
      } catch {
        // ignore
      }
      this.workletNode = null
    }

    if (this.sourceNode) {
      try {
        this.sourceNode.disconnect()
      } catch {
        // ignore
      }
      this.sourceNode = null
    }

    if (this.audioContext && this.audioContext.state !== 'closed') {
      this.audioContext.close().catch(() => {
        // ignore
      })
    }
    this.audioContext = null

    if (this.mediaStream) {
      for (const track of this.mediaStream.getTracks()) {
        try {
          track.stop()
        } catch {
          // ignore
        }
      }
      this.mediaStream = null
    }

    this.chunkAccumulator = []
    this.lastSequence = -1
    this.teardownInProgress = false
  }
}
