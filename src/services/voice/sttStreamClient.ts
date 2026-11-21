/**
 * Client for the ElevenLabs realtime speech-to-text socket, one socket per
 * user turn. Field names follow the API reference
 * (elevenlabs.io/docs/api-reference/speech-to-text/v-1-speech-to-text-realtime):
 *
 *   send     { message_type: 'input_audio_chunk', audio_base_64, commit, sample_rate }
 *   receive  session_started | partial_transcript { text } | committed_transcript { text }
 *            and error messages, each its own message_type with an `error` string
 *
 * Commit strategy is manual: our VAD decides when a turn ends. The server
 * also commits by itself after about 36 s of accumulated audio, so one turn
 * can produce several committed segments; they are joined in order.
 *
 * A committed_transcript does not say which commit it answers. If our commit
 * goes out while a server self-commit may still be on its way back, the
 * stream waits for two segments rather than one (see STT_SELF_COMMIT_GUARD_S),
 * so the tail of a long turn cannot be dropped.
 */

export const STT_STREAM_URL = 'wss://api.elevenlabs.io/v1/speech-to-text/realtime'
export const STT_STREAM_MODELS = ['scribe_v2_realtime', 'scribe_v3_live'] as const
export type SttStreamModel = (typeof STT_STREAM_MODELS)[number]
/**
 * Audio sent since the last committed segment, in seconds, at or above which
 * a server self-commit (documented as "approximately 36 seconds") may be in
 * flight when we commit.
 */
export const STT_SELF_COMMIT_GUARD_S = 34

export interface SttSocketHandlers {
  onMessage: (data: string) => void
  onClose: () => void
}
export interface SttSocket {
  send: (data: string) => void
  close: () => void
}
export type SttSocketFactory = (url: string, handlers: SttSocketHandlers) => SttSocket

const browserSocketFactory: SttSocketFactory = (url, handlers) => {
  const ws = new WebSocket(url)
  ws.onmessage = (ev) => {
    if (typeof ev.data === 'string') handlers.onMessage(ev.data)
  }
  ws.onclose = () => handlers.onClose()
  return { send: (data) => ws.send(data), close: () => ws.close() }
}

export function buildSttStreamUrl(
  token: string,
  modelId: SttStreamModel,
  sampleRate: number,
  noVerbatim = false,
): string {
  const params = new URLSearchParams({
    model_id: modelId,
    token,
    audio_format: `pcm_${sampleRate}`,
    language_code: 'en',
    commit_strategy: 'manual',
  })
  // Filler words and disfluencies are removed from the transcript.
  if (noVerbatim) params.set('no_verbatim', 'true')
  return `${STT_STREAM_URL}?${params.toString()}`
}

/** Float32 [-1, 1] → 16-bit little-endian PCM, base64. */
export function floatToPcm16Base64(samples: Float32Array): string {
  const bytes = new Uint8Array(samples.length * 2)
  const view = new DataView(bytes.buffer)
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]))
    view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true)
  }
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return btoa(binary)
}

export interface SttStreamOptions {
  token: Promise<string>
  modelId: SttStreamModel
  sampleRate: number
  noVerbatim?: boolean
  /**
   * Keep the socket open this long after the final is delivered, to catch a
   * segment that arrives late. 0 (the default) closes at once.
   */
  lingerMs?: number
  /** A non-empty segment arrived after the final was delivered: words were lost. */
  onLateSegment?: (text: string) => void
  /** The running transcript (committed segments + latest partial) changed. */
  onTextUpdate?: (text: string) => void
  createSocket?: SttSocketFactory
  now?: () => number
}

export interface SttStreamFinal {
  text: string
  segments: number
  /** `now()` when the last committed segment arrived. */
  finalAt: number
  /** Segments the server committed by itself, before our commit. */
  selfCommits: number
  /** Our commit waited for two segments because a self-commit could be in flight. */
  selfCommitGuard: boolean
}

export class SttStream {
  chunksSent = 0
  commitsSent = 0
  /** `now()` when session_started arrived; null until then. */
  readyAt: number | null = null
  /** `no_verbatim` as echoed in session_started; null if not echoed. */
  noVerbatimAcked: boolean | null = null
  /** Why the stream failed; null while healthy. */
  failure: string | null = null

  private socket: SttSocket | null = null
  private queue: string[] = []
  private segments: string[] = []
  /** Latest partial_transcript for the audio not yet committed. */
  private partial = ''
  private pendingCommits = 0
  private finalAt = 0
  private selfCommits = 0
  private selfCommitGuard = false
  /** Samples sent since the last committed segment came back. */
  private unackedSamples = 0
  private delivered = false
  private lingerTimer: ReturnType<typeof setTimeout> | null = null
  private closed = false
  private waiter: { resolve: (f: SttStreamFinal) => void; reject: (e: Error) => void } | null = null
  private waiterTimer: ReturnType<typeof setTimeout> | null = null
  private readonly sampleRate: number
  private readonly lingerMs: number
  private readonly onLateSegment?: (text: string) => void
  private readonly onTextUpdate?: (text: string) => void
  private readonly now: () => number

