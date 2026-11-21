// The stage-2 Messages REST call, shared by both functions. The fetch is not
// exercised by tests; reading the response is (claude.test.ts).

import { STAGE2_MODEL } from './models.mjs'

export const CLAUDE_API_URL = 'https://api.anthropic.com/v1/messages'
export const ANTHROPIC_VERSION = '2023-06-01'

export type ClaudeResult = { text: string; error: null } | { text: null; error: string }

type ClaudeResponseBody = {
  stop_reason?: string | null
  stop_details?: { category?: string | null } | null
  content?: { type?: string; text?: string }[]
}

/**
 * Reads the reply out of a Messages response. Thinking is always on for the
 * stage-2 models, so the response opens with `thinking` blocks and the reply is
 * the `text` blocks after them; thinking also counts toward `max_tokens`.
 */
export function readClaudeResponse(data: ClaudeResponseBody | null | undefined): ClaudeResult {
  if (data?.stop_reason === 'refusal') {
    return { text: null, error: `Refused by the model (category: ${data.stop_details?.category ?? 'unspecified'})` }
  }
  const blocks = Array.isArray(data?.content) ? data.content : []
  const text = blocks
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('')
    .trim()
  if (data?.stop_reason === 'max_tokens') {
    return { text: null, error: `Hit max_tokens ${text ? 'mid-reply' : 'before any reply text'}; raise the limit` }
  }
  if (!text) {
    return { text: null, error: `Unexpected response shape: ${JSON.stringify(data).slice(0, 200)}` }
  }
  return { text, error: null }
}

export async function callClaude(
  apiKey: string,
  systemPrompt: string,
  userPrompt: string,
  options: { model?: string; maxTokens: number },
): Promise<ClaudeResult> {
  try {
    const response = await fetch(CLAUDE_API_URL, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: options.model ?? STAGE2_MODEL,
        max_tokens: options.maxTokens,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
      }),
    })

    if (!response.ok) {
      const body = await response.text()
      return { text: null, error: `HTTP ${response.status}: ${body.slice(0, 200)}` }
    }

    return readClaudeResponse(await response.json())
  } catch (err) {
    return { text: null, error: `Fetch error: ${err instanceof Error ? err.message : String(err)}` }
  }
}
