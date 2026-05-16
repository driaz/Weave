import { describe, expect, it, vi } from 'vitest'
import {
  createVoiceSessionController,
  type VoiceSessionControllerDeps,
} from '../voiceSessionController'

/**
 * Pure unit tests for the controller. The persistence layer and
 * Gemini call are injected as stubs so these tests don't touch the
 * network or the database.
 */

const emptySnapshot = {
  nodes: [],
  edges: [],
  captured_at: new Date().toISOString(),
}

function makeDeps(overrides: Partial<VoiceSessionControllerDeps> = {}): {
  deps: VoiceSessionControllerDeps
  createSession: ReturnType<typeof vi.fn>
  endSession: ReturnType<typeof vi.fn>
  writeUtterance: ReturnType<typeof vi.fn>
  updateUtteranceEmbedding: ReturnType<typeof vi.fn>
  embedText: ReturnType<typeof vi.fn>
} {
  const createSession = vi.fn(async () => ({
    id: 'session-123',
    user_id: 'user-1',
    anchor_edge_id: null,
    board_snapshot: emptySnapshot,
    started_at: new Date().toISOString(),
    ended_at: null,
    end_reason: null,
    processing_log: [],
    summary: null,
  }))
  const endSession = vi.fn(async () => ({}) as never)
  const writeUtterance = vi.fn(async () => ({
    utteranceId: 'utt-1',
    stripped: false,
    event: undefined,
  }))
  const updateUtteranceEmbedding = vi.fn(async () => undefined)
  const embedText = vi.fn(async () => Array.from({ length: 3072 }, () => 0.1))

  return {
    deps: {
      createSession,
      endSession,
      writeUtterance,
      updateUtteranceEmbedding,
      embedText,
      ...overrides,
    },
    createSession,
    endSession,
    writeUtterance,
    updateUtteranceEmbedding,
    embedText,
  }
}

