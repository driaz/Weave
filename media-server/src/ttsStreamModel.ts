// Models /api/tts-stream may request from ElevenLabs. eleven_v4_turbo is
// the default since 2026-11-16 (clearer than turbo v2.5 at pcm_24000, same
// per-char cost). eleven_turbo_v2_5 stays allowlisted, with its original
// voice_settings, for rollback by request or by flipping the default.
// Anything not listed is a 400.
export const DEFAULT_TTS_STREAM_MODEL = 'eleven_v4_turbo'
export const TTS_STREAM_MODELS = ['eleven_turbo_v2_5', 'eleven_v4_turbo'] as const
export type TtsStreamModel = (typeof TTS_STREAM_MODELS)[number]

interface VoiceSettings {
  stability: number
  similarity_boost: number
  style: number
  use_speaker_boost: boolean
}

// v4 Turbo at turbo v2.5's 0.6 / 0.2 read as over-dramatic; 0.85 / 0.0 was
// picked by ear from a stability/style A/B (Backlog: v4 Turbo prod swap).
const VOICE_SETTINGS: Record<TtsStreamModel, VoiceSettings> = {
  eleven_turbo_v2_5: { stability: 0.6, similarity_boost: 0.8, style: 0.2, use_speaker_boost: true },
  eleven_v4_turbo: { stability: 0.85, similarity_boost: 0.8, style: 0, use_speaker_boost: true },
}

/** Absent → default; listed → that model; anything else → null (reject). */
export function resolveTtsStreamModel(value: unknown): TtsStreamModel | null {
  if (value === undefined) return DEFAULT_TTS_STREAM_MODEL
  return (TTS_STREAM_MODELS as readonly unknown[]).includes(value)
    ? (value as TtsStreamModel)
    : null
}

/** JSON body for ElevenLabs POST /v1/text-to-speech/{voice}/stream. */
export function buildTtsStreamUpstreamBody(text: string, model: TtsStreamModel): string {
  return JSON.stringify({ text, model_id: model, voice_settings: VOICE_SETTINGS[model] })
}
