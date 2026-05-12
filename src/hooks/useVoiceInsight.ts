import { useCallback, useEffect, useRef, useState } from 'react'
import type { VoiceNodePayload } from '../utils/voicePayload'
import { PcmStreamPlayer, type PlaybackEvent } from '../services/pcmStreamPlayer'
import { logVoicePlaybackEvent } from '../services/voiceLogger'
import { supabase } from '../services/supabaseClient'

export type VoiceState = 'idle' | 'loading' | 'playing' | 'error'

export type VoiceInsightRequest = {
  connectionLabel: string
  connectionExplanation: string
  node1: VoiceNodePayload
  node2: VoiceNodePayload
}

export type VoicePlayedMetrics = {
  durationListened: number
  completed: boolean
  insightLength: number
  totalLatency: number
}

type Options = {
  buildRequest: () => VoiceInsightRequest | null
  onPlayed?: (metrics: VoicePlayedMetrics) => void
}

const ERROR_RESET_MS = 2000
const PCM_FLAG_KEY = 'weave.voice.pcm'

type FlagSource = 'localStorage' | 'default'

function resolvePcmFlag(): { enabled: boolean; source: FlagSource } {
  const raw = localStorage.getItem(PCM_FLAG_KEY)
  return {
    enabled: raw === 'true',
    source: raw === null ? 'default' : 'localStorage',
  }
}

