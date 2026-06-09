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
 * @param relatedMaterial   Phase 10B per-turn retrieval block. When present, a
 *                          RELATED MATERIAL section is appended AFTER node
 *                          content (a trailing parent section, distinct from
 *                          recentThinking) — the widening corpus retrieved for
 *                          THIS edge/turn. Already self-framed by
 *                          `buildRelatedMaterial`; passed through untouched.
 *                          Omitted entirely when absent or empty, exactly like
 *                          the empty-snapshot path for recentThinking — never
 *                          breaks a turn. Changes per turn (unlike the fixed
 *                          connection/node sections), so it is threaded as a
 *                          per-turn argument, not a session option.
 * @param workingMemory     Session working memory: everything retrieval has
 *                          surfaced in PRIOR turns, rendered as a SURFACED
 *                          THIS SESSION section after relatedMaterial
 *                          (`buildWorkingMemoryBlock` — already self-framed,
 *                          passed through untouched). Omitted when absent or
 *                          empty, so prompts before anything surfaces stay
 *                          byte-identical to pre-working-memory behavior.
 */
export function buildSystemPrompt(input: {
  role: string
  cadence: string
  recentThinking?: string
  connectionContext: string
  nodeContent: string
  relatedMaterial?: string
  workingMemory?: string
}): string {
  const { role, cadence, recentThinking, connectionContext, nodeContent, relatedMaterial, workingMemory } = input

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

  if (relatedMaterial && relatedMaterial.trim().length > 0) {
    sections.push('---', 'RELATED MATERIAL', relatedMaterial)
  }

  if (workingMemory && workingMemory.trim().length > 0) {
    sections.push('---', 'SURFACED THIS SESSION', workingMemory)
  }

  return sections.join('\n\n')
}

const RECENT_THINKING_FRAMING =
  "A recent analytical read of patterns across the user's canvas — " +
  'interpretive threads, not facts, as of recently. Use it as ground ' +
  'for committing to specific reads of the current edge rather than ' +
  "hedging. Do not refer to it, summarize it, or signal you've read " +
  'it. Let it shape what you notice and what you say, not how you ' +
  'announce yourself.'
