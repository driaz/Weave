import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NodeLogger } from '../../utils/logger'

vi.mock('../supabaseClient', () => ({
  supabase: {
    auth: {
      getSession: vi.fn(async () => ({ data: { session: { access_token: 'jwt' } } })),
    },
  },
}))

// linkEnrichment pulls these in at import; the trigger doesn't use them.
vi.mock('../embeddingService', () => ({ embedNodeAsync: vi.fn() }))
vi.mock('../../utils/transcriptUtils', () => ({ fetchTranscript: vi.fn() }))

const BOARD = 'board-1'
const NODE = '7'

function makeLogger(): NodeLogger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), persist: vi.fn() }
}

async function load() {
  vi.resetModules()
  vi.stubEnv('VITE_WEAVE_MEDIA_URL', 'https://media.example/')
  const enrichment = await import('../linkEnrichment')
  const signal = await import('../firstSave')
  return { ...enrichment, ...signal }
}

describe('triggerMediaPipeline waits for the first confirmed save', () => {
  const fetchMock = vi.fn(async () => new Response(null, { status: 202 }))

  beforeEach(() => {
    vi.useFakeTimers()
    fetchMock.mockClear()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  })

  it('fires /process after a save that includes the card is confirmed', async () => {
    const { triggerMediaPipeline, notifyBoardSaved, resetFirstSaveSignal } = await load()
    const logger = makeLogger()

    expect(
      triggerMediaPipeline({ boardId: BOARD, nodeId: NODE, url: 'https://youtu.be/x', nodeType: 'youtube', logger }),
    ).toBe(true)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(fetchMock).not.toHaveBeenCalled()

    notifyBoardSaved(BOARD, ['3', NODE])
    await vi.advanceTimersByTimeAsync(0)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://media.example/process')
    expect(JSON.parse(init.body as string)).toMatchObject({ node_id: NODE, board_id: BOARD })
    expect(logger.persist).not.toHaveBeenCalled()
    resetFirstSaveSignal()
  })

  it('fires at once when the latest confirmed save already included the card', async () => {
    const { triggerMediaPipeline, notifyBoardSaved, resetFirstSaveSignal } = await load()
    notifyBoardSaved(BOARD, [NODE])

    triggerMediaPipeline({ boardId: BOARD, nodeId: NODE, url: 'https://x.com/a/status/1', nodeType: 'twitter' })
    await vi.advanceTimersByTimeAsync(0)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    resetFirstSaveSignal()
  })

  it('never fires before the card is saved', async () => {
    const { triggerMediaPipeline, notifyBoardSaved, FIRST_SAVE_TIMEOUT_MS, resetFirstSaveSignal } = await load()

    triggerMediaPipeline({ boardId: BOARD, nodeId: NODE, url: 'https://youtu.be/x', nodeType: 'youtube' })
    // Saves that don't carry this card, or belong to another board, don't release it.
    notifyBoardSaved(BOARD, ['1', '2'])
    notifyBoardSaved('board-2', [NODE])
    await vi.advanceTimersByTimeAsync(FIRST_SAVE_TIMEOUT_MS - 1)

    expect(fetchMock).not.toHaveBeenCalled()
    resetFirstSaveSignal()
  })

  it('on timeout, logs one skipped event and never fires, even if a save lands later', async () => {
    const { triggerMediaPipeline, notifyBoardSaved, FIRST_SAVE_TIMEOUT_MS, resetFirstSaveSignal } = await load()
    const logger = makeLogger()

    triggerMediaPipeline({ boardId: BOARD, nodeId: NODE, url: 'https://youtu.be/x', nodeType: 'youtube', logger })
    await vi.advanceTimersByTimeAsync(FIRST_SAVE_TIMEOUT_MS)
    notifyBoardSaved(BOARD, [NODE])
    await vi.advanceTimersByTimeAsync(FIRST_SAVE_TIMEOUT_MS)

    expect(fetchMock).not.toHaveBeenCalled()
    expect(logger.persist).toHaveBeenCalledTimes(1)
    expect(logger.persist).toHaveBeenCalledWith('media.trigger', 'skipped', {
      reason: 'first-save-timeout',
      timeoutMs: FIRST_SAVE_TIMEOUT_MS,
      nodeType: 'youtube',
    })
    resetFirstSaveSignal()
  })
})
