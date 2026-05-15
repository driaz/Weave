/**
 * Sentence segmenter — pure, streaming-friendly punctuation-based scanner.
 *
 * Built for the Voice v2 sentence-chunked TTS path: Claude's tokens arrive
 * incrementally; this module decides when a complete sentence is in hand
 * so the controller can fire a TTS request for it while Claude continues
 * generating the next.
 *
 * Pure module: no audio, no network, no AudioContext, no controller imports.
 *
 * Detection is punctuation-based. Failure modes deliberately handled:
 *
 *   - Decimals: `3.14` is not a sentence boundary.
 *   - Abbreviations: a small list (Dr. Mr. Mrs. Ms. Prof. Sr. Jr. St.
 *     etc. e.g. i.e. vs. cf. No. Vol. pp.) — period after one is not a
 *     boundary.
 *   - Ellipsis: `...` is treated as a soft pause, not a boundary.
 *   - Multi-letter abbreviations without trailing whitespace (e.g.
 *     `U.S.A.`) — no boundary unless followed by whitespace + capital.
 *   - Closing quotes/parens: `She said "go." Then left.` splits after
 *     the closing quote.
 *
 * Min-sentence-words floor: candidate sentences below MIN_SENTENCE_WORDS
 * merge with the next sentence so TTS doesn't get one-word stubs like
 * "Yes." as their own request.
 *
 * Force-split safety valve: if the buffer grows past
 * FORCE_SPLIT_WORD_LIMIT words without any detected boundary, split at
 * the most recent clause boundary (, ; :) or word boundary near the
 * limit. Prevents one runaway unpunctuated stretch from blocking the
 * pipeline.
 */

/** Above this word count with no detected boundary, force a split. */
export const FORCE_SPLIT_WORD_LIMIT = 28

/**
 * Candidates shorter than this merge with the next sentence. Prevents
 * absurd one-word TTS segments. flush() ignores this floor.
 */
export const MIN_SENTENCE_WORDS = 3

const ABBREVIATIONS = new Set<string>([
  'dr',
  'mr',
  'mrs',
  'ms',
  'prof',
  'sr',
  'jr',
  'st',
  'ave',
  'blvd',
  'etc',
  'eg',
  'ie',
  'vs',
  'cf',
  'no',
  'vol',
  'pp',
])

