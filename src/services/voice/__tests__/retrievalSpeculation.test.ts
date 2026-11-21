import { describe, expect, it } from 'vitest'
import { normalizeTranscript, RetrievalSpeculator } from '../retrievalSpeculation'

function harness() {
  const calls: Array<{ text: string; signal: AbortSignal; resolve: (v: string) => void; reject: (e: Error) => void }> = []
  const clock = { t: 0 }
  const speculator = new RetrievalSpeculator<string>({
    run: (text, signal) =>
      new Promise<string>((resolve, reject) => calls.push({ text, signal, resolve, reject })),
    now: () => clock.t,
  })
  return { speculator, calls, clock }
}

describe('normalizeTranscript', () => {
  it('ignores case, punctuation and spacing', () => {
    expect(normalizeTranscript("  What's the  WARNING, in this case? ")).toBe('whats the warning in this case')
  })
})

describe('RetrievalSpeculator', () => {
  it('hands over a speculation whose text matches the final', async () => {
    const { speculator, calls, clock } = harness()
    speculator.start('turn-1', 'what is the warning')
    clock.t = 900
    const take = speculator.take('turn-1', 'What is the warning?')
    expect(take.outcome).toBe('hit')
    if (take.outcome !== 'hit') return
    expect(take.exact).toBe(false)
    expect(take.ageMs).toBe(900)
    expect(take.runs).toBe(1)
    calls[0].resolve('result')
    await expect(take.result).resolves.toBe('result')
    expect(calls[0].signal.aborted).toBe(false)
  })

  it('marks a character-for-character match as exact', () => {
    const { speculator } = harness()
    speculator.start('turn-1', 'What is the warning?')
    const take = speculator.take('turn-1', 'What is the warning?')
    expect(take.outcome === 'hit' && take.exact).toBe(true)
  })

  it('does not restart for the same normalized text', () => {
    const { speculator, calls } = harness()
    speculator.start('turn-1', 'hello there')
    speculator.start('turn-1', 'Hello there.')
    expect(calls).toHaveLength(1)
  })

  it('aborts the old run when the text changes', () => {
    const { speculator, calls } = harness()
    speculator.start('turn-1', 'hello')
    speculator.start('turn-1', 'hello there')
    expect(calls).toHaveLength(2)
    expect(calls[0].signal.aborted).toBe(true)
    expect(calls[1].signal.aborted).toBe(false)
    const take = speculator.take('turn-1', 'hello there')
    expect(take.outcome).toBe('hit')
    expect(take.runs).toBe(2)
  })

  it('misses and aborts when the final says something else', () => {
    const { speculator, calls } = harness()
    speculator.start('turn-1', 'hello')
    const take = speculator.take('turn-1', 'hello there')
    expect(take).toMatchObject({ outcome: 'miss', reason: 'text_changed', speculatedChars: 5 })
    expect(calls[0].signal.aborted).toBe(true)
  })

  it('never hands a speculation to another turn', () => {
    const { speculator } = harness()
    speculator.start('turn-1', 'hello')
    expect(speculator.take('turn-2', 'hello')).toMatchObject({ outcome: 'miss', reason: 'other_turn' })
  })

  it('misses on a run that already failed, and retries it on the next start', async () => {
    const { speculator, calls } = harness()
    speculator.start('turn-1', 'hello')
    calls[0].reject(new Error('embed failed'))
    await Promise.resolve()
    await Promise.resolve()
    speculator.start('turn-1', 'hello')
    expect(calls).toHaveLength(2)
    calls[1].reject(new Error('embed failed again'))
    await Promise.resolve()
    await Promise.resolve()
    expect(speculator.take('turn-1', 'hello')).toMatchObject({ outcome: 'miss', reason: 'failed' })
  })

  it('cancel aborts the run, and the commit then finds nothing', () => {
    const { speculator, calls } = harness()
    speculator.start('turn-1', 'hello')
    speculator.cancel()
    expect(calls[0].signal.aborted).toBe(true)
    expect(speculator.take('turn-1', 'hello')).toMatchObject({ outcome: 'none', runs: 1 })
  })

  it('is empty after a take', () => {
    const { speculator } = harness()
    speculator.start('turn-1', 'hello')
    speculator.take('turn-1', 'hello')
    expect(speculator.take('turn-1', 'hello')).toMatchObject({ outcome: 'none', runs: 0 })
  })

  it('ignores empty text', () => {
    const { speculator, calls } = harness()
    speculator.start('turn-1', ' ... ')
    expect(calls).toHaveLength(0)
  })
})
