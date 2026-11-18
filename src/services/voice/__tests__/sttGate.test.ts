import { describe, expect, it } from 'vitest'
import {
  audioDurationMs,
  isShortTurn,
  STT_MIN_DURATION_MS,
  STT_MIN_WORDS,
} from '../sttGate'

describe('audioDurationMs', () => {
  it('is samples / sampleRate in milliseconds', () => {
    expect(audioDurationMs(16000, 16000)).toBe(1000)
    expect(audioDurationMs(800, 16000)).toBe(50)
    expect(audioDurationMs(48000 * 28, 48000)).toBe(28000)
  })

  it('is 0 for an unusable sample rate', () => {
    expect(audioDurationMs(16000, 0)).toBe(0)
  })
})

describe('isShortTurn', () => {
  it('accepts a turn at the duration and word floors', () => {
    expect(isShortTurn(STT_MIN_DURATION_MS, STT_MIN_WORDS)).toBe(false)
  })

  it('rejects audio shorter than the floor', () => {
    expect(isShortTurn(STT_MIN_DURATION_MS - 1, 5)).toBe(true)
  })

  it('rejects a transcript under the word floor', () => {
    expect(isShortTurn(30000, STT_MIN_WORDS - 1)).toBe(true)
  })

  it('does not depend on how fast the transcription came back', () => {
    // The 06-09 prod turn: 11 words, Whisper answered in 466 ms. The gate
    // sees the audio length, so a sub-500 ms round trip cannot reject it.
    const whisperRoundTripMs = 466
    const audioMs = audioDurationMs(16000 * 6, 16000)
    expect(whisperRoundTripMs).toBeLessThan(STT_MIN_DURATION_MS)
    expect(isShortTurn(audioMs, 11)).toBe(false)
  })
})
