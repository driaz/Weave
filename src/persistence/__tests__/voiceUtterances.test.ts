import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { detectSentinel, persistence, type VoiceSession } from '../index'
import { createTestUser, hasServiceRole, type TestUser } from './setup'

describe('persistence.voiceUtterances.detectSentinel', () => {
  const userFirstSlot = {
    speaker: 'user' as const,
    utteranceIndex: 0,
    assistantHasSpokenInSession: false,
  }

  it('strips the exact sentinel in the opening user slot', () => {
    const result = detectSentinel('Begin.', userFirstSlot)
    expect(result.action).toBe('strip')
    expect(result.event?.phase).toBe('voice.sentinel.stripped')
    expect(result.event?.outcome).toBe('success')
  })

  it('does not strip lowercase "begin." and emits a malformed warning', () => {
    const result = detectSentinel('begin.', userFirstSlot)
    expect(result.action).toBe('pass')
    expect(result.event?.phase).toBe('voice.sentinel.detection_warning')
    expect(result.event?.outcome).toBe('degraded')
    expect(result.event?.detail.reason).toBe('sentinel_malformed')
  })

  it('does not strip "Begin" without a period and emits a malformed warning', () => {
    const result = detectSentinel('Begin', userFirstSlot)
    expect(result.action).toBe('pass')
    expect(result.event?.phase).toBe('voice.sentinel.detection_warning')
    expect(result.event?.detail.reason).toBe('sentinel_malformed')
  })

  it('does not strip the sentinel from the assistant and warns about slot', () => {
    const result = detectSentinel('Begin.', {
      speaker: 'assistant',
      utteranceIndex: 0,
      assistantHasSpokenInSession: false,
    })
    expect(result.action).toBe('pass')
    expect(result.event?.phase).toBe('voice.sentinel.detection_warning')
    expect(result.event?.detail.reason).toBe('sentinel_in_unexpected_slot')
  })

  it('does not strip the sentinel at utterance_index > 0 and warns', () => {
    const result = detectSentinel('Begin.', {
      ...userFirstSlot,
      utteranceIndex: 1,
    })
    expect(result.action).toBe('pass')
    expect(result.event?.phase).toBe('voice.sentinel.detection_warning')
    expect(result.event?.detail.reason).toBe('sentinel_in_unexpected_slot')
  })

  it('does not strip the sentinel after the assistant has spoken and warns', () => {
    const result = detectSentinel('Begin.', {
      ...userFirstSlot,
      assistantHasSpokenInSession: true,
    })
    expect(result.action).toBe('pass')
    expect(result.event?.phase).toBe('voice.sentinel.detection_warning')
    expect(result.event?.detail.reason).toBe('sentinel_in_unexpected_slot')
  })

  it('passes ordinary text through with no event', () => {
    const result = detectSentinel('hello there', userFirstSlot)
    expect(result.action).toBe('pass')
    expect(result.event).toBeUndefined()
  })

  it('does not flag conversational uses of the word "begin"', () => {
    const result = detectSentinel("let's begin with the first node", userFirstSlot)
    expect(result.action).toBe('pass')
    expect(result.event).toBeUndefined()
  })
})

describe.skipIf(!hasServiceRole())('persistence.voiceUtterances (integration)', () => {
  let user: TestUser
  let session: VoiceSession

  beforeAll(async () => {
    user = await createTestUser('voice-utterances')
    session = await persistence.voiceSessions.createSession({
      anchor_edge_id: null,
      board_snapshot: { nodes: [], edges: [], captured_at: new Date().toISOString() } as unknown as never,
      started_at: new Date().toISOString(),
      processing_log: [] as unknown as never,
      end_reason: null,
      ended_at: null,
      summary: null,
    })
  })

  afterAll(async () => {
    await user.cleanup()
  })

  it('writes a non-sentinel utterance and lists it', async () => {
    const result = await persistence.voiceUtterances.writeUtterance(
      {
        session_id: session.id,
        speaker: 'user',
        text: 'hello there',
        utterance_index: 0,
        started_at: new Date().toISOString(),
        ended_at: new Date().toISOString(),
      },
      { assistantHasSpokenInSession: false },
    )
    expect(result.stripped).toBe(false)
    expect(result.utteranceId).toBeTruthy()
    expect(result.event).toBeUndefined()

    const listed = await persistence.voiceUtterances.listUtterancesBySession(session.id)
    expect(listed.some((u) => u.id === result.utteranceId)).toBe(true)
  })

  it('skips the row entirely when the sentinel matches', async () => {
    const fresh = await persistence.voiceSessions.createSession({
      anchor_edge_id: null,
      board_snapshot: { nodes: [], edges: [], captured_at: new Date().toISOString() } as unknown as never,
      started_at: new Date().toISOString(),
      processing_log: [] as unknown as never,
      end_reason: null,
      ended_at: null,
      summary: null,
    })

    const result = await persistence.voiceUtterances.writeUtterance(
      {
        session_id: fresh.id,
        speaker: 'user',
        text: 'Begin.',
        utterance_index: 0,
        started_at: new Date().toISOString(),
        ended_at: new Date().toISOString(),
      },
      { assistantHasSpokenInSession: false },
    )
    expect(result.stripped).toBe(true)
    expect(result.utteranceId).toBeNull()
    expect(result.event?.phase).toBe('voice.sentinel.stripped')

    const listed = await persistence.voiceUtterances.listUtterancesBySession(fresh.id)
    expect(listed).toHaveLength(0)
  })

  it('updates the embedding column after the row exists', async () => {
    const written = await persistence.voiceUtterances.writeUtterance(
      {
        session_id: session.id,
        speaker: 'assistant',
        text: 'the answer is forty-two',
        utterance_index: 1,
        started_at: new Date().toISOString(),
        ended_at: new Date().toISOString(),
      },
      { assistantHasSpokenInSession: false },
    )
    expect(written.utteranceId).toBeTruthy()

    // Use a small but well-formed vector. Production calls Gemini; the
    // dimension doesn't have to match for this test — we're verifying
    // the UPDATE round-trip and that pgvector accepts JSON-array text.
    await persistence.voiceUtterances.updateUtteranceEmbedding(
      written.utteranceId!,
      Array.from({ length: 3072 }, () => 0),
    )

    const listed = await persistence.voiceUtterances.listUtterancesBySession(session.id)
    const row = listed.find((u) => u.id === written.utteranceId)
    expect(row?.embedding).toBeTruthy()
  })
})
