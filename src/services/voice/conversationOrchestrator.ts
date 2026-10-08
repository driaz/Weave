import roleText from '../../../prompts/role.txt?raw'
import cadenceOpeningText from '../../../prompts/cadence-opening.txt?raw'
import cadenceFollowupText from '../../../prompts/cadence-followup.txt?raw'
import { supabase } from '../supabaseClient'
import { buildSystemBlocks, type SystemBlocks } from './buildSystemPrompt'

const PROXY_URL = 'https://weave-media.fly.dev/api/claude'
const MODEL = 'claude-opus-5'
const MAX_TOKENS = 4096

export interface ConversationMessage {
  role: 'user' | 'assistant'
  content: string
}

export interface RunConversationTurnInput {
  connectionContext: string
  nodeContent: string
  messages: ConversationMessage[]
  /**
   * Aborts the underlying SSE fetch. Without this, calling abort() on a
   * downstream controller only causes the for-await loop to exit between
   * yields — the SSE connection itself stays open, which lets Claude keep
   * generating after the user has clicked Stop. Threading the signal here
   * closes the connection at the network layer.
   */
  signal?: AbortSignal
  /**
   * Phase 9 pre-assembled system prompt override, as prompt-cache blocks
   * (`buildSystemBlocks`). When provided, the orchestrator sends these
   * verbatim and skips its own assembly (so `connectionContext` /
   * `nodeContent` are ignored). The caller is responsible for selecting
   * cadence-opening vs cadence-followup when assembling. Opening turns use
   * this so the fetched profile snapshot can be folded into the prompt
   * upstream and the joined string can be logged alongside voice.turn.started.
   * Follow-up turns omit it and let the orchestrator assemble as before.
   */
  systemBlocks?: SystemBlocks
  /**
   * Phase 10B follow-up retrieval block. Threaded per-turn (it changes every
   * turn, unlike the fixed connectionContext / nodeContent) into the
   * orchestrator's own assembly. Ignored when `systemBlocks` is
   * provided (opening turns pre-fold their own relatedMaterial upstream).
   * Absent / empty → the section is omitted, exactly like Phase 9.
   */
  relatedMaterial?: string
  /**
   * Session working memory block (SURFACED THIS SESSION): everything
   * retrieval surfaced in prior turns, threaded per-turn exactly like
   * `relatedMaterial` and ignored the same way when `systemBlocks` is
   * provided. Absent / empty → the section is omitted.
   */
  workingMemory?: string
  /**
   * First-token latency markers (#23). Called synchronously at three points
   * so the caller can log them against the turn's correlationId:
   *   - voice.claude.request_sent — immediately before the proxy fetch
   *   - voice.claude.first_delta — first content_block_delta of any type
   *     (`deltaType` says whether thinking or text arrived first)
   *   - voice.claude.first_text_delta — first text_delta (same instant as
   *     first_delta when no thinking precedes the text)
   *   - voice.claude.response_complete — on message_stop, with token usage
   *     merged from message_start and the final message_delta
   * Fire-and-forget: the orchestrator never awaits it.
   */
  onMarker?: (phase: ClaudeMarkerPhase, detail?: Record<string, unknown>) => void
}

export type ClaudeMarkerPhase =
  | 'voice.claude.request_sent'
  | 'voice.claude.first_delta'
  | 'voice.claude.first_text_delta'
  | 'voice.claude.response_complete'

/**
 * Run one turn of the voice conversation. Selects opening vs follow-up
 * cadence from `messages` state, composes the system prompt, calls the
 * `/api/claude` streaming proxy, and yields text deltas as they arrive.
 *
 * Caller owns:
 *   - accumulating yielded chunks into the final assistant response,
 *   - appending that response to `messages` for the next turn,
 *   - catching and handling errors thrown by the generator.
 *
 * Fails loud: throws on non-2xx HTTP, on `error` events in the stream,
 * and if the stream ends without `message_stop`.
 */