  constructor(opts: SttStreamOptions) {
    this.sampleRate = opts.sampleRate
    this.lingerMs = opts.lingerMs ?? 0
    this.onLateSegment = opts.onLateSegment
    this.onTextUpdate = opts.onTextUpdate
    this.now = opts.now ?? (() => performance.now())
    const createSocket = opts.createSocket ?? browserSocketFactory
    opts.token.then(
      (token) => {
        if (this.closed) return
        try {
          this.socket = createSocket(
            buildSttStreamUrl(token, opts.modelId, opts.sampleRate, opts.noVerbatim),
            {
              onMessage: (data) => this.handleMessage(data),
              onClose: () => this.fail('socket_closed'),
            },
          )
        } catch (err) {
          this.fail(`socket_open_failed: ${errorText(err)}`)
        }
      },
      (err) => this.fail(`token_failed: ${errorText(err)}`),
    )
  }

  sendAudio(samples: Float32Array): void {
    this.chunksSent++
    this.unackedSamples += samples.length
    this.enqueue(floatToPcm16Base64(samples), false)
  }

  /** Ask for the audio sent so far to be committed. Sent as an empty chunk. */
  commit(): void {
    this.commitsSent++
    this.pendingCommits++
    if (this.unackedSamples / this.sampleRate >= STT_SELF_COMMIT_GUARD_S) {
      // A server self-commit may be on its way back; ours is answered after it.
      this.pendingCommits++
      this.selfCommitGuard = true
    }
    this.enqueue('', true)
  }

  /**
   * Resolves once every commit sent has been answered by a
   * committed_transcript. Rejects on a stream failure or after `timeoutMs`.
   */
  waitForFinal(timeoutMs: number): Promise<SttStreamFinal> {
    return new Promise((resolve, reject) => {
      if (this.failure) return reject(new Error(this.failure))
      this.waiter = { resolve, reject }
      this.waiterTimer = setTimeout(() => this.fail('final_timeout'), timeoutMs)
      this.resolveIfFinal()
    })
  }

  /**
   * The running transcript: committed segments, then the latest partial for
   * the audio not yet committed. Unlike the final, it can lag the audio by a
   * word or two.
   */
  currentText(): string {
    return [...this.segments, this.partial].filter(Boolean).join(' ')
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.queue = []
    if (this.waiterTimer) clearTimeout(this.waiterTimer)
    if (this.lingerTimer) clearTimeout(this.lingerTimer)
    try {
      this.socket?.close()
    } catch {
      // closing a socket that never opened
    }
  }

  private enqueue(audioBase64: string, commit: boolean): void {
    if (this.closed) return
    this.queue.push(
      JSON.stringify({
        message_type: 'input_audio_chunk',
        audio_base_64: audioBase64,
        commit,
        sample_rate: this.sampleRate,
      }),
    )
    this.flush()
  }

  private flush(): void {
    if (!this.socket || this.readyAt === null || this.closed) return
    try {
      for (const message of this.queue) this.socket.send(message)
      this.queue = []
    } catch (err) {
      this.fail(`send_failed: ${errorText(err)}`)
    }
  }

  private handleMessage(data: string): void {
    if (this.closed) return
    let msg: { message_type?: unknown; text?: unknown; error?: unknown; config?: unknown }
    try {
      msg = JSON.parse(data)
    } catch {
      return
    }
    if (msg.message_type === 'session_started') {
      this.readyAt = this.now()
      const echoed = (msg.config as { no_verbatim?: unknown } | null | undefined)?.no_verbatim
      if (typeof echoed === 'boolean') this.noVerbatimAcked = echoed
      this.flush()
    } else if (msg.message_type === 'committed_transcript') {
      const text = typeof msg.text === 'string' ? msg.text.trim() : ''
      if (this.delivered) {
        if (text) this.onLateSegment?.(text)
        return
      }
      if (text) this.segments.push(text)
      // The committed segment supersedes the partial it was built from.
      this.partial = ''
      this.finalAt = this.now()
      this.unackedSamples = 0
      if (this.pendingCommits > 0) this.pendingCommits--
      else this.selfCommits++
      this.resolveIfFinal()
      this.emitTextUpdate()
    } else if (msg.message_type === 'partial_transcript') {
      if (this.delivered) return
      const text = typeof msg.text === 'string' ? msg.text.trim() : ''
      if (text === this.partial) return
      this.partial = text
      this.emitTextUpdate()
    } else if (typeof msg.error === 'string') {
      // error, auth_error, quota_exceeded, commit_throttled, input_error, ...
      this.fail(`${String(msg.message_type)}: ${msg.error}`)
    }
    // warning is not used.
  }

  private emitTextUpdate(): void {
    if (!this.onTextUpdate || this.delivered) return
    try {
      this.onTextUpdate(this.currentText())
    } catch {
      // A listener fault must not break the stream.
    }
  }

  private resolveIfFinal(): void {
    if (!this.waiter || this.commitsSent === 0 || this.pendingCommits > 0) return
    const waiter = this.waiter
    this.waiter = null
    waiter.resolve({
      text: this.segments.join(' '),
      segments: this.segments.length,
      finalAt: this.finalAt,
      selfCommits: this.selfCommits,
      selfCommitGuard: this.selfCommitGuard,
    })
    this.delivered = true
    if (this.waiterTimer) clearTimeout(this.waiterTimer)
    if (this.lingerMs > 0) this.lingerTimer = setTimeout(() => this.close(), this.lingerMs)
    else this.close()
  }

  private fail(reason: string): void {
    if (this.closed || this.failure) return
    if (this.delivered) return this.close()
    this.failure = reason
    const waiter = this.waiter
    this.waiter = null
    this.close()
    waiter?.reject(new Error(reason))
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
