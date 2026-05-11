/**
 * PcmStreamPlayer — streams raw 16-bit LE mono PCM at 24kHz from a
 * ReadableStream into Web Audio for low-latency playback.
 *
 * Contract & constraints captured in `docs/voice-v2-swap1-audit.md` and
 * the validated prototype findings in `docs/voice-v2-validation.md`:
 *
 *   - 50ms chunks (1200 samples / 2400 bytes at 24kHz)
 *   - Pre-buffer 2 chunks (~100ms) before scheduling the first one
 *   - Int16LE → Float32 normalization (divide by 32768)
 *   - AudioBufferSourceNode per chunk, scheduled with absolute timing
 *   - AudioContext created at native 24kHz (no resampling step)
 *
 * Events are namespaced `voice.playback.*`. Records are flat — Voice v2
 * input will introduce sibling correlators (sessionId etc.) without
 * nesting under playbackId.
 *
 * Failure posture: loud. Any failure during `start()` emits a
 * `voice.playback.error` event and throws — no silent fallback.
 */

export type PlaybackEvent =
  | { type: 'voice.playback.started'; playbackId: string; ts: number }
  | {
      type: 'voice.playback.firstAudio'
      playbackId: string
      latencyMs: number
      ts: number
    }
  | {
      type: 'voice.playback.underrun'
      playbackId: string
      chunkIndex: number
      bufferedMs: number
      ts: number
    }
  | {
      type: 'voice.playback.stateChange'
      playbackId: string
      from: AudioContextState
      to: AudioContextState
      ts: number
    }
  | {
      type: 'voice.playback.error'
      playbackId: string
      phase: string
      error: string
      ts: number
    }
  | { type: 'voice.playback.ended'; playbackId: string; ts: number }

export type PlaybackErrorPhase =
  | 'fetch'
  | 'stream-read'
  | 'decode'
  | 'schedule'
  | 'audiocontext'

const SAMPLE_RATE = 24000
const CHANNELS = 1
const BYTES_PER_SAMPLE = 2 // 16-bit
const CHUNK_DURATION_MS = 50
const SAMPLES_PER_CHUNK = (SAMPLE_RATE * CHUNK_DURATION_MS) / 1000 // 1200
const BYTES_PER_CHUNK = SAMPLES_PER_CHUNK * BYTES_PER_SAMPLE * CHANNELS // 2400
const PREBUFFER_CHUNKS = 2

type OnEvent = (event: PlaybackEvent) => void

export class PcmStreamPlayer {
  private readonly onEvent: OnEvent

  private audioContext: AudioContext | null = null
  private lastState: AudioContextState = 'suspended'
  private statechangeListener: (() => void) | null = null

  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null
  private leftoverBytes: Uint8Array = new Uint8Array(0)
  private pendingChunks: Uint8Array[] = []
  private prebufferReady = false

  private nextStartTime = 0
  private firstAudioEmitted = false
  private chunkIndex = 0
  private scheduledCount = 0
  private streamDone = false
  private stopped = false
  private endedEmitted = false

  private playbackId = ''
  private startedTs = 0

  constructor(opts: { onEvent: OnEvent }) {
    this.onEvent = opts.onEvent
  }

  /**
   * Begins playback. Resolves when the stream is fully consumed (the final
   * chunk has been *scheduled*, not necessarily finished playing — the
   * `voice.playback.ended` event fires when the last scheduled source
   * actually ends).
   *
   * Throws — after emitting a `voice.playback.error` event — on any failure
   * during setup, stream read, decode, or scheduling.
   */
  async start(
    stream: ReadableStream<Uint8Array>,
    opts: { playbackId: string },
  ): Promise<void> {
    this.playbackId = opts.playbackId
    this.startedTs = Date.now()
    this.emit({
      type: 'voice.playback.started',
      playbackId: this.playbackId,
      ts: this.startedTs,
    })

    try {
      this.audioContext = new AudioContext({ sampleRate: SAMPLE_RATE })
    } catch (err) {
      this.emitError('audiocontext', err)
      throw err
    }

    this.lastState = this.audioContext.state
    this.statechangeListener = () => {
      const ctx = this.audioContext
      if (!ctx) return
      const from = this.lastState
      const to = ctx.state
      if (from === to) return
      this.lastState = to
      this.emit({
        type: 'voice.playback.stateChange',
        playbackId: this.playbackId,
        from,
        to,
        ts: Date.now(),
      })
    }
    this.audioContext.addEventListener('statechange', this.statechangeListener)

    if (this.audioContext.state === 'suspended') {
      try {
        await this.audioContext.resume()
      } catch (err) {
        this.emitError('audiocontext', err)
        throw err
      }
    }

    this.nextStartTime = this.audioContext.currentTime
    this.reader = stream.getReader()

    await this.consumeStream()
  }

  /**
   * Cancels in-flight stream reading, closes the AudioContext, and
   * suppresses the trailing `voice.playback.ended` event. The
   * `voice.playback.stateChange` to `'closed'` will still fire via the
   * AudioContext listener.
   */
  stop(): void {
    if (this.stopped) return
    this.stopped = true

    if (this.reader) {
      this.reader.cancel().catch(() => {
        /* swallow — caller already stopping */
      })
      this.reader = null
    }

    if (this.audioContext && this.audioContext.state !== 'closed') {
      this.audioContext.close().catch(() => {
        /* swallow — caller already stopping */
      })
    }
  }

