/**
 * Streaming STT drives the turn (H2 phase 3). Each user turn is streamed to
 * ElevenLabs Scribe while it is spoken; the committed transcript feeds the
 * turn. Whisper (the batch WAV to /api/stt) is the fallback: it is used when
 * Scribe has no final within STT_SCRIBE_FINAL_TIMEOUT_MS of the commit, when
 * the socket fails, or when the final is empty. The two are never both awaited.
 *
 *   localStorage.setItem('weave.sttScribe', '0')               // kill switch: Whisper only
 *   localStorage.setItem('weave.sttScribe', 'scribe_v3_live')  // Scribe, other model
 *   localStorage.removeItem('weave.sttScribe')                 // Scribe (the default)
 */
import type { CorrelationIds } from '../../utils/logger'
import { supabase } from '../supabaseClient'
import {
  STT_STREAM_MODELS,
  SttStream,
  type SttSocketFactory,
  type SttStreamFinal,
  type SttStreamModel,
} from './sttStreamClient'
import type { VoiceSessionLogger } from './voiceSessionLogger'

export const STT_SCRIBE_FLAG = 'weave.sttScribe'
export const STT_SCRIBE_SAMPLE_RATE = 16000
/** How long after the commit a Scribe final may take before Whisper is used. */
export const STT_SCRIBE_FINAL_TIMEOUT_MS = 500
/** The socket stays open this long after the final, to report a late segment. */
export const STT_SCRIBE_LINGER_MS = 2000
// The media server gives ElevenLabs 5 s to mint a token; allow for the hop.
export const STT_TOKEN_TIMEOUT_MS = 6000
const STT_TOKEN_URL = 'https://weave-media.fly.dev/api/stt-token'
const TRANSCRIPT_LOG_CHARS = 4000
const DEFAULT_MODEL: SttStreamModel = 'scribe_v2_realtime'

export interface SttScribeConfig {
  modelId: SttStreamModel
}

/** Null when the kill switch is set. Anything unrecognised means the default. */
export function parseSttScribeFlag(raw: string | null): SttScribeConfig | null {
  const value = (raw ?? '').trim().toLowerCase()
  if (value === '0' || value === 'false' || value === 'off') return null
  if ((STT_STREAM_MODELS as readonly string[]).includes(value)) {
    return { modelId: value as SttStreamModel }
  }
  return { modelId: DEFAULT_MODEL }
}

export function readSttScribeConfig(): SttScribeConfig | null {
  try {
    return parseSttScribeFlag(localStorage.getItem(STT_SCRIBE_FLAG))
  } catch {
    return { modelId: DEFAULT_MODEL }
  }
}

