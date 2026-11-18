import { describe, expect, it, vi } from 'vitest'
import { parseSttShadowFlag, startSttShadowTurn, type SttShadowConfig } from '../sttShadow'
import { FakeSttSocket, flushPromises } from './fakeSttSocket'

const EXPIRY: SttShadowConfig = { commitOn: 'expiry', modelId: 'scribe_v2_realtime' }
const SILENCE: SttShadowConfig = { commitOn: 'silence', modelId: 'scribe_v2_realtime' }
const IDS = { correlationId: 'turn-1', parentCorrelationId: 'session-1' }
const chunk = () => new Float32Array(800)

function start(config: SttShadowConfig | null, opts: { sampleRate?: number; tokenFails?: boolean } = {}) {
  const socket = new FakeSttSocket()
  const clock = { t: 0 }
  const events: Array<{ phase: string; outcome: string; detail: Record<string, unknown> }> = []
  const fetchToken = vi.fn(async () => {
    if (opts.tokenFails) throw new Error('stt-token 401')
    return 'sutkn_1'
  })
  const turn = startSttShadowTurn({
    config,
    sampleRate: opts.sampleRate ?? 16000,
    logger: {
      event: (phase, outcome, detail, ids) => {
        expect(ids).toEqual(IDS)
        events.push({ phase, outcome, detail: detail ?? {} })
      },
    },
    correlationIds: IDS,
    fetchToken,
    createSocket: socket.factory,
    now: () => clock.t,
    finalTimeoutMs: 1000,
  })
  const sessionStarted = () =>
    socket.serverSends({ message_type: 'session_started', session_id: 's1', config: {} })
  const committed = (text: string) => socket.serverSends({ message_type: 'committed_transcript', text })
  return { turn, socket, clock, events, fetchToken, sessionStarted, committed }
}

describe('parseSttShadowFlag', () => {
  it('is off by default and for unknown values', () => {
    expect(parseSttShadowFlag(null)).toBeNull()
    expect(parseSttShadowFlag('')).toBeNull()
    expect(parseSttShadowFlag('0')).toBeNull()
    expect(parseSttShadowFlag('false')).toBeNull()
    expect(parseSttShadowFlag('1,scribe_v9')).toBeNull()
  })

  it('reads the commit point and the model', () => {
    expect(parseSttShadowFlag('1')).toEqual(EXPIRY)
    expect(parseSttShadowFlag('true')).toEqual(EXPIRY)
    expect(parseSttShadowFlag('silence')).toEqual(SILENCE)
    expect(parseSttShadowFlag('scribe_v3_live')).toEqual({ commitOn: 'expiry', modelId: 'scribe_v3_live' })
    expect(parseSttShadowFlag(' Silence , scribe_v3_live ')).toEqual({
      commitOn: 'silence',
      modelId: 'scribe_v3_live',
    })
  })
})

describe('startSttShadowTurn', () => {
  it('does nothing when the flag is off: no token request, no socket, no log', async () => {
    const { turn, socket, events, fetchToken } = start(null)
    await flushPromises()
    expect(turn).toBeNull()
    expect(fetchToken).not.toHaveBeenCalled()
    expect(socket.created).toBe(false)
    expect(events).toEqual([])
  })

  it('reads the flag from localStorage when no config is passed, and is off without one', () => {
    // The node test environment has no localStorage, the same as an unset flag.
    const turn = startSttShadowTurn({
      sampleRate: 16000,
      logger: { event: () => undefined },
      correlationIds: IDS,
      fetchToken: async () => 'unused',
    })
    expect(turn).toBeNull()
  })

  it('skips a capture rate other than 16 kHz', async () => {
    const { turn, events, fetchToken } = start(EXPIRY, { sampleRate: 48000 })
    expect(turn).toBeNull()
    expect(fetchToken).not.toHaveBeenCalled()
    expect(events).toEqual([
      {
        phase: 'voice.stt.shadow_failed',
        outcome: 'skipped',
        detail: { mode: 'shadow', error: 'unsupported_sample_rate', sampleRate: 48000 },
      },
    ])
  })
})

