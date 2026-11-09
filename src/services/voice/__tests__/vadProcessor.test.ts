import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// public/voice/vad-processor.js is a classic AudioWorklet script, not a
// module. Run its source against stubbed worklet globals and drive
// process() with synthetic 128-sample quanta.

const SOURCE = readFileSync(
  resolve(__dirname, '../../../../public/voice/vad-processor.js'),
  'utf8',
)
const QUANTUM = 128
const SAMPLE_RATE = 48000

interface OutMsg {
  type: string
  samples?: Float32Array
  isPreRoll?: boolean
  sequence?: number
}

interface Processor {
  process(inputs: Float32Array[][]): boolean
}

function createProcessor(sampleRate = SAMPLE_RATE) {
  const out: OutMsg[] = []
  let onmessage: ((e: { data: unknown }) => void) | null = null
  class AudioWorkletProcessor {
    port = {
      postMessage: (m: OutMsg) => out.push(m),
      set onmessage(fn: (e: { data: unknown }) => void) {
        onmessage = fn
      },
    }
  }
  let Ctor: (new () => Processor) | null = null
  const registerProcessor = (_name: string, c: new () => Processor) => {
    Ctor = c
  }
  new Function('AudioWorkletProcessor', 'registerProcessor', 'sampleRate', 'currentTime', SOURCE)(
    AudioWorkletProcessor,
    registerProcessor,
    sampleRate,
    0,
  )
  if (!Ctor) throw new Error('processor not registered')
  const proc = new (Ctor as new () => Processor)()
  const send = (data: unknown) => onmessage?.({ data })
  const feed = (amplitude: number, ms: number) => {
    const quanta = Math.ceil((ms / 1000) * sampleRate / QUANTUM)
    for (let q = 0; q < quanta; q++) {
      proc.process([[new Float32Array(QUANTUM).fill(amplitude)]])
    }
    return quanta * QUANTUM
  }
  return { out, send, feed, proc }
}

function configure(send: (d: unknown) => void, preRollMs?: number) {
  send({
    type: 'configure',
    rmsThreshold: 0.01,
    minSpeechDurationMs: 10,
    minSilenceDurationMs: 200,
    ...(preRollMs === undefined ? {} : { preRollMs }),
  })
}

const preRolls = (out: OutMsg[]) => out.filter((m) => m.type === 'audio_chunk' && m.isPreRoll)
const count = (out: OutMsg[], type: string) => out.filter((m) => m.type === type).length

