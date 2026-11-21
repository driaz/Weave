import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Connection } from '../../../api/claude'
import type { DepositCorpusLoad, DepositCorpusRow } from '../depositRetrieval'
import type { FetchRetrievalParams, RetrievalRow, WorkingMemoryEntry } from '../retrievalContext'
import { SPECULATION_DELAY_MS } from '../retrievalSpeculation'

// Speculative follow-up retrieval (docs/reads/speculative-retrieval.md). The
// speculation runs the read half of retrieval during the silence timer; these
// tests pin that it never marks or admits anything, that a hit leaves the turn
// exactly where the serial path would, and how the timer arms and aborts it.

const loadDepositCorpus = vi.fn<() => Promise<DepositCorpusLoad>>()
const fetchRetrievalContext = vi.fn<(client: unknown, p: FetchRetrievalParams) => Promise<RetrievalRow[]>>()
const embedText = vi.fn<(text: string, opts?: { signal?: AbortSignal }) => Promise<number[]>>()

vi.mock('../depositRetrieval', async (importActual) => ({
  ...(await importActual<typeof import('../depositRetrieval')>()),
  loadDepositCorpus: () => loadDepositCorpus(),
}))
vi.mock('../retrievalContext', async (importActual) => ({
  ...(await importActual<typeof import('../retrievalContext')>()),
  fetchRetrievalContext: (c: unknown, p: FetchRetrievalParams) => fetchRetrievalContext(c, p),
}))
vi.mock('../../embeddingService', () => ({
  embedText: (t: string, o?: { signal?: AbortSignal }) => embedText(t, o),
}))
vi.mock('../../../persistence/session', () => ({ requireClient: () => ({}) }))

const { VadController } = await import('../vadController')

interface SpeculativeRetrieval {
  embedding: number[]
  queryVector: number[]
  nodeBand: { rows: RetrievalRow[] } | null
}
interface Internals {
  runRetrieval(
    client: object,
    queryVector: number[],
    opts?: { prefetchedNodeBand?: unknown },
  ): Promise<string | null>
  runSpeculativeRetrieval(text: string, signal: AbortSignal): Promise<SpeculativeRetrieval>
  handleSilenceStarted(rms: number, debouncedForMs: number): void
  handleSpeechStarted(rms: number): void
  handleTranscriptUpdate(text: string): void
  cancelSilenceTimer(): void
  speculator: {
    take(key: string, text: string): { outcome: string; result?: Promise<SpeculativeRetrieval> }
  }
  sttScribe: { currentText(): string; cancel(): void } | null
  surfacedRefIds: Set<string>
  surfacedDepositIds: Set<string>
  workingMemory: Map<string, WorkingMemoryEntry>
  lastUserQueryEmbedding: number[] | null
}

const anchor = { from: 'node-1', to: 'node-2', mode: 'weave' } as unknown as Connection

function makeController(): Internals {
  const state = { status: 'user_speaking', turnId: 'turn-1', sessionId: 'session-1' }
  const store = { getState: () => state }
  const controller = new VadController({
    boardId: 'board-1',
    connectionContext: 'ctx',
    nodeContent: 'nodes',
    anchorConnection: anchor,
    connections: [anchor],
    liveNodeIds: ['1', '2', '3', '4'],
    store: store as never,
  })
  return controller as unknown as Internals
}

function nodeRow(id: string): RetrievalRow {
  return {
    source: 'node',
    ref_id: id,
    content: `node ${id} `.padEnd(80, 'y'),
    speaker: null,
    node_type: 'text',
    similarity: 0.8,
    score: 0.8,
  }
}

const deposit: DepositCorpusRow = {
  id: 'dep-1',
  sessionId: 's-1',
  type: 'deposit',
  body: 'deposit body'.padEnd(120, 'x'),
  embedding: [1, 0],
  sourceBoard: null,
}

const snapshot = (wm: Map<string, WorkingMemoryEntry>) =>
  [...wm.entries()].map(([k, e]) => [k, e.surfacedAtTurn, e.content])

beforeEach(() => {
  vi.spyOn(console, 'info').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.stubGlobal('window', globalThis)
  loadDepositCorpus.mockResolvedValue({ corpus: [deposit], scanned: 1, dropped: 0 })
  fetchRetrievalContext.mockResolvedValue([nodeRow('3'), nodeRow('4')])
  embedText.mockResolvedValue([1, 0])
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  loadDepositCorpus.mockReset()
  fetchRetrievalContext.mockReset()
  embedText.mockReset()
})

