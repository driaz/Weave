import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildSttStreamUrl, floatToPcm16Base64, SttStream } from '../sttStreamClient'
import { FakeSttSocket, flushPromises } from './fakeSttSocket'

function decodePcm16(base64: string): number[] {
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
  const view = new DataView(bytes.buffer)
  return Array.from({ length: bytes.length / 2 }, (_, i) => view.getInt16(i * 2, true))
}

function open(overrides: { token?: Promise<string> } = {}) {
  const socket = new FakeSttSocket()
  const clock = { t: 0 }
  const stream = new SttStream({
    token: overrides.token ?? Promise.resolve('sutkn_1'),
    modelId: 'scribe_v2_realtime',
    sampleRate: 16000,
    createSocket: socket.factory,
    now: () => clock.t,
  })
  return { socket, stream, clock }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('floatToPcm16Base64', () => {
  it('encodes 16-bit little-endian PCM and clamps out-of-range samples', () => {
    const encoded = floatToPcm16Base64(new Float32Array([0, 1, -1, 0.5, 2, -2]))
    expect(decodePcm16(encoded)).toEqual([0, 32767, -32768, 16383, 32767, -32768])
  })

  it('encodes a 50 ms chunk at 16 kHz to 1600 bytes', () => {
    const encoded = floatToPcm16Base64(new Float32Array(800))
    expect(atob(encoded).length).toBe(1600)
  })
})

describe('buildSttStreamUrl', () => {
  it('uses the realtime endpoint with manual commit and 16 kHz PCM', () => {
    const url = new URL(buildSttStreamUrl('sutkn_1', 'scribe_v3_live', 16000))
    expect(url.origin + url.pathname).toBe('wss://api.elevenlabs.io/v1/speech-to-text/realtime')
    expect(Object.fromEntries(url.searchParams)).toEqual({
      model_id: 'scribe_v3_live',
      token: 'sutkn_1',
      audio_format: 'pcm_16000',
      language_code: 'en',
      commit_strategy: 'manual',
    })
  })
})

describe('SttStream', () => {
  it('holds audio until session_started, then sends it in order with the reference field names', async () => {
    const { socket, stream, clock } = open()
    stream.sendAudio(new Float32Array([0.5]))
    stream.sendAudio(new Float32Array([-0.5]))
    await flushPromises()

    expect(socket.created).toBe(true)
    expect(socket.url).toContain('token=sutkn_1')
    expect(socket.sent).toEqual([])
    expect(stream.readyAt).toBeNull()

    clock.t = 420
    socket.serverSends({ message_type: 'session_started', session_id: 's1', config: {} })
    stream.sendAudio(new Float32Array([0]))

    expect(stream.readyAt).toBe(420)
    expect(socket.sent).toHaveLength(3)
    expect(Object.keys(socket.sent[0]).sort()).toEqual([
      'audio_base_64', 'commit', 'message_type', 'sample_rate',
    ])
    expect(socket.sent.map((m) => decodePcm16(m.audio_base_64)[0])).toEqual([16383, -16384, 0])
    expect(socket.sent.every((m) => m.message_type === 'input_audio_chunk')).toBe(true)
    expect(socket.sent.every((m) => m.commit === false && m.sample_rate === 16000)).toBe(true)
    expect(stream.chunksSent).toBe(3)
  })

  it('commits with an empty chunk and resolves with the committed transcript', async () => {
    const { socket, stream, clock } = open()
    await flushPromises()
    socket.serverSends({ message_type: 'session_started', session_id: 's1', config: {} })
    stream.sendAudio(new Float32Array(800))
    stream.commit()
    const final = stream.waitForFinal(1000)

    expect(socket.sent[1]).toEqual({
      message_type: 'input_audio_chunk',
      audio_base_64: '',
      commit: true,
      sample_rate: 16000,
    })

    socket.serverSends({ message_type: 'partial_transcript', text: 'hello th' })
    clock.t = 310
    socket.serverSends({ message_type: 'committed_transcript', text: ' hello there ' })

    await expect(final).resolves.toEqual({ text: 'hello there', segments: 1, finalAt: 310 })
    expect(socket.closed).toBe(true)
  })

  it('joins segments the server committed by itself with the final one', async () => {
    const { socket, stream } = open()
    await flushPromises()
    socket.serverSends({ message_type: 'session_started', session_id: 's1', config: {} })
    stream.sendAudio(new Float32Array(800))
    // ~36 s of audio: the server commits without being asked.
    socket.serverSends({ message_type: 'committed_transcript', text: 'first part' })

    let settled = false
    stream.commit()
    const final = stream.waitForFinal(1000)
    void final.then(() => (settled = true))
    await flushPromises()
    expect(settled).toBe(false)

    socket.serverSends({ message_type: 'committed_transcript', text: 'second part' })
    await expect(final).resolves.toMatchObject({ text: 'first part second part', segments: 2 })
  })

  it('waits for every commit sent before resolving', async () => {
    const { socket, stream } = open()
    await flushPromises()
    socket.serverSends({ message_type: 'session_started', session_id: 's1', config: {} })
    stream.commit()
    stream.commit()
    let settled = false
    const final = stream.waitForFinal(1000)
    void final.then(() => (settled = true))

    socket.serverSends({ message_type: 'committed_transcript', text: 'one' })
    await flushPromises()
    expect(settled).toBe(false)
    socket.serverSends({ message_type: 'committed_transcript', text: 'two' })
    await expect(final).resolves.toMatchObject({ text: 'one two', segments: 2 })
  })

  it('rejects with the server error type and closes', async () => {
    const { socket, stream } = open()
    await flushPromises()
    socket.serverSends({ message_type: 'session_started', session_id: 's1', config: {} })
    stream.commit()
    const final = stream.waitForFinal(1000)
    socket.serverSends({ message_type: 'commit_throttled', error: 'too many commits' })

    await expect(final).rejects.toThrow('commit_throttled: too many commits')
    expect(socket.closed).toBe(true)
  })

  it('rejects when the token request fails and never opens a socket', async () => {
    const { socket, stream } = open({ token: Promise.reject(new Error('stt-token 401')) })
    stream.sendAudio(new Float32Array(800))
    await flushPromises()
    stream.commit()

    await expect(stream.waitForFinal(1000)).rejects.toThrow('token_failed: stt-token 401')
    expect(socket.created).toBe(false)
  })

  it('rejects when the socket closes before the final', async () => {
    const { socket, stream } = open()
    await flushPromises()
    socket.serverSends({ message_type: 'session_started', session_id: 's1', config: {} })
    stream.commit()
    const final = stream.waitForFinal(1000)
    socket.serverCloses()
    await expect(final).rejects.toThrow('socket_closed')
  })

  it('rejects after the timeout when no final arrives', async () => {
    vi.useFakeTimers()
    const { socket, stream } = open()
    await flushPromises()
    socket.serverSends({ message_type: 'session_started', session_id: 's1', config: {} })
    stream.commit()
    const final = stream.waitForFinal(1000)
    const assertion = expect(final).rejects.toThrow('final_timeout')
    await vi.advanceTimersByTimeAsync(1000)
    await assertion
    expect(socket.closed).toBe(true)
  })

  it('sends nothing after close, and does not open a socket if closed before the token arrives', async () => {
    const early = open()
    early.stream.close()
    await flushPromises()
    expect(early.socket.created).toBe(false)

    const { socket, stream } = open()
    await flushPromises()
    socket.serverSends({ message_type: 'session_started', session_id: 's1', config: {} })
    stream.close()
    stream.sendAudio(new Float32Array(800))
    stream.commit()
    expect(socket.sent).toEqual([])
  })
})