describe('vad-processor pre-roll', () => {
  it('posts one pre-roll per turn even when speech re-triggers after a dip', () => {
    const { out, send, feed } = createProcessor()
    configure(send, 300)
    feed(0, 500) // fill the ring
    send({ type: 'start' })

    feed(0.5, 1000)
    feed(0, 500) // dip long enough for silence_started
    feed(0.5, 1000)
    feed(0, 500)
    feed(0.5, 1000)

    expect(count(out, 'speech_started')).toBe(3)
    expect(count(out, 'silence_started')).toBe(2)
    expect(preRolls(out)).toHaveLength(1)

    // Sequences stay contiguous: pre-roll is 0, stream chunks follow.
    const seqs = out.filter((m) => m.type === 'audio_chunk').map((m) => m.sequence)
    expect(seqs).toEqual(seqs.map((_, i) => i))
  })

  it('starts a fresh pre-roll on the next turn after stop/start', () => {
    const { out, send, feed } = createProcessor()
    configure(send, 300)
    feed(0, 500)
    send({ type: 'start' })
    feed(0.5, 500)
    send({ type: 'stop' })
    feed(0, 500)
    send({ type: 'start' })
    feed(0.5, 500)

    expect(preRolls(out)).toHaveLength(2)
  })

  it('streams every sample exactly once across a mid-turn re-trigger', () => {
    const { out, send, proc } = createProcessor()
    configure(send, 300)
    // Every sample carries a unique marker (silent ones stay well under
    // threshold) so a dropped or repeated stretch misaligns the stream.
    const fed: number[] = []
    let onset = -1
    const run = (loud: boolean, ms: number) => {
      const quanta = Math.ceil(((ms / 1000) * SAMPLE_RATE) / QUANTUM)
      for (let q = 0; q < quanta; q++) {
        const block = new Float32Array(QUANTUM)
        for (let i = 0; i < QUANTUM; i++) block[i] = (loud ? 0.5 : 0) + (fed.length + i) * 1e-9
        const before = count(out, 'speech_started')
        proc.process([[block]])
        if (onset < 0 && count(out, 'speech_started') > before) onset = fed.length
        fed.push(...block)
      }
    }
    run(false, 500)
    send({ type: 'start' })
    run(true, 1000)
    run(false, 500)
    run(true, 1000)
    expect(count(out, 'speech_started')).toBe(2)

    const streamed = out
      .filter((m) => m.type === 'audio_chunk' && !m.isPreRoll)
      .flatMap((m) => Array.from(m.samples ?? []))
    expect(streamed.length).toBeGreaterThan(0)
    expect(streamed).toEqual(fed.slice(onset, onset + streamed.length))
  })

  it('sizes the pre-roll from preRollMs at the worklet rate', () => {
    const at48 = createProcessor(48000)
    configure(at48.send, 300)
    at48.feed(0, 500)
    at48.send({ type: 'start' })
    at48.feed(0.5, 200)
    expect(preRolls(at48.out)[0].samples).toHaveLength(14400)

    const at16 = createProcessor(16000)
    configure(at16.send, 300)
    at16.feed(0, 1500)
    at16.send({ type: 'start' })
    at16.feed(0.5, 200)
    expect(preRolls(at16.out)[0].samples).toHaveLength(4800)
  })

  it('falls back to the whole ring when preRollMs is absent', () => {
    const { out, send, feed } = createProcessor()
    configure(send)
    feed(0, 500)
    send({ type: 'start' })
    feed(0.5, 200)
    expect(preRolls(out)[0].samples).toHaveLength(16384)
  })

  it('pre-roll ends with the most recent samples, oldest first', () => {
    const { out, send, feed } = createProcessor()
    configure(send, 300)
    feed(0, 500)
    send({ type: 'start' })
    feed(0.5, 200)
    const pr = preRolls(out)[0].samples!
    // Last sample is the onset quantum (loud); first is from the quiet lead-in.
    expect(pr[pr.length - 1]).toBe(0.5)
    expect(pr[0]).toBe(0)
  })
})

describe('vad-processor stream chunks', () => {
  const chunkLengths = (sampleRate: number) => {
    const { out, send, feed } = createProcessor(sampleRate)
    configure(send, 300)
    feed(0, 1500)
    send({ type: 'start' })
    feed(0.5, 1000)
    return out
      .filter((m) => m.type === 'audio_chunk' && !m.isPreRoll)
      .map((m) => m.samples!.length)
  }

  it('sizes chunks at 50 ms of the worklet rate', () => {
    const at48 = chunkLengths(48000)
    const at16 = chunkLengths(16000)
    expect(at48.length).toBeGreaterThan(0)
    expect(at16.length).toBeGreaterThan(0)
    expect(new Set(at48)).toEqual(new Set([2400]))
    expect(new Set(at16)).toEqual(new Set([800]))
  })

  it('keeps the speech/silence debounce in ms at 16 kHz', () => {
    const { out, send, feed } = createProcessor(16000)
    send({
      type: 'configure',
      rmsThreshold: 0.01,
      minSpeechDurationMs: 200,
      minSilenceDurationMs: 200,
      preRollMs: 300,
    })
    feed(0, 1500)
    send({ type: 'start' })
    feed(0.5, 150) // EMA rise + 150 ms is under the 200 ms hold
    expect(count(out, 'speech_started')).toBe(0)
    feed(0.5, 150)
    expect(count(out, 'speech_started')).toBe(1)
    feed(0, 150)
    expect(count(out, 'silence_started')).toBe(0)
    feed(0, 150)
    expect(count(out, 'silence_started')).toBe(1)
  })
})
