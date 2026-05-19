/**
 * Compose the Claude `system` field from named sections.
 *
 * Pure concatenation — `role` and `cadence` already carry their own internal
 * formatting and are passed through untouched. The caller pre-loads each
 * string (typically via Vite `?raw` imports for the prompt files).
 *
 * @param role              Identity + behavior instructions (prompts/role.txt).
 * @param cadence           Mode-selected pacing rules — opening vs follow-up
 *                          (prompts/cadence-opening.txt | cadence-followup.txt).
 * @param recentThinking    Phase 9 opening-turn-only. Narrative of the user's
 *                          most recent profile snapshot. When present, a
 *                          RECENT THINKING block is inserted between cadence
 *                          and CONNECTION CONTEXT, prefixed by a constant
 *                          framing paragraph that tells Claude to use the
 *                          snapshot as ground for commitment — not as
 *                          material to summarize or refer to. Absent or empty
 *                          on follow-up turns and when no snapshot exists.
 * @param connectionContext Edge metadata: type, strength, explanation.
 * @param nodeContent       Full analyzed text of both connected nodes.
 */
export function buildSystemPrompt(input: {
  role: string
  cadence: string
  recentThinking?: string
  connectionContext: string
  nodeContent: string
}): string {
  const { role, cadence, recentThinking, connectionContext, nodeContent } = input

  const sections: string[] = [role, '---', cadence]

  if (recentThinking && recentThinking.trim().length > 0) {
    sections.push(
      '---',
      'RECENT THINKING',
      RECENT_THINKING_FRAMING,
      recentThinking,
    )
  }

  sections.push(
    '---',
    'CONNECTION CONTEXT',
    '',
    connectionContext,
    '---',
    'NODE CONTENT',
    '',
    nodeContent,
  )

  return sections.join('\n\n')
}

const RECENT_THINKING_FRAMING =
  "A recent analytical read of patterns across the user's canvas — " +
  'interpretive threads, not facts, as of recently. Use it as ground ' +
  'for committing to specific reads of the current edge rather than ' +
  "hedging. Do not refer to it, summarize it, or signal you've read " +
  'it. Let it shape what you notice and what you say, not how you ' +
  'announce yourself.'
