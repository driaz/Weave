import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import roleText from '../../../../prompts/role.txt?raw'
import cadenceOpeningText from '../../../../prompts/cadence-opening.txt?raw'
import cadenceFollowupText from '../../../../prompts/cadence-followup.txt?raw'

/**
 * Voice prompt caching (docs/reads/voice-prompt-cache.md). The system prompt
 * goes out as three text blocks with cache breakpoints on the first two. The
 * blocks must join to exactly the pre-cache single string, so the model sees
 * the same prompt text.
 */

vi.mock('../../supabaseClient', () => ({
  supabase: {
    auth: {
      getSession: async () => ({ data: { session: { access_token: 'tok' } } }),
    },
  },
}))

import { buildSystemBlocks, type SystemPromptInput } from '../buildSystemPrompt'
import {
  runConversationTurn,
  toSystemParam,
  type ConversationMessage,
  type SystemTextBlock,
} from '../conversationOrchestrator'

/** buildSystemPrompt as it was before the block split (bc88467), verbatim. */
function legacyBuildSystemPrompt(input: SystemPromptInput): string {
  const { role, cadence, recentThinking, connectionContext, nodeContent, relatedMaterial, workingMemory } = input
  const sections: string[] = [role, '---', cadence]
  if (recentThinking && recentThinking.trim().length > 0) {
    sections.push('---', 'RECENT THINKING', LEGACY_RECENT_THINKING_FRAMING, recentThinking)
  }
  sections.push('---', 'CONNECTION CONTEXT', '', connectionContext, '---', 'NODE CONTENT', '', nodeContent)
  if (relatedMaterial && relatedMaterial.trim().length > 0) {
    sections.push('---', 'RELATED MATERIAL', relatedMaterial)
  }
  if (workingMemory && workingMemory.trim().length > 0) {
    sections.push('---', 'SURFACED THIS SESSION', workingMemory)
  }
  return sections.join('\n\n')
}

const LEGACY_RECENT_THINKING_FRAMING =
  "A recent analytical read of patterns across the user's canvas — " +
  'interpretive threads, not facts, as of recently. Use it as ground ' +
  'for committing to specific reads of the current edge rather than ' +
  "hedging. Do not refer to it, summarize it, or signal you've read " +
  'it. Let it shape what you notice and what you say, not how you ' +
  'announce yourself.'

const CONNECTION = 'Type: tension\nStrength: 0.8\nExplanation: both argue about attention.'
const NODES = 'Node A: "---" a card whose text\n\ncontains a separator\n\nNode B: second card.'
const RECENT = 'Threads on attention and craft.\n\nA second paragraph.'
const RELATED = 'Related: a card from another board.'
const SURFACED = '- deposit one\n- deposit two'

const opener = (extra: Partial<SystemPromptInput> = {}): SystemPromptInput => ({
  role: roleText,
  cadence: cadenceOpeningText,
  recentThinking: RECENT,
  connectionContext: CONNECTION,
  nodeContent: NODES,
  ...extra,
})

const followup = (extra: Partial<SystemPromptInput> = {}): SystemPromptInput => ({
  role: roleText,
  cadence: cadenceFollowupText,
  connectionContext: CONNECTION,
  nodeContent: NODES,
  ...extra,
})

const FIXTURES: Record<string, SystemPromptInput> = {
  'opener, snapshot, nothing retrieved': opener(),
  'opener, no snapshot': opener({ recentThinking: undefined }),
  'opener, related + surfaced': opener({ relatedMaterial: RELATED, workingMemory: SURFACED }),
  'follow-up, nothing retrieved': followup(),
  'follow-up, related only': followup({ relatedMaterial: RELATED }),
  'follow-up, surfaced only': followup({ workingMemory: SURFACED }),
  'follow-up, related + surfaced': followup({ relatedMaterial: RELATED, workingMemory: SURFACED }),
  'follow-up, whitespace-only blocks': followup({ relatedMaterial: '  ', workingMemory: '\n' }),
}

const joined = (system: SystemTextBlock[]): string => system.map((b) => b.text).join('')

