import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * First-token latency markers (#23). Drives runConversationTurn against a
 * stubbed SSE proxy, with its onMarker wired to a real voiceSessionLogger
 * exactly as vadController wires it, and asserts what lands in the active
 * session's processing_log buffer.
 *
 * The controller, eventTracker, shared logger and Supabase client are
 * mocked; everything between the orchestrator and the logger is real.
 */

interface LoggedEvent {
  phase: string
  ts: string
  detail?: Record<string, unknown>
  correlationId?: string
}

const logEventMock = vi.fn<(event: LoggedEvent) => void>()
const trackEventMock = vi.fn()

vi.mock('../voiceSessionController', () => ({
  voiceSessionController: {
    isActive: () => true,
    getSessionId: () => 'session-1',
    logEvent: (event: LoggedEvent) => logEventMock(event),
  },
}))

vi.mock('../../eventTracker', () => ({
  trackEvent: (...args: unknown[]) => trackEventMock(...args),
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

vi.mock('../../supabaseClient', () => ({
  supabase: {
    auth: {
      getSession: async () => ({ data: { session: { access_token: 'tok' } } }),
    },
  },
}))

import { runConversationTurn, type ConversationMessage } from '../conversationOrchestrator'
import { createVoiceSessionLogger } from '../voiceSessionLogger'

const SSE_EVENTS = [
  { type: 'message_start', message: { usage: { input_tokens: 1200, cache_read_input_tokens: 0, output_tokens: 1 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello there. ' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Second sentence.' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 42 } },
  { type: 'message_stop' },
]

function sseResponse(): Response {
  const body = SSE_EVENTS.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('')
  return new Response(body, { status: 200 })
}

async function runTurn(input: {
  messages: ConversationMessage[]
  systemPrompt?: string
}): Promise<string> {
  const logger = createVoiceSessionLogger({ scope: 'test', boardId: 'b1' })
  const correlationIds = { correlationId: 'turn-1', parentCorrelationId: 'session-1' }
  let text = ''
  for await (const chunk of runConversationTurn({
    connectionContext: 'ctx',
    nodeContent: 'nodes',
    messages: input.messages,
    systemPrompt: input.systemPrompt,
    onMarker: (phase, detail) => logger.event(phase, 'success', detail, correlationIds),
  })) {
    text += chunk
  }
  return text
}

function markers(): LoggedEvent[] {
  return logEventMock.mock.calls
    .map(([e]) => e)
    .filter((e) => e.phase.startsWith('voice.claude.'))
}

describe('voice.claude latency markers', () => {
  beforeEach(() => {
    logEventMock.mockReset()
    trackEventMock.mockReset()
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-09-28T12:00:00.000Z'))
    // Model time: the proxy "takes" 850ms to first byte.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        vi.setSystemTime(new Date('2026-09-28T12:00:00.850Z'))
        return sseResponse()
      }),
    )
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('writes request_sent and first_delta with the turn correlationId, in order', async () => {
    await runTurn({ messages: [{ role: 'user', content: 'what links these?' }] })

    const [sent, first] = markers()
    expect(sent.phase).toBe('voice.claude.request_sent')
    expect(first.phase).toBe('voice.claude.first_delta')
    expect(sent.correlationId).toBe('turn-1')
    expect(first.correlationId).toBe('turn-1')
    expect(Date.parse(sent.ts)).toBeLessThan(Date.parse(first.ts))
    expect(first.detail).toEqual({ deltaType: 'text_delta' })
  })

  it('records merged token usage on response_complete', async () => {
    await runTurn({ messages: [{ role: 'user', content: 'what links these?' }] })

    const complete = markers().find((e) => e.phase === 'voice.claude.response_complete')
    expect(complete?.correlationId).toBe('turn-1')
    expect(complete?.detail).toEqual({
      usage: { input_tokens: 1200, cache_read_input_tokens: 0, output_tokens: 42 },
      stopReason: 'end_turn',
    })
    expect(markers().map((e) => e.phase)).toEqual([
      'voice.claude.request_sent',
      'voice.claude.first_delta',
      'voice.claude.response_complete',
    ])
  })

  it('emits both markers on an opening turn (pre-assembled prompt, synthetic Begin.)', async () => {
    const text = await runTurn({
      messages: [{ role: 'user', content: 'Begin.' }],
      systemPrompt: 'assembled opening prompt',
    })

    expect(text).toBe('Hello there. Second sentence.')
    const phases = markers().map((e) => e.phase)
    expect(phases).toContain('voice.claude.request_sent')
    expect(phases).toContain('voice.claude.first_delta')
  })

  it('writes nothing to weave_events during the turn', async () => {
    await runTurn({ messages: [{ role: 'user', content: 'what links these?' }] })

    expect(markers()).toHaveLength(3)
    expect(trackEventMock).not.toHaveBeenCalled()
  })
})
