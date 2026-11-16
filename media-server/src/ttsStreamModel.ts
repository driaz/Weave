// Models /api/tts-stream may request from ElevenLabs. The default is what
// prod has always used; the override exists so a Netlify preview can hear
// eleven_v4_turbo without changing prod. Anything not listed is a 400.
export const DEFAULT_TTS_STREAM_MODEL = 'eleven_turbo_v2_5'
export const TTS_STREAM_MODELS = [DEFAULT_TTS_STREAM_MODEL, 'eleven_v4_turbo'] as const
export type TtsStreamModel = (typeof TTS_STREAM_MODELS)[number]

/** Absent → default; listed → that model; anything else → null (reject). */
export function resolveTtsStreamModel(value: unknown): TtsStreamModel | null {
  if (value === undefined) return DEFAULT_TTS_STREAM_MODEL
  return (TTS_STREAM_MODELS as readonly unknown[]).includes(value)
    ? (value as TtsStreamModel)
    : null
}

/** JSON body for ElevenLabs POST /v1/text-to-speech/{voice}/stream. */
export function buildTtsStreamUpstreamBody(text: string, model: TtsStreamModel): string {
  return JSON.stringify({
    text,
    model_id: model,
    voice_settings: {
      stability: 0.6,
      similarity_boost: 0.8,
      style: 0.2,
      use_speaker_boost: true,
    },
  })
}
