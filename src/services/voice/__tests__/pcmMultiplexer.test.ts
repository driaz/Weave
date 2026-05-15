import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  PcmMultiplexer,
  type MuxEvent,
  type PcmAudioSink,
  type SinkFactory,
} from '../pcmMultiplexer'
import type { PlaybackEvent } from '../../pcmStreamPlayer'

/**
 * Synthetic byte-recording sink. Reads the merged stream and stores every
 * chunk in arrival order. Emits voice.playback.firstAudio after the first
 * non-empty chunk arrives, voice.playback.ended when the stream closes.
 * Can be commanded to emit a voice.playback.underrun for forwarding tests.
 */
class RecordingSink implements PcmAudioSink {
  readonly chunks: Uint8Array[] = []
  startCalled = false
  stopCalled = false
  private readonly onPlaybackEvent: (e: PlaybackEvent) => void
  private playbackId = ''
  private firstAudioEmitted = false
  private endedEmitted = false
  /** Resolved when start() returns (stream fully consumed). */
  private donePromise!: Promise<void>
  resolveDone!: () => void

  constructor(onPlaybackEvent: (e: PlaybackEvent) => void) {
    this.onPlaybackEvent = onPlaybackEvent
    this.donePromise = new Promise<void>((resolve) => {
      this.resolveDone = resolve
    })
  }

  /** Concatenated bytes across all chunks, in arrival order. */
  concatenated(): Uint8Array {
    let total = 0
    for (const c of this.chunks) total += c.length
    const out = new Uint8Array(total)
    let pos = 0
    for (const c of this.chunks) {
      out.set(c, pos)
      pos += c.length
    }
    return out
  }

  /** Force an underrun event for forwarding tests. */
  forceUnderrun(
    phase: 'pre-schedule' | 'post-source-end' = 'post-source-end',
  ): void {
    this.onPlaybackEvent({
      type: 'voice.playback.underrun',
      playbackId: this.playbackId,
      phase,
      chunkIndex: 0,
      bufferedMs: 0,
      ts: 0,
    })
  }

  async start(
    stream: ReadableStream<Uint8Array>,
    opts: { playbackId: string },
  ): Promise<void> {
    this.startCalled = true
    this.playbackId = opts.playbackId
    this.onPlaybackEvent({
      type: 'voice.playback.started',
      playbackId: opts.playbackId,
      ts: 0,
    })
    const reader = stream.getReader()
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        if (value && value.length > 0) {
          this.chunks.push(value)
          if (!this.firstAudioEmitted) {
            this.firstAudioEmitted = true
            this.onPlaybackEvent({
              type: 'voice.playback.firstAudio',
              playbackId: opts.playbackId,
              scheduledLatencyMs: 0,
              audibleLatencyMs: 0,
              ts: 0,
            })
          }
        }
      }
      if (!this.endedEmitted) {
        this.endedEmitted = true
        this.onPlaybackEvent({
          type: 'voice.playback.ended',
          playbackId: opts.playbackId,
          ts: 0,
        })
      }
    } finally {
      this.resolveDone()
    }
    return this.donePromise
  }

  stop(): void {
    this.stopCalled = true
  }
}

/** Build a ReadableStream that emits the given chunks then closes. */
function streamFromChunks(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(c)
      controller.close()
    },
  })
}

/**
 * Stream backed by an external `pump` function. Emits chunks only when
 * the test calls pump.push(bytes) / pump.end(). Used to control when a
 * segment hits the prebuffer floor / closes.
 */
interface ManualStreamHandle {
  stream: ReadableStream<Uint8Array>
  push(bytes: Uint8Array): void
  end(): void
}

