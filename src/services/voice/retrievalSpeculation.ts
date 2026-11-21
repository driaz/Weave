/**
 * Speculative follow-up retrieval. While the silence timer runs, the turn's
 * retrieval work (embed + node-band RPC) starts on Scribe's running
 * transcript. At the commit the result is reused if the final transcript
 * says the same thing. If not, the turn runs the serial path as before.
 *
 * The speculative work must be free of side effects: it reads only. The
 * novelty filter, surfaced marking and working-memory admission all happen
 * at the commit, on whichever result the turn ends up using.
 *
 *   localStorage.setItem('weave.speculativeRetrieval', '0')  // kill switch
 *   localStorage.removeItem('weave.speculativeRetrieval')    // on (the default)
 */

export const SPECULATIVE_RETRIEVAL_FLAG = 'weave.speculativeRetrieval'
/**
 * Wait this long after the silence timer starts before speculating. It
 * skips the shortest pauses and gives Scribe's partial time to catch the
 * last word. The work (median ≈ 1.05 s in prod) still fits in the 1.5 s timer.
 */
export const SPECULATION_DELAY_MS = 300

export function readSpeculativeRetrievalEnabled(): boolean {
  try {
    const raw = (localStorage.getItem(SPECULATIVE_RETRIEVAL_FLAG) ?? '').trim().toLowerCase()
    return !(raw === '0' || raw === 'false' || raw === 'off')
  } catch {
    return true
  }
}

/** Case, punctuation and spacing don't change what was said. */
export function normalizeTranscript(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
}

export type SpeculationTake<T> =
  | {
      outcome: 'hit'
      /** The speculated text equals the final transcript character for character. */
      exact: boolean
      result: Promise<T>
      runs: number
      /** ms from this speculation's start to the take. */
      ageMs: number
      speculatedChars: number
    }
  | {
      outcome: 'miss' | 'none'
      reason: 'no_speculation' | 'text_changed' | 'other_turn' | 'failed'
      runs: number
      speculatedChars: number | null
    }

interface Run<T> {
  key: string
  text: string
  normalized: string
  startedAt: number
  controller: AbortController
  result: Promise<T>
  failed: boolean
}

export interface RetrievalSpeculatorOptions<T> {
  run: (text: string, signal: AbortSignal) => Promise<T>
  now?: () => number
}

/**
 * At most one speculation at a time, tagged with the turn it belongs to.
 * `start` with the same normalized text is a no-op; with new text it aborts
 * the old run and starts again.
 */
export class RetrievalSpeculator<T> {
  private current: Run<T> | null = null
  private runs = 0
  private runsKey: string | null = null
  private readonly opts: RetrievalSpeculatorOptions<T>
  private readonly now: () => number

  constructor(opts: RetrievalSpeculatorOptions<T>) {
    this.opts = opts
    this.now = opts.now ?? (() => performance.now())
  }

  start(key: string, text: string): void {
    const normalized = normalizeTranscript(text)
    if (!normalized) return
    const cur = this.current
    if (cur && cur.key === key && cur.normalized === normalized && !cur.failed) return
    this.cancel()
    if (this.runsKey !== key) {
      this.runsKey = key
      this.runs = 0
    }
    this.runs += 1
    const controller = new AbortController()
    const run: Run<T> = {
      key,
      text,
      normalized,
      startedAt: this.now(),
      controller,
      result: this.opts.run(text, controller.signal),
      failed: false,
    }
    // A failed speculation is retried on the next start, and never reused.
    run.result.catch(() => {
      run.failed = true
    })
    this.current = run
  }

  /** Abort and drop the speculation in flight, if any (speech resumed, teardown). */
  cancel(): void {
    const cur = this.current
    if (!cur) return
    this.current = null
    cur.controller.abort()
  }

  /**
   * Called once at the commit. Hands over the speculation if it matches
   * `finalText` for this turn. Either way the speculator is empty afterwards.
   */
  take(key: string, finalText: string): SpeculationTake<T> {
    const cur = this.current
    const runs = this.runsKey === key ? this.runs : 0
    this.runs = 0
    this.runsKey = null
    if (!cur) return { outcome: 'none', reason: 'no_speculation', runs, speculatedChars: null }
    this.current = null
    const miss = (reason: 'text_changed' | 'other_turn' | 'failed'): SpeculationTake<T> => {
      cur.controller.abort()
      return { outcome: 'miss', reason, runs, speculatedChars: cur.text.length }
    }
    if (cur.key !== key) return miss('other_turn')
    if (cur.failed) return miss('failed')
    if (cur.normalized !== normalizeTranscript(finalText)) return miss('text_changed')
    return {
      outcome: 'hit',
      exact: cur.text.trim() === finalText.trim(),
      result: cur.result,
      runs,
      ageMs: Math.round(this.now() - cur.startedAt),
      speculatedChars: cur.text.length,
    }
  }
}
