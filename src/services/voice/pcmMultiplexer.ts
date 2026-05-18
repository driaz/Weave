/**
 * PcmMultiplexer — orders N producer PCM byte streams into one continuous
 * audio sink for the Voice v2 sentence-chunked TTS path.
 *
 * Architecture (one continuous sink, N producers, write-coordinated):
 *
 *   - ONE audio sink (default: PcmStreamPlayer). The sink owns the
 *     AudioContext and consume loop and reads from a single
 *     ReadableStream<Uint8Array> exposed by the multiplexer.
 *
 *   - N PRODUCERS. Each addSegment(seq, stream) registers a producer.
 *     The multiplexer eagerly reads bytes from every active producer into
 *     a per-segment staging buffer.
 *
 *   - WRITE COORDINATOR. Only the lowest-sequence not-yet-drained segment
 *     can append bytes to the shared stream. A higher-sequence segment
 *     that finishes fetching first must wait. This enforces playback
 *     order regardless of how fast each TTS request resolves.
 *
 *   - PREBUFFER FLOOR. A segment cannot become the active writer until
 *     it has ≥ prebufferFloorBytes worth of PCM staged (default 400ms).
 *     On the normal path this is already satisfied by the time the
 *     previous segment drains. If it isn't, the handoff stalls (logged).
 *
 *   - FAIL-LOUD OBSERVABILITY. handoff_stall, underrun, and error events
 *     are emitted as voice.mux.* events. Underrun = sink ran out of
 *     samples mid-playback with segments still pending (forwarded from
 *     the sink's voice.playback.underrun). These should never happen on
 *     the normal path; when they do, we want them visible.
 *
 * Public API:
 *   - addSegment(sequence, stream): register a producer in playback order.
 *   - endOfSegments(): signal that no more segments will be added.
 *   - start(): construct the sink and begin consumption; resolves when
 *     the sink's start() resolves (the entire stream has been scheduled).
 *   - stop(): idempotent teardown — cancels producer streams, closes the
 *     shared stream, stops the sink.
 *
 * Testability: tests inject a synthetic sink via sinkFactory. The default
 * sink wraps PcmStreamPlayer which requires AudioContext (browser only).
 */

import { PcmStreamPlayer, type PlaybackEvent } from '../pcmStreamPlayer'

const SAMPLE_RATE = 24000
const BYTES_PER_SAMPLE = 2
const DEFAULT_PREBUFFER_FLOOR_MS = 400
/** 400ms × 24kHz × 2 bytes = 19200 bytes */
export const DEFAULT_PREBUFFER_FLOOR_BYTES =
  (SAMPLE_RATE * DEFAULT_PREBUFFER_FLOOR_MS) / 1000 * BYTES_PER_SAMPLE

