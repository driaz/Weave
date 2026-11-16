import { describe, expect, it } from 'vitest'
import {
  buildTtsStreamUpstreamBody,
  DEFAULT_TTS_STREAM_MODEL,
  resolveTtsStreamModel,
  TTS_STREAM_MODELS,
} from '../ttsStreamModel'

describe('resolveTtsStreamModel', () => {
  it('defaults to eleven_turbo_v2_5 when model_id is absent', () => {
    expect(DEFAULT_TTS_STREAM_MODEL).toBe('eleven_turbo_v2_5')
    expect(resolveTtsStreamModel(undefined)).toBe('eleven_turbo_v2_5')
  })

  it('allows exactly the two listed models', () => {
    expect(TTS_STREAM_MODELS).toEqual(['eleven_turbo_v2_5', 'eleven_v4_turbo'])
    expect(resolveTtsStreamModel('eleven_v4_turbo')).toBe('eleven_v4_turbo')
    expect(resolveTtsStreamModel('eleven_turbo_v2_5')).toBe('eleven_turbo_v2_5')
  })

  it.each([null, '', 'eleven_v4', 'eleven_flash_v2_5', 'ELEVEN_V4_TURBO', 42, {}, []])(
    'rejects %j',
    (value) => {
      expect(resolveTtsStreamModel(value)).toBeNull()
    },
  )
})

describe('buildTtsStreamUpstreamBody', () => {
  it('default path is byte-identical to the pre-override body', () => {
    const before =
      '{"text":"hello","model_id":"eleven_turbo_v2_5","voice_settings":' +
      '{"stability":0.6,"similarity_boost":0.8,"style":0.2,"use_speaker_boost":true}}'
    expect(buildTtsStreamUpstreamBody('hello', resolveTtsStreamModel(undefined)!)).toBe(before)
  })

  it('override changes only model_id', () => {
    const body = JSON.parse(buildTtsStreamUpstreamBody('hello', 'eleven_v4_turbo'))
    const base = JSON.parse(buildTtsStreamUpstreamBody('hello', 'eleven_turbo_v2_5'))
    expect(body).toEqual({ ...base, model_id: 'eleven_v4_turbo' })
  })
})
