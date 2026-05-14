/**
 * Voice session state machine.
 *
 * Single source of truth for what a voice session is doing right now.
 * UI elements read from it; external events (VAD, STT/Claude/TTS pipeline,
 * user clicks, network failures) drive transitions through it. The
 * orchestrator, VAD controller, and playback layer all *call into* this
 * store but do not own it.
 *
 * Design notes:
 *   - Pure, synchronous state. No audio, no network, no logging. Side
 *     effects live in the callers that drive the transitions.
 *   - Invalid transitions throw. Fail-loud is the project principle and
 *     a wrong-state transition is always a real bug, not a recoverable
 *     condition.
 *   - sessionId is generated on idle → initializing and persists until
 *     the next → idle. userClickedRetry (error → initializing) preserves
 *     sessionId because that transition is recovery within an existing
 *     session, not a new one.
 *   - turnId is generated on two transitions into a turn:
 *       initializing → assistant_speaking (the opening turn — Claude
 *         speaks first, unprompted, when the session is ready), and
 *       listening → user_speaking (every subsequent user turn).
 *     turnId is cleared on any transition that ends a turn:
 *     assistant_speaking → listening, processing_user_turn → listening
 *     (empty / too-short), any → idle, and on userClickedRetry (the
 *     failed turn is abandoned). turnId is preserved on → error so
 *     error logs can correlate to the turn that failed.
 *   - substep is a free-form marker the orchestrator updates while in
 *     processing_user_turn for log granularity. Auto-cleared on every
 *     transition out of processing_user_turn. setSubstep() outside that
 *     state throws.
 */

export type VoiceSessionStatus =
  | 'idle'
  | 'initializing'
  | 'listening'
  | 'user_speaking'
  | 'processing_user_turn'
  | 'assistant_speaking'
  | 'error'

export type VoiceSessionSubstep = 'stt' | 'claude' | 'tts'

export type VoiceSessionErrorKind =
  | 'mic_denied'
  | 'mic_lost'
  | 'audio_context_failed'
  | 'audio_context_suspended'
  | 'audio_context_lost'
  | 'worklet_load_failed'
  | 'worklet_init_timeout'
  | 'worklet_runtime_error'
  | 'audio_stream_corruption'
  | 'stt_failed'
  | 'stt_timeout'
  | 'claude_failed'
  | 'tts_failed'
  | 'playback_failed'
  | 'unknown'

export interface VoiceSessionError {
  kind: VoiceSessionErrorKind
  message: string
  substep?: VoiceSessionSubstep
  recoverable: boolean
  originalError?: unknown
}

export interface VoiceSessionState {
  status: VoiceSessionStatus
  error: VoiceSessionError | null
  substep: VoiceSessionSubstep | null
  sessionId: string | null
  turnId: string | null
}

export type VoiceSessionListener = (
  state: VoiceSessionState,
  prev: VoiceSessionState,
) => void

export interface VoiceSessionStore {
  getState(): VoiceSessionState
  subscribe(listener: VoiceSessionListener): () => void

  userClickedSpeak(): void
  initComplete(): void
  initFailed(error: VoiceSessionError): void
  userClickedCancel(): void

  vadSpeechStarted(): void
  vadSpeechEnded(): void
  userClickedStop(): void
  userClickedClose(): void
  fatalError(error: VoiceSessionError): void

  firstAudioChunkArrived(): void
  sttReturnedEmpty(): void
  sttReturnedTooShort(): void
  sttFailed(error: VoiceSessionError): void
  claudeFailed(error: VoiceSessionError): void
  ttsFailed(error: VoiceSessionError): void

  playbackEndedNaturally(): void

  userClickedRetry(): void
  userClickedDismiss(): void

  setSubstep(substep: VoiceSessionSubstep | null): void
}

const INITIAL_STATE: VoiceSessionState = {
  status: 'idle',
  error: null,
  substep: null,
  sessionId: null,
  turnId: null,
}

function generateId(): string {
  return crypto.randomUUID()
}