describe('SttShadowTurn', () => {
  it('streams the turn, commits at the VAD commit, and logs timing against Whisper', async () => {
    const { turn, socket, clock, events, fetchToken, sessionStarted, committed } = start(EXPIRY)
    expect(fetchToken).toHaveBeenCalledWith('turn-1')

    turn?.onAudioChunk(chunk())
    clock.t = 180
    await flushPromises()
    clock.t = 400
    sessionStarted()
    turn?.onAudioChunk(chunk())
    turn?.onSilenceStarted()
    expect(socket.sent.filter((m) => m.commit)).toHaveLength(0)

    clock.t = 5000
    turn?.onCommit('silence_timer')
    turn?.onAudioChunk(chunk()) // after the commit: not sent
    expect(socket.sent.map((m) => m.commit)).toEqual([false, false, true])

    clock.t = 5350
    committed('So I was thinking about the garden project.')
    clock.t = 7800
    turn?.onWhisperResult('So, I was thinking about the garden project')
    await flushPromises()

    expect(events).toEqual([
      {
        phase: 'voice.stt.shadow_result',
        outcome: 'success',
        detail: {
          mode: 'shadow',
          model: 'scribe_v2_realtime',
          commitOn: 'expiry',
          commitSource: 'silence_timer',
          chunks: 2,
          commits: 1,
          tokenMs: 180,
          openMs: 400,
          whisperMsAfterCommit: 2800,
          segments: 1,
          finalMsAfterCommit: 350,
          leadMs: 2450,
          shadowWords: 8,
          whisperWords: 8,
          wordErrorRate: 0,
          shadowTranscript: 'So I was thinking about the garden project.',
        },
      },
    ])
    expect(socket.closed).toBe(true)
  })

  it('logs the word error rate when the transcripts differ', async () => {
    const { turn, events, sessionStarted, committed } = start(EXPIRY)
    await flushPromises()
    sessionStarted()
    turn?.onAudioChunk(chunk())
    turn?.onCommit('silence_timer')
    committed('the quick red fox')
    turn?.onWhisperResult('the quick brown fox')
    await flushPromises()
    expect(events[0].detail).toMatchObject({ wordErrorRate: 0.25, shadowWords: 4, whisperWords: 4 })
  })

  it('waits for a final that arrives after Whisper', async () => {
    const { turn, clock, events, sessionStarted, committed } = start(EXPIRY)
    await flushPromises()
    sessionStarted()
    turn?.onAudioChunk(chunk())
    clock.t = 1000
    turn?.onCommit('silence_timer')
    clock.t = 1500
    turn?.onWhisperResult('hello there')
    await flushPromises()
    expect(events).toEqual([])

    clock.t = 1900
    committed('hello there')
    await flushPromises()
    expect(events[0].detail).toMatchObject({
      whisperMsAfterCommit: 500,
      finalMsAfterCommit: 900,
      leadMs: -400,
    })
  })

  it('in silence mode commits at each pause and has the final before the VAD commit', async () => {
    const { turn, socket, clock, events, sessionStarted, committed } = start(SILENCE)
    await flushPromises()
    sessionStarted()
    turn?.onAudioChunk(chunk())
    clock.t = 2000
    turn?.onSilenceStarted()
    clock.t = 2300
    committed('first thought')
    turn?.onAudioChunk(chunk())
    clock.t = 6000
    turn?.onSilenceStarted()
    clock.t = 6250
    committed('second thought')

    clock.t = 7500
    turn?.onCommit('silence_timer')
    expect(socket.sent.filter((m) => m.commit)).toHaveLength(2)
    turn?.onWhisperResult('first thought second thought')
    await flushPromises()

    expect(events[0].detail).toMatchObject({
      commitOn: 'silence',
      commits: 2,
      segments: 2,
      finalMsAfterCommit: -1250,
      shadowTranscript: 'first thought second thought',
      wordErrorRate: 0,
    })
  })

  it('in silence mode still commits when the user presses stop mid-speech', async () => {
    const { turn, socket, sessionStarted } = start(SILENCE)
    await flushPromises()
    sessionStarted()
    turn?.onAudioChunk(chunk())
    turn?.onSilenceStarted()
    turn?.onAudioChunk(chunk())
    turn?.onCommit('user_stop')
    expect(socket.sent.map((m) => m.commit)).toEqual([false, true, false, true])
  })

  it('logs a failure without throwing when the stream errors', async () => {
    const { turn, socket, events, sessionStarted } = start(EXPIRY)
    await flushPromises()
    sessionStarted()
    turn?.onAudioChunk(chunk())
    socket.serverSends({ message_type: 'quota_exceeded', error: 'out of credits' })
    turn?.onAudioChunk(chunk())
    turn?.onCommit('silence_timer')
    turn?.onWhisperResult('hello there')
    await flushPromises()

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      phase: 'voice.stt.shadow_failed',
      outcome: 'failed',
      detail: { mode: 'shadow', error: 'quota_exceeded: out of credits', whisperMsAfterCommit: 0 },
    })
  })

  it('logs a failure when the token cannot be minted', async () => {
    const { turn, socket, events } = start(EXPIRY, { tokenFails: true })
    turn?.onAudioChunk(chunk())
    await flushPromises()
    turn?.onCommit('silence_timer')
    turn?.onWhisperResult(null)
    await flushPromises()

    expect(socket.created).toBe(false)
    expect(events[0]).toMatchObject({
      phase: 'voice.stt.shadow_failed',
      detail: { error: 'token_failed: stt-token 401', tokenMs: null, openMs: null, whisperMsAfterCommit: null },
    })
  })

  it('still logs the streaming timing when Whisper failed', async () => {
    const { turn, clock, events, sessionStarted, committed } = start(EXPIRY)
    await flushPromises()
    sessionStarted()
    turn?.onAudioChunk(chunk())
    turn?.onCommit('silence_timer')
    clock.t = 300
    committed('hello there')
    turn?.onWhisperResult(null)
    await flushPromises()
    expect(events[0].detail).toMatchObject({
      finalMsAfterCommit: 300,
      whisperMsAfterCommit: null,
      leadMs: null,
      whisperWords: null,
      wordErrorRate: null,
    })
  })

  it('cancel closes the socket and logs nothing', async () => {
    const { turn, socket, events, sessionStarted } = start(EXPIRY)
    await flushPromises()
    sessionStarted()
    turn?.onAudioChunk(chunk())
    turn?.cancel()
    turn?.onAudioChunk(chunk())
    await flushPromises()
    expect(socket.closed).toBe(true)
    expect(socket.sent).toHaveLength(1)
    expect(events).toEqual([])
  })
})
