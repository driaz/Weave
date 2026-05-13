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
 * @param connectionContext Edge metadata: type, strength, explanation.
 * @param nodeContent       Full analyzed text of both connected nodes.
 */
export function buildSystemPrompt(input: {
  role: string
  cadence: string
  connectionContext: string
  nodeContent: string
}): string {
  const { role, cadence, connectionContext, nodeContent } = input
  return [
    role,
    '---',
    cadence,
    '---',
    'CONNECTION CONTEXT',
    '',
    connectionContext,
    '---',
    'NODE CONTENT',
    '',
    nodeContent,
  ].join('\n\n')
}
