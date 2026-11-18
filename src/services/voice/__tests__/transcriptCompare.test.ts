import { describe, expect, it } from 'vitest'
import { normalizeWords, wordErrorRate } from '../transcriptCompare'

describe('normalizeWords', () => {
  it('lowercases and drops punctuation but keeps apostrophes and digits', () => {
    expect(normalizeWords("Well — I don't know, maybe 3 things?")).toEqual([
      'well', 'i', "don't", 'know', 'maybe', '3', 'things',
    ])
  })

  it('is empty for blank text', () => {
    expect(normalizeWords('  \n ')).toEqual([])
  })
})

describe('wordErrorRate', () => {
  it('is 0 when only case and punctuation differ', () => {
    expect(wordErrorRate('Hello, world.', 'hello world')).toBe(0)
  })

  it('counts a substitution, a deletion and an insertion', () => {
    expect(wordErrorRate('the quick brown fox', 'the quick red fox')).toBe(0.25)
    expect(wordErrorRate('the quick brown fox', 'the quick fox')).toBe(0.25)
    expect(wordErrorRate('the quick brown fox', 'the very quick brown fox')).toBe(0.25)
  })

  it('handles empty transcripts', () => {
    expect(wordErrorRate('', '')).toBe(0)
    expect(wordErrorRate('', 'something')).toBe(1)
    expect(wordErrorRate('two words', '')).toBe(1)
  })
})
