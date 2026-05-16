/**
 * Singleton wrapper around VadController so any caller (the
 * EdgeDetailPopup Speak button, the VoiceSessionCard's buttons, future
 * keyboard shortcuts) can drive the active session without holding a
 * reference. The controller is created on the first beginVoiceSession()
 * call and cleared when the store returns to idle.
 *
 * Only one session is alive at a time. Calling beginVoiceSession()
 * while another session is active is a no-op — callers are expected to
 * gate on the store status before invoking.
 *
 * Phase 8: beginVoiceSession awaits voiceSessionController.startSession
 * BEFORE constructing the VadController. This guarantees the session
 * row exists by the time the opening turn's "Begin." sentinel reaches
 * recordUtterance. Persistence failure is intentionally non-fatal —
 * the voice session opens regardless, and subsequent recordUtterance
 * calls log to processing_log if the controller never started.
 */

import {
  VadController,
  type TurnTimestamps,
  type VadControllerOptions,
} from './vadController'
import { voiceSessionStore } from './voiceSessionStore'
import { voiceSessionController } from './voiceSessionController'
import type { BoardSnapshot } from '../../persistence'

let activeController: VadController | null = null

voiceSessionStore.subscribe((state, prev) => {
  if (state.status === 'idle' && prev.status !== 'idle') {
    activeController = null
  }
})

export interface BeginVoiceSessionInput extends VadControllerOptions {
  /**
   * UUID of the edge that anchored this session (e.g. the connection
   * the user clicked Speak on). `null` when the modal was opened from
   * a non-edge entry point — the schema allows it.
   *
   * NOTE: today the EdgeDetailPopup's `Connection` object doesn't
   * carry a database uuid, so callers from that entry point pass
   * `null` until the client-side edge id is plumbed. The session's
   * board context is still recoverable via `boardSnapshot`.
   */
  anchorEdgeId: string | null
  /** Snapshot of the canvas at the moment the modal opened. */
  boardSnapshot: BoardSnapshot
}

export async function beginVoiceSession(
  opts: BeginVoiceSessionInput,
): Promise<void> {
  if (activeController) return
  if (voiceSessionStore.getState().status !== 'idle') return

  // Phase 8: persistence session FIRST. Awaited so the controller has
  // its session id and counters initialized by the time the opening
  // turn's "Begin." sentinel reaches recordUtterance. The opening
  // sentinel is stripped (controller's sentinel detection handles
  // it), but recordUtterance still requires an active session.
  //
  // A persistence failure here intentionally does NOT block the
  // voice session — voice is the load-bearing user value. The
  // failure is logged to console; subsequent recordUtterance calls
  // will throw "no active session" and the controller-side wiring
  // already swallows those (see VadController persistence hooks).
  const { anchorEdgeId, boardSnapshot, ...vadOpts } = opts
  try {
    await voiceSessionController.startSession({
      anchorEdgeId,
      boardSnapshot,
    })
  } catch (err) {
    console.error(
      '[voiceSessionManager] voiceSessionController.startSession failed; ' +
        'continuing without persistence:',
      err,
    )
  }

  const controller = new VadController(vadOpts)
  activeController = controller
  await controller.start()
}

export function voiceUserClickedStop(): void {
  activeController?.userClickedStop()
}

export function voiceUserClickedClose(): void {
  activeController?.userClickedClose()
}

export function voiceUserClickedRetry(): Promise<void> {
  return activeController?.userClickedRetry() ?? Promise.resolve()
}

/**
 * Phase 8: read the current turn-boundary timestamps from the active
 * VAD controller. Returns `null` when no session is active. Prompt
 * B2 calls this from the voiceSessionController integration to
 * stamp voice_utterances rows. See TurnTimestamps in vadController.ts
 * for the read contract.
 */
export function voiceGetTurnTimestamps(): TurnTimestamps | null {
  return activeController?.getTurnTimestamps() ?? null
}
