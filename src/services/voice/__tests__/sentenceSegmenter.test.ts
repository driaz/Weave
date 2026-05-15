import { describe, expect, it } from 'vitest'
import {
  createSentenceSegmenter,
  FORCE_SPLIT_WORD_LIMIT,
  MIN_SENTENCE_WORDS,
} from '../sentenceSegmenter'

function pushAll(text: string): string[] {
  const seg = createSentenceSegmenter()
  const out = seg.push(text)
  return out.concat(seg.flush())
}

function pushChunked(text: string, chunkSize: number): string[] {
  const seg = createSentenceSegmenter()
  const out: string[] = []
  for (let i = 0; i < text.length; i += chunkSize) {
    out.push(...seg.push(text.slice(i, i + chunkSize)))
  }
  out.push(...seg.flush())
  return out
}

describe('sentenceSegmenter', () => {
  describe('basic splitting', () => {
    it('splits three sentences on . ! ?', () => {
      // Each sentence ≥ MIN_SENTENCE_WORDS so the floor doesn't merge.
      const out = pushAll(
        'Hello dear world. This is really great! Is it though really?',
      )
      expect(out).toEqual([
        'Hello dear world.',
        'This is really great!',
        'Is it though really?',
      ])
    })

    it('emits nothing while only one partial sentence is buffered', () => {
      const seg = createSentenceSegmenter()
      expect(seg.push('This is an incomplete sentence with no end')).toEqual([])
    })

    it('flush() emits the trailing partial (even below min words)', () => {
      const seg = createSentenceSegmenter()
      expect(seg.push('Yes')).toEqual([])
      expect(seg.flush()).toEqual(['Yes'])
    })

    it('flush() on empty buffer returns []', () => {
      const seg = createSentenceSegmenter()
      expect(seg.flush()).toEqual([])
    })
  })

  describe('decimal numbers', () => {
    it('does not split inside 3.14', () => {
      expect(pushAll('It costs 3.14 dollars total.')).toEqual([
        'It costs 3.14 dollars total.',
      ])
    })

    it('does not split inside 2.5', () => {
      expect(pushAll('Average is 2.5 today.')).toEqual([
        'Average is 2.5 today.',
      ])
    })

    it('still splits a real sentence boundary after a decimal', () => {
      expect(pushAll('Price is 3.14 dollars. Next item ships tomorrow.')).toEqual([
        'Price is 3.14 dollars.',
        'Next item ships tomorrow.',
      ])
    })
  })

  describe('abbreviations', () => {
    it('does not split after Dr.', () => {
      expect(pushAll('Then Dr. Smith arrived at the lab.')).toEqual([
        'Then Dr. Smith arrived at the lab.',
      ])
    })

    it('does not split after etc.', () => {
      expect(pushAll('They brought books, pens, etc. to the meeting.')).toEqual([
        'They brought books, pens, etc. to the meeting.',
      ])
    })

    it('does not split after e.g.', () => {
      expect(pushAll('Bring snacks, e.g. fruit, to the picnic.')).toEqual([
        'Bring snacks, e.g. fruit, to the picnic.',
      ])
    })

    it('still splits a real sentence after an abbreviation', () => {
      expect(pushAll('Dr. Smith arrived. The room cheered loudly.')).toEqual([
        'Dr. Smith arrived.',
        'The room cheered loudly.',
      ])
    })

    it('does not split inside acronym U.S.A.', () => {
      // No whitespace after each interior period — never a boundary.
      expect(pushAll('She lives in the U.S.A. now permanently.')).toEqual([
        'She lives in the U.S.A. now permanently.',
      ])
    })
  })

  describe('ellipsis', () => {
    it('does not split on ...', () => {
      expect(pushAll('Wait... I am thinking about it.')).toEqual([
        'Wait... I am thinking about it.',
      ])
    })

    it('does not split on a longer ellipsis run', () => {
      expect(pushAll('Hmm.... So I guess we should try.')).toEqual([
        'Hmm.... So I guess we should try.',
      ])
    })

    it('still splits on a real period that follows the ellipsis', () => {
      expect(pushAll('Wait... I am thinking. The answer is yes.')).toEqual([
        'Wait... I am thinking.',
        'The answer is yes.',
      ])
    })
  })

  describe('quotes and parentheticals', () => {
    it('splits after a closing quote following a terminator', () => {
      expect(pushAll('She said "go." Then she left the room.')).toEqual([
        'She said "go."',
        'Then she left the room.',
      ])
    })

    it('splits after a closing paren following a terminator', () => {
      expect(pushAll('They paused (briefly.) Then continued onward.')).toEqual([
        'They paused (briefly.)',
        'Then continued onward.',
      ])
    })
  })

  describe('multi-terminator runs', () => {
    it('treats ?! as a single boundary', () => {
      // Each side ≥ MIN_SENTENCE_WORDS so the floor doesn't merge them.
      expect(
        pushAll('Did you really say that?! You should apologize now.'),
      ).toEqual(['Did you really say that?!', 'You should apologize now.'])
    })

    it('treats !! as a single boundary', () => {
      expect(
        pushAll('Stop right there now!! The light just changed.'),
      ).toEqual(['Stop right there now!!', 'The light just changed.'])
    })
  })

  describe('incremental feeding equivalence', () => {
    const cases = [
      'Hello world. This is great! Is it though?',
      'It costs 3.14 dollars total. Dr. Smith arrived.',
      'Wait... I am thinking about it. The answer is yes.',
      'She said "go." Then she left the room.',
      'Bring snacks, e.g. fruit, to the picnic. Then leave.',
    ]
    for (const text of cases) {
      it(`one-shot equals chunked-by-1 for: "${text.slice(0, 40)}..."`, () => {
        expect(pushChunked(text, 1)).toEqual(pushAll(text))
      })
      it(`one-shot equals chunked-by-3 for: "${text.slice(0, 40)}..."`, () => {
        expect(pushChunked(text, 3)).toEqual(pushAll(text))
      })
      it(`one-shot equals chunked-by-7 for: "${text.slice(0, 40)}..."`, () => {
        expect(pushChunked(text, 7)).toEqual(pushAll(text))
      })
    }
  })

  describe('min-sentence-words floor', () => {
    it('merges a 2-word "Yes." with the next sentence', () => {
      expect(pushAll('Yes. I think we should explore this further.')).toEqual([
        'Yes. I think we should explore this further.',
      ])
    })

    it('merges "I see." (2 words) with the next sentence', () => {
      expect(pushAll('I see. The pattern is now very clear.')).toEqual([
        'I see. The pattern is now very clear.',
      ])
    })

    it('emits when first candidate already meets the floor', () => {
      // "I see this." is 3 words → meets MIN_SENTENCE_WORDS.
      expect(MIN_SENTENCE_WORDS).toBe(3)
      expect(pushAll('I see this. The pattern is now clear.')).toEqual([
        'I see this.',
        'The pattern is now clear.',
      ])
    })

    it('flush() emits a tiny trailing partial even if below floor', () => {
      const seg = createSentenceSegmenter()
      expect(seg.push('A complete first sentence here. Yes')).toEqual([
        'A complete first sentence here.',
      ])
      expect(seg.flush()).toEqual(['Yes'])
    })
  })

  describe('force-split safety valve', () => {
    it('does NOT force-split a short unpunctuated buffer', () => {
      const seg = createSentenceSegmenter()
      const short = 'one two three four five six seven'
      expect(seg.push(short)).toEqual([])
      expect(seg.peekBuffer()).toBe(short)
    })

    it('force-splits when a long unpunctuated buffer exceeds the limit', () => {
      // 35 words, no punctuation at all.
      const words = Array.from({ length: 35 }, (_, i) => `w${i}`).join(' ')
      const out = pushAll(words)
      // flush() picks up the trailing partial — so total sentences ≥ 1
      // and the first emission must have been a forced split.
      expect(out.length).toBeGreaterThanOrEqual(1)
      const joined = out.join(' ')
      // No words lost.
      expect(joined.split(/\s+/).filter(Boolean).length).toBe(35)
    })

    it('force-splits at a clause boundary when one exists before the limit', () => {
      // Build "w0 w1 ... w20, w21 ... w30" — 31 words, comma after w20.
      const parts: string[] = []
      for (let i = 0; i < 31; i++) {
        parts.push(`w${i}${i === 20 ? ',' : ''}`)
      }
      const text = parts.join(' ')
      const seg = createSentenceSegmenter()
      const emitted = seg.push(text)
      expect(emitted.length).toBeGreaterThanOrEqual(1)
      // First emission should end at the comma (so it includes w20,).
      expect(emitted[0].endsWith('w20,')).toBe(true)
    })

    it('handles a runaway unpunctuated stream by keeping the pipeline moving', () => {
      const seg = createSentenceSegmenter()
      const long = Array.from({ length: 60 }, (_, i) => `tok${i}`).join(' ')
      const emitted = seg.push(long)
      // Should have produced at least one forced sentence rather than
      // leaving the whole thing buffered.
      expect(emitted.length).toBeGreaterThanOrEqual(1)
      // And the buffer should be smaller than the original input.
      expect(seg.peekBuffer().length).toBeLessThan(long.length)
    })

    it('FORCE_SPLIT_WORD_LIMIT is a sensible constant', () => {
      expect(FORCE_SPLIT_WORD_LIMIT).toBeGreaterThanOrEqual(20)
      expect(FORCE_SPLIT_WORD_LIMIT).toBeLessThanOrEqual(40)
    })
  })

  describe('edge cases', () => {
    it('handles empty pushes gracefully', () => {
      const seg = createSentenceSegmenter()
      expect(seg.push('')).toEqual([])
      expect(seg.push('Hello there. ')).toEqual([])
      // "Hello there." is only 2 words — merges with next. Second
      // boundary lands at end-of-buffer with no trailing whitespace, so
      // it can't be confirmed until flush().
      expect(seg.push('Then more came later.')).toEqual([])
      expect(seg.flush()).toEqual([
        'Hello there. Then more came later.',
      ])
    })

    it('waits for whitespace after a final terminator before emitting', () => {
      const seg = createSentenceSegmenter()
      // No whitespace follows the period → cannot disambiguate yet.
      expect(seg.push('Hello there friend.')).toEqual([])
      // Whitespace arrives → first boundary confirmed. The trailing
      // period is again end-of-buffer, so the second sentence waits for
      // flush() (or more text).
      expect(seg.push(' Next sentence here now.')).toEqual([
        'Hello there friend.',
      ])
      expect(seg.flush()).toEqual(['Next sentence here now.'])
    })

    it('treats interleaved decimals and sentences correctly', () => {
      expect(
        pushAll(
          'The cost is 1.5 dollars per unit. We sold 2.75 thousand today.',
        ),
      ).toEqual([
        'The cost is 1.5 dollars per unit.',
        'We sold 2.75 thousand today.',
      ])
    })

    it('handles abbreviation + decimal in same sentence', () => {
      expect(pushAll('Dr. Smith charges 3.14 dollars per visit.')).toEqual([
        'Dr. Smith charges 3.14 dollars per visit.',
      ])
    })
  })
})