export async function* runConversationTurn(
  input: RunConversationTurnInput,
): AsyncGenerator<string, void, unknown> {
  const { connectionContext, nodeContent, messages, signal, systemBlocks, relatedMaterial, workingMemory, onMarker } = input

  let blocks: SystemBlocks
  if (systemBlocks) {
    blocks = systemBlocks
  } else {
    const hasPriorAssistant = messages.some((m) => m.role === 'assistant')
    const cadence = hasPriorAssistant ? cadenceFollowupText : cadenceOpeningText
    blocks = buildSystemBlocks({
      role: roleText,
      cadence,
      connectionContext,
      nodeContent,
      relatedMaterial,
      workingMemory,
    })
  }

  if (!supabase) {
    throw new Error(
      'Supabase client not configured — cannot authenticate Claude proxy request',
    )
  }
  const { data } = await supabase.auth.getSession()
  const token = data.session?.access_token
  if (!token) throw new Error('No Supabase session — please sign in')

  onMarker?.('voice.claude.request_sent')
  const response = await fetch(PROXY_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'low' },
      system: toSystemParam(blocks),
      messages,
      stream: true,
    }),
    signal,
  })

  if (!response.ok) {
    const errorBody = await response.text().catch(() => '')
    throw new Error(`Claude proxy error (${response.status}): ${errorBody}`)
  }
  if (!response.body) {
    throw new Error('Claude proxy response has no body')
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let sawMessageStop = false
  let sawFirstDelta = false
  let sawFirstTextDelta = false
  let usage: Record<string, unknown> = {}
  let stopReason: unknown = null

  const parseEvent = (raw: string): string | null => {
    let dataLine = ''
    for (const line of raw.split('\n')) {
      if (line.startsWith('data:')) {
        dataLine = line.startsWith('data: ') ? line.slice(6) : line.slice(5)
      }
    }
    if (!dataLine) return null
    let event: { type?: string; [k: string]: unknown }
    try {
      event = JSON.parse(dataLine)
    } catch {
      console.warn(
        '[conversationOrchestrator] malformed SSE data line:',
        dataLine.slice(0, 200),
      )
      return null
    }
    const type = event.type
    if (type === 'content_block_delta') {
      const delta = (event as { delta?: { type?: string; text?: unknown } }).delta
      if (!sawFirstDelta) {
        sawFirstDelta = true
        onMarker?.('voice.claude.first_delta', { deltaType: delta?.type ?? null })
      }
      if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
        if (!sawFirstTextDelta) {
          sawFirstTextDelta = true
          onMarker?.('voice.claude.first_text_delta')
        }
        return delta.text
      }
    } else if (type === 'message_start') {
      const u = (event as { message?: { usage?: Record<string, unknown> } }).message?.usage
      if (u) usage = { ...usage, ...u }
    } else if (type === 'message_delta') {
      const e = event as { usage?: Record<string, unknown>; delta?: { stop_reason?: unknown } }
      if (e.usage) usage = { ...usage, ...e.usage }
      if (e.delta?.stop_reason !== undefined) stopReason = e.delta.stop_reason
    } else if (type === 'message_stop') {
      sawMessageStop = true
    } else if (type === 'error') {
      const detail = (event as { error?: { message?: unknown } }).error?.message
      throw new Error(
        `Claude stream error: ${typeof detail === 'string' ? detail : 'unknown'}`,
      )
    }
    return null
  }

  try {
    while (true) {
      const { value, done } = await reader.read()
      if (value) {
        buffer += decoder.decode(value, { stream: true })
        const parts = buffer.split('\n\n')
        buffer = parts.pop() ?? ''
        for (const part of parts) {
          const chunk = parseEvent(part)
          if (chunk) yield chunk
        }
      }
      if (done) break
    }
    if (buffer.trim()) {
      const chunk = parseEvent(buffer)
      if (chunk) yield chunk
    }
  } finally {
    reader.releaseLock()
  }

  if (!sawMessageStop) {
    throw new Error('Claude stream ended without message_stop')
  }
  onMarker?.('voice.claude.response_complete', { usage, stopReason })
}

export interface SystemTextBlock {
  type: 'text'
  text: string
  cache_control?: { type: 'ephemeral' }
}

/**
 * Prompt-cache layout (docs/reads/voice-prompt-cache.md): breakpoints on the
 * role block (shared by opener and follow-ups) and on the session-stable
 * block; the volatile block is unmarked, and omitted when empty because the
 * API rejects empty text blocks.
 */
export function toSystemParam([role, stable, volatile]: SystemBlocks): SystemTextBlock[] {
  const system: SystemTextBlock[] = [
    { type: 'text', text: role, cache_control: { type: 'ephemeral' } },
    { type: 'text', text: stable, cache_control: { type: 'ephemeral' } },
  ]
  if (volatile.length > 0) system.push({ type: 'text', text: volatile })
  return system
}
