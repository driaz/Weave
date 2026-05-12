import type { PlaybackEvent } from './pcmStreamPlayer'

/**
 * Stub sink for `voice.playback.*` events. Console-only by design —
 * persistence (Supabase, processing_log, sessions) is deferred to the
 * Voice v2 design pass. When that work lands, swap this body and call
 * sites stay put.
 *
 * The `voice.playback.started` event additionally carries `flagSource`
 * so we can debug "why didn't PCM fire" after the fact.
 */
export function logVoicePlaybackEvent(
  event: PlaybackEvent & { flagSource?: 'localStorage' | 'default' },
): void {
  console.log('[voice.playback]', JSON.stringify(event))
}
