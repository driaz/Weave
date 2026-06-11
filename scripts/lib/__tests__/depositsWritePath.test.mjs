import { describe, expect, it } from 'vitest'
import { computePromptVersion, parseSummary } from '../depositsWritePath.mjs'

describe('parseSummary', () => {
  it('parses delimited deposits plus open edge', () => {
    const rows = parseSummary('Deposit one body.\n---\nDeposit two body,\nmultiline.\n---\nOPEN EDGE: the live tension.')
    expect(rows).toEqual([
      { ordinal: 1, type: 'deposit', body: 'Deposit one body.', provenance: null },
      { ordinal: 2, type: 'deposit', body: 'Deposit two body,\nmultiline.', provenance: null },
      { ordinal: 3, type: 'open_edge', body: 'the live tension.', provenance: null },
    ])
  })

  it('drops the open_edge row on "OPEN EDGE: none"', () => {
    const rows = parseSummary('Only deposit.\n---\nOPEN EDGE: none')
    expect(rows).toEqual([{ ordinal: 1, type: 'deposit', body: 'Only deposit.', provenance: null }])
  })

  // Zero-delimiter shape: single-deposit draws have nothing to separate
  // (backfill 2026-06-11 — honest thin outputs from assistant-only stubs).
  it('parses zero-delimiter output as one deposit plus open edge', () => {
    const rows = parseSummary('There is no conversation to extract deposits from.\n\nOPEN EDGE: the unanswered closing question.')
    expect(rows).toEqual([
      { ordinal: 1, type: 'deposit', body: 'There is no conversation to extract deposits from.', provenance: null },
      { ordinal: 2, type: 'open_edge', body: 'the unanswered closing question.', provenance: null },
    ])
  })

  it('honors "OPEN EDGE: none" in zero-delimiter output', () => {
    const rows = parseSummary('Single honest deposit.\n\nOPEN EDGE: none')
    expect(rows).toEqual([{ ordinal: 1, type: 'deposit', body: 'Single honest deposit.', provenance: null }])
  })

  // Tripwire for the fabricated-continuation failure mode (session 72a855bd:
  // the model invented a multi-turn dialogue and summarized it; only an
  // accidental formatting artifact kept it out of prod).
  it('fails loud on speaker-tagged dialogue lines', () => {
    expect(() =>
      parseSummary('---\n\nUSER: an invented turn.\n\nASSISTANT: an invented reply.\n\n---\nOPEN EDGE: x'),
    ).toThrow(/fabricated dialogue/)
    expect(() => parseSummary('Deposit.\nASSISTANT: echoed line.\n---\nOPEN EDGE: x')).toThrow(/fabricated dialogue/)
  })

  it('fails loud when no open-edge marker exists', () => {
    expect(() => parseSummary('just prose with no markers at all')).toThrow(/no "OPEN EDGE:" marker/)
  })

  it('fails loud on an empty deposit body', () => {
    expect(() => parseSummary('---\nOPEN EDGE: x')).toThrow(/empty deposit body at segment 1/)
    expect(() => parseSummary('d1\n---\n---\nOPEN EDGE: x')).toThrow(/empty deposit body at segment 2/)
  })

  it('fails loud when the open edge is not last', () => {
    expect(() => parseSummary('OPEN EDGE: early\n---\nreal deposit\n---\nOPEN EDGE: real')).toThrow(/final segment only/)
  })

  it('fails loud on more than one open edge in the final segment', () => {
    expect(() => parseSummary('d1\n---\nOPEN EDGE: a OPEN EDGE: b')).toThrow(/more than one/)
  })

  it('fails loud when the final delimited segment lacks the marker', () => {
    expect(() => parseSummary('d1\n---\nd2 with no marker')).toThrow(/does not start with "OPEN EDGE:"/)
  })

  it('fails loud on an empty open-edge body', () => {
    expect(() => parseSummary('d1\n---\nOPEN EDGE:')).toThrow(/body is empty/)
  })

  it('fails loud on empty input', () => {
    expect(() => parseSummary('   \n ')).toThrow(/empty summary/)
  })
})

describe('computePromptVersion', () => {
  it('returns the first 16 hex chars of sha256', () => {
    expect(computePromptVersion('test')).toBe('9f86d081884c7d65')
  })
})
