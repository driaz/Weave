import roleText from '../../../prompts/role.txt?raw'
import cadenceOpeningText from '../../../prompts/cadence-opening.txt?raw'
import cadenceFollowupText from '../../../prompts/cadence-followup.txt?raw'
import { supabase } from '../supabaseClient'
import { buildSystemPrompt } from './buildSystemPrompt'

const PROXY_URL = 'https://weave-media.fly.dev/api/claude'
const MODEL = 'claude-opus-4-7'
const MAX_TOKENS = 2048

export interface ConversationMessage {
  role: 'user' | 'assistant'
  content: string
}

export interface RunConversationTurnInput {
  connectionContext: string
  nodeContent: string
  messages: ConversationMessage[]
}

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
  const { connectionContext, nodeContent, messages } = input

  const hasPriorAssistant = messages.some((m) => m.role === 'assistant')
  const cadence = hasPriorAssistant ? cadenceFollowupText : cadenceOpeningText

  const system = buildSystemPrompt({
    role: roleText,
    cadence,
    connectionContext,
    nodeContent,
  })

  if (!supabase) {
    throw new Error(
      'Supabase client not configured — cannot authenticate Claude proxy request',
    )
  }
  const { data } = await supabase.auth.getSession()
  const token = data.session?.access_token
  if (!token) throw new Error('No Supabase session — please sign in')

  const response = await fetch(PROXY_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system,
      messages,
      stream: true,
    }),
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
      if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
        return delta.text
      }
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
}