describe('buildSystemBlocks — byte equality with the pre-cache prompt', () => {
  for (const [name, input] of Object.entries(FIXTURES)) {
    it(`${name}: blocks join to the legacy string`, () => {
      const legacy = legacyBuildSystemPrompt(input)
      expect(buildSystemBlocks(input).join('')).toBe(legacy)
      expect(joined(toSystemParam(buildSystemBlocks(input)))).toBe(legacy)
    })
  }
})

describe('toSystemParam — breakpoint placement', () => {
  it('marks exactly blocks 1 and 2, leaving the volatile block unmarked', () => {
    const system = toSystemParam(buildSystemBlocks(followup({ workingMemory: SURFACED })))
    expect(system).toHaveLength(3)
    expect(system.map((b) => b.cache_control)).toEqual([
      { type: 'ephemeral' },
      { type: 'ephemeral' },
      undefined,
    ])
  })

  it('omits the volatile block when empty (the API rejects empty text blocks)', () => {
    const system = toSystemParam(buildSystemBlocks(followup()))
    expect(system).toHaveLength(2)
    expect(system.every((b) => b.text.length > 0)).toBe(true)
    expect(system.filter((b) => b.cache_control)).toHaveLength(2)
  })
})

describe('buildSystemBlocks — cache-prefix stability', () => {
  it('block 1 is identical between opener and follow-up', () => {
    const [openerRole] = buildSystemBlocks(opener({ relatedMaterial: RELATED }))
    const [followupRole] = buildSystemBlocks(followup({ workingMemory: SURFACED }))
    expect(openerRole).toBe(followupRole)
    expect(openerRole).toBe(`${roleText}\n\n---\n\n`)
  })

  it('block 2 does not change with whether the volatile block is present', () => {
    const stable = buildSystemBlocks(followup())[1]
    expect(buildSystemBlocks(followup({ relatedMaterial: RELATED }))[1]).toBe(stable)
    expect(buildSystemBlocks(followup({ workingMemory: SURFACED }))[1]).toBe(stable)
    expect(
      buildSystemBlocks(followup({ relatedMaterial: RELATED, workingMemory: SURFACED }))[1],
    ).toBe(stable)
  })
})

describe('runConversationTurn — request body', () => {
  let bodies: Array<Record<string, unknown>>

  beforeEach(() => {
    bodies = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        bodies.push(JSON.parse(init.body as string))
        const sse = [
          { type: 'message_start', message: { usage: { input_tokens: 1 } } },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hi.' } },
          { type: 'message_stop' },
        ]
          .map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`)
          .join('')
        return new Response(sse, { status: 200 })
      }),
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  async function send(input: Parameters<typeof runConversationTurn>[0]): Promise<Record<string, unknown>> {
    for await (const chunk of runConversationTurn(input)) void chunk
    return bodies[bodies.length - 1]
  }

  it('opener: sends the pre-assembled blocks with breakpoints on 1 and 2', async () => {
    const blocks = buildSystemBlocks(opener())
    const body = await send({
      connectionContext: CONNECTION,
      nodeContent: NODES,
      messages: [{ role: 'user', content: 'Begin.' }],
      systemBlocks: blocks,
    })
    const system = body.system as SystemTextBlock[]
    expect(joined(system)).toBe(legacyBuildSystemPrompt(opener()))
    expect(system.map((b) => Boolean(b.cache_control))).toEqual([true, true])
  })

  it('follow-up: assembles with cadence-followup and keeps the same block 1', async () => {
    const messages: ConversationMessage[] = [
      { role: 'assistant', content: 'Opening observation.' },
      { role: 'user', content: 'say more' },
    ]
    const body = await send({
      connectionContext: CONNECTION,
      nodeContent: NODES,
      messages,
      workingMemory: SURFACED,
    })
    const system = body.system as SystemTextBlock[]
    expect(joined(system)).toBe(legacyBuildSystemPrompt(followup({ workingMemory: SURFACED })))
    expect(system.map((b) => Boolean(b.cache_control))).toEqual([true, true, false])
    expect(system[0].text).toBe(buildSystemBlocks(opener())[0])
    // No top-level automatic caching; request settings unchanged.
    expect(body).not.toHaveProperty('cache_control')
    expect(body).toMatchObject({
      model: 'claude-opus-5',
      max_tokens: 4096,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'low' },
      stream: true,
    })
  })
})
