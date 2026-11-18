/**
 * Streaming STT in shadow mode (H2 phase 2). When the localStorage flag is
 * set, each user turn is also streamed to ElevenLabs realtime STT. The
 * result is only logged: the turn still runs on the Whisper transcript, and
 * nothing here can fail or delay it.
 *
 *   localStorage.setItem('weave.sttShadow', '1')        // on, commit at the VAD commit
 *   localStorage.setItem('weave.sttShadow', 'silence')  // commit at every silence_started
 *   add ',scribe_v3_live' to either to pick the model
 *   localStorage.removeItem('weave.sttShadow')          // off (the default)
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
import { normalizeWords, wordErrorRate } from './transcriptCompare'
import type { VoiceSessionLogger } from './voiceSessionLogger'

export const STT_SHADOW_FLAG = 'weave.sttShadow'
export const STT_SHADOW_SAMPLE_RATE = 16000
export const STT_SHADOW_FINAL_TIMEOUT_MS = 10000
const STT_TOKEN_URL = 'https://weave-media.fly.dev/api/stt-token'
const SHADOW_TRANSCRIPT_LOG_CHARS = 2000

export interface SttShadowConfig {
  /** 'expiry': one commit when the VAD commits the turn. 'silence': at every silence_started. */
  commitOn: 'expiry' | 'silence'
  modelId: SttStreamModel
}

/** Null (off) for a missing, empty or unrecognised value. */
export function parseSttShadowFlag(raw: string | null): SttShadowConfig | null {
  if (!raw) return null
  const config: SttShadowConfig = { commitOn: 'expiry', modelId: 'scribe_v2_realtime' }
  for (const part of raw.split(',').map((p) => p.trim().toLowerCase())) {
    if (part === '1' || part === 'true' || part === 'expiry') config.commitOn = 'expiry'
    else if (part === 'silence') config.commitOn = 'silence'
    else if ((STT_STREAM_MODELS as readonly string[]).includes(part)) config.modelId = part as SttStreamModel
    else return null
  }
  return config
}

export function readSttShadowConfig(): SttShadowConfig | null {
  try {
    return parseSttShadowFlag(localStorage.getItem(STT_SHADOW_FLAG))
  } catch {
    return null
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
  })
  if (!response.ok) throw new Error(`stt-token ${response.status}`)
  const json = (await response.json()) as { token?: unknown }
  if (typeof json.token !== 'string' || !json.token) throw new Error('stt-token response had no token')
  return json.token
}

export interface SttShadowTurnOptions {
  config: SttShadowConfig
  sampleRate: number
  logger: VoiceSessionLogger
  correlationIds: CorrelationIds
  fetchToken?: (recordingId: string) => Promise<string>
  createSocket?: SttSocketFactory
  now?: () => number
  finalTimeoutMs?: number
}

export type SttShadowCommitSource = 'silence_timer' | 'user_stop'

/** One user turn streamed in shadow. Every method is safe to call in any state. */
export class SttShadowTurn {
  private readonly opts: SttShadowTurnOptions
  private readonly now: () => number
  private readonly startedAt: number
  private readonly stream: SttStream
  private tokenMs: number | null = null
  private commitAt: number | null = null
  private commitSource: SttShadowCommitSource | null = null
  private outcome: Promise<SttStreamFinal | Error> | null = null

  constructor(opts: SttShadowTurnOptions) {
    this.opts = opts
    this.now = opts.now ?? (() => performance.now())
    this.startedAt = this.now()
    const fetchToken = opts.fetchToken ?? fetchSttToken
    const token = fetchToken(String(opts.correlationIds.correlationId ?? '')).then((t) => {
      this.tokenMs = Math.round(this.now() - this.startedAt)
      return t
    })
    this.stream = new SttStream({
      token,
      modelId: opts.config.modelId,
      sampleRate: opts.sampleRate,
      createSocket: opts.createSocket,
      now: this.now,
    })
  }

  onAudioChunk(samples: Float32Array): void {
    this.guard(() => {
      if (this.commitAt === null) this.stream.sendAudio(samples)
    })
  }

  onSilenceStarted(): void {
    this.guard(() => {
      if (this.commitAt === null && this.opts.config.commitOn === 'silence') this.stream.commit()
    })
  }