export type MuxEvent =
  | {
      type: 'voice.mux.segment_added'
      sequence: number
      ts: number
    }
  | {
      type: 'voice.mux.segment_ready'
      sequence: number
      bytesStaged: number
      ts: number
    }
  | {
      type: 'voice.mux.segment_writing'
      sequence: number
      /** Total bytes staged for this segment at the moment writing began. */
      bytesStaged: number
      /**
       * Whether this segment is the FIRST to enter writing across the
       * turn, or a 'middle' transition. 'last' is never reported here —
       * it can't be known until segment-drained / endOfSegments time.
       */
      positionInPipeline: 'first' | 'middle'
      ts: number
    }
  | {
      type: 'voice.mux.segment_drained'
      sequence: number
      /** Total bytes the mux enqueued to the shared stream for this segment. */
      bytesEnqueued: number
      /**
       * 'first' if no earlier segment had drained; 'last' if
       * endOfSegments has been called and no other non-drained segment
       * remains; 'middle' otherwise. For a single-segment turn 'last'
       * takes precedence over 'first'.
       */
      positionInPipeline: 'first' | 'middle' | 'last'
      ts: number
    }
  | {
      /**
       * Fired when a segment ended with an odd byte count and the mux
       * dropped its trailing byte to keep int16 sample alignment intact
       * at the segment seam. Fail-loud: ElevenLabs segments should be
       * even-byte; if this fires in production, something upstream is
       * truncating a sample (network close, proxy framing, partial
       * sample close) and we want it visible.
       */
      type: 'voice.mux.alignment_correction'
      sequence: number
      droppedBytes: number
      ts: number
    }
  | {
      type: 'voice.mux.handoff_stall'
      sequence: number
      waitMs: number
      ts: number
    }
  | {
      /**
       * Fired when the write-coordinator would have promoted the lowest
       * delivered segment to writer, but a still-undelivered RESERVED
       * sequence with a lower number is in flight. The promotion is
       * deferred until either the lower sequence's addSegment arrives or
       * its reservation is cancelled. Closes the out-of-order race where
       * a faster later-sequence TTS response would otherwise overtake a
       * slower earlier-sequence response at the writer slot.
       *
       * Deduped per (candidateSequence, blockingReservedSequence) pair —
       * each unique block is reported once. Rare in normal operation:
       * frequent emissions = controller is firing TTS in tight bursts
       * with reordering at the TTS provider.
       */
      type: 'voice.mux.promotion_blocked'
      /** segments[0]'s sequence — the one we WOULD have promoted. */
      candidateSequence: number
      /** Lowest reserved sequence that's blocking promotion. */
      blockingReservedSequence: number
      /** Sorted snapshot of all currently reserved sequences. */
      reservedSequences: number[]
      /** performance.now() when this specific block was first detected. */
      waitStartedAtTs: number
      ts: number
    }
  | {
      type: 'voice.mux.underrun'
      sequence: number
      phase: 'pre-schedule' | 'post-source-end'
      ts: number
    }
  | {
      type: 'voice.mux.first_audio'
      scheduledLatencyMs: number
      audibleLatencyMs: number
      ts: number
    }
  | {
      type: 'voice.mux.complete'
      ts: number
    }
  | {
      type: 'voice.mux.error'
      sequence?: number
      phase: string
      error: string
      ts: number
    }

export interface PcmAudioSink {
  start(
    stream: ReadableStream<Uint8Array>,
    opts: { playbackId: string },
  ): Promise<void>
  stop(): void
}

/**
 * Sink factory — given a callback for PlaybackEvents, return a sink. In
 * production the default constructs a PcmStreamPlayer. Tests inject a
 * synthetic sink that records the byte order the mux produces.
 */
export type SinkFactory = (
  onPlaybackEvent: (event: PlaybackEvent) => void,
) => PcmAudioSink

export interface PcmMultiplexerOptions {
  playbackId: string
  onEvent: (event: MuxEvent) => void
  /** Default: () => new PcmStreamPlayer({ onEvent }). Tests override. */
  sinkFactory?: SinkFactory
  /** Default: DEFAULT_PREBUFFER_FLOOR_BYTES. Tests can lower this. */
  prebufferFloorBytes?: number
}

type SegmentState =
  | 'pending'
  | 'streaming'
  | 'ready'
  | 'writing'
  | 'drained'
  | 'errored'

interface Segment {
  sequence: number
  stream: ReadableStream<Uint8Array>
  reader: ReadableStreamDefaultReader<Uint8Array> | null
  staged: Uint8Array[]
  /** Total bytes ever staged (monotonic) — gates the prebuffer floor. */
  stagedBytes: number
  /** Bytes already forwarded to the shared stream. */
  consumedBytes: number
  state: SegmentState
  streamEnded: boolean
  /**
   * Per-segment int16-alignment carry. If a chunk would have caused this
   * segment's enqueued bytes to become odd, the trailing byte is held
   * here and prepended to the next chunk. At segment end, a leftover
   * carry is dropped (incomplete sample) and an alignment_correction
   * event is emitted. This guarantees the bytes the multiplexer hands
   * to the sink are int16-aligned at every segment seam.
   */
  tailByte: Uint8Array | null
}

export class PcmMultiplexer {
  private readonly playbackId: string
  private readonly onEvent: (e: MuxEvent) => void
  private readonly sinkFactory: SinkFactory
  private readonly prebufferFloorBytes: number

