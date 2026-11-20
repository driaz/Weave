import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  parseSttScribeFlag,
  resolveTurnTranscript,
  startScribeTurn,
  type SttScribeConfig,
} from '../sttScribe'
import { FakeSttSocket, flushPromises } from './fakeSttSocket'

const V2: SttScribeConfig = { modelId: 'scribe_v2_realtime' }
const IDS = { correlationId: 'turn-1', parentCorrelationId: 'session-1' }
const chunk = () => new Float32Array(800) // 50 ms at 16 kHz

interface Logged {
  phase: string
  outcome: string
  detail: Record<string, unknown>
}

function start(
  config: SttScribeConfig | null = V2,
  opts: { sampleRate?: number; fetchToken?: () => Promise<string> } = {},
) {
  const socket = new FakeSttSocket()
  const clock = { t: 0 }
  const events: Logged[] = []
  const logger = {
    event: (phase: string, outcome: string, detail?: Record<string, unknown>, ids?: unknown) => {
      expect(ids).toEqual(IDS)
      events.push({ phase, outcome, detail: detail ?? {} })
    },
  }
  const fetchToken = vi.fn(opts.fetchToken ?? (async () => 'sutkn_1'))
  const turn = startScribeTurn({
    config,
    sampleRate: opts.sampleRate ?? 16000,
    logger,
    correlationIds: IDS,
    fetchToken,
    createSocket: socket.factory,
    now: () => clock.t,
  })
  const whisper = vi.fn(async () => 'whisper transcript')
  const resolve = () =>
    resolveTurnTranscript({ scribe: turn, transcribeBatch: whisper, logger, correlationIds: IDS })
  const sessionStarted = () =>
    socket.serverSends({ message_type: 'session_started', session_id: 's1', config: { no_verbatim: true } })
  const committed = (text: string) => socket.serverSends({ message_type: 'committed_transcript', text })
  const sourceLines = () => events.filter((e) => e.phase === 'voice.stt.source')
  return { turn, socket, clock, events, fetchToken, whisper, resolve, sessionStarted, committed, sourceLines }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('parseSttScribeFlag', () => {
  it('is on by default, with the v2 realtime model', () => {
    expect(parseSttScribeFlag(null)).toEqual(V2)
    expect(parseSttScribeFlag('')).toEqual(V2)
    expect(parseSttScribeFlag('1')).toEqual(V2)
    expect(parseSttScribeFlag('something else')).toEqual(V2)
  })

  it('is off for the kill switch values', () => {
    expect(parseSttScribeFlag('0')).toBeNull()
    expect(parseSttScribeFlag(' False ')).toBeNull()
    expect(parseSttScribeFlag('off')).toBeNull()
  })

  it('picks the other model by name', () => {
    expect(parseSttScribeFlag(' Scribe_v3_live ')).toEqual({ modelId: 'scribe_v3_live' })
  })
})

describe('Scribe drives the turn', () => {
  it('uses the Scribe final, asks for no_verbatim, and never calls Whisper', async () => {
    const { turn, socket, clock, whisper, resolve, sessionStarted, committed, sourceLines, fetchToken } = start()
    expect(fetchToken).toHaveBeenCalledWith('turn-1')
    turn?.onAudioChunk(chunk())
    clock.t = 180
    await flushPromises()
    expect(new URL(socket.url).searchParams.get('no_verbatim')).toBe('true')
    clock.t = 400
    sessionStarted()
    turn?.onAudioChunk(chunk())

    clock.t = 5000
    turn?.onCommit('silence_timer')
    turn?.onAudioChunk(chunk()) // after the commit: not sent
    expect(socket.sent.map((m) => m.commit)).toEqual([false, false, true])

    const result = resolve()
    clock.t = 5077
    committed('I was thinking about the garden project.')

    await expect(result).resolves.toEqual({
      transcript: 'I was thinking about the garden project.',
      source: 'scribe',
    })
    expect(whisper).not.toHaveBeenCalled()
    expect(sourceLines()).toEqual([
      {
        phase: 'voice.stt.source',
        outcome: 'success',
        detail: {
          source: 'scribe',
          model: 'scribe_v2_realtime',
          commitSource: 'silence_timer',
          chunks: 2,
          tokenMs: 180,
          openMs: 400,
          noVerbatimAcked: true,
          finalMsAfterCommit: 77,
          segments: 1,
          selfCommits: 0,
          selfCommitGuard: false,
          transcript: 'I was thinking about the garden project.',
          rawTranscript: null,
        },
      },
    ])
  })

  it('uses Whisper only, with no token request or socket, when the kill switch is set', async () => {
    const { turn, socket, whisper, resolve, sourceLines, fetchToken } = start(null)
    expect(turn).toBeNull()
    await expect(resolve()).resolves.toEqual({ transcript: 'whisper transcript', source: 'whisper' })
    expect(fetchToken).not.toHaveBeenCalled()
    expect(socket.created).toBe(false)
    expect(whisper).toHaveBeenCalledTimes(1)
    expect(sourceLines().map((e) => e.detail)).toEqual([{ source: 'whisper', scribeDisabled: true }])
  })

  it('is on when nothing is stored (no localStorage in the node test environment)', () => {
    const turn = startScribeTurn({
      sampleRate: 16000,
      logger: { event: () => undefined },
      correlationIds: IDS,
      fetchToken: async () => 'sutkn_1',
      createSocket: new FakeSttSocket().factory,
    })
    expect(turn).not.toBeNull()
    turn?.cancel()
  })
})

describe('Whisper fallback', () => {
  async function fallback(reason: string) {
    const ctx = start()
    await flushPromises()
    return { ...ctx, reason }
  }

  function expectFallback(ctx: ReturnType<typeof start>, reason: string, error: string | null) {
    expect(ctx.whisper).toHaveBeenCalledTimes(1)
    expect(ctx.sourceLines()).toHaveLength(1)
    expect(ctx.sourceLines()[0].detail).toMatchObject({ source: 'whisper_fallback', fallbackReason: reason, error })
    expect(ctx.socket.created ? ctx.socket.closed : true).toBe(true)
  }

  it('timeout: no final within 500 ms of the commit', async () => {
    vi.useFakeTimers()
    const ctx = await fallback('timeout')
    ctx.sessionStarted()
    ctx.turn?.onAudioChunk(chunk())
    ctx.turn?.onCommit('silence_timer')
    const result = ctx.resolve()

    await vi.advanceTimersByTimeAsync(499)
    expect(ctx.whisper).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    await expect(result).resolves.toEqual({ transcript: 'whisper transcript', source: 'whisper_fallback' })
    expectFallback(ctx, 'timeout', 'final_timeout')

    // A final that turns up afterwards is ignored: the turn already ran on Whisper.
    ctx.committed('late scribe text')
    expect(ctx.events.filter((e) => e.phase === 'voice.stt.late_segment')).toEqual([])
  })

  it('the 500 ms runs from the commit, not from when the transcript is asked for', async () => {
    vi.useFakeTimers()
    const ctx = await fallback('timeout')
    ctx.sessionStarted()
    ctx.turn?.onCommit('silence_timer')
    ctx.clock.t = 300 // e.g. WAV encoding on a slow device
    const result = ctx.resolve()
    await vi.advanceTimersByTimeAsync(200)
    await expect(result).resolves.toMatchObject({ source: 'whisper_fallback' })
  })

  it('socket_error: the socket closes while waiting for the final', async () => {
    const ctx = await fallback('socket_error')
    ctx.sessionStarted()
    ctx.turn?.onCommit('silence_timer')
    const result = ctx.resolve()
    ctx.socket.serverCloses()
    await expect(result).resolves.toMatchObject({ source: 'whisper_fallback' })
    expectFallback(ctx, 'socket_error', 'socket_closed')
  })

  it('socket_error: the socket closed mid-turn, before the commit; no wait at all', async () => {
    const ctx = await fallback('socket_error')
    ctx.sessionStarted()
    ctx.turn?.onAudioChunk(chunk())
    ctx.socket.serverCloses()
    ctx.turn?.onAudioChunk(chunk())
    ctx.turn?.onCommit('silence_timer')
    await expect(ctx.resolve()).resolves.toMatchObject({ source: 'whisper_fallback' })
    expectFallback(ctx, 'socket_error', 'socket_closed')
  })

  it('socket_error: the server sends an error message', async () => {
    const ctx = await fallback('socket_error')
    ctx.sessionStarted()
    ctx.turn?.onCommit('user_stop')
    const result = ctx.resolve()
    ctx.socket.serverSends({ message_type: 'quota_exceeded', error: 'out of credits' })
    await result
    expectFallback(ctx, 'socket_error', 'quota_exceeded: out of credits')
  })

  it('empty_final: Scribe answers the commit with no text', async () => {
    const ctx = await fallback('empty_final')
    ctx.sessionStarted()
    ctx.turn?.onAudioChunk(chunk())
    ctx.turn?.onCommit('silence_timer')
    const result = ctx.resolve()
    ctx.committed('  ')
    await result
    expectFallback(ctx, 'empty_final', null)
  })

  it('not_ready: the session had not started at the commit; no wait, no commit sent', async () => {
    const ctx = await fallback('not_ready')
    ctx.turn?.onAudioChunk(chunk())
    ctx.turn?.onCommit('silence_timer')
    await expect(ctx.resolve()).resolves.toMatchObject({ source: 'whisper_fallback' })
    expectFallback(ctx, 'not_ready', 'session_not_started')
    expect(ctx.socket.sent).toEqual([])
  })

  it('not_ready: the token request failed', async () => {
    const ctx = start(V2, {
      fetchToken: async () => {
        throw new Error('stt-token 401')
      },
    })
    await flushPromises()
    ctx.turn?.onAudioChunk(chunk())
    ctx.turn?.onCommit('silence_timer')
    await ctx.resolve()
    expectFallback(ctx, 'not_ready', 'token_failed: stt-token 401')
    expect(ctx.socket.created).toBe(false)
  })

  it('not_ready: a capture rate other than 16 kHz never opens a socket', async () => {
    const ctx = start(V2, { sampleRate: 48000 })
    await flushPromises()
    ctx.turn?.onAudioChunk(chunk())
    ctx.turn?.onCommit('silence_timer')
    await ctx.resolve()
    expectFallback(ctx, 'not_ready', 'unsupported_sample_rate: 48000')
    expect(ctx.fetchToken).not.toHaveBeenCalled()
  })

  it('a Whisper failure on the fallback rejects, after the source line is logged', async () => {
    const ctx = await fallback('not_ready')
    ctx.whisper.mockRejectedValueOnce(new Error('STT proxy error (502)'))
    ctx.turn?.onCommit('silence_timer')
    await expect(ctx.resolve()).rejects.toThrow('STT proxy error (502)')
    expect(ctx.sourceLines()).toHaveLength(1)
  })

  it('a socket that throws on send falls back instead of breaking the turn', async () => {
    const ctx = await fallback('socket_error')
    ctx.sessionStarted()
    ctx.socket.closed = true // the fake throws on send once closed
    ctx.turn?.onAudioChunk(chunk())
    ctx.turn?.onCommit('silence_timer')
    await ctx.resolve()
    expectFallback(ctx, 'socket_error', 'send_failed: socket is closed')
  })
})

/**
 * A fake Scribe server for long turns. Every 50 ms chunk it receives stands
 * for one spoken word, numbered in arrival order. It commits by itself once
 * `selfCommitAfterChunks` chunks have accumulated (36 s = 720 chunks) and
 * answers a manual commit with whatever has accumulated since.
 */
function fakeLongTurnServer(ctx: ReturnType<typeof start>, opts: { holdSelfCommits?: boolean } = {}) {
  const selfCommitAfterChunks = 720
  let seen = 0
  let wordsHeard = 0
  let accumulated: string[] = []
  const held: string[] = []
  const pump = () => {
    for (; seen < ctx.socket.sent.length; seen++) {
      const message = ctx.socket.sent[seen]
      if (!message.commit) {
        accumulated.push(`w${wordsHeard++}`)
        if (accumulated.length < selfCommitAfterChunks) continue
      }
      const text = accumulated.join(' ')
      accumulated = []
      // A held self-commit is one whose answer is still on the wire.
      if (!message.commit && opts.holdSelfCommits) held.push(text)
      else ctx.committed(text)
    }
  }
  const releaseHeld = () => held.splice(0).forEach((text) => ctx.committed(text))
  return { pump, releaseHeld }
}

const words = (n: number) => Array.from({ length: n }, (_, i) => `w${i}`).join(' ')

describe('a single turn longer than the 36 s server self-commit', () => {
  async function speak(ctx: ReturnType<typeof start>, server: { pump: () => void }, chunks: number) {
    await flushPromises()
    ctx.sessionStarted()
    for (let i = 0; i < chunks; i++) {
      ctx.clock.t += 50
      ctx.turn?.onAudioChunk(chunk())
      server.pump()
    }
  }

  it('40 s: joins the self-committed segment and the tail in order, nothing lost or repeated', async () => {
    const ctx = start()
    const server = fakeLongTurnServer(ctx)
    await speak(ctx, server, 800)

    ctx.turn?.onCommit('silence_timer')
    const result = ctx.resolve()
    ctx.clock.t += 80
    server.pump()

    const { transcript, source } = await result
    expect(source).toBe('scribe')
    expect(transcript).toBe(words(800))
    expect(ctx.whisper).not.toHaveBeenCalled()
    expect(ctx.sourceLines()[0].detail).toMatchObject({
      source: 'scribe',
      chunks: 800,
      segments: 2,
      selfCommits: 1,
      selfCommitGuard: false,
      finalMsAfterCommit: 80,
    })
    expect(ctx.socket.sent.filter((m) => m.commit)).toHaveLength(1)
  })

  it('80 s: two self-commits and the tail, still in order', async () => {
    const ctx = start()
    const server = fakeLongTurnServer(ctx)
    await speak(ctx, server, 1600)
    ctx.turn?.onCommit('silence_timer')
    const result = ctx.resolve()
    server.pump()

    expect((await result).transcript).toBe(words(1600))
    expect(ctx.sourceLines()[0].detail).toMatchObject({ segments: 3, selfCommits: 2 })
  })

  it('exactly 36 s: an empty answer to our commit after the self-commit does not fall back', async () => {
    const ctx = start()
    const server = fakeLongTurnServer(ctx)
    await speak(ctx, server, 720)
    ctx.turn?.onCommit('silence_timer')
    const result = ctx.resolve()
    server.pump() // the manual commit finds nothing new: committed with empty text

    await expect(result).resolves.toEqual({ transcript: words(720), source: 'scribe' })
    expect(ctx.sourceLines()[0].detail).toMatchObject({ segments: 1, selfCommits: 1 })
  })

  it('the self-commit answer arrives after our commit: waits for both, drops no tail', async () => {
    const ctx = start()
    const server = fakeLongTurnServer(ctx, { holdSelfCommits: true })
    await speak(ctx, server, 730) // self-commit at 720, its answer still on the wire

    ctx.turn?.onCommit('silence_timer')
    const result = ctx.resolve()
    let settled = false
    void result.then(() => (settled = true))

    server.releaseHeld() // the self-committed segment lands first
    await flushPromises()
    expect(settled).toBe(false)
    server.pump() // then the answer to our commit, with the last 10 words

    expect((await result).transcript).toBe(words(730))
    expect(ctx.sourceLines()[0].detail).toMatchObject({ segments: 2, selfCommitGuard: true })
  })

  it('35 s outstanding and the server does not self-commit: Whisper takes the turn', async () => {
    vi.useFakeTimers()
    const ctx = start()
    const server = fakeLongTurnServer(ctx)
    await speak(ctx, server, 700)
    ctx.turn?.onCommit('silence_timer')
    const result = ctx.resolve()
    server.pump() // one answer only; the guard expected two
    await vi.advanceTimersByTimeAsync(500)

    await expect(result).resolves.toEqual({ transcript: 'whisper transcript', source: 'whisper_fallback' })
    expect(ctx.sourceLines()[0].detail).toMatchObject({ fallbackReason: 'timeout' })
  })

  it('logs a segment that lands after the final was used', async () => {
    vi.useFakeTimers()
    const ctx = start()
    await flushPromises()
    ctx.sessionStarted()
    ctx.turn?.onAudioChunk(chunk())
    ctx.turn?.onCommit('silence_timer')
    const result = ctx.resolve()
    ctx.committed('the first part')
    await result
    ctx.committed('and a part that came too late')

    expect(ctx.events.filter((e) => e.phase === 'voice.stt.late_segment')).toEqual([
      {
        phase: 'voice.stt.late_segment',
        outcome: 'failed',
        detail: { model: 'scribe_v2_realtime', text: 'and a part that came too late' },
      },
    ])
    await vi.advanceTimersByTimeAsync(2000)
    expect(ctx.socket.closed).toBe(true)
  })
})
