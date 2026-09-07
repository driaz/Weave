// The stage-2 Messages REST call, shared by both functions. Not exercised by tests.

import { STAGE2_MODEL } from './models.mjs'

export const CLAUDE_API_URL = 'https://api.anthropic.com/v1/messages'
export const ANTHROPIC_VERSION = '2023-06-01'

export type ClaudeResult = { text: string; error: null } | { text: null; error: string }

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

    const data = await response.json()
    const text = data?.content?.[0]?.text
    if (!text) {
      return { text: null, error: `Unexpected response shape: ${JSON.stringify(data).slice(0, 200)}` }
    }
    return { text: text.trim(), error: null }
  } catch (err) {
    return { text: null, error: `Fetch error: ${err instanceof Error ? err.message : String(err)}` }
  }
}
