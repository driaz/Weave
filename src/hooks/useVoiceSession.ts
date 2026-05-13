import { useSyncExternalStore } from 'react'
import {
  voiceSessionStore,
  type VoiceSessionState,
} from '../services/voice/voiceSessionStore'

/**
 * React adapter for the vanilla voice session store. Re-renders when
 * status, error, substep, sessionId, or turnId changes. The store
 * emits a new state object on every setState so React's
 * reference-equality check is sufficient — no selectors needed.
 */
export function useVoiceSession(): VoiceSessionState {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

function subscribe(onChange: () => void): () => void {
  return voiceSessionStore.subscribe(() => onChange())
}

function getSnapshot(): VoiceSessionState {
  return voiceSessionStore.getState()
}
