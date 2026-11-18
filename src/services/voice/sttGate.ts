/**
 * Short-turn gate applied after STT. A turn is rejected when the captured
 * audio is shorter than STT_MIN_DURATION_MS or the transcript has fewer
 * than STT_MIN_WORDS words.
 *
 * The duration is the length of the audio (samples / sampleRate), never
 * the STT round-trip time: a fast transcription must not reject a turn.
 */
export const STT_MIN_DURATION_MS = 500
export const STT_MIN_WORDS = 2

export function audioDurationMs(samples: number, sampleRate: number): number {
  if (sampleRate <= 0) return 0
  return (samples / sampleRate) * 1000
}

export function isShortTurn(audioMs: number, wordCount: number): boolean {
  return audioMs < STT_MIN_DURATION_MS || wordCount < STT_MIN_WORDS
}