describe('the speculative run', () => {
  it('only reads: nothing is marked surfaced or admitted', async () => {
    const c = makeController()
    c.lastUserQueryEmbedding = [0, 1]
    const result = await c.runSpeculativeRetrieval('what is the warning', new AbortController().signal)

    expect(embedText).toHaveBeenCalledWith('what is the warning', expect.anything())
    expect(fetchRetrievalContext).toHaveBeenCalledTimes(1)
    expect(result.embedding).toEqual([1, 0])
    // Blended with the prior user turn exactly as the commit would.
    expect(result.queryVector).toEqual([0.65, 0.35])
    expect(result.nodeBand?.rows.map((r) => r.ref_id)).toEqual(['3', '4'])
    expect(c.surfacedRefIds.size).toBe(0)
    expect(c.surfacedDepositIds.size).toBe(0)
    expect(c.workingMemory.size).toBe(0)
    expect(loadDepositCorpus).not.toHaveBeenCalled()
  })

  it('passes its abort signal to the embed and the RPC', async () => {
    const c = makeController()
    const controller = new AbortController()
    await c.runSpeculativeRetrieval('hello', controller.signal)
    expect(embedText.mock.calls[0][1]?.signal).toBe(controller.signal)
    expect(fetchRetrievalContext.mock.calls[0][1].signal).toBe(controller.signal)
  })
})

describe('reusing a speculation at the commit', () => {
  it('skips the RPC and leaves the turn exactly as the serial path would', async () => {
    const serial = makeController()
    const serialBlock = await serial.runRetrieval({}, [1, 0])

    const speculative = makeController()
    const spec = await speculative.runSpeculativeRetrieval('hello', new AbortController().signal)
    fetchRetrievalContext.mockClear()
    const block = await speculative.runRetrieval({}, spec.queryVector, {
      prefetchedNodeBand: spec.nodeBand,
    })

    expect(fetchRetrievalContext).not.toHaveBeenCalled()
    expect(block).toBe(serialBlock)
    expect(snapshot(speculative.workingMemory)).toEqual(snapshot(serial.workingMemory))
    expect([...speculative.surfacedRefIds]).toEqual([...serial.surfacedRefIds])
    expect([...speculative.surfacedDepositIds]).toEqual([...serial.surfacedDepositIds])
  })

  it('applies the novelty filter at the commit, not when the rows were fetched', async () => {
    const c = makeController()
    const spec = await c.runSpeculativeRetrieval('hello', new AbortController().signal)
    // Row 3 surfaces between the fetch and the commit (not reachable in prod,
    // where one turn is in flight at a time, but it pins where the filter runs).
    c.surfacedRefIds.add('3')
    const block = await c.runRetrieval({}, spec.queryVector, { prefetchedNodeBand: spec.nodeBand })
    expect(block).toContain('node 4')
    expect(block).not.toContain('node 3')
  })
})

describe('arming during the silence timer', () => {
  it('speculates on the running transcript once the delay has passed', async () => {
    vi.useFakeTimers()
    const c = makeController()
    c.sttScribe = { currentText: () => 'what is the warning', cancel: () => {} }

    c.handleSilenceStarted(0, 200)
    vi.advanceTimersByTime(SPECULATION_DELAY_MS - 1)
    expect(embedText).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(embedText).toHaveBeenCalledTimes(1)

    // A later partial with new words restarts it; a repeat does not.
    c.handleTranscriptUpdate('what is the warning here')
    c.handleTranscriptUpdate('What is the warning here?')
    expect(embedText).toHaveBeenCalledTimes(2)
    const take = c.speculator.take('turn-1', 'What is the warning here?')
    expect(take.outcome).toBe('hit')
    c.cancelSilenceTimer()
  })

  it('does not speculate on partials before the delay', () => {
    vi.useFakeTimers()
    const c = makeController()
    c.sttScribe = { currentText: () => '', cancel: () => {} }
    c.handleSilenceStarted(0, 200)
    c.handleTranscriptUpdate('hello')
    expect(embedText).not.toHaveBeenCalled()
    c.cancelSilenceTimer()
  })

  it('aborts the speculation when speech resumes, leaving nothing behind', async () => {
    vi.useFakeTimers()
    let signal: AbortSignal | undefined
    embedText.mockImplementation((_t, o) => {
      signal = o?.signal
      return new Promise(() => {})
    })
    const c = makeController()
    c.sttScribe = { currentText: () => 'hello', cancel: () => {} }
    c.handleSilenceStarted(0, 200)
    vi.advanceTimersByTime(SPECULATION_DELAY_MS)
    expect(signal?.aborted).toBe(false)

    c.handleSpeechStarted(0.1)
    expect(signal?.aborted).toBe(true)
    // Disarmed: further partials don't restart it until the next silence.
    c.handleTranscriptUpdate('hello there')
    expect(embedText).toHaveBeenCalledTimes(1)
    expect(c.speculator.take('turn-1', 'hello').outcome).toBe('none')
    expect(c.surfacedRefIds.size).toBe(0)
    expect(c.workingMemory.size).toBe(0)
  })

  it('respects the kill switch', () => {
    vi.useFakeTimers()
    vi.stubGlobal('localStorage', { getItem: () => '0' })
    const c = makeController()
    c.sttScribe = { currentText: () => 'hello', cancel: () => {} }
    c.handleSilenceStarted(0, 200)
    vi.advanceTimersByTime(SPECULATION_DELAY_MS * 2)
    expect(embedText).not.toHaveBeenCalled()
    c.cancelSilenceTimer()
  })
})
