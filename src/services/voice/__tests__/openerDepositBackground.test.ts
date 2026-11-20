import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Connection } from '../../../api/claude'
import type { DepositCorpusLoad, DepositCorpusRow } from '../depositRetrieval'
import type { RetrievalRow, WorkingMemoryEntry } from '../retrievalContext'

// The opener runs the deposit band in the background, after the node band (its
// output can't reach the opener's own prompt, and its download would compete
// with the node band's reads), while the node band still feeds RELATED MATERIAL.
// These tests pin the two promises that change makes: the opener no longer
// waits on the corpus download, and the next turn's working memory is exactly
// what the old serial path produced.

const loadDepositCorpus = vi.fn<() => Promise<DepositCorpusLoad>>()
const fetchRetrievalContext = vi.fn<() => Promise<RetrievalRow[]>>()

vi.mock('../depositRetrieval', async (importActual) => ({
  ...(await importActual<typeof import('../depositRetrieval')>()),
  loadDepositCorpus: () => loadDepositCorpus(),
}))
vi.mock('../retrievalContext', async (importActual) => ({
  ...(await importActual<typeof import('../retrievalContext')>()),
  fetchRetrievalContext: () => fetchRetrievalContext(),
}))
vi.mock('../../../persistence/session', () => ({ requireClient: () => ({}) }))

const { VadController } = await import('../vadController')

interface RetrievalInternals {
  runRetrieval(
    client: object,
    queryVector: number[],
    opts?: { depositsInBackground?: boolean },
  ): Promise<string | null>
  awaitPendingRetrievalAdmissions(): Promise<void>
  workingMemory: Map<string, WorkingMemoryEntry>
}

const anchor = { from: 'node-1', to: 'node-2', mode: 'weave' } as unknown as Connection

function makeController(): RetrievalInternals {
  const controller = new VadController({
    boardId: 'board-1',
    connectionContext: 'ctx',
    nodeContent: 'nodes',
    anchorConnection: anchor,
    connections: [anchor],
    liveNodeIds: ['1', '2', '3', '4'],
  })
  return controller as unknown as RetrievalInternals
}

function deposit(i: number, bodyChars: number): DepositCorpusRow {
  return {
    id: `dep-${i}`,
    sessionId: `s-${i}`,
    type: 'deposit',
    body: `deposit ${i} `.padEnd(bodyChars, 'x'),
    embedding: [1, i / 10],
    sourceBoard: null,
  }
}

function nodeRow(id: string, contentChars: number): RetrievalRow {
  return {
    source: 'node',
    ref_id: id,
    content: `node ${id} `.padEnd(contentChars, 'y'),
    speaker: null,
    node_type: 'text',
    similarity: 0.8,
    score: 0.8,
  }
}

function deferred<T>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

const snapshot = (wm: Map<string, WorkingMemoryEntry>) =>
  [...wm.entries()].map(([k, e]) => [k, e.surfacedAtTurn, e.content.length])

beforeEach(() => {
  vi.spyOn(console, 'info').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  vi.restoreAllMocks()
  loadDepositCorpus.mockReset()
  fetchRetrievalContext.mockReset()
})

describe('opener retrieval with the deposit band in the background', () => {
  it('returns the node block without waiting for the deposit corpus', async () => {
    const corpus = deferred<DepositCorpusLoad>()
    loadDepositCorpus.mockReturnValue(corpus.promise)
    fetchRetrievalContext.mockResolvedValue([nodeRow('3', 100)])

    const c = makeController()
    const block = await c.runRetrieval({}, [1, 0], { depositsInBackground: true })

    expect(block).toContain('node 3')
    // Nothing admitted yet: admissions wait for the deposit band, in order.
    expect(c.workingMemory.size).toBe(0)

    corpus.resolve({ corpus: [deposit(1, 200)], scanned: 1, dropped: 0 })
    await c.awaitPendingRetrievalAdmissions()
    expect([...c.workingMemory.values()].map((e) => [e.refType, e.surfacedAtTurn])).toEqual([
      ['deposit', 1],
      ['node', 2],
    ])
  })

  it.each([
    ['without overflow', 200, 100],
    ['with overflow eviction', 1500, 1200],
  ])('leaves working memory identical to the serial path (%s)', async (_, depChars, nodeChars) => {
    const deposits = Array.from({ length: 8 }, (_, i) => deposit(i, depChars))
    const nodes = [nodeRow('3', nodeChars), nodeRow('4', nodeChars)]

    loadDepositCorpus.mockResolvedValue({ corpus: deposits, scanned: 8, dropped: 0 })
    fetchRetrievalContext.mockResolvedValue(nodes)
    const serial = makeController()
    const serialBlock = await serial.runRetrieval({}, [1, 0])

    // Background: the corpus lands AFTER the node band, as it does in prod.
    const corpus = deferred<DepositCorpusLoad>()
    loadDepositCorpus.mockReturnValue(corpus.promise)
    fetchRetrievalContext.mockResolvedValue(nodes)
    const background = makeController()
    const backgroundBlock = await background.runRetrieval({}, [1, 0], {
      depositsInBackground: true,
    })
    corpus.resolve({ corpus: deposits, scanned: 8, dropped: 0 })
    await background.awaitPendingRetrievalAdmissions()

    expect(backgroundBlock).toBe(serialBlock)
    expect(snapshot(background.workingMemory)).toEqual(snapshot(serial.workingMemory))
  })

  it('starts the corpus download only after the node band answers', async () => {
    const rpc = deferred<RetrievalRow[]>()
    fetchRetrievalContext.mockReturnValue(rpc.promise)
    loadDepositCorpus.mockResolvedValue({ corpus: [deposit(1, 200)], scanned: 1, dropped: 0 })

    const c = makeController()
    const block = c.runRetrieval({}, [1, 0], { depositsInBackground: true })
    await new Promise((r) => setTimeout(r, 0))
    // Node band still in flight → the 2.8 MB download must not compete with it.
    expect(loadDepositCorpus).not.toHaveBeenCalled()

    rpc.resolve([nodeRow('3', 100)])
    expect(await block).toContain('node 3')
    expect(loadDepositCorpus).toHaveBeenCalledTimes(1)
    await c.awaitPendingRetrievalAdmissions()
    expect([...c.workingMemory.values()].map((e) => e.refType)).toEqual(['deposit', 'node'])
  })

  it('still admits the deposits when the node band fails', async () => {
    loadDepositCorpus.mockResolvedValue({ corpus: [deposit(1, 200)], scanned: 1, dropped: 0 })
    fetchRetrievalContext.mockRejectedValue(new Error('rpc down'))

    const c = makeController()
    await expect(c.runRetrieval({}, [1, 0], { depositsInBackground: true })).rejects.toThrow(
      'rpc down',
    )
    await c.awaitPendingRetrievalAdmissions()
    expect([...c.workingMemory.values()].map((e) => e.refType)).toEqual(['deposit'])
  })

  it('never blocks the next turn when the corpus load fails', async () => {
    loadDepositCorpus.mockRejectedValue(new Error('network'))
    fetchRetrievalContext.mockResolvedValue([nodeRow('3', 100)])

    const c = makeController()
    await c.runRetrieval({}, [1, 0], { depositsInBackground: true })
    await expect(c.awaitPendingRetrievalAdmissions()).resolves.toBeUndefined()
    expect([...c.workingMemory.values()].map((e) => e.refType)).toEqual(['node'])
  })
})
