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

import roleText from '../../../prompts/role.txt?raw'
import cadenceOpeningText from '../../../prompts/cadence-opening.txt?raw'
import { PcmMultiplexer, type MuxEvent } from './pcmMultiplexer'
import {
  runConversationTurn,
  type ConversationMessage,
} from './conversationOrchestrator'
import { buildSystemPrompt } from './buildSystemPrompt'
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
import { voiceSessionController } from './voiceSessionController'
import type { EndReason } from '../../persistence'
import { getLatestProfileSnapshot } from '../../persistence/profileSnapshots'
import { requireClient } from '../../persistence/session'
import type { Connection } from '../../api/claude'
import { embedText } from '../embeddingService'
import { computeRetrievalExclusions } from '../../utils/retrievalExclusions'
import {
  blendQueryVectors,
  buildRelatedMaterial,
  fetchRetrievalContext,
  filterUnseen,
  lookupEdgeQueryVector,
  RETRIEVAL_FLOOR,
} from './retrievalContext'

const WORKLET_URL = '/voice/vad-processor.js'
const WORKLET_PROCESSOR_NAME = 'vad-processor'
const WORKLET_READY_TIMEOUT_MS = 1000
const SILENCE_TIMER_MS = 1500
const VAD_RMS_THRESHOLD = 0.02
const VAD_MIN_SPEECH_DURATION_MS = 200
const VAD_MIN_SILENCE_DURATION_MS = 200
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
  | {
      type: 'silence_started'
      timestamp: number
      rms: number
      debouncedForMs: number
    }
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
  /**
   * Phase 10B: the anchor edge this session is centered on. Its identity drives
   * the opening-turn edge-vector lookup, and its endpoints are the anchors for
   * the retrieval exclusion set. Absent (e.g. a non-edge entry point, or a
   * Claude-derived connection) → retrieval is disabled for the session and the
   * RELATED MATERIAL section never appears.
   */
  anchorConnection?: Connection
  /**
   * Phase 10B: the full board connection list, for graph-adjacency exclusions
   * (`computeRetrievalExclusions`). Empty/absent → only the anchor endpoints
   * themselves are excluded.
   */
  connections?: Connection[]
  /**
   * Phase 10B retrieval v1: live board membership (bare client node ids) for
   * orphan-drop (migration 034). The RPC keeps only embedding rows whose node is
   * in this set. Sourced from the same in-memory graph as `connections`, but as
   * the FULL node list (isolated nodes included) — connections alone would miss
   * unconnected-but-live nodes. Absent → orphan-drop disabled (safe degrade).
   */
  liveNodeIds?: string[]
}

/**
 * Phase 8 turn-boundary timestamps for the most recently completed
 * (or in-progress) turn. Wall-clock ISO strings, suitable for direct
 * use in voice_utterances.started_at / ended_at.
 *
 * Lifecycle:
 *   - `user.speechStartedAt` is set when VAD transitions
 *     listening → user_speaking (a brand-new user turn). Re-triggers
 *     within an existing user_speaking turn don't overwrite it.
 *   - `user.speechEndedAt` is set when the 1.5s silence timer
 *     expires OR when the user clicks Stop while speaking. It's the
 *     moment the system commits to ending the turn (just before
 *     handing audio to STT).
 *   - `assistant.firstAudioAt` is set when voice.mux.first_audio
 *     fires — the moment the user begins hearing the response. Set
 *     on every assistant turn (opening and follow-up); each new turn
 *     clears `playbackEndedAt`.
 *   - `assistant.playbackEndedAt` is set when voice.mux.complete
 *     fires — the moment playback finishes naturally. Not set on
 *     interrupted playback (Stop during assistant_speaking).
 *
 * Read contract for Prompt B2:
 *   - User utterance: read `user` after STT returns transcript and
 *     before recordUtterance — both fields are guaranteed populated
 *     (speech_started fired earlier in this turn; speech_ended fired
 *     just before processUserTurn began).
 *   - Assistant utterance: read `assistant` inside the
 *     voice.mux.complete handler (or immediately after) — by then
 *     both fields are populated for the just-completed turn. Reading
 *     later risks the next user-speech-start firing first, but in
 *     practice rearmWorklet defers that to the next event loop tick.
 *
 * Each side is `null` when no boundary has fired for that role yet
 * in the session.
 */