/** Single-use ElevenLabs token from the media server, JWT-gated like /api/stt. */
export async function fetchSttToken(recordingId: string): Promise<string> {
  if (!supabase) throw new Error('Supabase client not configured')
  const { data } = await supabase.auth.getSession()
  const jwt = data.session?.access_token
  if (!jwt) throw new Error('No Supabase session')
  const response = await fetch(STT_TOKEN_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${jwt}`, 'X-Recording-Id': recordingId },
    signal: AbortSignal.timeout(STT_TOKEN_TIMEOUT_MS),
  })
  if (!response.ok) throw new Error(`stt-token ${response.status}`)
  const json = (await response.json()) as { token?: unknown }
  if (typeof json.token !== 'string' || !json.token) throw new Error('stt-token response had no token')
  return json.token
}

/** Rejects with `token_timeout` if the token is not in hand in time. */
function withTokenTimeout(token: Promise<string>, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('token_timeout')), timeoutMs)
    token.then(resolve, reject).finally(() => clearTimeout(timer))
  })
}

export type SttCommitSource = 'silence_timer' | 'user_stop'
export type SttFallbackReason = 'timeout' | 'socket_error' | 'empty_final' | 'not_ready'

export type ScribeOutcome =
  | { ok: true; text: string; final: SttStreamFinal; finalMsAfterCommit: number }
  | { ok: false; reason: SttFallbackReason; error?: string }

export interface ScribeTurnOptions {
  config: SttScribeConfig
  sampleRate: number
  logger: VoiceSessionLogger
  correlationIds: CorrelationIds
  fetchToken?: (recordingId: string) => Promise<string>
  createSocket?: SttSocketFactory
  now?: () => number
  finalTimeoutMs?: number
  tokenTimeoutMs?: number
  lingerMs?: number
  /** The running transcript (segments + latest partial) changed. */
  onTextUpdate?: (text: string) => void
}

/** One user turn streamed to Scribe. Every method is safe to call in any state. */
export class ScribeTurn {
  private readonly opts: ScribeTurnOptions
  private readonly now: () => number
  private readonly startedAt: number
  private stream: SttStream | null = null
  private startError: string | null = null
  private tokenMs: number | null = null
  private commitAt: number | null = null
  private commitSource: SttCommitSource | null = null
  private readyAtCommit = false

  constructor(opts: ScribeTurnOptions) {
    this.opts = opts
    this.now = opts.now ?? (() => performance.now())
    this.startedAt = this.now()
    // A capture rate other than 16 kHz is not resampled: the turn uses Whisper.
    if (opts.sampleRate !== STT_SCRIBE_SAMPLE_RATE) {
      this.startError = `unsupported_sample_rate: ${opts.sampleRate}`
      return
    }
    try {
      const fetchToken = opts.fetchToken ?? fetchSttToken
      const token = withTokenTimeout(
        fetchToken(String(opts.correlationIds.correlationId ?? '')),
        opts.tokenTimeoutMs ?? STT_TOKEN_TIMEOUT_MS,
      ).then((t) => {
        this.tokenMs = Math.round(this.now() - this.startedAt)
        return t
      })
      this.stream = new SttStream({
        token,
        modelId: opts.config.modelId,
        sampleRate: opts.sampleRate,
        noVerbatim: true,
        lingerMs: opts.lingerMs ?? STT_SCRIBE_LINGER_MS,
        onLateSegment: (text) => this.logLateSegment(text),
        onTextUpdate: opts.onTextUpdate,
        createSocket: opts.createSocket,
        now: this.now,
      })
    } catch (err) {
      this.startError = `start_failed: ${errorText(err)}`
    }
  }

  onAudioChunk(samples: Float32Array): void {
    if (this.commitAt !== null) return
    this.guard(() => this.stream?.sendAudio(samples))
  }

  /** The VAD committed the turn (silence timer expired, or the user pressed stop). */
  onCommit(source: SttCommitSource): void {
    if (this.commitAt !== null) return
    this.commitAt = this.now()
    this.commitSource = source
    this.readyAtCommit = !!this.stream && this.stream.readyAt !== null && !this.stream.failure
    // Not ready or already failed: the turn goes to Whisper, nothing to commit.
    if (this.readyAtCommit) this.guard(() => this.stream?.commit())
  }

  /**
   * The Scribe transcript, or the reason Whisper has to be used. Settles at
   * most STT_SCRIBE_FINAL_TIMEOUT_MS after the commit; at once when the
   * socket was not ready or had already failed. Never rejects.
   */
  async outcome(): Promise<ScribeOutcome> {
    const stream = this.stream
    if (!stream) return { ok: false, reason: 'not_ready', error: this.startError ?? undefined }
    if (this.commitAt === null) return this.giveUp('not_ready', 'no_commit')
    if (stream.failure) {
      return this.giveUp(stream.readyAt === null ? 'not_ready' : 'socket_error', stream.failure)
    }
    if (!this.readyAtCommit) return this.giveUp('not_ready', 'session_not_started')
    const commitAt = this.commitAt
    const budget = this.opts.finalTimeoutMs ?? STT_SCRIBE_FINAL_TIMEOUT_MS
    const remaining = Math.max(0, budget - (this.now() - commitAt))
    try {
      const final = await stream.waitForFinal(remaining)
      if (!final.text) return this.giveUp('empty_final')
      return { ok: true, text: final.text, final, finalMsAfterCommit: Math.round(final.finalAt - commitAt) }
    } catch (err) {
      const message = errorText(err)
      return this.giveUp(message === 'final_timeout' ? 'timeout' : 'socket_error', message)
    }
  }

  /** The running transcript so far (segments + latest partial); '' when none. */
  currentText(): string {
    return this.stream?.currentText() ?? ''
  }

  /** Fields for the per-turn `voice.stt.source` log line. */
  logDetail(): Record<string, unknown> {
    const stream = this.stream
    return {
      model: this.opts.config.modelId,
      commitSource: this.commitSource,
      chunks: stream?.chunksSent ?? 0,
      tokenMs: this.tokenMs,
      openMs: !stream || stream.readyAt === null ? null : Math.round(stream.readyAt - this.startedAt),
      noVerbatimAcked: stream?.noVerbatimAcked ?? null,
    }
  }

  /** Drop the turn (teardown, re-arm, aborted turn). */
  cancel(): void {
    this.stream?.close()
  }

  private giveUp(reason: SttFallbackReason, error?: string): ScribeOutcome {
    this.stream?.close()
    return { ok: false, reason, error }
  }

  private logLateSegment(text: string): void {
    this.guard(() =>
      this.opts.logger.event(
        'voice.stt.late_segment',
        'failed',
        { model: this.opts.config.modelId, text: text.slice(0, TRANSCRIPT_LOG_CHARS) },
        this.opts.correlationIds,
      ),
    )
  }

  /** A streaming fault must never break the turn: Whisper covers it. */
  private guard(fn: () => void): void {
    try {
      fn()
    } catch (err) {
      console.warn('[voice.stt.scribe]', err)
      this.stream?.close()
    }
  }
}

/** Start streaming a turn, or return null when the kill switch is set. */
export function startScribeTurn(
  opts: Omit<ScribeTurnOptions, 'config'> & { config?: SttScribeConfig | null },
): ScribeTurn | null {
  const config = opts.config === undefined ? readSttScribeConfig() : opts.config
  if (!config) return null
  return new ScribeTurn({ ...opts, config })
}

export interface TurnTranscript {
  transcript: string
  source: 'scribe' | 'whisper_fallback' | 'whisper'
}

export interface ResolveTurnTranscriptOptions {
  /** Null when the kill switch is set. */
  scribe: ScribeTurn | null
  /** Sends the batch WAV to Whisper. Called only when Scribe is not used. */
  transcribeBatch: () => Promise<string>
  logger: VoiceSessionLogger
  correlationIds: CorrelationIds
}

/**
 * The transcript for a committed turn: Scribe's if it is in hand in time,
 * otherwise Whisper's. Logs one `voice.stt.source` line per turn, before any
 * Whisper call so the line survives a Whisper failure. Rejects only if the
 * Whisper call does.
 */
export async function resolveTurnTranscript(opts: ResolveTurnTranscriptOptions): Promise<TurnTranscript> {
  const { scribe, logger, correlationIds } = opts
  if (!scribe) {
    logger.event('voice.stt.source', 'success', { source: 'whisper', scribeDisabled: true }, correlationIds)
    return { transcript: await opts.transcribeBatch(), source: 'whisper' }
  }
  const outcome = await scribe.outcome()
  if (outcome.ok) {
    logger.event(
      'voice.stt.source',
      'success',
      {
        source: 'scribe',
        ...scribe.logDetail(),
        // Negative when a segment was already in hand at the commit.
        finalMsAfterCommit: outcome.finalMsAfterCommit,
        segments: outcome.final.segments,
        selfCommits: outcome.final.selfCommits,
        selfCommitGuard: outcome.final.selfCommitGuard,
        // The no_verbatim text. The API does not return the raw text alongside it.
        transcript: outcome.text.slice(0, TRANSCRIPT_LOG_CHARS),
        rawTranscript: null,
      },
      correlationIds,
    )
    return { transcript: outcome.text, source: 'scribe' }
  }
  logger.event(
    'voice.stt.source',
    'success',
    {
      source: 'whisper_fallback',
      fallbackReason: outcome.reason,
      error: outcome.error ?? null,
      ...scribe.logDetail(),
    },
    correlationIds,
  )
  return { transcript: await opts.transcribeBatch(), source: 'whisper_fallback' }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