function manualStream(): ManualStreamHandle {
  let pendingResolve: ((value: { done: boolean; value?: Uint8Array }) => void) | null =
    null
  const queue: Uint8Array[] = []
  let closed = false

  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      // Drain whatever's queued first; if nothing, wait for push/end.
      while (true) {
        if (queue.length > 0) {
          controller.enqueue(queue.shift()!)
          return
        }
        if (closed) {
          controller.close()
          return
        }
        await new Promise<void>((resolve) => {
          pendingResolve = () => resolve()
        })
      }
    },
  })

  return {
    stream,
    push(bytes) {
      queue.push(bytes)
      if (pendingResolve) {
        const r = pendingResolve
        pendingResolve = null
        r({ done: false, value: bytes })
      }
    },
    end() {
      closed = true
      if (pendingResolve) {
        const r = pendingResolve
        pendingResolve = null
        r({ done: true })
      }
    },
  }
}

/** Make a Uint8Array of `length` bytes, each = (fill & 0xff). */
function bytes(length: number, fill: number): Uint8Array {
  return new Uint8Array(length).fill(fill & 0xff)
}

/** Yield to the microtask queue a few times so async pulls can settle. */
async function settle(ticks = 5): Promise<void> {
  for (let i = 0; i < ticks; i++) {
    await Promise.resolve()
  }
}

