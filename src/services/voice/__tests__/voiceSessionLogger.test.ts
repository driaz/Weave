import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Phase 8 logger mirror test. Verifies that every voiceSessionLogger
 * event (post-verbose-gate) lands in the active voiceSessionController's
 * processing_log, and that the mirror is a no-op when no session is
 * active.
 *
 * Vitest module mocking is used so the logger sees a controllable
 * controller singleton without needing real Supabase.
 */

const isActiveMock = vi.fn(() => false)
const logEventMock = vi.fn()

vi.mock('../voiceSessionController', () => ({
  voiceSessionController: {
    isActive: () => isActiveMock(),
    logEvent: (event: unknown) => logEventMock(event),
  },
}))

vi.mock('../../eventTracker', () => ({
  trackEvent: vi.fn(),
}))

vi.mock('../../../utils/logger', () => ({
  createNodeLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    persist: vi.fn(),
  }),
}))

import { createVoiceSessionLogger } from '../voiceSessionLogger'

describe('voiceSessionLogger Phase 8 mirror', () => {
  beforeEach(() => {
    isActiveMock.mockReset().mockReturnValue(false)
    logEventMock.mockReset()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('does not call controller.logEvent when no session is active', () => {
    isActiveMock.mockReturnValue(false)
    const logger = createVoiceSessionLogger({ scope: 'test', boardId: 'b1' })

    logger.event('voice.turn.started', 'success', { foo: 'bar' }, {
      correlationId: 'turn-1',
      parentCorrelationId: 'session-1',
    })

    expect(logEventMock).not.toHaveBeenCalled()
  })

  it('mirrors phase, outcome, detail, and correlation ids when active', () => {
    isActiveMock.mockReturnValue(true)
    const logger = createVoiceSessionLogger({ scope: 'test', boardId: 'b1' })

    logger.event(
      'voice.turn.completed',
      'success',
      { isOpening: false },
      { correlationId: 'turn-2', parentCorrelationId: 'session-2' },
    )

    expect(logEventMock).toHaveBeenCalledOnce()
    const event = logEventMock.mock.calls[0][0] as Record<string, unknown>
    expect(event.phase).toBe('voice.turn.completed')
    expect(event.outcome).toBe('success')
    expect(event.detail).toEqual({ isOpening: false })
    expect(event.correlationId).toBe('turn-2')
    expect(event.parentCorrelationId).toBe('session-2')
    expect(typeof event.ts).toBe('string')
    expect(event.ts as string).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('drops verbose-only events when verbose mode is off, even when session is active', () => {
    isActiveMock.mockReturnValue(true)
    // The logger reads localStorage.getItem('weave.voice.logLevel'); when
    // localStorage doesn't exist (node test env), isVerbose() catches and
    // returns false, which is the behavior we want to test.
    const logger = createVoiceSessionLogger({ scope: 'test', boardId: 'b1' })

    logger.event(
      'voice.vad.chunk_received',
      'success',
      { sequence: 0 },
      undefined,
    )

    expect(logEventMock).not.toHaveBeenCalled()
  })

  it('passes verbose-only events through when verbose mode is on and session is active', () => {
    isActiveMock.mockReturnValue(true)
    const original = (globalThis as { localStorage?: Storage }).localStorage
    ;(globalThis as { localStorage: Pick<Storage, 'getItem'> }).localStorage = {
      getItem: () => 'verbose',
    }
    try {
      const logger = createVoiceSessionLogger({ scope: 'test', boardId: 'b1' })

      logger.event(
        'voice.vad.speech_started',
        'success',
        { rms: 0.05 },
        { correlationId: 'turn-3' },
      )

      expect(logEventMock).toHaveBeenCalledOnce()
      const event = logEventMock.mock.calls[0][0] as Record<string, unknown>
      expect(event.phase).toBe('voice.vad.speech_started')
    } finally {
      if (original) {
        ;(globalThis as { localStorage: Storage }).localStorage = original
      } else {
        delete (globalThis as { localStorage?: Storage }).localStorage
      }
    }
  })
})
