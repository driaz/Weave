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
 */

import {
  VadController,
  type TurnTimestamps,
  type VadControllerOptions,
} from './vadController'
import { voiceSessionStore } from './voiceSessionStore'

let activeController: VadController | null = null

voiceSessionStore.subscribe((state, prev) => {
  if (state.status === 'idle' && prev.status !== 'idle') {
    activeController = null
  }
})

export async function beginVoiceSession(
  opts: VadControllerOptions,
): Promise<void> {
  if (activeController) return
  if (voiceSessionStore.getState().status !== 'idle') return
  const controller = new VadController(opts)
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