describe('PcmMultiplexer', () => {
  let events: MuxEvent[]
  let sink: RecordingSink
  let sinkFactory: SinkFactory
  let mux: PcmMultiplexer

  beforeEach(() => {
    events = []
    sinkFactory = (onPlaybackEvent) => {
      sink = new RecordingSink(onPlaybackEvent)
      return sink
    }
    mux = new PcmMultiplexer({
      playbackId: 'test-playback',
      onEvent: (e) => events.push(e),
      sinkFactory,
      // 100 bytes floor — small enough that tiny synthetic segments
      // either meet it or hit stream-end first (handled identically).
      prebufferFloorBytes: 100,
    })
  })

  afterEach(() => {
    try {
      mux.stop()
    } catch {
      /* idempotent */
    }
  })

  describe('basic ordering', () => {
    it('plays two segments back-to-back, output is segment 0 bytes then segment 1 bytes', async () => {
      const seg0 = bytes(200, 0xaa)
      const seg1 = bytes(150, 0xbb)

      mux.start()
      mux.addSegment(0, streamFromChunks([seg0]))
      mux.addSegment(1, streamFromChunks([seg1]))
      mux.endOfSegments()

      await settle(20)

      const combined = sink.concatenated()
      expect(combined.length).toBe(seg0.length + seg1.length)
      // First 200 bytes should be 0xAA, next 150 should be 0xBB.
      for (let i = 0; i < seg0.length; i++) expect(combined[i]).toBe(0xaa)
      for (let i = 0; i < seg1.length; i++) {
        expect(combined[seg0.length + i]).toBe(0xbb)
      }
    })

    it('emits segment_added → segment_ready → segment_writing → segment_drained for each segment', async () => {
      mux.start()
      mux.addSegment(0, streamFromChunks([bytes(200, 0x01)]))
      mux.endOfSegments()
      await settle(20)

      const types = events.map((e) => e.type)
      expect(types).toContain('voice.mux.segment_added')
      expect(types).toContain('voice.mux.segment_ready')
      expect(types).toContain('voice.mux.segment_writing')
      expect(types).toContain('voice.mux.segment_drained')

      // Order must be added → ready → writing → drained.
      const idxAdded = types.indexOf('voice.mux.segment_added')
      const idxReady = types.indexOf('voice.mux.segment_ready')
      const idxWriting = types.indexOf('voice.mux.segment_writing')
      const idxDrained = types.indexOf('voice.mux.segment_drained')
      expect(idxAdded).toBeLessThan(idxReady)
      expect(idxReady).toBeLessThan(idxWriting)
      expect(idxWriting).toBeLessThan(idxDrained)
    })

    it('handles a single segment correctly', async () => {
      const only = bytes(300, 0x42)
      mux.start()
      mux.addSegment(0, streamFromChunks([only]))
      mux.endOfSegments()
      await settle(20)

      expect(sink.concatenated()).toEqual(only)
    })
  })

  describe('out-of-order completion preserves playback order', () => {
    it('seg 1 finishes first but seg 0 bytes still emit first', async () => {
      const seg0 = bytes(200, 0xaa)
      const seg1 = bytes(150, 0xbb)

      // Create a manual stream for seg 0 so we can hold it back, and a
      // pre-closed stream for seg 1 that completes immediately.
      const seg0Handle = manualStream()
      const seg1Stream = streamFromChunks([seg1])

      mux.start()
      // Register seg 1 first (out-of-order add) so its bytes are staged
      // before seg 0's bytes arrive.
      mux.addSegment(1, seg1Stream)
      mux.addSegment(0, seg0Handle.stream)

      // Let seg 1 fully stream into staging first.
      await settle(10)
      // Sink must NOT have received any bytes yet — seg 0 hasn't started.
      expect(sink.concatenated().length).toBe(0)

      // Now feed seg 0 and close.
      seg0Handle.push(seg0)
      seg0Handle.end()
      mux.endOfSegments()
      await settle(20)

      const combined = sink.concatenated()
      // Total bytes correct.
      expect(combined.length).toBe(seg0.length + seg1.length)
      // First 200 are seg 0's pattern (0xAA), then 150 of seg 1 (0xBB).
      for (let i = 0; i < seg0.length; i++) expect(combined[i]).toBe(0xaa)
      for (let i = 0; i < seg1.length; i++) {
        expect(combined[seg0.length + i]).toBe(0xbb)
      }
    })
  })

  describe('prebuffer floor and handoff stall', () => {
    it('does not start writing a segment until it has met the prebuffer floor (or its stream has ended)', async () => {
      // Use a large floor so that a small first push does NOT meet it.
      const slowMux = new PcmMultiplexer({
        playbackId: 'slow',
        onEvent: (e) => events.push(e),
        sinkFactory,
        prebufferFloorBytes: 500,
      })
      const handle = manualStream()
      slowMux.start()
      slowMux.addSegment(0, handle.stream)

      // Push a tiny amount — below floor. Stream still open.
      handle.push(bytes(50, 0x11))
      await settle(5)
      // Nothing should be written yet.
      expect(sink.concatenated().length).toBe(0)
      // No 'segment_ready' event yet.
      expect(events.find((e) => e.type === 'voice.mux.segment_ready')).toBeUndefined()

      // Push enough to cross the floor.
      handle.push(bytes(500, 0x22))
      await settle(10)
      // Now segment_ready and segment_writing should fire.
      expect(
        events.find((e) => e.type === 'voice.mux.segment_ready'),
      ).toBeDefined()
      expect(
        events.find((e) => e.type === 'voice.mux.segment_writing'),
      ).toBeDefined()
      expect(sink.concatenated().length).toBeGreaterThan(0)

      handle.end()
      slowMux.endOfSegments()
      await settle(10)
      slowMux.stop()
    })

    it('emits voice.mux.handoff_stall when seg N drains but seg N+1 has not met the floor', async () => {
      const stallMux = new PcmMultiplexer({
        playbackId: 'stall',
        onEvent: (e) => events.push(e),
        sinkFactory,
        prebufferFloorBytes: 500,
      })
      const seg0 = bytes(200, 0xaa)
      const seg1Handle = manualStream()

      stallMux.start()
      stallMux.addSegment(0, streamFromChunks([seg0]))
      stallMux.addSegment(1, seg1Handle.stream)

      // seg 0 streams fully and drains; seg 1 still empty.
      await settle(10)
      expect(
        events.find(
          (e) =>
            e.type === 'voice.mux.segment_drained' &&
            'sequence' in e &&
            e.sequence === 0,
        ),
      ).toBeDefined()
      // No handoff stall event yet — it fires on RESOLUTION of the stall.
      expect(
        events.find((e) => e.type === 'voice.mux.handoff_stall'),
      ).toBeUndefined()

      // Wait a brief moment so waitMs > 0.
      await new Promise((r) => setTimeout(r, 10))

      // Now feed seg 1 enough to cross the floor.
      seg1Handle.push(bytes(500, 0xbb))
      await settle(10)

      const stall = events.find((e) => e.type === 'voice.mux.handoff_stall')
      expect(stall).toBeDefined()
      if (stall && stall.type === 'voice.mux.handoff_stall') {
        expect(stall.sequence).toBe(1)
        expect(stall.waitMs).toBeGreaterThan(0)
      }

      seg1Handle.end()
      stallMux.endOfSegments()
      await settle(10)
      stallMux.stop()
    })
  })

  describe('underrun forwarding', () => {
    it('forwards voice.playback.underrun from the sink as voice.mux.underrun', async () => {
      mux.start()
      mux.addSegment(0, streamFromChunks([bytes(200, 0x99)]))
      await settle(10)
      // Synthetic underrun signal from the sink (PcmStreamPlayer would
      // fire this when its scheduling clock falls behind playback).
      sink.forceUnderrun('post-source-end')
      const ur = events.find((e) => e.type === 'voice.mux.underrun')
      expect(ur).toBeDefined()
      if (ur && ur.type === 'voice.mux.underrun') {
        expect(ur.phase).toBe('post-source-end')
        // Sequence should be the currently-writing or next-expected.
        expect(ur.sequence).toBe(0)
      }
      mux.endOfSegments()
      await settle(10)
    })
  })

  describe('completion signal', () => {
    it('emits voice.mux.complete after endOfSegments and all segments drain', async () => {
      mux.start()
      mux.addSegment(0, streamFromChunks([bytes(100, 0x33)]))
      mux.addSegment(1, streamFromChunks([bytes(100, 0x44)]))
      mux.endOfSegments()
      await settle(20)

      const complete = events.find((e) => e.type === 'voice.mux.complete')
      expect(complete).toBeDefined()
    })

    it('emits voice.mux.first_audio once after the first bytes reach the sink', async () => {
      mux.start()
      mux.addSegment(0, streamFromChunks([bytes(100, 0x55)]))
      mux.addSegment(1, streamFromChunks([bytes(100, 0x66)]))
      mux.endOfSegments()
      await settle(20)

      const firstAudios = events.filter((e) => e.type === 'voice.mux.first_audio')
      expect(firstAudios).toHaveLength(1)
    })
  })

  describe('stop() teardown', () => {
    it('is idempotent — calling stop() twice does not throw', () => {
      mux.start()
      mux.addSegment(0, streamFromChunks([bytes(100, 0x77)]))
      mux.stop()
      expect(() => mux.stop()).not.toThrow()
    })

    it('stops the sink and clears segments', async () => {
      mux.start()
      mux.addSegment(0, streamFromChunks([bytes(100, 0x77)]))
      await settle(2)
      mux.stop()
      expect(sink.stopCalled).toBe(true)
    })

    it('addSegment after stop() is a no-op', () => {
      mux.start()
      mux.stop()
      // Should not throw, should not emit voice.mux.segment_added.
      mux.addSegment(0, streamFromChunks([bytes(100, 0x88)]))
      expect(
        events.find((e) => e.type === 'voice.mux.segment_added'),
      ).toBeUndefined()
    })
  })

  describe('error surfaces', () => {
    it('rejects duplicate sequence numbers with a voice.mux.error event', () => {
      mux.start()
      mux.addSegment(0, streamFromChunks([bytes(100, 0x01)]))
      mux.addSegment(0, streamFromChunks([bytes(100, 0x02)]))
      const errs = events.filter((e) => e.type === 'voice.mux.error')
      expect(errs.length).toBeGreaterThanOrEqual(1)
      const dup = errs.find(
        (e) => e.type === 'voice.mux.error' && e.phase === 'add_segment',
      )
      expect(dup).toBeDefined()
    })
  })
})