describe('VoiceSessionController', () => {
  it('startSession creates a row and returns the session id', async () => {
    const { deps, createSession } = makeDeps()
    const controller = createVoiceSessionController(deps)

    const id = await controller.startSession({
      anchorEdgeId: 'edge-1',
      boardSnapshot: emptySnapshot,
    })

    expect(id).toBe('session-123')
    expect(controller.isActive()).toBe(true)
    expect(controller.getSessionId()).toBe('session-123')
    expect(createSession).toHaveBeenCalledOnce()
    const arg = createSession.mock.calls[0][0]
    expect(arg.anchor_edge_id).toBe('edge-1')
  })

  it('startSession rejects when a session is already active', async () => {
    const { deps } = makeDeps()
    const controller = createVoiceSessionController(deps)
    await controller.startSession({ anchorEdgeId: null, boardSnapshot: emptySnapshot })
    await expect(
      controller.startSession({ anchorEdgeId: null, boardSnapshot: emptySnapshot }),
    ).rejects.toThrow(/already active/)
  })

  it('recordUtterance increments the counter on a written utterance', async () => {
    const { deps, writeUtterance } = makeDeps()
    const controller = createVoiceSessionController(deps)
    await controller.startSession({ anchorEdgeId: null, boardSnapshot: emptySnapshot })

    await controller.recordUtterance({
      speaker: 'user',
      text: 'first',
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
    })
    await controller.recordUtterance({
      speaker: 'assistant',
      text: 'second',
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
    })

    expect(writeUtterance).toHaveBeenCalledTimes(2)
    expect(writeUtterance.mock.calls[0][0].utterance_index).toBe(0)
    expect(writeUtterance.mock.calls[1][0].utterance_index).toBe(1)
  })

  it('does not advance the counter when an utterance is stripped', async () => {
    const writeUtterance = vi
      .fn()
      .mockResolvedValueOnce({
        utteranceId: null,
        stripped: true,
        event: {
          phase: 'voice.sentinel.stripped',
          outcome: 'success',
          detail: { text: 'Begin.' },
          ts: new Date().toISOString(),
        },
      })
      .mockResolvedValueOnce({ utteranceId: 'utt-2', stripped: false })
    const { deps } = makeDeps({ writeUtterance })
    const controller = createVoiceSessionController(deps)
    await controller.startSession({ anchorEdgeId: null, boardSnapshot: emptySnapshot })

    await controller.recordUtterance({
      speaker: 'user',
      text: 'Begin.',
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
    })
    await controller.recordUtterance({
      speaker: 'user',
      text: 'real first utterance',
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
    })

    expect(writeUtterance).toHaveBeenCalledTimes(2)
    expect(writeUtterance.mock.calls[0][0].utterance_index).toBe(0)
    expect(writeUtterance.mock.calls[1][0].utterance_index).toBe(0)

    const log = controller.getProcessingLog()
    expect(log.some((e) => e.phase === 'voice.sentinel.stripped')).toBe(true)
  })

  it('flags assistantHasSpokenInSession after the first assistant utterance', async () => {
    const { deps, writeUtterance } = makeDeps()
    const controller = createVoiceSessionController(deps)
    await controller.startSession({ anchorEdgeId: null, boardSnapshot: emptySnapshot })

    await controller.recordUtterance({
      speaker: 'user',
      text: 'hi',
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
    })
    expect(writeUtterance.mock.calls[0][1].assistantHasSpokenInSession).toBe(false)

    await controller.recordUtterance({
      speaker: 'assistant',
      text: 'hello back',
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
    })
    await controller.recordUtterance({
      speaker: 'user',
      text: 'next',
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
    })
    expect(writeUtterance.mock.calls[2][1].assistantHasSpokenInSession).toBe(true)
  })

  it('kicks off async embedding on successful writes', async () => {
    const { deps, embedText, updateUtteranceEmbedding } = makeDeps()
    const controller = createVoiceSessionController(deps)
    await controller.startSession({ anchorEdgeId: null, boardSnapshot: emptySnapshot })

    await controller.recordUtterance({
      speaker: 'user',
      text: 'something to embed',
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
    })

    // Allow the fire-and-forget chain to resolve.
    await new Promise((r) => setTimeout(r, 0))
    await new Promise((r) => setTimeout(r, 0))

    expect(embedText).toHaveBeenCalledWith('something to embed')
    expect(updateUtteranceEmbedding).toHaveBeenCalledOnce()
    const log = controller.getProcessingLog()
    expect(log.some((e) => e.phase === 'voice.utterance.embedded')).toBe(true)
  })

  it('logs an embedding_failed event when the Gemini call rejects', async () => {
    const { deps } = makeDeps({
      embedText: vi.fn().mockRejectedValue(new Error('quota exceeded')),
    })
    const controller = createVoiceSessionController(deps)
    await controller.startSession({ anchorEdgeId: null, boardSnapshot: emptySnapshot })

    await controller.recordUtterance({
      speaker: 'user',
      text: 'will fail to embed',
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
    })

    await new Promise((r) => setTimeout(r, 0))
    await new Promise((r) => setTimeout(r, 0))

    const log = controller.getProcessingLog()
    const failure = log.find((e) => e.phase === 'voice.utterance.embedding_failed')
    expect(failure?.outcome).toBe('failed')
    expect(failure?.detail?.error).toBe('quota exceeded')
  })

  it('logs an insert_failed event when writeUtterance throws but does not abort the session', async () => {
    const { deps } = makeDeps({
      writeUtterance: vi.fn().mockRejectedValueOnce(new Error('rls denied')),
    })
    const controller = createVoiceSessionController(deps)
    await controller.startSession({ anchorEdgeId: null, boardSnapshot: emptySnapshot })

    const result = await controller.recordUtterance({
      speaker: 'user',
      text: 'doomed write',
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
    })

    expect(result.utteranceId).toBeNull()
    expect(result.stripped).toBe(false)
    expect(controller.isActive()).toBe(true)
    const log = controller.getProcessingLog()
    expect(log.some((e) => e.phase === 'voice.utterance.insert_failed')).toBe(true)
  })

  it('endSession flushes the processing_log and clears state', async () => {
    const { deps, endSession } = makeDeps()
    const controller = createVoiceSessionController(deps)
    await controller.startSession({ anchorEdgeId: null, boardSnapshot: emptySnapshot })

    controller.logEvent({
      phase: 'voice.test.event',
      outcome: 'success',
      ts: new Date().toISOString(),
    })

    await controller.endSession({ endReason: 'user_closed' })

    expect(endSession).toHaveBeenCalledOnce()
    const [sessionId, patch] = endSession.mock.calls[0]
    expect(sessionId).toBe('session-123')
    expect(patch.end_reason).toBe('user_closed')
    expect(Array.isArray(patch.processing_log)).toBe(true)
    expect(patch.processing_log.length).toBeGreaterThan(0)
    expect(controller.isActive()).toBe(false)
    expect(controller.getSessionId()).toBeNull()
  })

  it('requireSession throws on recordUtterance / endSession with no active session', async () => {
    const { deps } = makeDeps()
    const controller = createVoiceSessionController(deps)

    await expect(
      controller.recordUtterance({
        speaker: 'user',
        text: 'nope',
        startedAt: new Date().toISOString(),
        endedAt: new Date().toISOString(),
      }),
    ).rejects.toThrow(/no active session/)

    await expect(controller.endSession({ endReason: 'user_closed' })).rejects.toThrow(
      /no active session/,
    )
  })
})
