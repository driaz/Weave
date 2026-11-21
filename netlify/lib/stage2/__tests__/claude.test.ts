import { describe, expect, it } from 'vitest'
import { readClaudeResponse } from '../claude'

describe('readClaudeResponse', () => {
  it('reads the text block that follows a thinking block', () => {
    const result = readClaudeResponse({
      stop_reason: 'end_turn',
      content: [
        { type: 'thinking', text: undefined },
        { type: 'text', text: '  The reply.  ' },
      ],
    })
    expect(result).toEqual({ text: 'The reply.', error: null })
  })

  it('joins several text blocks', () => {
    const result = readClaudeResponse({
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'One. ' }, { type: 'thinking' }, { type: 'text', text: 'Two.' }],
    })
    expect(result.text).toBe('One. Two.')
  })

  it('reports a refusal with its category instead of reading content', () => {
    const result = readClaudeResponse({ stop_reason: 'refusal', stop_details: { category: 'cyber' }, content: [] })
    expect(result.text).toBeNull()
    expect(result.error).toContain('cyber')
  })

  it('treats max_tokens as a failure, with or without partial text', () => {
    const empty = readClaudeResponse({ stop_reason: 'max_tokens', content: [{ type: 'thinking' }] })
    expect(empty).toEqual({ text: null, error: 'Hit max_tokens before any reply text; raise the limit' })
    const partial = readClaudeResponse({ stop_reason: 'max_tokens', content: [{ type: 'text', text: 'Cut off mid' }] })
    expect(partial.text).toBeNull()
    expect(partial.error).toContain('mid-reply')
  })

  it('reports an unexpected shape when there is no text', () => {
    expect(readClaudeResponse({ stop_reason: 'end_turn', content: [] }).text).toBeNull()
    expect(readClaudeResponse(null).text).toBeNull()
  })
})