  private segments: Segment[] = []
  /**
   * Sequences the controller has announced via expectSegment() but whose
   * addSegment() hasn't yet arrived. The write-coordinator refuses to
   * promote a delivered segment whose sequence is HIGHER than any value
   * in this set — that prevents a faster later-sequence TTS response
   * from overtaking a still-in-flight earlier-sequence response.
   * Cleared per-sequence by addSegment / cancelReservation / stop.
   */
  private reservedSequences = new Set<number>()
  /**
   * Dedupe state for promotion_blocked emission. Tracks the (candidate,
   * blocker) pair we most recently emitted for; cleared on any successful
   * promotion. Prevents drive() — which can be called many times per
   * staging chunk — from spamming the same blocked event.
   */
  private blockedFor: { candidate: number; blocker: number } | null = null
  private endOfSegmentsCalled = false
  private stopped = false
  private started = false

  private sharedController: ReadableStreamDefaultController<Uint8Array> | null =
    null
  private sharedStream: ReadableStream<Uint8Array> | null = null
  private controllerClosed = false
  private sink: PcmAudioSink | null = null
  private sinkPromise: Promise<void> | null = null

  private firstAudioForwarded = false
  /**
   * Wall-clock timestamp at which we began waiting for the next segment
   * after a previous one drained. Set ONLY in the drain→next-not-ready
   * transition (never for the first segment). Cleared when the wait ends.
   */
  private stallStartTs: number | null = null
  /**
   * Sequence of the most recent segment to enter writing state. Used to
   * tag forwarded underrun events meaningfully even after a drain.
   */
  private lastActiveSequence: number | null = null
  /** Counters for positionInPipeline on segment_writing / segment_drained. */
  private writeTransitionCount = 0
  private drainCount = 0

  constructor(opts: PcmMultiplexerOptions) {
    this.playbackId = opts.playbackId
    this.onEvent = opts.onEvent
    this.sinkFactory =
      opts.sinkFactory ?? ((onPlay) => new PcmStreamPlayer({ onEvent: onPlay }))
    this.prebufferFloorBytes =
      opts.prebufferFloorBytes ?? DEFAULT_PREBUFFER_FLOOR_BYTES
  }

