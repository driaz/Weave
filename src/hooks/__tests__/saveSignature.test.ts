import { describe, expect, it } from 'vitest'
import type { Connection } from '../../api/claude'
import { computeSaveSignature } from '../saveSignature'

const base: Connection = {
  from: '5',
  to: '7',
  label: 'x',
  explanation: '',
  type: 'related',
  strength: 0.5,
  surprise: 0.5,
  mode: 'weave',
}

describe('computeSaveSignature', () => {
  it('ignores connection ids — the id write-back after a save is not an edit', () => {
    expect(computeSaveSignature([], [{ ...base, id: 'edge-uuid' }])).toBe(
      computeSaveSignature([], [base]),
    )
  })

  it('still sees real connection edits', () => {
    expect(computeSaveSignature([], [{ ...base, label: 'y' }])).not.toBe(
      computeSaveSignature([], [base]),
    )
  })
})
