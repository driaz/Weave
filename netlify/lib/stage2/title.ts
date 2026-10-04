// The snapshot title step: one call with the original prompt, and one corrective
// retry when the phrase is over-length. Never truncates; a title that still fails
// comes back as a structured error the caller records in generation_metadata.
// The Claude call is injected so tests run without network.

import type { ClaudeResult } from './claude'
import { TITLE_MAX_LENGTH, TITLE_PROMPT_TEMPLATE } from './prompts'

export type TitleCall = (userPrompt: string) => Promise<ClaudeResult>

export type TitleError = {
  phase: 'title_generation' | 'title_validation'
  reason: string
  attempts: number
  rejected_values: string[]
}

export type TitleOutcome =
  | { title: string; attempts: number; error: null }
  | { title: null; attempts: number; error: TitleError }

export function titlePrompt(narrative: string): string {
  return `${TITLE_PROMPT_TEMPLATE}${narrative}`
}

export function correctiveTitlePrompt(narrative: string, rejected: string): string {
  return `${titlePrompt(narrative)}

---

Your previous answer was "${rejected}", which is ${rejected.length} characters — over the limit. Return a phrase of at most ${TITLE_MAX_LENGTH} characters. Return only the phrase, nothing else.`
}

type Attempt = { kind: 'ok'; value: string } | { kind: 'too_long'; value: string } | { kind: 'empty' } | { kind: 'error'; message: string }

async function attempt(call: TitleCall, prompt: string): Promise<Attempt> {
  let result: ClaudeResult
  try {
    result = await call(prompt)
  } catch (err) {
    return { kind: 'error', message: `threw: ${err instanceof Error ? err.message : String(err)}` }
  }
  if (result.text === null) return { kind: 'error', message: result.error }
  const value = result.text.trim()
  if (!value) return { kind: 'empty' }
  if (value.length > TITLE_MAX_LENGTH) return { kind: 'too_long', value }
  return { kind: 'ok', value }
}

function failure(a: Exclude<Attempt, { kind: 'ok' }>, attempts: number, rejected: string[]): TitleOutcome {
  if (a.kind === 'error') {
    return { title: null, attempts, error: { phase: 'title_generation', reason: a.message, attempts, rejected_values: rejected } }
  }
  const reason = a.kind === 'empty' ? 'empty' : `over_length: ${a.value.length} > ${TITLE_MAX_LENGTH}`
  const values = a.kind === 'too_long' ? [...rejected, a.value] : rejected
  return { title: null, attempts, error: { phase: 'title_validation', reason, attempts, rejected_values: values } }
}

export async function generateTitle(narrative: string, call: TitleCall): Promise<TitleOutcome> {
  const first = await attempt(call, titlePrompt(narrative))
  if (first.kind === 'ok') return { title: first.value, attempts: 1, error: null }
  if (first.kind !== 'too_long') return failure(first, 1, [])

  // The over-length result is deterministic for a given narrative, so a plain
  // identical retry repeats it; the corrective prompt names the rejected value.
  const second = await attempt(call, correctiveTitlePrompt(narrative, first.value))
  if (second.kind === 'ok') return { title: second.value, attempts: 2, error: null }
  return failure(second, 2, [first.value])
}