  /** The VAD committed the turn (silence timer expired, or the user pressed stop). */
  onCommit(source: SttShadowCommitSource): void {
    if (this.commitAt !== null) return
    this.commitAt = this.now()
    this.commitSource = source
    this.guard(() => this.commitAndWait(source))
  }

  private commitAndWait(source: SttShadowCommitSource): void {
    // In 'silence' mode the last pause already committed everything, unless
    // the user stopped mid-speech or no pause was ever seen.
    const needsCommit =
      this.opts.config.commitOn === 'expiry' || source === 'user_stop' || this.stream.commitsSent === 0
    if (needsCommit) this.stream.commit()
    this.outcome = this.stream
      .waitForFinal(this.opts.finalTimeoutMs ?? STT_SHADOW_FINAL_TIMEOUT_MS)
      .catch((err: unknown) => (err instanceof Error ? err : new Error(String(err))))
  }

  /**
   * The batch transcript is in (null when Whisper failed). Logs the
   * comparison once the streaming result has settled. Never throws.
   */
  onWhisperResult(whisperTranscript: string | null): void {
    const whisperAt = this.now()
    const outcome = this.outcome
    if (!outcome || this.commitAt === null) return this.cancel()
    const commitAt = this.commitAt
    void outcome.then((result) =>
      this.guard(() => this.logOutcome(result, whisperTranscript, whisperAt, commitAt)),
    )
  }

  private logOutcome(
    result: SttStreamFinal | Error,
    whisperTranscript: string | null,
    whisperAt: number,
    commitAt: number,
  ): void {
    {
      const { config } = this.opts
      const base = {
        mode: 'shadow',
        model: config.modelId,
        commitOn: config.commitOn,
        commitSource: this.commitSource,
        chunks: this.stream.chunksSent,
        commits: this.stream.commitsSent,
        tokenMs: this.tokenMs,
        openMs: this.stream.readyAt === null ? null : Math.round(this.stream.readyAt - this.startedAt),
        whisperMsAfterCommit: whisperTranscript === null ? null : Math.round(whisperAt - commitAt),
      }
      if (result instanceof Error) {
        this.opts.logger.event(
          'voice.stt.shadow_failed',
          'failed',
          { ...base, error: result.message },
          this.opts.correlationIds,
        )
        return
      }
      const finalMsAfterCommit = Math.round(result.finalAt - commitAt)
      this.opts.logger.event(
        'voice.stt.shadow_result',
        'success',
        {
          ...base,
          segments: result.segments,
          // Negative when the final was already in hand at the commit.
          finalMsAfterCommit,
          leadMs: base.whisperMsAfterCommit === null ? null : base.whisperMsAfterCommit - finalMsAfterCommit,
          shadowWords: normalizeWords(result.text).length,
          whisperWords: whisperTranscript === null ? null : normalizeWords(whisperTranscript).length,
          // Shadow against Whisper as the reference. 0 = same words.
          wordErrorRate:
            whisperTranscript === null
              ? null
              : Math.round(wordErrorRate(whisperTranscript, result.text) * 1000) / 1000,
          shadowTranscript: result.text.slice(0, SHADOW_TRANSCRIPT_LOG_CHARS),
        },
        this.opts.correlationIds,
      )
    }
  }

  /** Shadow mode must never break the turn it is watching. */
  private guard(fn: () => void): void {
    try {
      fn()
    } catch (err) {
      console.warn('[voice.stt.shadow]', err)
      this.stream.close()
    }
  }

  /** Drop the turn without logging (teardown, re-arm, aborted turn). */
  cancel(): void {
    this.stream.close()
  }
}

/**
 * Start shadowing a turn, or return null when the flag is off. A capture
 * rate other than 16 kHz is logged and skipped rather than resampled.
 */
export function startSttShadowTurn(
  opts: Omit<SttShadowTurnOptions, 'config'> & { config?: SttShadowConfig | null },
): SttShadowTurn | null {
  try {
    const config = opts.config === undefined ? readSttShadowConfig() : opts.config
    if (!config) return null
    if (opts.sampleRate !== STT_SHADOW_SAMPLE_RATE) {
      opts.logger.event(
        'voice.stt.shadow_failed',
        'skipped',
        { mode: 'shadow', error: 'unsupported_sample_rate', sampleRate: opts.sampleRate },
        opts.correlationIds,
      )
      return null
    }
    return new SttShadowTurn({ ...opts, config })
  } catch (err) {
    console.warn('[voice.stt.shadow] failed to start', err)
    return null
  }
}
