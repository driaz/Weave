import { beforeEach, describe, expect, it } from 'vitest'
import {
  createVoiceSessionStore,
  type VoiceSessionError,
  type VoiceSessionErrorKind,
  type VoiceSessionStore,
} from '../voiceSessionStore'

function makeError(
  kind: VoiceSessionErrorKind = 'unknown',
  overrides: Partial<VoiceSessionError> = {},
): VoiceSessionError {
  return {
    kind,
    message: 'boom',
    recoverable: true,
    ...overrides,
  }
}

describe('voiceSessionStore', () => {
  let store: VoiceSessionStore

  beforeEach(() => {
    store = createVoiceSessionStore()
  })

  describe('initial state', () => {
    it('starts in idle with all nullable fields null', () => {
      expect(store.getState()).toEqual({
        status: 'idle',
        error: null,
        substep: null,
        sessionId: null,
        turnId: null,
      })
    })
  })

  describe('transitions from idle', () => {
    it('userClickedSpeak → initializing, generates sessionId', () => {
      store.userClickedSpeak()
      const s = store.getState()
      expect(s.status).toBe('initializing')
      expect(s.sessionId).toBeTruthy()
      expect(s.turnId).toBeNull()
      expect(s.error).toBeNull()
    })

    it('invalid: vadSpeechStarted throws from idle', () => {
      expect(() => store.vadSpeechStarted()).toThrow(/Invalid.*vadSpeechStarted/)
    })

    it('invalid: userClickedClose throws from idle', () => {
      expect(() => store.userClickedClose()).toThrow(/Invalid.*userClickedClose/)
    })

    it('invalid: firstAudioChunkArrived throws from idle', () => {
      expect(() => store.firstAudioChunkArrived()).toThrow(/Invalid/)
    })
  })

  describe('transitions from initializing', () => {
    beforeEach(() => {
      store.userClickedSpeak()
    })

    it('initComplete → listening, sessionId preserved', () => {
      const sid = store.getState().sessionId
      store.initComplete()
      expect(store.getState().status).toBe('listening')
      expect(store.getState().sessionId).toBe(sid)
    })

    it('initFailed → error, error payload set', () => {
      const e = makeError('mic_denied', { recoverable: false })
      store.initFailed(e)
      expect(store.getState().status).toBe('error')
      expect(store.getState().error).toEqual(e)
    })

    it('userClickedCancel → idle, sessionId cleared', () => {
      store.userClickedCancel()
      expect(store.getState()).toEqual({
        status: 'idle',
        error: null,
        substep: null,
        sessionId: null,
        turnId: null,
      })
    })

    it('invalid: vadSpeechStarted throws from initializing', () => {
      expect(() => store.vadSpeechStarted()).toThrow(/Invalid/)
    })

    it('invalid: userClickedClose throws from initializing (cancel only)', () => {
      expect(() => store.userClickedClose()).toThrow(/Invalid/)
    })
  })

  describe('transitions from listening', () => {
    beforeEach(() => {
      store.userClickedSpeak()
      store.initComplete()
    })

    it('vadSpeechStarted → user_speaking, generates turnId', () => {
      store.vadSpeechStarted()
      const s = store.getState()
      expect(s.status).toBe('user_speaking')
      expect(s.turnId).toBeTruthy()
      expect(s.sessionId).toBeTruthy()
    })

    it('userClickedClose → idle, sessionId and turnId both cleared', () => {
      store.userClickedClose()
      expect(store.getState().status).toBe('idle')
      expect(store.getState().sessionId).toBeNull()
      expect(store.getState().turnId).toBeNull()
    })

    it('fatalError → error, error set, sessionId preserved', () => {
      const sid = store.getState().sessionId
      const e = makeError('mic_lost', { recoverable: false })
      store.fatalError(e)
      expect(store.getState().status).toBe('error')
      expect(store.getState().error).toEqual(e)
      expect(store.getState().sessionId).toBe(sid)
    })

    it('invalid: initComplete throws from listening', () => {
      expect(() => store.initComplete()).toThrow(/Invalid/)
    })
  })

  describe('transitions from user_speaking', () => {
    beforeEach(() => {
      store.userClickedSpeak()
      store.initComplete()
      store.vadSpeechStarted()
    })

    it('vadSpeechEnded → processing_user_turn, turnId preserved', () => {
      const tid = store.getState().turnId
      store.vadSpeechEnded()
      expect(store.getState().status).toBe('processing_user_turn')
      expect(store.getState().turnId).toBe(tid)
    })

    it('userClickedStop → processing_user_turn', () => {
      store.userClickedStop()
      expect(store.getState().status).toBe('processing_user_turn')
    })

    it('userClickedClose → idle, sessionId and turnId both cleared', () => {
      store.userClickedClose()
      const s = store.getState()
      expect(s.status).toBe('idle')
      expect(s.sessionId).toBeNull()
      expect(s.turnId).toBeNull()
    })

    it('fatalError → error, turnId preserved (for log correlation)', () => {
      const tid = store.getState().turnId
      store.fatalError(makeError('audio_stream_corruption'))
      expect(store.getState().status).toBe('error')
      expect(store.getState().turnId).toBe(tid)
    })
  })

  describe('transitions from processing_user_turn', () => {
    beforeEach(() => {
      store.userClickedSpeak()
      store.initComplete()
      store.vadSpeechStarted()
      store.vadSpeechEnded()
    })

    it('firstAudioChunkArrived → assistant_speaking, turnId preserved', () => {
      const tid = store.getState().turnId
      store.firstAudioChunkArrived()
      expect(store.getState().status).toBe('assistant_speaking')
      expect(store.getState().turnId).toBe(tid)
    })

    it('sttReturnedEmpty → listening, turnId cleared, sessionId preserved', () => {
      const sid = store.getState().sessionId
      store.sttReturnedEmpty()
      expect(store.getState().status).toBe('listening')
      expect(store.getState().turnId).toBeNull()
      expect(store.getState().sessionId).toBe(sid)
    })

    it('sttReturnedTooShort → listening, turnId cleared', () => {
      store.sttReturnedTooShort()
      expect(store.getState().status).toBe('listening')
      expect(store.getState().turnId).toBeNull()
    })

    it('sttFailed → error, payload set, turnId preserved', () => {
      const tid = store.getState().turnId
      const e = makeError('stt_failed', { substep: 'stt' })
      store.sttFailed(e)
      expect(store.getState().status).toBe('error')
      expect(store.getState().error).toEqual(e)
      expect(store.getState().turnId).toBe(tid)
    })

    it('claudeFailed → error, payload set', () => {
      const e = makeError('claude_failed', { substep: 'claude' })
      store.claudeFailed(e)
      expect(store.getState().status).toBe('error')
      expect(store.getState().error).toEqual(e)
    })

    it('ttsFailed → error, payload set', () => {
      const e = makeError('tts_failed', { substep: 'tts' })
      store.ttsFailed(e)
      expect(store.getState().status).toBe('error')
      expect(store.getState().error).toEqual(e)
    })

    it('userClickedClose → idle, IDs and substep cleared', () => {
      store.setSubstep('claude')
      store.userClickedClose()
      const s = store.getState()
      expect(s.status).toBe('idle')
      expect(s.sessionId).toBeNull()
      expect(s.turnId).toBeNull()
      expect(s.substep).toBeNull()
    })

    it('setSubstep updates substep through the pipeline', () => {
      store.setSubstep('stt')
      expect(store.getState().substep).toBe('stt')
      store.setSubstep('claude')
      expect(store.getState().substep).toBe('claude')
      store.setSubstep('tts')
      expect(store.getState().substep).toBe('tts')
    })

    it('substep cleared when leaving via sttReturnedEmpty', () => {
      store.setSubstep('stt')
      store.sttReturnedEmpty()
      expect(store.getState().substep).toBeNull()
    })

    it('substep cleared when leaving via firstAudioChunkArrived', () => {
      store.setSubstep('tts')
      store.firstAudioChunkArrived()
      expect(store.getState().substep).toBeNull()
    })

    it('substep cleared when leaving via sttFailed', () => {
      store.setSubstep('stt')
      store.sttFailed(makeError('stt_failed'))
      expect(store.getState().substep).toBeNull()
    })
  })

  describe('transitions from assistant_speaking', () => {
    beforeEach(() => {
      store.userClickedSpeak()
      store.initComplete()
      store.vadSpeechStarted()
      store.vadSpeechEnded()
      store.firstAudioChunkArrived()
    })

    it('playbackEndedNaturally → listening, turnId cleared, sessionId preserved', () => {
      const sid = store.getState().sessionId
      store.playbackEndedNaturally()
      expect(store.getState().status).toBe('listening')
      expect(store.getState().turnId).toBeNull()
      expect(store.getState().sessionId).toBe(sid)
    })

    it('userClickedStop → listening, turnId cleared', () => {
      store.userClickedStop()
      expect(store.getState().status).toBe('listening')
      expect(store.getState().turnId).toBeNull()
    })

    it('userClickedClose → idle', () => {
      store.userClickedClose()
      expect(store.getState().status).toBe('idle')
      expect(store.getState().sessionId).toBeNull()
    })

    it('fatalError → error, both IDs preserved', () => {
      const sid = store.getState().sessionId
      const tid = store.getState().turnId
      store.fatalError(makeError('playback_failed'))
      expect(store.getState().status).toBe('error')
      expect(store.getState().sessionId).toBe(sid)
      expect(store.getState().turnId).toBe(tid)
    })
  })

  describe('transitions from error', () => {
    beforeEach(() => {
      store.userClickedSpeak()
      store.initFailed(makeError('mic_denied'))
    })

    it('userClickedRetry → initializing, sessionId preserved, error cleared', () => {
      const sid = store.getState().sessionId
      store.userClickedRetry()
      const s = store.getState()
      expect(s.status).toBe('initializing')
      expect(s.sessionId).toBe(sid)
      expect(s.error).toBeNull()
      expect(s.turnId).toBeNull()
    })

    it('userClickedDismiss → idle, everything cleared', () => {
      store.userClickedDismiss()
      expect(store.getState()).toEqual({
        status: 'idle',
        error: null,
        substep: null,
        sessionId: null,
        turnId: null,
      })
    })

    it('invalid: vadSpeechStarted throws from error', () => {
      expect(() => store.vadSpeechStarted()).toThrow(/Invalid/)
    })
  })

  describe('correlation ID lifecycle across multi-turn sessions', () => {
    it('sessionId persists across multiple completed turns', () => {
      store.userClickedSpeak()
      store.initComplete()
      const sid = store.getState().sessionId

      store.vadSpeechStarted()
      store.vadSpeechEnded()
      store.firstAudioChunkArrived()
      store.playbackEndedNaturally()
      expect(store.getState().sessionId).toBe(sid)

      store.vadSpeechStarted()
      store.vadSpeechEnded()
      store.firstAudioChunkArrived()
      store.playbackEndedNaturally()
      expect(store.getState().sessionId).toBe(sid)
    })

    it('each new turn generates a fresh turnId', () => {
      store.userClickedSpeak()
      store.initComplete()

      store.vadSpeechStarted()
      const tid1 = store.getState().turnId
      store.vadSpeechEnded()
      store.firstAudioChunkArrived()
      store.playbackEndedNaturally()

      store.vadSpeechStarted()
      const tid2 = store.getState().turnId

      expect(tid1).toBeTruthy()
      expect(tid2).toBeTruthy()
      expect(tid1).not.toBe(tid2)
    })

    it('retry from error clears turnId, keeps sessionId', () => {
      store.userClickedSpeak()
      store.initComplete()
      store.vadSpeechStarted()
      store.vadSpeechEnded()
      const tid = store.getState().turnId
      expect(tid).toBeTruthy()
      store.sttFailed(makeError('stt_failed'))
      expect(store.getState().turnId).toBe(tid)

      const sid = store.getState().sessionId
      store.userClickedRetry()
      expect(store.getState().sessionId).toBe(sid)
      expect(store.getState().turnId).toBeNull()
    })
  })

  describe('subscribe', () => {
    it('notifies on every state change with prev and next', () => {
      const calls: Array<{ status: string; prev: string }> = []
      const unsub = store.subscribe((s, prev) => {
        calls.push({ status: s.status, prev: prev.status })
      })

      store.userClickedSpeak()
      store.initComplete()

      expect(calls).toEqual([
        { status: 'initializing', prev: 'idle' },
        { status: 'listening', prev: 'initializing' },
      ])
      unsub()
    })

    it('unsubscribe stops further notifications', () => {
      let count = 0
      const unsub = store.subscribe(() => {
        count++
      })
      store.userClickedSpeak()
      unsub()
      store.initComplete()
      expect(count).toBe(1)
    })
  })

  describe('setSubstep validation', () => {
    it('throws when called from idle', () => {
      expect(() => store.setSubstep('stt')).toThrow(/only valid during/)
    })

    it('throws when called from listening', () => {
      store.userClickedSpeak()
      store.initComplete()
      expect(() => store.setSubstep('stt')).toThrow(/only valid during/)
    })

    it('throws when called from assistant_speaking', () => {
      store.userClickedSpeak()
      store.initComplete()
      store.vadSpeechStarted()
      store.vadSpeechEnded()
      store.firstAudioChunkArrived()
      expect(() => store.setSubstep('tts')).toThrow(/only valid during/)
    })
  })
})