export interface TurnTimestamps {
  user: { speechStartedAt: string; speechEndedAt: string } | null
  assistant: { firstAudioAt: string; playbackEndedAt: string } | null
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

  // ------- Phase 8 turn-boundary timestamps -------
  //
  // Wall-clock ISO timestamps captured at four boundaries Prompt B2's
  // voiceSessionController consumes for voice_utterances.started_at /
  // ended_at. Kept separate from the performance.now() ts fields on
  // logger / mux events; those drive latency math and stay unchanged.
  //
  // Lifetime of each pair is one user/assistant turn — set when the
  // boundary fires, never overwritten mid-turn (re-triggers within
  // user_speaking are ignored), reset implicitly when the next turn
  // begins. Reading them between turns sees the most recent completed
  // turn; B2 reads at the moment of recordUtterance and the values are
  // valid because the next-turn writer hasn't fired yet (see contract
  // in voiceSessionController.ts).
  private currentUserSpeechStartedAt: string | null = null
  private currentUserSpeechEndedAt: string | null = null
  private currentAssistantFirstAudioAt: string | null = null
  private currentAssistantPlaybackEndedAt: string | null = null

  // ------- Phase 10B retrieval state (session-local) -------
  //
  // Once-per-session novelty filter: a retrieved item (node or utterance ref
  // id) surfaces at most once per session. Tracked client-side because 10A's
  // RPC has no cross-turn memory and its exclusion array only covers the node
  // corpus — a post-RPC ref_id filter covers nodes and utterances uniformly.
  private readonly surfacedRefIds = new Set<string>()
  // The prior USER turn's RAW utterance embedding, carried for the follow-up
  // query blend (recency-weighted with the current turn). Null until the first
  // follow-up has been embedded — `blendQueryVectors` then weights the current
  // turn alone (the N-1-not-ready / first-follow-up fallback).
  private lastUserQueryEmbedding: number[] | null = null

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
   * Snapshot of the four Phase 8 turn-boundary timestamps. Pure read
   * — does not clear or mutate internal state. See TurnTimestamps
   * for the lifecycle and read contract.
   */
  getTurnTimestamps(): TurnTimestamps {
    const user =
      this.currentUserSpeechStartedAt && this.currentUserSpeechEndedAt
        ? {
            speechStartedAt: this.currentUserSpeechStartedAt,
            speechEndedAt: this.currentUserSpeechEndedAt,
          }
        : null
    const assistant =
      this.currentAssistantFirstAudioAt && this.currentAssistantPlaybackEndedAt
        ? {
            firstAudioAt: this.currentAssistantFirstAudioAt,
            playbackEndedAt: this.currentAssistantPlaybackEndedAt,
          }
        : null
    return { user, assistant }
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
      void this.kickOffOpeningTurn()
    } catch (err) {
      const vErr = toVoiceError(err, 'unknown')
      this.logger.event(
        'voice.session.init_failed',
        'failed',
        { kind: vErr.kind, message: vErr.message },
        { correlationId: sessionId },
      )
      this.store.initFailed(vErr)
      this.teardownSession('error')
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
      // Phase 8 boundary: user-initiated end-of-speech, same role as
      // the silence-timer expiry. Captured before the state mutation.
      this.currentUserSpeechEndedAt = new Date().toISOString()
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

    // Capture the persistence end reason before the state transition
    // erases the pre-close status. Dismissing the error UI ends the
    // session for the reason that actually closed it — the error.
    const endReason: EndReason = state.status === 'error' ? 'error' : 'user_closed'

    if (state.status === 'initializing') {
      this.store.userClickedCancel()
    } else if (state.status === 'error') {
      this.store.userClickedDismiss()
    } else {
      this.store.userClickedClose()
    }

    this.logger.event('voice.session.ended', 'success', undefined, correlationIds)
    this.teardownSession(endReason)
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
      void this.kickOffOpeningTurn()
    } catch (err) {
      const vErr = toVoiceError(err, 'unknown')
      this.logger.event(
        'voice.session.init_failed',
        'failed',
        { kind: vErr.kind, message: vErr.message },
        { correlationId: sessionId },
      )
      this.store.initFailed(vErr)
      this.teardownSession('error')
    }
  }

  /**
   * Fetch the latest profile snapshot (Phase 9), assemble the opening
   * system prompt, log voice.turn.started with the assembled prompt and
   * snapshot fields, and fire-and-forget the opening turn. Shared by
   * start() and userClickedRetry() so retry doesn't accidentally diverge.
   *
   * The snapshot fetch is best-effort: any failure (including a missing
   * Supabase client) is swallowed so the opening turn still proceeds
   * with the four-section prompt. Latency is recorded even on failure.
   */
  private async kickOffOpeningTurn(): Promise<void> {
    const state = this.store.getState()
    const correlationIds = {
      correlationId: state.turnId ?? undefined,
      parentCorrelationId: state.sessionId ?? undefined,
    }

    // Phase 9 snapshot fetch and Phase 10B retrieval run together so the added
    // latency is max(snapshot, retrieval), not their sum. Both are best-effort:
    // either failing degrades to its empty path, never blocks the opening turn.
    const fetchStartedAt = performance.now()
    const [snapshot, relatedMaterial] = await Promise.all([
      getLatestProfileSnapshot(requireClient()).catch((err) => {
        console.warn(
          '[VadController] profile snapshot fetch failed; opening turn will proceed without recentThinking:',
          err,
        )
        return null
      }),
      this.computeOpeningRelatedMaterial(),
    ])
    const snapshotFetchLatencyMs = Math.round(performance.now() - fetchStartedAt)

    const assembledSystemPrompt = buildSystemPrompt({
      role: roleText,
      cadence: cadenceOpeningText,
      recentThinking: snapshot?.narrative,
      connectionContext: this.opts.connectionContext,
      nodeContent: this.opts.nodeContent,
      relatedMaterial: relatedMaterial ?? undefined,
    })

    this.logger.event(
      'voice.turn.started',
      'success',
      {
        isOpening: true,
        snapshotId: snapshot?.id ?? null,
        assembledSystemPrompt,
        snapshotFetchLatencyMs,
        relatedMaterialPresent: Boolean(relatedMaterial),
      },
      correlationIds,
    )
    void this.runOpeningTurn(assembledSystemPrompt)
  }

  // ------- Phase 10B retrieval -------

  /**
   * Opening-turn related material. Query vector = the anchor edge's STORED
   * embedding (no Gemini call). Returns null — and the section is omitted —
   * when retrieval is disabled (no anchor connection), the edge has no
   * embedding yet (just-created, async write not landed), or nothing clears
   * the floor. Best-effort: never throws into the opening path.
   */
  private async computeOpeningRelatedMaterial(): Promise<string | null> {
    const conn = this.opts.anchorConnection
    if (!conn) return null
    try {
      const client = requireClient()
      const queryVector = await lookupEdgeQueryVector(client, this.opts.boardId, conn)
      if (!queryVector) return null
      return await this.runRetrieval(client, queryVector)
    } catch (err) {
      console.warn(
        '[VadController] opening retrieval failed; proceeding without relatedMaterial:',
        err,
      )
      return null
    }
  }

  /**
   * Shared retrieval tail (both turn types): compute the exclusion set, call
   * the 10A RPC, apply the once-per-session novelty filter, and assemble the
   * `relatedMaterial` block. Records what surfaced so it can't surface again.
   * Returns null when nothing clears the floor / survives the filter.
   */
  private async runRetrieval(
    client: ReturnType<typeof requireClient>,
    queryVector: number[],
  ): Promise<string | null> {
    const conn = this.opts.anchorConnection
    if (!conn) return null

    const excludedNodeIds = computeRetrievalExclusions(this.opts.connections ?? [], [
      conn.from,
      conn.to,
    ])

    // RPC returns the FULL ranked band (threshold 0); the floor is applied here,
    // client-side, so we can log the whole curve before cutting.
    const rows = await fetchRetrievalContext(client, {
      queryVector,
      boardId: this.opts.boardId,
      excludedNodeIds,
      // Live board membership for orphan-drop. Absent → null → orphan-drop
      // disabled (migration 034), never an empty array (which would drop all).
      liveNodeIds: this.opts.liveNodeIds ?? null,
    })

    // Diagnostic: the full returned band (scores) BEFORE the floor cut — so the
    // whole distribution is visible, not just survivors. Tune RETRIEVAL_FLOOR by
    // eye against this.
    const state = this.store.getState()
    this.logger.event(
      'voice.retrieval.band',
      'success',
      {
        floor: RETRIEVAL_FLOOR,
        excludedCount: excludedNodeIds.length,
        liveNodeCount: this.opts.liveNodeIds?.length ?? null,
        returned: rows.length,
        aboveFloor: rows.filter((r) => r.similarity >= RETRIEVAL_FLOOR).length,
        band: rows.map((r) => ({
          ref_id: r.ref_id,
          similarity: Number(r.similarity.toFixed(4)),
        })),
      },
      { correlationId: state.turnId ?? undefined, parentCorrelationId: state.sessionId ?? undefined },
    )

    // Apply the floor client-side, after logging, before novelty filtering.
    const floored = rows.filter((r) => r.similarity >= RETRIEVAL_FLOOR)

    const novel = filterUnseen(floored, this.surfacedRefIds)
    const block = buildRelatedMaterial(novel)
    if (block) {
      // The whole block is injected this turn → every novel row has surfaced.
      for (const r of novel) this.surfacedRefIds.add(r.ref_id)
    }
    return block
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
      minSilenceDurationMs: VAD_MIN_SILENCE_DURATION_MS,
      preRollMs: VAD_PRE_ROLL_MS,
    })
    this.logger.event(
      'voice.vad.config_applied',
      'success',
      {
        rmsThreshold: VAD_RMS_THRESHOLD,
        minSpeechDurationMs: VAD_MIN_SPEECH_DURATION_MS,
        minSilenceDurationMs: VAD_MIN_SILENCE_DURATION_MS,
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
        this.handleSilenceStarted(msg.rms, msg.debouncedForMs)
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
      // Capture the user turn's start timestamp before any state mutates.
      // Phase 8: consumed by voiceSessionController in Prompt B2.
      this.currentUserSpeechStartedAt = new Date().toISOString()
      this.currentUserSpeechEndedAt = null
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

  private handleSilenceStarted(rms: number, debouncedForMs: number): void {
    const state = this.store.getState()
    if (state.status !== 'user_speaking') return
    this.startSilenceTimer()
    this.logger.event(
      'voice.vad.silence_started',
      'success',
      { rms, debouncedForMs },
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
      // Phase 8 boundary: the moment the system commits to ending the
      // user's turn. Captured before the state machine transition so a
      // reader can rely on it being set by the time STT processing
      // starts.
      this.currentUserSpeechEndedAt = new Date().toISOString()
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
      this.teardownSession('error')
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

    // Phase 10B: embed the user transcript INLINE (blocking) before the turn
    // assembles. Double duty — this single vector is the retrieval query AND
    // the utterance row write, so there is no second Gemini call. Real in-app
    // embed latency is ~218–360ms, under the 500ms budget. On failure, degrade:
    // skip retrieval this turn and let the row write embed in the background as
    // before — never block the turn.
    let userEmbedding: number[] | null = null
    const embedStartedAt = performance.now()
    try {
      userEmbedding = await embedText(transcript)
    } catch (err) {
      console.warn(
        '[VadController] inline utterance embed failed; skipping retrieval this turn:',
        err,
      )
    }
    const embedMs = Math.round(performance.now() - embedStartedAt)
    if (abort.signal.aborted) return

    let relatedMaterial: string | null = null
    if (userEmbedding) {
      // Instrumentation (10A follow-up): BARE embed latency, captured before
      // the utterance row's background DB update, so the dev-script proxy is
      // confirmed against the real in-app number once voice runs for real.
      if (voiceSessionController.isActive()) {
        voiceSessionController.logEvent({
          phase: 'voice.embed.inline',
          outcome: 'success',
          ts: new Date().toISOString(),
          detail: { textLen: transcript.length, dims: userEmbedding.length },
          durationMs: embedMs,
          correlationId: turnId,
          parentCorrelationId: sessionId,
        })
      }
      // Query = recency-weighted blend of this turn and the prior USER turn.
      // No fall-back to the edge vector on follow-ups (that throws away drift).
      const queryVector = blendQueryVectors(userEmbedding, this.lastUserQueryEmbedding)
      // Carry the RAW current vector as next turn's prior (the blend is of raw
      // embeddings, never of prior blends).
      this.lastUserQueryEmbedding = userEmbedding
      try {
        relatedMaterial = await this.runRetrieval(requireClient(), queryVector)
      } catch (err) {
        console.warn(
          '[VadController] follow-up retrieval failed; proceeding without relatedMaterial:',
          err,
        )
      }
      if (abort.signal.aborted) return
    }

    // Phase 8: persist the user utterance. Fire-and-forget so the
    // Claude call doesn't wait on a Supabase round-trip; the controller
    // logs insert failures to processing_log and the session keeps
    // going. Timestamps come from B1's instrumentation — both fields
    // are populated by now (speech-start fired earlier in this turn,
    // speech-end fired just before processUserTurn began). Phase 10B: pass the
    // inline embedding so the row write reuses it (no second Gemini call).
    if (voiceSessionController.isActive()) {
      const ts = this.getTurnTimestamps()
      if (ts.user) {
        void voiceSessionController
          .recordUtterance({
            speaker: 'user',
            text: transcript,
            startedAt: ts.user.speechStartedAt,
            endedAt: ts.user.speechEndedAt,
            embedding: userEmbedding ?? undefined,
          })
          .catch((err) =>
            console.error(
              '[VadController] voiceSessionController.recordUtterance(user) failed:',
              err,
            ),
          )
      }
    }
    this.messages.push({ role: 'user', content: transcript })

    try {
      await this.runSentenceChunkedSpeech({
        turnId,
        abort,
        claudeMessages: this.messages,
        isOpening: false,
        correlationIds,
        relatedMaterial: relatedMaterial ?? undefined,
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
      this.teardownSession('error')
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
  private async runOpeningTurn(systemPrompt: string): Promise<void> {
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
        systemPrompt,
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
    /**
     * Phase 9: opening turn passes the pre-assembled prompt (assembled
     * upstream in kickOffOpeningTurn so the snapshot fetch can run and
     * the assembled string can be logged on voice.turn.started). Absent
     * on follow-up turns; the orchestrator assembles those itself.
     */
    systemPrompt?: string
    /**
     * Phase 10B per-turn retrieval block. Follow-up turns pass it here so it
     * threads into the orchestrator's own buildSystemPrompt call (it changes
     * every turn, so it can't be a fixed session option). Opening turns leave
     * it undefined — their relatedMaterial is already folded into
     * `systemPrompt` upstream, and the orchestrator ignores it when
     * `systemPrompt` is set.
     */
    relatedMaterial?: string
  }): Promise<void> {
    const { turnId, abort, claudeMessages, isOpening, correlationIds, systemPrompt, relatedMaterial } =
      args

    const segmenter = createSentenceSegmenter()
    const pending: string[] = []
    const activeSegments = new Set<number>()
    let nextSeq = 0
    let storedError: VoiceError | null = null
    let claudeComplete = false
    /**
     * Per-sequence diagnostic metadata for log enrichment ONLY. Lets us
     * surface the actual sentence text and fire timestamp on mux events
     * (mux itself sees bytes, not text). Pure logging state — does not
     * influence control flow.
     */
    const segMeta = new Map<number, { sentence: string; fireTs: number }>()
    /** Truncate sentence text for log output. */
    const truncateForLog = (s: string): string =>
      s.length > 200 ? `${s.slice(0, 200)}...` : s
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
      const fireTs = performance.now()
      segMeta.set(seq, { sentence: text, fireTs })
      this.logger.event(
        'voice.tts.segment_requested',
        'success',
        {
          sequence: seq,
          sentence: truncateForLog(text),
          textLength: text.length,
          queueDepthAtFire: pending.length,
          // Note: activeSegments.add(seq) already happened in tryFireNext
          // before this call, so activeSegments.size reflects "after fire".
          activeCountAfterFire: activeSegments.size,
        },
        correlationIds,
      )
      try {
        const stream = await fetchTtsStream({
          text,
          playbackId: turnId,
          signal: abort.signal,
        })
        if (abort.signal.aborted) {
          // Release the mux reservation — without this the
          // write-coordinator would wait forever for a segment that
          // will never arrive.
          mux.cancelReservation(seq)
          activeSegments.delete(seq)
          checkDrain()
          return
        }
        mux.addSegment(seq, stream)
        // activeSegments stays — removed on voice.mux.segment_drained.
      } catch (err) {
        mux.cancelReservation(seq)
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
        // Announce the reservation to the mux BEFORE any later-sequence
        // segment can be delivered. This is what prevents an out-of-order
        // TTS response from overtaking the writer slot.
        mux.expectSegment(seq)
        void fireTts(seq, sentence)
      }
    }

    /**
     * Wraps segmenter.push / segmenter.flush emissions with diagnostic
     * logging. Pure logging — the body is identical to inline
     * `pending.push(...sentences); tryFireNext()`, just with structured
     * events around it.
     *
     * Sentences emitted by the segmenter get a `candidateSequence`
     * (what they WILL receive at fire time) — sequences are actually
     * assigned by tryFireNext / fireTts. After firing, anything still
     * in `pending` is "queued because the cap is full" and gets its own
     * voice.tts.segment_queued event.
     */
    const ingestSentences = (
      sentences: string[],
      sourceCallType: 'push' | 'flush',
    ): void => {
      if (sentences.length === 0) return
      for (let i = 0; i < sentences.length; i++) {
        this.logger.event(
          'voice.segmenter.emitted',
          'success',
          {
            sentence: truncateForLog(sentences[i]),
            candidateSequence: nextSeq + pending.length + i,
            sourceCallType,
            batchIndex: i,
          },
          correlationIds,
        )
      }
      pending.push(...sentences)
      tryFireNext()
      // Anything in pending after tryFireNext that came from this batch
      // is queued-because-the-cap-was-full. Because tryFireNext fires
      // from the front of `pending`, the still-queued sentences from
      // THIS batch occupy the last `queuedCount` positions of `pending`.
      const queuedCount = Math.min(sentences.length, pending.length)
      const firedFromBatch = sentences.length - queuedCount
      for (let i = 0; i < queuedCount; i++) {
        const sentence = sentences[firedFromBatch + i]
        const positionInPending = pending.length - queuedCount + i
        this.logger.event(
          'voice.tts.segment_queued',
          'success',
          {
            sentence: truncateForLog(sentence),
            candidateSequence: nextSeq + positionInPending,
            queueDepth: pending.length,
            activeCount: activeSegments.size,
          },
          correlationIds,
        )
      }
    }

    const handleMuxEvent = (event: MuxEvent): void => {
      switch (event.type) {
        case 'voice.mux.first_audio': {
          // Phase 8 boundary: the moment the user begins hearing the
          // assistant's response. Captured here on every assistant
          // turn (opening and follow-up). The previous turn's value
          // is overwritten — see the contract note in
          // voiceSessionController.ts: Prompt B2 reads at the
          // playback-end moment, when both first_audio and
          // playback_end are guaranteed to belong to the same turn.
          this.currentAssistantFirstAudioAt = new Date().toISOString()
          this.currentAssistantPlaybackEndedAt = null
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
            // Phase 8 boundary: assistant utterance is fully audible.
            this.currentAssistantPlaybackEndedAt = new Date().toISOString()
            this.store.playbackEndedNaturally()
            this.logger.event(
              'voice.turn.completed',
              'success',
              { isOpening },
              correlationIds,
            )
            // Phase 8: record the just-completed assistant utterance.
            // assistantText is the full accumulated Claude response
            // (captured in this closure). Fire-and-forget so the
            // rearm doesn't wait on Supabase. Interrupted turns (Stop
            // during assistant_speaking) take the userClickedStop
            // branch and never reach this code — they're intentionally
            // not recorded.
            if (voiceSessionController.isActive() && assistantText.length > 0) {
              const ts = this.getTurnTimestamps()
              if (ts.assistant) {
                void voiceSessionController
                  .recordUtterance({
                    speaker: 'assistant',
                    text: assistantText,
                    startedAt: ts.assistant.firstAudioAt,
                    endedAt: ts.assistant.playbackEndedAt,
                  })
                  .catch((err) =>
                    console.error(
                      '[VadController] voiceSessionController.recordUtterance(assistant) failed:',
                      err,
                    ),
                  )
              }
            }
            this.pcmMultiplexer = null
            this.rearmWorklet()
          }
          return
        }
        case 'voice.mux.segment_added': {
          const meta = segMeta.get(event.sequence)
          const timeSinceFire =
            meta !== undefined ? performance.now() - meta.fireTs : null
          this.logger.event(
            'voice.mux.segment_added',
            'success',
            {
              sequence: event.sequence,
              sentence: meta ? truncateForLog(meta.sentence) : null,
              timeSinceFire,
            },
            correlationIds,
          )
          return
        }
        case 'voice.mux.segment_writing': {
          const meta = segMeta.get(event.sequence)
          this.logger.event(
            'voice.mux.segment_writing',
            'success',
            {
              sequence: event.sequence,
              sentence: meta ? truncateForLog(meta.sentence) : null,
              bytesStaged: event.bytesStaged,
              positionInPipeline: event.positionInPipeline,
            },
            correlationIds,
          )
          return
        }
        case 'voice.mux.segment_drained': {
          const meta = segMeta.get(event.sequence)
          this.logger.event(
            'voice.mux.segment_drained',
            'success',
            {
              sequence: event.sequence,
              sentence: meta ? truncateForLog(meta.sentence) : null,
              bytesEnqueued: event.bytesEnqueued,
              positionInPipeline: event.positionInPipeline,
            },
            correlationIds,
          )
          activeSegments.delete(event.sequence)
          segMeta.delete(event.sequence)
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
        case 'voice.mux.promotion_blocked': {
          // The mux deferred promoting a delivered segment because a
          // lower-sequence reservation is still in flight. Evidence the
          // ordering guard caught an out-of-order TTS response that would
          // otherwise have caused audible mis-sequencing. Rare in normal
          // operation; informational.
          this.logger.event(
            'voice.mux.promotion_blocked',
            'success',
            {
              candidateSequence: event.candidateSequence,
              blockingReservedSequence: event.blockingReservedSequence,
              reservedSequences: event.reservedSequences,
            },
            correlationIds,
          )
          return
        }
        case 'voice.mux.alignment_correction': {
          // Fail-loud: a segment ended on an odd byte count; the mux
          // dropped the trailing byte to keep int16 sample alignment at
          // the seam. ElevenLabs PCM should be even-byte — if this fires,
          // something upstream is truncating a sample.
          this.logger.event(
            'voice.mux.alignment_correction',
            'failed',
            { sequence: event.sequence, droppedBytes: event.droppedBytes },
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
        // segment_ready — intermediate "prebuffer floor met" signal,
        // less load-bearing than added/writing/drained. Not surfaced
        // through the logger; the segment_writing log immediately after
        // captures the same info plus byte counts.
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
        systemPrompt,
        relatedMaterial,
      })) {
        if (abort.signal.aborted) break
        assistantText += chunk
        ingestSentences(segmenter.push(chunk), 'push')
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
    ingestSentences(segmenter.flush(), 'flush')
    claudeComplete = true
    // ingestSentences already called tryFireNext; do one extra after
    // claudeComplete flips so checkDrain can fire if there's nothing
    // left at all (zero-segment edge case for very short Claude replies).
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
    this.teardownSession('error')
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

  private teardownSession(endReason: EndReason = 'user_closed'): void {
    if (this.teardownInProgress) return
    this.teardownInProgress = true

    // Phase 8: flush the persistence session before destroying any
    // ephemeral pipeline state. The controller captures its buffer +
    // session id synchronously and clears its own internal state
    // before awaiting the Supabase round-trip, so this is safe to
    // fire-and-forget — close UI returns to idle immediately.
    if (voiceSessionController.isActive()) {
      voiceSessionController
        .endSession({ endReason })
        .catch((err) =>
          console.error('[VadController] voiceSessionController.endSession failed:', err),
        )
    }

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