export function createVoiceSessionStore(): VoiceSessionStore {
  let state: VoiceSessionState = { ...INITIAL_STATE }
  const listeners = new Set<VoiceSessionListener>()

  function setState(patch: Partial<VoiceSessionState>): void {
    const prev = state
    state = { ...state, ...patch }
    for (const listener of listeners) listener(state, prev)
  }

  function reject(action: string): never {
    throw new Error(
      `Invalid voice session transition: ${action}() called from status='${state.status}'`,
    )
  }

  return {
    getState: () => state,

    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },

    userClickedSpeak() {
      if (state.status !== 'idle') reject('userClickedSpeak')
      setState({
        status: 'initializing',
        sessionId: generateId(),
        turnId: null,
        substep: null,
        error: null,
      })
    },

    initComplete() {
      if (state.status !== 'initializing') reject('initComplete')
      setState({ status: 'assistant_speaking', turnId: generateId() })
    },

    initFailed(error) {
      if (state.status !== 'initializing') reject('initFailed')
      setState({ status: 'error', error })
    },

    userClickedCancel() {
      if (state.status !== 'initializing') reject('userClickedCancel')
      setState({ ...INITIAL_STATE })
    },

    vadSpeechStarted() {
      if (state.status !== 'listening') reject('vadSpeechStarted')
      setState({ status: 'user_speaking', turnId: generateId() })
    },

    vadSpeechEnded() {
      if (state.status !== 'user_speaking') reject('vadSpeechEnded')
      setState({ status: 'processing_user_turn', substep: null })
    },

    userClickedStop() {
      if (state.status === 'user_speaking') {
        setState({ status: 'processing_user_turn', substep: null })
      } else if (state.status === 'assistant_speaking') {
        setState({ status: 'listening', turnId: null, substep: null })
      } else {
        reject('userClickedStop')
      }
    },

    userClickedClose() {
      if (
        state.status === 'listening' ||
        state.status === 'user_speaking' ||
        state.status === 'processing_user_turn' ||
        state.status === 'assistant_speaking'
      ) {
        setState({ ...INITIAL_STATE })
      } else {
        reject('userClickedClose')
      }
    },

    fatalError(error) {
      if (
        state.status === 'listening' ||
        state.status === 'user_speaking' ||
        state.status === 'assistant_speaking'
      ) {
        setState({ status: 'error', error, substep: null })
      } else {
        reject('fatalError')
      }
    },

    firstAudioChunkArrived() {
      if (state.status !== 'processing_user_turn') reject('firstAudioChunkArrived')
      setState({ status: 'assistant_speaking', substep: null })
    },

    sttReturnedEmpty() {
      if (state.status !== 'processing_user_turn') reject('sttReturnedEmpty')
      setState({ status: 'listening', turnId: null, substep: null })
    },

    sttReturnedTooShort() {
      if (state.status !== 'processing_user_turn') reject('sttReturnedTooShort')
      setState({ status: 'listening', turnId: null, substep: null })
    },

    sttFailed(error) {
      if (state.status !== 'processing_user_turn') reject('sttFailed')
      setState({ status: 'error', error, substep: null })
    },

    claudeFailed(error) {
      if (state.status !== 'processing_user_turn') reject('claudeFailed')
      setState({ status: 'error', error, substep: null })
    },

    ttsFailed(error) {
      if (state.status !== 'processing_user_turn') reject('ttsFailed')
      setState({ status: 'error', error, substep: null })
    },

    playbackEndedNaturally() {
      if (state.status !== 'assistant_speaking') reject('playbackEndedNaturally')
      setState({ status: 'listening', turnId: null })
    },

    userClickedRetry() {
      if (state.status !== 'error') reject('userClickedRetry')
      setState({
        status: 'initializing',
        error: null,
        turnId: null,
        substep: null,
      })
    },

    userClickedDismiss() {
      if (state.status !== 'error') reject('userClickedDismiss')
      setState({ ...INITIAL_STATE })
    },

    setSubstep(substep) {
      if (state.status !== 'processing_user_turn') {
        throw new Error(
          `setSubstep() is only valid during status='processing_user_turn', got '${state.status}'`,
        )
      }
      setState({ substep })
    },
  }
}

export const voiceSessionStore: VoiceSessionStore = createVoiceSessionStore()
