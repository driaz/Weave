// Shared helpers for generating a 2-3 sentence YouTube content description
// from a transcript. Used by:
//   - netlify/functions/generate-content-description.ts (per-node, called
//     during ingest so the voice pipeline has a summary by the time the
//     node settles)
//   - netlify/functions/backfill-youtube-descriptions.ts (one-shot pass
//     over historical nodes that landed before description-on-ingest)
//
// Lives in netlify/lib/ rather than netlify/functions/ so Netlify doesn't
// try to deploy it as its own endpoint.

const CLAUDE_API_URL = 'https://api.anthropic.com/v1/messages'
const CLAUDE_MODEL = 'claude-sonnet-4-6'
const CLAUDE_MAX_TOKENS = 400

const TRANSCRIPT_CHAR_LIMIT = 3000

const SYSTEM_PROMPT = `Summarize this video in 2-3 sentences. Focus on the core argument, thesis, or subject matter — what is this video actually about? Include the tone or style only if it's central to the content (e.g. satirical, polemical, instructional). Do not describe it as "a video about X" — just state what it says or argues.`

export type DescriptionInput = {
  title: string
  channel?: string | null
  transcript: string
  /** Free-form tonal context from the Fly multimodal pipeline (media_analysis or tonal_metadata). Optional. */
  tonalContext?: string | null
}

export function buildDescriptionPrompt(input: DescriptionInput): string {
  const transcript =
    input.transcript.length > TRANSCRIPT_CHAR_LIMIT
      ? input.transcript.slice(0, TRANSCRIPT_CHAR_LIMIT)
      : input.transcript

  const lines: string[] = [
    `Video title: ${input.title}`,
    `Channel: ${input.channel?.trim() || 'Unknown'}`,
    `Transcript: ${transcript}`,
  ]
  if (input.tonalContext && input.tonalContext.trim().length > 0) {
    lines.push(`Tonal context: ${input.tonalContext.trim()}`)
  }
  return lines.join('\n')
}

export async function generateYouTubeDescription(
  apiKey: string,
  input: DescriptionInput,
): Promise<{ description: string; error: null } | { description: null; error: string }> {
  if (!input.transcript || input.transcript.trim().length === 0) {
    return { description: null, error: 'transcript is empty' }
  }

  try {
    const response = await fetch(CLAUDE_API_URL, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: CLAUDE_MODEL,
        max_tokens: CLAUDE_MAX_TOKENS,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: buildDescriptionPrompt(input) }],
      }),
    })

    if (!response.ok) {
      const body = await response.text()
      return {
        description: null,
        error: `HTTP ${response.status}: ${body.slice(0, 200)}`,
      }
    }

    const data = (await response.json()) as {
      content?: Array<{ type: string; text?: string }>
    }
    const text = data.content?.find((b) => b.type === 'text')?.text
    if (!text) {
      return { description: null, error: 'no text in response' }
    }
    return { description: text.trim(), error: null }
  } catch (err) {
    return {
      description: null,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}