  private async consumeStream(): Promise<void> {
    if (!this.reader) return

    while (!this.stopped) {
      let result: ReadableStreamReadResult<Uint8Array>
      try {
        result = await this.reader.read()
      } catch (err) {
        this.emitError('stream-read', err)
        throw err
      }

      if (result.done) {
        this.streamDone = true
        this.flushOnEnd()
        return
      }

      this.appendBytes(result.value)
      this.drainChunks()
    }
  }

  private appendBytes(bytes: Uint8Array): void {
    if (bytes.length === 0) return
    const combined = new Uint8Array(this.leftoverBytes.length + bytes.length)
    combined.set(this.leftoverBytes)
    combined.set(bytes, this.leftoverBytes.length)
    this.leftoverBytes = combined
  }

  private drainChunks(): void {
    while (this.leftoverBytes.length >= BYTES_PER_CHUNK) {
      const chunk = this.leftoverBytes.slice(0, BYTES_PER_CHUNK)
      this.leftoverBytes = this.leftoverBytes.slice(BYTES_PER_CHUNK)
      this.handleChunk(chunk)
    }
  }

  private handleChunk(bytes: Uint8Array): void {
    if (this.prebufferReady) {
      this.scheduleChunk(bytes)
      return
    }
    this.pendingChunks.push(bytes)
    if (this.pendingChunks.length >= PREBUFFER_CHUNKS) {
      this.prebufferReady = true
      const queued = this.pendingChunks
      this.pendingChunks = []
      for (const c of queued) this.scheduleChunk(c)
    }
  }

  // Stream ended — flush any remaining partial chunk plus any pending
  // prebuffer chunks that never reached the threshold (very short stream).
  private flushOnEnd(): void {
    if (this.leftoverBytes.length >= BYTES_PER_SAMPLE) {
      // Align to whole samples — drop a trailing odd byte if any.
      const usable =
        this.leftoverBytes.length - (this.leftoverBytes.length % BYTES_PER_SAMPLE)
      const tail = this.leftoverBytes.slice(0, usable)
      this.leftoverBytes = new Uint8Array(0)
      if (this.prebufferReady) {
        this.scheduleChunk(tail)
      } else {
        this.pendingChunks.push(tail)
      }
    }
    if (!this.prebufferReady && this.pendingChunks.length > 0) {
      this.prebufferReady = true
      const queued = this.pendingChunks
      this.pendingChunks = []
      for (const c of queued) this.scheduleChunk(c)
    }
    // If we have zero audio (truly empty stream), fire ended now.
    if (this.scheduledCount === 0 && !this.endedEmitted && !this.stopped) {
      this.endedEmitted = true
      this.emit({
        type: 'voice.playback.ended',
        playbackId: this.playbackId,
        ts: Date.now(),
      })
    }
  }

  private scheduleChunk(bytes: Uint8Array): void {
    const ctx = this.audioContext
    if (!ctx || this.stopped) return

    let buffer: AudioBuffer
    try {
      const samples = bytes.length / BYTES_PER_SAMPLE
      const float32 = new Float32Array(samples)
      // Reading via DataView guarantees little-endian regardless of host byte
      // order. (x86/ARM are LE today, but the spec doesn't promise that.)
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
      for (let i = 0; i < samples; i++) {
        float32[i] = view.getInt16(i * BYTES_PER_SAMPLE, true) / 32768
      }
      buffer = ctx.createBuffer(CHANNELS, samples, SAMPLE_RATE)
      buffer.copyToChannel(float32, 0)
    } catch (err) {
      this.emitError('decode', err)
      throw err
    }

    let source: AudioBufferSourceNode
    try {
      source = ctx.createBufferSource()
      source.buffer = buffer
      source.connect(ctx.destination)

      const now = ctx.currentTime
      if (this.nextStartTime < now) {
        // We're behind the clock — there is (or was) a gap. Only count as
        // an underrun after first audio has been emitted; before then,
        // nextStartTime < now just means the prebuffer took longer than
        // a single sample-tick to assemble (not a real underrun).
        if (this.firstAudioEmitted) {
          this.emit({
            type: 'voice.playback.underrun',
            playbackId: this.playbackId,
            chunkIndex: this.chunkIndex,
            bufferedMs: 0,
            ts: Date.now(),
          })
        }
        this.nextStartTime = now
      }

      source.start(this.nextStartTime)
      this.nextStartTime += buffer.duration
      this.scheduledCount++
      this.chunkIndex++
    } catch (err) {
      this.emitError('schedule', err)
      throw err
    }

    if (!this.firstAudioEmitted) {
      this.firstAudioEmitted = true
      this.emit({
        type: 'voice.playback.firstAudio',
        playbackId: this.playbackId,
        latencyMs: Date.now() - this.startedTs,
        ts: Date.now(),
      })
    }

    source.onended = () => {
      this.scheduledCount--
      if (this.stopped || this.endedEmitted) return
      if (this.scheduledCount === 0) {
        if (this.streamDone) {
          this.endedEmitted = true
          this.emit({
            type: 'voice.playback.ended',
            playbackId: this.playbackId,
            ts: Date.now(),
          })
        } else {
          this.emit({
            type: 'voice.playback.underrun',
            playbackId: this.playbackId,
            chunkIndex: this.chunkIndex,
            bufferedMs: 0,
            ts: Date.now(),
          })
        }
      }
    }
  }

  private emit(event: PlaybackEvent): void {
    try {
      this.onEvent(event)
    } catch {
      /* a misbehaving handler must not break playback */
    }
  }

  private emitError(phase: PlaybackErrorPhase, err: unknown): void {
    const message = err instanceof Error ? err.message : String(err)
    this.emit({
      type: 'voice.playback.error',
      playbackId: this.playbackId,
      phase,
      error: message,
      ts: Date.now(),
    })
  }
}