const TERMINATOR_RE = /[.!?]/
const CLOSER_RE = /["')\]]/
const DIGIT_RE = /\d/
const WS_RE = /\s/
const LETTER_RE = /[A-Za-z]/

function isAbbreviation(word: string): boolean {
  if (!word) return false
  const normalized = word.toLowerCase().replace(/[^a-z]/g, '')
  return ABBREVIATIONS.has(normalized)
}

function countWords(s: string): number {
  if (!s) return 0
  let count = 0
  let inWord = false
  for (let i = 0; i < s.length; i++) {
    const isWs = WS_RE.test(s[i])
    if (!isWs && !inWord) {
      count++
      inWord = true
    } else if (isWs) {
      inWord = false
    }
  }
  return count
}

/**
 * Result of scanning for a boundary. `start` is the index of the first
 * terminator char; `end` is the index after the last closing quote/paren.
 * The sentence content is buffer.slice(0, end).
 */
interface Boundary {
  start: number
  end: number
}

/**
 * Scan `buffer` from `fromIndex` for the next sentence boundary.
 * Returns null if no boundary can be confirmed yet (either no terminator
 * found, or a terminator is at end-of-buffer with no following character
 * to disambiguate).
 */
function findNextBoundary(buffer: string, fromIndex: number): Boundary | null {
  let i = fromIndex
  while (i < buffer.length) {
    const ch = buffer[i]
    if (!TERMINATOR_RE.test(ch)) {
      i++
      continue
    }

    // Decimal: digit-period-digit. Only applies to `.`.
    if (
      ch === '.' &&
      i > 0 &&
      i + 1 < buffer.length &&
      DIGIT_RE.test(buffer[i - 1]) &&
      DIGIT_RE.test(buffer[i + 1])
    ) {
      i++
      continue
    }

    // Consume consecutive terminators (e.g., "?!" or "...").
    const termStart = i
    let termEnd = i
    while (termEnd < buffer.length && TERMINATOR_RE.test(buffer[termEnd])) {
      termEnd++
    }
    const terminatorRun = buffer.slice(termStart, termEnd)

    // Ellipsis: a run of 3+ dots (`...`) is a soft pause, not a boundary.
    if (/^\.{3,}$/.test(terminatorRun)) {
      i = termEnd
      continue
    }

    // Include any closing quotes/parens immediately after the terminator.
    let afterClosing = termEnd
    while (afterClosing < buffer.length && CLOSER_RE.test(buffer[afterClosing])) {
      afterClosing++
    }

    const atEnd = afterClosing >= buffer.length
    if (atEnd) {
      // Can't disambiguate yet — wait for more text.
      return null
    }

    const next = buffer[afterClosing]
    const followedByWs = WS_RE.test(next)

    if (!followedByWs) {
      // E.g., "U.S.A." mid-acronym: period followed by a letter is not a
      // boundary. Keep scanning past this terminator run.
      i = termEnd
      continue
    }

    // Abbreviation check applies only to a plain single `.` (not "?", "!",
    // or "?!" — those are unambiguous sentence enders). Walk back through
    // both letters and interior periods so we can spot patterns like
    // `e.g.` and `U.S.A.` whose "word" spans multiple periods.
    if (terminatorRun === '.') {
      let wstart = termStart - 1
      while (
        wstart >= 0 &&
        (LETTER_RE.test(buffer[wstart]) || buffer[wstart] === '.')
      ) {
        wstart--
      }
      wstart++
      const word = buffer.slice(wstart, termStart)
      // Any word containing an interior period (`e.g`, `U.S.A`) is treated
      // as an acronym/abbreviation pattern — never a sentence boundary.
      if (word.includes('.')) {
        i = termEnd
        continue
      }
      if (isAbbreviation(word)) {
        i = termEnd
        continue
      }
    }

    return { start: termStart, end: afterClosing }
  }
  return null
}

/**
 * Find a force-split point inside `buffer`. Prefers the most recent
 * clause boundary (, ; :) — split AFTER it so the previous clause is the
 * emitted sentence. If no clause boundary found, split at the last word
 * boundary near the limit so we still make progress.
 *
 * Returns the index at which to split (sentence = buffer.slice(0, idx)),
 * or null if the buffer is too short to force-split sensibly.
 */
function findForceSplit(buffer: string): number | null {
  // Walk forward; remember the last clause boundary seen up to the limit
  // word, and a fallback word boundary. We split based on word count, so
  // count words as we go.
  let words = 0
  let inWord = false
  let lastClauseIdx = -1
  let lastWordEndIdx = -1
  for (let i = 0; i < buffer.length; i++) {
    const ch = buffer[i]
    const isWs = WS_RE.test(ch)
    if (!isWs && !inWord) {
      words++
      inWord = true
    } else if (isWs) {
      if (inWord) lastWordEndIdx = i
      inWord = false
    }
    if (ch === ',' || ch === ';' || ch === ':') {
      // Split AFTER the punctuation + any whitespace.
      let j = i + 1
      while (j < buffer.length && WS_RE.test(buffer[j])) j++
      lastClauseIdx = j
    }
    if (words >= FORCE_SPLIT_WORD_LIMIT) break
  }
  if (lastClauseIdx > 0) return lastClauseIdx
  if (lastWordEndIdx > 0) {
    // Split at the whitespace after the last word, consuming the space.
    let j = lastWordEndIdx
    while (j < buffer.length && WS_RE.test(buffer[j])) j++
    return j
  }
  return null
}

export interface SentenceSegmenter {
  /** Append `text` and return any sentences completed by this push. */
  push(text: string): string[]
  /** End-of-stream: emit any remaining partial as a final sentence. */
  flush(): string[]
  /** Current unfinished buffer (for diagnostics / tests). */
  peekBuffer(): string
}

export function createSentenceSegmenter(): SentenceSegmenter {
  let buffer = ''

  function drain(): string[] {
    const out: string[] = []
    let lastEmitEnd = 0
    let scanFrom = 0

    while (true) {
      const boundary = findNextBoundary(buffer, scanFrom)
      if (boundary === null) break

      const candidate = buffer.slice(lastEmitEnd, boundary.end).trim()
      if (countWords(candidate) >= MIN_SENTENCE_WORDS) {
        out.push(candidate)
        lastEmitEnd = boundary.end
        while (lastEmitEnd < buffer.length && WS_RE.test(buffer[lastEmitEnd])) {
          lastEmitEnd++
        }
        scanFrom = lastEmitEnd
      } else {
        // Below floor — merge with whatever comes next. Skip past this
        // boundary but don't slice the buffer.
        scanFrom = boundary.end
      }
    }

    if (lastEmitEnd > 0) {
      buffer = buffer.slice(lastEmitEnd)
    }

    // Force-split safety valve. If we still have a large unpunctuated
    // buffer (no boundary detected and a backlog), force a split so the
    // pipeline doesn't stall on a runaway unpunctuated stretch.
    while (countWords(buffer) >= FORCE_SPLIT_WORD_LIMIT) {
      const splitIdx = findForceSplit(buffer)
      if (splitIdx === null || splitIdx <= 0) break
      const forced = buffer.slice(0, splitIdx).trim()
      if (forced.length === 0) break
      out.push(forced)
      buffer = buffer.slice(splitIdx)
    }

    return out
  }

  return {
    push(text) {
      if (!text) return []
      buffer += text
      return drain()
    },
    flush() {
      const remaining = buffer.trim()
      buffer = ''
      return remaining.length > 0 ? [remaining] : []
    },
    peekBuffer() {
      return buffer
    },
  }
}
