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
 */

export const STT_STREAM_URL = 'wss://api.elevenlabs.io/v1/speech-to-text/realtime'
export const STT_STREAM_MODELS = ['scribe_v2_realtime', 'scribe_v3_live'] as const
export type SttStreamModel = (typeof STT_STREAM_MODELS)[number]

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

export function buildSttStreamUrl(token: string, modelId: SttStreamModel, sampleRate: number): string {
  const params = new URLSearchParams({
    model_id: modelId,
    token,
    audio_format: `pcm_${sampleRate}`,
    language_code: 'en',
    commit_strategy: 'manual',
  })
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
  createSocket?: SttSocketFactory
  now?: () => number
}

export interface SttStreamFinal {
  text: string
  segments: number
  /** `now()` when the last committed segment arrived. */
  finalAt: number
}

export class SttStream {
  chunksSent = 0
  commitsSent = 0
  /** `now()` when session_started arrived; null until then. */
  readyAt: number | null = null

  private socket: SttSocket | null = null
  private queue: string[] = []
  private segments: string[] = []
  private pendingCommits = 0
  private finalAt = 0
  private failure: string | null = null
  private closed = false
  private waiter: { resolve: (f: SttStreamFinal) => void; reject: (e: Error) => void } | null = null
  private waiterTimer: ReturnType<typeof setTimeout> | null = null
  private readonly sampleRate: number
  private readonly now: () => number

  constructor(opts: SttStreamOptions) {
    this.sampleRate = opts.sampleRate
    this.now = opts.now ?? (() => performance.now())
    const createSocket = opts.createSocket ?? browserSocketFactory
    opts.token.then(
      (token) => {
        if (this.closed) return
        try {
          this.socket = createSocket(buildSttStreamUrl(token, opts.modelId, opts.sampleRate), {
            onMessage: (data) => this.handleMessage(data),
            onClose: () => this.fail('socket_closed'),
          })
        } catch (err) {
          this.fail(`socket_open_failed: ${errorText(err)}`)
        }
      },
      (err) => this.fail(`token_failed: ${errorText(err)}`),
    )
  }

  sendAudio(samples: Float32Array): void {
    this.chunksSent++
    this.enqueue(floatToPcm16Base64(samples), false)
  }

  /** Ask for the audio sent so far to be committed. Sent as an empty chunk. */
  commit(): void {
    this.commitsSent++
    this.pendingCommits++
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

  close(): void {
    if (this.closed) return
    this.closed = true
    this.queue = []
    if (this.waiterTimer) clearTimeout(this.waiterTimer)
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
    let msg: { message_type?: unknown; text?: unknown; error?: unknown }
    try {
      msg = JSON.parse(data)
    } catch {
      return
    }
    if (msg.message_type === 'session_started') {
      this.readyAt = this.now()
      this.flush()
    } else if (msg.message_type === 'committed_transcript') {
      const text = typeof msg.text === 'string' ? msg.text.trim() : ''
      if (text) this.segments.push(text)
      this.finalAt = this.now()
      if (this.pendingCommits > 0) this.pendingCommits--
      this.resolveIfFinal()
    } else if (typeof msg.error === 'string') {
      // error, auth_error, quota_exceeded, commit_throttled, input_error, ...
      this.fail(`${String(msg.message_type)}: ${msg.error}`)
    }
    // partial_transcript and warning are not used in shadow mode.
  }

  private resolveIfFinal(): void {
    if (!this.waiter || this.commitsSent === 0 || this.pendingCommits > 0) return
    const waiter = this.waiter
    this.waiter = null
    waiter.resolve({
      text: this.segments.join(' '),
      segments: this.segments.length,
      finalAt: this.finalAt,
    })
    this.close()
  }

  private fail(reason: string): void {
    if (this.closed || this.failure) return
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
