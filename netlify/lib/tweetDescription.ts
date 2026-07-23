// Shared helpers for generating a content description for a video clip
// shared in a tweet (Issue #2 Change 5). Sibling of youtubeDescription.ts —
// same system/user split, same model, same never-throws-to-caller shape.
// Used by:
//   - netlify/functions/generate-tweet-description.ts (per-node, called by
//     the client after transcript arrival when the gate lets it through:
//     media_analysis present, or transcript > 1,000 chars)
//
// Lives in netlify/lib/ rather than netlify/functions/ so Netlify doesn't
// try to deploy it as its own endpoint.
//
// The prompt text is FROZEN as decided in the Issue #2 design cycle
// (docs/tweet-description-samples.md) — deploy verbatim; known weaknesses
// are recorded in the PR description, not patched here.

const CLAUDE_API_URL = 'https://api.anthropic.com/v1/messages'
const CLAUDE_MODEL = 'claude-sonnet-4-6'
const CLAUDE_MAX_TOKENS = 400

const SYSTEM_PROMPT = `You write content descriptions for video clips shared in tweets.
Descriptions are embedded for semantic retrieval alongside dense editorial
summaries of other content; write in that register: third-person,
declarative, substantive. Aim for 400-700 characters in 2-3 sentences.`

export type TweetDescriptionInput = {
  authorName: string
  authorHandle?: string | null
  tweetText: string
  transcript?: string | null
  mediaAnalysis?: string | null
}

/**
 * Strip the oEmbed boilerplate the tweet author never wrote: the trailing
 * "pic.twitter.com/<id>— Author Name (@handle) Month D, YYYY" block.
 * Substitution hygiene lives here in code, not in the prompt.
 */
export function stripTweetBoilerplate(tweetText: string): string {
  return tweetText
    .replace(/\s*pic\.twitter\.com\/\S+/g, '')
    .replace(/\s*—\s*[^—]*\(@\w+\)\s+[A-Za-z]+ \d{1,2}, \d{4}\s*$/, '')
    .trim()
}

export function buildTweetDescriptionPrompt(input: TweetDescriptionInput): string {
  // authorHandle is stored with a leading "@" (oEmbed author_url tail);
  // normalize so the prompt renders "(@handle)", never "(@@handle)".
  const handle = input.authorHandle?.trim().replace(/^@/, '') ?? ''
  const authorLine = handle
    ? `Tweet author: ${input.authorName} (@${handle})`
    : `Tweet author: ${input.authorName}`

  const lines: string[] = [
    authorLine,
    `Tweet text: ${stripTweetBoilerplate(input.tweetText)}`,
  ]
  const transcript = input.transcript?.trim()
  if (transcript) {
    lines.push(`Transcript of the clip's audio: ${transcript}`)
  }
  const mediaAnalysis = input.mediaAnalysis?.trim()
  if (mediaAnalysis) {
    lines.push(`Tonal/visual analysis of the clip: ${mediaAnalysis}`)
  }

  lines.push(
    '',
    `Describe this clip: who is speaking or what is happening, the substance
of what is said or shown, and — where the tweet text signals it — the
framing or point the person sharing it was making.

Constraints:
- Describe; do not quote. Never present words as verbatim speech, even
  words that appear in the transcript.
- Draw only on the inputs above. Do not add context about the speaker,
  event, or topic from outside knowledge, even when you recognize them.
- Where the speaker distinguishes between cases or makes a concession,
  preserve the distinction; do not flatten the argument.
- If the transcript is fragmentary or unclear, describe what is clear
  and say nothing about the rest. Do not reconstruct or infer missing
  content.`,
  )
  return lines.join('\n')
}

export async function generateTweetDescription(
  apiKey: string,
  input: TweetDescriptionInput,
): Promise<{ description: string; error: null } | { description: null; error: string }> {
  const transcript = input.transcript?.trim() ?? ''
  const mediaAnalysis = input.mediaAnalysis?.trim() ?? ''
  if (!transcript && !mediaAnalysis) {
    return { description: null, error: 'transcript or mediaAnalysis is required' }
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
        messages: [{ role: 'user', content: buildTweetDescriptionPrompt(input) }],
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
