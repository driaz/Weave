import { describe, expect, it } from 'vitest'
import type { ClaudeResult } from '../claude'
import { TITLE_MAX_LENGTH, TITLE_PROMPT_TEMPLATE } from '../prompts'
import { generateTitle, type TitleCall } from '../title'

const NARRATIVE = 'A narrative about clarity and having nowhere to put what one sees.'
// The t2 reproduction (docs/reads/t2.md §8.5): 68 chars, deterministic on retry.
const T2_REJECTED = 'Clarity as the specific price of having nowhere to put what one sees'

/** A call that replays scripted results and records the prompts it was given. */
function scripted(...results: Array<ClaudeResult | Error>): TitleCall & { prompts: string[] } {
  const prompts: string[] = []
  const call = async (prompt: string): Promise<ClaudeResult> => {
    prompts.push(prompt)
    const next = results.shift()
    if (!next) throw new Error('unexpected extra call')
    if (next instanceof Error) throw next
    return next
  }
  return Object.assign(call, { prompts })
}
const ok = (text: string): ClaudeResult => ({ text, error: null })

describe('generateTitle', () => {
  it('fixture is over the limit, as recorded', () => {
    expect(T2_REJECTED.length).toBe(68)
    expect(T2_REJECTED.length).toBeGreaterThan(TITLE_MAX_LENGTH)
  })

  it('accepts a first-attempt title with the original prompt unchanged', async () => {
    const call = scripted(ok('Clarity without a place to put it'))
    const out = await generateTitle(NARRATIVE, call)
    expect(out).toEqual({ title: 'Clarity without a place to put it', attempts: 1, error: null })
    expect(call.prompts).toEqual([`${TITLE_PROMPT_TEMPLATE}${NARRATIVE}`])
  })

  it('accepts exactly TITLE_MAX_LENGTH characters', async () => {
    const exact = 'x'.repeat(TITLE_MAX_LENGTH)
    const out = await generateTitle(NARRATIVE, scripted(ok(exact)))
    expect(out.title).toBe(exact)
  })

  it('makes one corrective retry on over-length and accepts the corrected title', async () => {
    const call = scripted(ok(T2_REJECTED), ok('Clarity as the price of nowhere to put it'))
    const out = await generateTitle(NARRATIVE, call)
    expect(out).toEqual({ title: 'Clarity as the price of nowhere to put it', attempts: 2, error: null })
    expect(call.prompts).toHaveLength(2)
    const corrective = call.prompts[1]
    expect(corrective.startsWith(`${TITLE_PROMPT_TEMPLATE}${NARRATIVE}`)).toBe(true)
    expect(corrective).toContain(`"${T2_REJECTED}"`)
    expect(corrective).toContain('68 characters')
    expect(corrective).toContain(`at most ${TITLE_MAX_LENGTH} characters`)
  })

  it('returns title_error with both rejected values when over-length twice (no truncation, no third call)', async () => {
    const second = `${T2_REJECTED}, again`
    const call = scripted(ok(T2_REJECTED), ok(second))
    const out = await generateTitle(NARRATIVE, call)
    expect(out.title).toBeNull()
    expect(out.error).toEqual({
      phase: 'title_validation',
      reason: `over_length: ${second.length} > ${TITLE_MAX_LENGTH}`,
      attempts: 2,
      rejected_values: [T2_REJECTED, second],
    })
    expect(call.prompts).toHaveLength(2)
  })

  it('returns title_error on an API error without retrying', async () => {
    const call = scripted({ text: null, error: 'HTTP 529: overloaded' })
    const out = await generateTitle(NARRATIVE, call)
    expect(out).toEqual({
      title: null,
      attempts: 1,
      error: { phase: 'title_generation', reason: 'HTTP 529: overloaded', attempts: 1, rejected_values: [] },
    })
    expect(call.prompts).toHaveLength(1)
  })

  it('returns title_error when the call throws', async () => {
    const out = await generateTitle(NARRATIVE, scripted(new Error('socket hang up')))
    expect(out.error).toEqual({ phase: 'title_generation', reason: 'threw: socket hang up', attempts: 1, rejected_values: [] })
  })

  it('records the rejected first value when the corrective call errors', async () => {
    const out = await generateTitle(NARRATIVE, scripted(ok(T2_REJECTED), { text: null, error: 'HTTP 500: boom' }))
    expect(out.error).toEqual({ phase: 'title_generation', reason: 'HTTP 500: boom', attempts: 2, rejected_values: [T2_REJECTED] })
  })

  it('does not retry an empty title', async () => {
    const call = scripted(ok('   '))
    const out = await generateTitle(NARRATIVE, call)
    expect(out.error).toEqual({ phase: 'title_validation', reason: 'empty', attempts: 1, rejected_values: [] })
    expect(call.prompts).toHaveLength(1)
  })
})