export function useVoiceInsight({ buildRequest, onPlayed }: Options) {
  const [state, setState] = useState<VoiceState>('idle')

  const audioRef = useRef<HTMLAudioElement | null>(null)
  const audioUrlRef = useRef<string | null>(null)
  const playerRef = useRef<PcmStreamPlayer | null>(null)
  const insightLengthRef = useRef<number>(0)
  const totalLatencyRef = useRef<number>(0)
  const tapStartRef = useRef<number>(0)
  const playStartRef = useRef<number>(0)
  const onPlayedRef = useRef(onPlayed)
  const buildRequestRef = useRef(buildRequest)
  const errorTimerRef = useRef<number | null>(null)

  useEffect(() => {
    onPlayedRef.current = onPlayed
    buildRequestRef.current = buildRequest
  }, [onPlayed, buildRequest])

  const emitPlayed = useCallback((completed: boolean) => {
    if (!playStartRef.current) return
    const durationListened = (Date.now() - playStartRef.current) / 1000
    onPlayedRef.current?.({
      durationListened,
      completed,
      insightLength: insightLengthRef.current,
      totalLatency: totalLatencyRef.current,
    })
    playStartRef.current = 0
  }, [])

  const stopAudio = useCallback(() => {
    const audio = audioRef.current
    if (!audio) return
    audio.pause()
    audio.currentTime = 0
  }, [])

  const cleanupAudio = useCallback(() => {
    const audio = audioRef.current
    if (audio) {
      audio.pause()
      audio.onended = null
      audio.onerror = null
    }
    audioRef.current = null
    if (audioUrlRef.current) {
      URL.revokeObjectURL(audioUrlRef.current)
      audioUrlRef.current = null
    }
  }, [])

  const stopPlayer = useCallback(() => {
    const player = playerRef.current
    if (!player) return
    playerRef.current = null
    player.stop()
  }, [])

  const stop = useCallback(() => {
    if ((audioRef.current || playerRef.current) && playStartRef.current) {
      emitPlayed(false)
    }
    stopAudio()
    stopPlayer()
    setState('idle')
  }, [emitPlayed, stopAudio, stopPlayer])

  const flashError = useCallback(() => {
    setState('error')
    if (errorTimerRef.current) window.clearTimeout(errorTimerRef.current)
    errorTimerRef.current = window.setTimeout(() => {
      setState('idle')
      errorTimerRef.current = null
    }, ERROR_RESET_MS)
  }, [])

  const trigger = useCallback(async () => {
    if (state === 'loading') return

    if (state === 'playing') {
      stop()
      return
    }

    const { enabled: pcmEnabled, source: flagSource } = resolvePcmFlag()

    if (pcmEnabled) {
      const req = buildRequestRef.current()
      if (!req) {
        flashError()
        return
      }

      setState('loading')
      tapStartRef.current = Date.now()

      let player: PcmStreamPlayer | null = null

      try {
        const insightRes = await fetch('/.netlify/functions/voice-insight', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(req),
        })
        if (!insightRes.ok) {
          throw new Error(`voice-insight HTTP ${insightRes.status}`)
        }
        const insightJson = (await insightRes.json()) as {
          insight?: string
          error?: string
        }
        const insight = insightJson.insight?.trim() ?? ''
        if (!insight) {
          throw new Error(insightJson.error || 'no insight returned')
        }

        const mediaUrl = import.meta.env.VITE_WEAVE_MEDIA_URL as
          | string
          | undefined
        if (!mediaUrl) {
          throw new Error('VITE_WEAVE_MEDIA_URL is not set')
        }
        if (!supabase) {
          throw new Error('Supabase client not configured — cannot authenticate tts-stream request')
        }
        const { data } = await supabase.auth.getSession()
        const token = data.session?.access_token
        if (!token) throw new Error('No Supabase session — please sign in')

        const playbackId = crypto.randomUUID()

        const ttsRes = await fetch(`${mediaUrl}/api/tts-stream`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            'X-Playback-Id': playbackId,
          },
          body: JSON.stringify({ text: insight }),
        })
        if (!ttsRes.ok) {
          throw new Error(`tts-stream HTTP ${ttsRes.status}`)
        }
        if (!ttsRes.body) {
          throw new Error('tts-stream response has no body')
        }

        insightLengthRef.current = insight.length
        // Note: totalLatency here measures click→scheduling-complete, not click→audible.
        // For audible latency, see voice.playback.firstAudio.audibleLatencyMs in console logs.
        // Plumbing audibleLatencyMs through VoicePlayedMetrics deferred to Voice v2.
        totalLatencyRef.current = Date.now() - tapStartRef.current

        const onEvent = (event: PlaybackEvent) => {
          if (event.type === 'voice.playback.started') {
            logVoicePlaybackEvent({ ...event, flagSource })
          } else {
            logVoicePlaybackEvent(event)
          }
          if (event.type === 'voice.playback.ended') {
            if (playerRef.current === player) playerRef.current = null
            emitPlayed(true)
            setState('idle')
          }
        }

        player = new PcmStreamPlayer({ onEvent })
        playerRef.current = player

        await player.start(ttsRes.body, { playbackId })
        playStartRef.current = Date.now()
        setState('playing')
      } catch (err) {
        console.warn(
          '[voice-insight] pcm pipeline failed:',
          err instanceof Error ? err.message : err,
        )
        if (player) {
          if (playerRef.current === player) playerRef.current = null
          player.stop()
        }
        flashError()
      }
      return
    }

    if (audioRef.current) {
      try {
        audioRef.current.currentTime = 0
        await audioRef.current.play()
        playStartRef.current = Date.now()
        setState('playing')
      } catch (err) {
        console.warn('[voice-insight] replay failed', err)
        flashError()
      }
      return
    }

    const req = buildRequestRef.current()
    if (!req) {
      flashError()
      return
    }

    setState('loading')
    tapStartRef.current = Date.now()

    try {
      const insightRes = await fetch('/.netlify/functions/voice-insight', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(req),
      })
      if (!insightRes.ok) {
        throw new Error(`voice-insight HTTP ${insightRes.status}`)
      }
      const insightJson = (await insightRes.json()) as {
        insight?: string
        error?: string
      }
      const insight = insightJson.insight?.trim() ?? ''
      if (!insight) {
        throw new Error(insightJson.error || 'no insight returned')
      }

      const mediaUrl = import.meta.env.VITE_WEAVE_MEDIA_URL as
        | string
        | undefined
      if (!mediaUrl) {
        throw new Error('VITE_WEAVE_MEDIA_URL is not set')
      }
      const ttsRes = await fetch(`${mediaUrl}/api/tts`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: insight }),
      })
      if (!ttsRes.ok) {
        throw new Error(`tts HTTP ${ttsRes.status}`)
      }
      const blob = await ttsRes.blob()
      const audioUrl = URL.createObjectURL(blob)
      const audio = new Audio(audioUrl)

      audio.onended = () => {
        emitPlayed(true)
        setState('idle')
      }
      audio.onerror = () => {
        console.warn('[voice-insight] audio element error')
        flashError()
      }

      audioRef.current = audio
      audioUrlRef.current = audioUrl
      insightLengthRef.current = insight.length
      totalLatencyRef.current = Date.now() - tapStartRef.current

      await audio.play()
      playStartRef.current = Date.now()
      setState('playing')
    } catch (err) {
      console.warn(
        '[voice-insight] pipeline failed:',
        err instanceof Error ? err.message : err,
      )
      cleanupAudio()
      flashError()
    }
  }, [state, stop, flashError, emitPlayed, cleanupAudio])

  useEffect(() => {
    return () => {
      if (errorTimerRef.current) window.clearTimeout(errorTimerRef.current)
      if ((audioRef.current || playerRef.current) && playStartRef.current) {
        emitPlayed(false)
      }
      cleanupAudio()
      stopPlayer()
    }
  }, [emitPlayed, cleanupAudio, stopPlayer])

  return { state, trigger, stop }
}