  /**
   * Construct the shared stream + sink and begin consumption. Returns the
   * sink's start() promise (resolves when the entire stream is consumed).
   */
  start(): Promise<void> {
    if (this.started) {
      return this.sinkPromise ?? Promise.resolve()
    }
    this.started = true

    this.sharedStream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.sharedController = controller
      },
    })

    this.sink = this.sinkFactory((e) => this.handlePlaybackEvent(e))
    this.sinkPromise = this.sink.start(this.sharedStream, {
      playbackId: this.playbackId,
    })

    // Drive once in case segments were added before start().
    this.drive()
    return this.sinkPromise
  }

  /**
   * Announce that a producer for `sequence` will arrive via addSegment()
   * later. Called by the controller after assigning the sequence number
   * but BEFORE the TTS fetch begins, so the mux knows about every
   * in-flight sequence before any of them can be delivered.
   *
   * Reservation is the load-bearing fix for the out-of-order playback
   * race: without it, the mux can promote a higher-sequence segment to
   * writer while a lower-sequence segment is still in flight.
   *
   * Tolerant: no-op if the mux is stopped or the sequence is already
   * reserved. Out-of-order calls are allowed but the controller calls
   * in ascending order in practice.
   */
  expectSegment(sequence: number): void {
    if (this.stopped) return
    this.reservedSequences.add(sequence)
  }

  /**
   * Release a reservation made via expectSegment() without delivering a
   * segment. Called by the controller when a TTS fetch fails or aborts —
   * if the reservation isn't cancelled, the write-coordinator will wait
   * forever for a segment that will never arrive.
   *
   * Tolerant: no-op for sequences that aren't reserved.
   */
  cancelReservation(sequence: number): void {
    if (!this.reservedSequences.has(sequence)) return
    this.reservedSequences.delete(sequence)
    this.drive()
  }

  /**
   * Register a producer. The multiplexer starts reading the stream
   * immediately into staging; it will be written to the shared sink in
   * sequence order once it has met the prebuffer floor (or its stream
   * has ended, whichever first).
   *
   * Sequences must be unique. Out-of-order addSegment is allowed (e.g.
   * addSegment(1) before addSegment(0)) — the mux waits for the missing
   * lower sequence before writing.
   *
   * Expected to be paired with a prior expectSegment(sequence); if the
   * reservation isn't present we log a warning and proceed normally for
   * backward compatibility with any caller that hasn't been updated.
   */
  addSegment(sequence: number, stream: ReadableStream<Uint8Array>): void {
    if (this.stopped) return
    if (this.reservedSequences.has(sequence)) {
      this.reservedSequences.delete(sequence)
    } else {
      console.warn(
        `[PcmMultiplexer] addSegment(${sequence}) without prior expectSegment — ordering guarantees apply only to reserved sequences`,
      )
    }
    if (this.segments.some((s) => s.sequence === sequence)) {
      this.emit({
        type: 'voice.mux.error',
        sequence,
        phase: 'add_segment',
        error: `duplicate sequence ${sequence}`,
        ts: performance.now(),
      })
      return
    }
    const seg: Segment = {
      sequence,
      stream,
      reader: null,
      staged: [],
      stagedBytes: 0,
      consumedBytes: 0,
      state: 'pending',
      streamEnded: false,
      tailByte: null,
    }
    const insertIdx = this.segments.findIndex((s) => s.sequence > sequence)
    if (insertIdx === -1) this.segments.push(seg)
    else this.segments.splice(insertIdx, 0, seg)

    this.emit({
      type: 'voice.mux.segment_added',
      sequence,
      ts: performance.now(),
    })

    void this.consumeSegment(seg)
    this.drive()
  }

  /**
   * Signal that no more segments will be added. The multiplexer closes
   * the shared stream once all currently-registered segments have
   * drained.
   */
  endOfSegments(): void {
    this.endOfSegmentsCalled = true
    this.drive()
  }

  /** Idempotent. Cancels producer reads, closes shared stream, stops sink. */
  stop(): void {
    if (this.stopped) return
    this.stopped = true

    for (const seg of this.segments) {
      if (seg.reader) {
        seg.reader.cancel().catch(() => {
          /* swallow — caller already stopping */
        })
      }
    }
    this.segments = []
    this.reservedSequences.clear()
    this.blockedFor = null

    if (this.sharedController && !this.controllerClosed) {
      try {
        this.sharedController.close()
        this.controllerClosed = true
      } catch {
        /* already closed */
      }
    }

    if (this.sink) {
      try {
        this.sink.stop()
      } catch {
        /* swallow */
      }
    }
  }

  private async consumeSegment(seg: Segment): Promise<void> {
    seg.state = 'streaming'
    let reader: ReadableStreamDefaultReader<Uint8Array>
    try {
      reader = seg.stream.getReader()
      seg.reader = reader
    } catch (err) {
      seg.state = 'errored'
      this.emit({
        type: 'voice.mux.error',
        sequence: seg.sequence,
        phase: 'segment_get_reader',
        error: err instanceof Error ? err.message : String(err),
        ts: performance.now(),
      })
      this.drive()
      return
    }

    try {
      while (true) {
        if (this.stopped) return
        const result = await reader.read()
        if (result.done) {
          seg.streamEnded = true
          break
        }
        if (result.value && result.value.length > 0) {
          seg.staged.push(result.value)
          seg.stagedBytes += result.value.length
          if (
            seg.state === 'streaming' &&
            seg.stagedBytes >= this.prebufferFloorBytes
          ) {
            seg.state = 'ready'
            this.emit({
              type: 'voice.mux.segment_ready',
              sequence: seg.sequence,
              bytesStaged: seg.stagedBytes,
              ts: performance.now(),
            })
          }
        }
        this.drive()
      }
    } catch (err) {
      if (this.stopped) return
      seg.state = 'errored'
      this.emit({
        type: 'voice.mux.error',
        sequence: seg.sequence,
        phase: 'segment_stream_read',
        error: err instanceof Error ? err.message : String(err),
        ts: performance.now(),
      })
      this.drive()
      return
    }

    // Stream ended. If we never hit the floor, that's fine — the segment
    // is "complete" (we have everything it'll ever have) so it can write.
    if (seg.state === 'streaming') {
      seg.state = 'ready'
      this.emit({
        type: 'voice.mux.segment_ready',
        sequence: seg.sequence,
        bytesStaged: seg.stagedBytes,
        ts: performance.now(),
      })
    }
    this.drive()
  }

  /**
   * Synchronous write coordinator. Walks segments in sequence order,
   * promotes the active segment to `writing` when its floor is met (or
   * its stream has ended), drains its staged bytes into the shared
   * stream, and advances when it's fully consumed. Idempotent — safe to
   * call from any path that might unblock progress.
   */
  private drive(): void {
    if (this.stopped) return
    if (!this.sharedController) return
    if (this.controllerClosed) return

    while (true) {
      const active = this.segments.find(
        (s) => s.state !== 'drained' && s.state !== 'errored',
      )
      if (!active) break

      if (active.state === 'pending') break

      // Active segment hasn't met the floor and its stream is still
      // arriving → wait. stallStartTs was set in the drain branch below
      // if this wait was triggered by a previous segment draining.
      if (active.state === 'streaming') break

      // ready → writing: gate on reservations. A delivered segment with
      // sequence N cannot promote while any RESERVED-BUT-NOT-DELIVERED
      // sequence < N is in flight. This is the load-bearing check that
      // prevents a faster later-sequence TTS response from overtaking a
      // slower earlier-sequence one.
      if (active.state === 'ready') {
        const blocker = this.lowestReservedBelow(active.sequence)
        if (blocker !== null) {
          if (
            !this.blockedFor ||
            this.blockedFor.candidate !== active.sequence ||
            this.blockedFor.blocker !== blocker
          ) {
            this.blockedFor = { candidate: active.sequence, blocker }
            const now = performance.now()
            this.emit({
              type: 'voice.mux.promotion_blocked',
              candidateSequence: active.sequence,
              blockingReservedSequence: blocker,
              reservedSequences: Array.from(this.reservedSequences).sort(
                (a, b) => a - b,
              ),
              waitStartedAtTs: now,
              ts: now,
            })
          }
          break
        }
        this.blockedFor = null
        active.state = 'writing'
        this.lastActiveSequence = active.sequence
        if (this.stallStartTs !== null) {
          const waitMs = performance.now() - this.stallStartTs
          this.emit({
            type: 'voice.mux.handoff_stall',
            sequence: active.sequence,
            waitMs,
            ts: performance.now(),
          })
          this.stallStartTs = null
        }
        const writingPosition: 'first' | 'middle' =
          this.writeTransitionCount === 0 ? 'first' : 'middle'
        this.writeTransitionCount++
        this.emit({
          type: 'voice.mux.segment_writing',
          sequence: active.sequence,
          bytesStaged: active.stagedBytes,
          positionInPipeline: writingPosition,
          ts: performance.now(),
        })
      }

      // Drain staged bytes. Enforce int16 sample alignment per segment:
      // each enqueue is even-byte; a trailing odd byte becomes tailByte
      // and is prepended to the next chunk. This way the absolute
      // cumulative position in the shared stream stays sample-aligned at
      // every segment seam regardless of how ElevenLabs chunks its body.
      while (active.staged.length > 0) {
        const incoming = active.staged.shift()!
        let combined: Uint8Array
        if (active.tailByte && active.tailByte.length > 0) {
          combined = new Uint8Array(active.tailByte.length + incoming.length)
          combined.set(active.tailByte)
          combined.set(incoming, active.tailByte.length)
          active.tailByte = null
        } else {
          combined = incoming
        }
        const evenLen = combined.length - (combined.length % 2)
        if (combined.length % 2 === 1) {
          active.tailByte = combined.slice(combined.length - 1)
        }
        if (evenLen === 0) continue // nothing to enqueue this round (carry only)
        const aligned =
          evenLen === combined.length ? combined : combined.slice(0, evenLen)
        try {
          this.sharedController.enqueue(aligned)
          active.consumedBytes += aligned.length
        } catch {
          // Controller already closed (likely stop() raced). Bail.
          return
        }
      }

      if (active.streamEnded && active.staged.length === 0) {
        // Drop any trailing odd byte — an incomplete int16 sample. Surface
        // the correction so misaligned upstream segments are visible.
        if (active.tailByte && active.tailByte.length > 0) {
          const dropped = active.tailByte.length
          active.tailByte = null
          this.emit({
            type: 'voice.mux.alignment_correction',
            sequence: active.sequence,
            droppedBytes: dropped,
            ts: performance.now(),
          })
        }
        active.state = 'drained'
        // Determine positionInPipeline. 'last' takes precedence (a
        // single-segment turn is "last" rather than "first" — it
        // semantically marks the end of playback).
        const next = this.segments.find(
          (s) => s.state !== 'drained' && s.state !== 'errored',
        )
        const isLast = this.endOfSegmentsCalled && !next
        const drainPosition: 'first' | 'middle' | 'last' = isLast
          ? 'last'
          : this.drainCount === 0
            ? 'first'
            : 'middle'
        this.drainCount++
        this.emit({
          type: 'voice.mux.segment_drained',
          sequence: active.sequence,
          bytesEnqueued: active.consumedBytes,
          positionInPipeline: drainPosition,
          ts: performance.now(),
        })
        // If a next segment exists and isn't ready, mark the start of a
        // handoff stall. Cleared (and emitted) when that segment reaches
        // writing state.
        if (next && next.state !== 'ready') {
          this.stallStartTs = performance.now()
        }
        continue
      }
      // Still writing but no more bytes available yet — wait.
      break
    }

    // Close the controller once everything is drained and the caller has
    // signaled end-of-segments. PcmStreamPlayer (or test sink) will then
    // emit voice.playback.ended → voice.mux.complete.
    if (
      this.endOfSegmentsCalled &&
      !this.controllerClosed &&
      this.segments.length > 0 &&
      this.segments.every(
        (s) => s.state === 'drained' || s.state === 'errored',
      )
    ) {
      try {
        this.sharedController.close()
        this.controllerClosed = true
      } catch {
        /* already closed */
      }
    }
  }

  private handlePlaybackEvent(event: PlaybackEvent): void {
    switch (event.type) {
      case 'voice.playback.firstAudio': {
        if (!this.firstAudioForwarded) {
          this.firstAudioForwarded = true
          this.emit({
            type: 'voice.mux.first_audio',
            scheduledLatencyMs: event.scheduledLatencyMs,
            audibleLatencyMs: event.audibleLatencyMs,
            ts: performance.now(),
          })
        }
        return
      }
      case 'voice.playback.underrun': {
        // Prefer the currently-writing segment; fall back to the most
        // recently active one so the event is meaningful even after a
        // drain (the underrun is "about" the audio we were just playing).
        const writing = this.segments.find((s) => s.state === 'writing')
        const seq =
          writing?.sequence ?? this.lastActiveSequence ?? event.chunkIndex
        this.emit({
          type: 'voice.mux.underrun',
          sequence: seq,
          phase: event.phase,
          ts: performance.now(),
        })
        return
      }
      case 'voice.playback.ended': {
        this.emit({
          type: 'voice.mux.complete',
          ts: performance.now(),
        })
        return
      }
      case 'voice.playback.error': {
        this.emit({
          type: 'voice.mux.error',
          phase: `playback:${event.phase}`,
          error: event.error,
          ts: performance.now(),
        })
        return
      }
      // voice.playback.started / .stateChange are not surfaced via mux —
      // intentional: they're sink-internal details. Add forwarding if the
      // integration prompt needs them.
      default:
        return
    }
  }

  /**
   * Returns the lowest reserved sequence strictly less than `seq`, or
   * `null` if no reservation blocks promotion of `seq`. Reservations
   * is typically small (≤ MAX_INFLIGHT_TTS), so the linear scan is
   * fast enough that a sorted index isn't worth the bookkeeping.
   */
  private lowestReservedBelow(seq: number): number | null {
    let lowest: number | null = null
    for (const r of this.reservedSequences) {
      if (r < seq && (lowest === null || r < lowest)) lowest = r
    }
    return lowest
  }

  private emit(event: MuxEvent): void {
    try {
      this.onEvent(event)
    } catch {
      /* misbehaving handler must not break the mux */
    }
  }
}
