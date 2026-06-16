import { describe, expect, it } from 'vitest'
import { deriveSessionKind } from '../deriveSessionKind'

describe('deriveSessionKind', () => {
  it("classifies a bare production host as 'real'", () => {
    expect(deriveSessionKind('weave-project.netlify.app')).toBe('real')
  })

  it("classifies a custom production domain as 'real' (default, not enumerated)", () => {
    expect(deriveSessionKind('weave.app')).toBe('real')
  })

  it("classifies a feat-* branch preview as 'qa' (Netlify -- marker)", () => {
    expect(deriveSessionKind('feat-036-session-kind--weave-project.netlify.app')).toBe('qa')
  })

  it("classifies a deploy-preview-N host as 'qa' (Netlify -- marker)", () => {
    expect(deriveSessionKind('deploy-preview-12--weave-project.netlify.app')).toBe('qa')
  })

  it("classifies localhost as 'qa'", () => {
    expect(deriveSessionKind('localhost')).toBe('qa')
  })

  it("classifies IPv4 loopback as 'qa'", () => {
    expect(deriveSessionKind('127.0.0.1')).toBe('qa')
  })

  it("classifies IPv6 loopback as 'qa'", () => {
    expect(deriveSessionKind('::1')).toBe('qa')
  })

  it("classifies an mDNS .local host as 'qa'", () => {
    expect(deriveSessionKind('macbook.local')).toBe('qa')
  })

  it('is case-insensitive and trims', () => {
    expect(deriveSessionKind('  FEAT-X--Weave-Project.Netlify.App  ')).toBe('qa')
    expect(deriveSessionKind('LOCALHOST')).toBe('qa')
  })
})
