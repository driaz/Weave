import { describe, expect, it } from 'vitest'
import { encodeWav } from '../wavEncode'

const CAPTURE_RATE = 16000

async function header(blob: Blob) {
  const view = new DataView(await blob.arrayBuffer())
  return {
    channels: view.getUint16(22, true),
    sampleRate: view.getUint32(24, true),
    byteRate: view.getUint32(28, true),
    dataBytes: view.getUint32(40, true),
  }
}

describe('encodeWav at the 16 kHz capture rate', () => {
  it('writes 16000 mono into the header', async () => {
    const h = await header(encodeWav(new Float32Array(CAPTURE_RATE), CAPTURE_RATE))
    expect(h.sampleRate).toBe(16000)
    expect(h.channels).toBe(1)
    expect(h.byteRate).toBe(32000)
  })

  it('a 90 s turn plus one 300 ms pre-roll is ~2.9 MB', async () => {
    const seconds = 90.3
    const samples = Math.round(seconds * CAPTURE_RATE)
    const blob = encodeWav(new Float32Array(samples), CAPTURE_RATE)
    const h = await header(blob)
    expect(h.dataBytes / 2).toBe(samples)
    expect(h.dataBytes / 2 / h.sampleRate).toBeCloseTo(seconds, 3)
    expect(blob.size).toBe(44 + samples * 2)
    expect(blob.size / 1e6).toBeCloseTo(2.89, 2)
  })
})
