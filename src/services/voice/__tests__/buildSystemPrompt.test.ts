import { describe, expect, it } from 'vitest'
import { buildSystemPrompt } from '../buildSystemPrompt'

const base = {
  role: 'ROLE',
  cadence: 'CADENCE',
  connectionContext: 'CONN',
  nodeContent: 'NODES',
}

describe('buildSystemPrompt — relatedMaterial (Phase 10B)', () => {
  it('omits the RELATED MATERIAL section when absent (Phase 9 parity)', () => {
    const out = buildSystemPrompt(base)
    expect(out).not.toContain('RELATED MATERIAL')
  })

  it('omits the section when the block is empty/whitespace', () => {
    expect(buildSystemPrompt({ ...base, relatedMaterial: '   ' })).not.toContain(
      'RELATED MATERIAL',
    )
  })

  it('appends RELATED MATERIAL as a trailing section AFTER node content', () => {
    const out = buildSystemPrompt({ ...base, relatedMaterial: 'BLOCK' })
    expect(out).toContain('RELATED MATERIAL')
    expect(out.indexOf('NODE CONTENT')).toBeLessThan(out.indexOf('RELATED MATERIAL'))
    expect(out.indexOf('BLOCK')).toBeGreaterThan(out.indexOf('NODES'))
  })

  it('keeps relatedMaterial distinct from recentThinking (both can coexist)', () => {
    const out = buildSystemPrompt({
      ...base,
      recentThinking: 'THINKING',
      relatedMaterial: 'BLOCK',
    })
    // recentThinking sits before the connection context; relatedMaterial after nodes.
    expect(out.indexOf('THINKING')).toBeLessThan(out.indexOf('CONN'))
    expect(out.indexOf('BLOCK')).toBeGreaterThan(out.indexOf('NODES'))
  })
})
