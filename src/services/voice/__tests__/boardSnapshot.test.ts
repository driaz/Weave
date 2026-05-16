import { describe, expect, it } from 'vitest'
import type { Node } from '@xyflow/react'
import type { Connection } from '../../../api/claude'
import { buildBoardSnapshot } from '../boardSnapshot'

const FIXED_NOW = new Date('2026-05-16T12:00:00.000Z')
const now = () => FIXED_NOW

function n(partial: Partial<Node>): Node {
  return {
    id: 'placeholder',
    position: { x: 0, y: 0 },
    data: {},
    ...partial,
  } as Node
}

describe('buildBoardSnapshot', () => {
  it('returns an empty snapshot with a captured_at on an empty board', () => {
    const snapshot = buildBoardSnapshot({ nodes: [], connections: [], now })
    expect(snapshot).toEqual({
      nodes: [],
      edges: [],
      captured_at: FIXED_NOW.toISOString(),
    })
  })

  it('passes through node id, type, and position', () => {
    const snapshot = buildBoardSnapshot({
      nodes: [
        n({
          id: 'node-1',
          type: 'textCard',
          position: { x: 100, y: 200 },
          data: { text: 'hello' },
        }),
      ],
      connections: [],
      now,
    })
    expect(snapshot.nodes).toEqual([
      {
        id: 'node-1',
        type: 'textCard',
        position: { x: 100, y: 200 },
        preview_text: 'hello',
      },
    ])
  })

  it('truncates long text-card text to 200 chars', () => {
    const longText = 'x'.repeat(500)
    const snapshot = buildBoardSnapshot({
      nodes: [n({ id: 'a', type: 'textCard', data: { text: longText } })],
      connections: [],
      now,
    })
    expect(snapshot.nodes[0].preview_text).toBe('x'.repeat(200))
  })

  it('prefers label over fileName on imageCard', () => {
    const snapshot = buildBoardSnapshot({
      nodes: [
        n({
          id: 'i1',
          type: 'imageCard',
          data: {
            label: 'Sunset photo',
            fileName: 'IMG_1234.png',
            imageDataUrl: 'data:image/png;base64,abc',
          },
        }),
      ],
      connections: [],
      now,
    })
    expect(snapshot.nodes[0].preview_text).toBe('Sunset photo')
  })

  it('falls back to fileName when label is empty on imageCard', () => {
    const snapshot = buildBoardSnapshot({
      nodes: [
        n({
          id: 'i2',
          type: 'imageCard',
          data: { label: '', fileName: 'photo.jpg', imageDataUrl: '' },
        }),
      ],
      connections: [],
      now,
    })
    expect(snapshot.nodes[0].preview_text).toBe('photo.jpg')
  })

  it('returns empty string for imageCard with neither label nor fileName', () => {
    const snapshot = buildBoardSnapshot({
      nodes: [
        n({
          id: 'i3',
          type: 'imageCard',
          data: { label: '', fileName: '', imageDataUrl: '' },
        }),
      ],
      connections: [],
      now,
    })
    expect(snapshot.nodes[0].preview_text).toBe('')
  })

  it('uses title for youtube linkCard preview', () => {
    const snapshot = buildBoardSnapshot({
      nodes: [
        n({
          id: 'l1',
          type: 'linkCard',
          data: {
            type: 'youtube',
            title: 'How HNSW works',
            description: 'short blurb',
            contentDescription: 'a longer summary',
            url: 'https://youtube.com/watch?v=abc',
          },
        }),
      ],
      connections: [],
      now,
    })
    expect(snapshot.nodes[0].preview_text).toBe('How HNSW works')
  })

  it('falls back to contentDescription for youtube when title is missing', () => {
    const snapshot = buildBoardSnapshot({
      nodes: [
        n({
          id: 'l2',
          type: 'linkCard',
          data: {
            type: 'youtube',
            title: '',
            contentDescription: 'a longer summary',
            description: '',
            url: 'https://youtube.com/watch?v=abc',
          },
        }),
      ],
      connections: [],
      now,
    })
    expect(snapshot.nodes[0].preview_text).toBe('a longer summary')
  })

  it('uses tweetText for twitter linkCard preview', () => {
    const snapshot = buildBoardSnapshot({
      nodes: [
        n({
          id: 'l3',
          type: 'linkCard',
          data: {
            type: 'twitter',
            tweetText: 'the tweet itself',
            title: 'twitter card title',
            url: 'https://x.com/x/status/1',
          },
        }),
      ],
      connections: [],
      now,
    })
    expect(snapshot.nodes[0].preview_text).toBe('the tweet itself')
  })

  it('uses title for generic linkCard preview', () => {
    const snapshot = buildBoardSnapshot({
      nodes: [
        n({
          id: 'l4',
          type: 'linkCard',
          data: {
            title: 'An article',
            description: 'description text',
            url: 'https://example.com/a',
          },
        }),
      ],
      connections: [],
      now,
    })
    expect(snapshot.nodes[0].preview_text).toBe('An article')
  })

  it('uses label or fileName for pdfCard', () => {
    const snapshot = buildBoardSnapshot({
      nodes: [
        n({
          id: 'p1',
          type: 'pdfCard',
          data: {
            label: '',
            fileName: 'paper.pdf',
            pdfDataUrl: '',
            thumbnailDataUrl: '',
            pageCount: 12,
          },
        }),
      ],
      connections: [],
      now,
    })
    expect(snapshot.nodes[0].preview_text).toBe('paper.pdf')
  })

  it('returns empty preview_text for unknown node types', () => {
    const snapshot = buildBoardSnapshot({
      nodes: [n({ id: 'x', type: 'somethingNew', data: { title: 'ignored' } })],
      connections: [],
      now,
    })
    expect(snapshot.nodes[0].preview_text).toBe('')
    expect(snapshot.nodes[0].type).toBe('somethingNew')
  })

  it('strips the "node-" prefix on connection endpoints and derives stable ids', () => {
    const conns: Connection[] = [
      {
        from: 'node-1',
        to: 'node-2',
        label: 'related',
        explanation: 'r',
        type: 'parallel',
        strength: 1,
        surprise: 0,
      },
      {
        from: '3',
        to: '4',
        label: 'other',
        explanation: 'o',
        type: 'tension',
        strength: 1,
        surprise: 0,
      },
    ]
    const snapshot = buildBoardSnapshot({ nodes: [], connections: conns, now })
    expect(snapshot.edges).toEqual([
      { id: 'weave-1-2-0', source: '1', target: '2' },
      { id: 'weave-3-4-1', source: '3', target: '4' },
    ])
  })

  it('defaults position to {0,0} when node.position is missing', () => {
    const node = {
      id: 'z',
      type: 'textCard',
      data: { text: 't' },
    } as unknown as Node
    const snapshot = buildBoardSnapshot({
      nodes: [node],
      connections: [],
      now,
    })
    expect(snapshot.nodes[0].position).toEqual({ x: 0, y: 0 })
  })

  it('uses Date.now() when no override is provided and produces a valid ISO timestamp', () => {
    const snapshot = buildBoardSnapshot({ nodes: [], connections: [] })
    expect(snapshot.captured_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  })
})
