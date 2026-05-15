import { useCallback, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import type { Node } from '@xyflow/react'
import type { Connection } from '../api/claude'
import type { WeaveMode } from '../types/board'
import { useVoiceInsight } from '../hooks/useVoiceInsight'
import { useVoiceSession } from '../hooks/useVoiceSession'
import { nodeToVoicePayload } from '../utils/voicePayload'
import { trackEvent } from '../services/eventTracker'
import { useBoardId } from '../hooks/useBoardId'
import { beginVoiceSession } from '../services/voice/voiceSessionManager'
import {
  buildConnectionContext,
  buildNodeContent,
} from '../services/voice/voiceContext'

type ModeMeta = {
  label: string
  ink: string
  bg: string
  bgSoft: string
  accent: string
}

const MODE_META: Record<WeaveMode, ModeMeta> = {
  weave: {
    label: 'Standard',
    ink: 'var(--w-standard-ink)',
    bg: 'var(--w-standard-bg)',
    bgSoft: 'var(--w-standard-bg-soft)',
    accent: 'var(--w-standard-accent)',
  },
  deeper: {
    label: 'Go Deeper',
    ink: 'var(--w-deeper-ink)',
    bg: 'var(--w-deeper-bg)',
    bgSoft: 'var(--w-deeper-bg-soft)',
    accent: 'var(--w-deeper-accent)',
  },
  tensions: {
    label: 'Find Tensions',
    ink: 'var(--w-tensions-ink)',
    bg: 'var(--w-tensions-bg)',
    bgSoft: 'var(--w-tensions-bg-soft)',
    accent: 'var(--w-tensions-accent)',
  },
}

// Hex literals are required for the soft glow under the bar fill — `var(...)`
// can't be alpha-mixed in a box-shadow. Keep these in sync with the tokens
// in src/index.css.
const MODE_ACCENT_HEX: Record<WeaveMode, string> = {
  weave: '#c9942f',
  deeper: '#3a7359',
  tensions: '#b84c3a',
}

function ModeGlyph({
  mode,
  size = 12,
  color,
}: {
  mode: WeaveMode
  size?: number
  color: string
}) {
  if (mode === 'weave') {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 20 20"
        fill="none"
        aria-hidden="true"
      >
        <path
          d="M 3 6 Q 10 14, 17 6"
          stroke={color}
          strokeWidth="1.8"
          strokeLinecap="round"
        />
        <path
          d="M 3 14 Q 10 6, 17 14"
          stroke={color}
          strokeWidth="1.8"
          strokeLinecap="round"
        />
      </svg>
    )
  }
  if (mode === 'deeper') {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 20 20"
        fill="none"
        aria-hidden="true"
      >
        <path
          d="M 10 3 L 10 11"
          stroke={color}
          strokeWidth="1.8"
          strokeLinecap="round"
        />
        <path
          d="M 10 11 Q 6 13, 4 17"
          stroke={color}
          strokeWidth="1.6"
          strokeLinecap="round"
        />
        <path
          d="M 10 11 Q 14 13, 16 17"
          stroke={color}
          strokeWidth="1.6"
          strokeLinecap="round"
        />
        <circle cx="10" cy="3" r="1.8" fill={color} />
      </svg>
    )
  }
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 20 20"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M 8 10 L 2 10"
        stroke={color}
        strokeWidth="1.8"
        strokeLinecap="round"
      />
      <path
        d="M 4 7 L 1 10 L 4 13"
        stroke={color}
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M 12 10 L 18 10"
        stroke={color}
        strokeWidth="1.8"
        strokeLinecap="round"
      />
      <path
        d="M 16 7 L 19 10 L 16 13"
        stroke={color}
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function StatBar({
  label,
  value,
  accent,
  accentHex,
  isLast = false,
}: {
  label: string
  value: number
  accent: string
  accentHex: string
  isLast?: boolean
}) {
  const pct = Math.round(value * 100)
  return (
    <div style={{ marginBottom: isLast ? 0 : 10 }}>
      <div
        className="flex items-center justify-between"
        style={{
          marginBottom: 4,
          fontFamily: 'var(--w-font-mono)',
          fontSize: 10,
          color: 'var(--w-ink-soft)',
          letterSpacing: 0.5,
          textTransform: 'uppercase',
        }}
      >
        <span>{label}</span>
        <span style={{ color: accent }}>{pct}%</span>
      </div>
      <div
        style={{
          height: 4,
          borderRadius: 2,
          background: 'rgba(42, 37, 33, 0.08)',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            width: `${pct}%`,
            height: '100%',
            background: accent,
            borderRadius: 2,
            boxShadow: `0 0 8px ${accentHex}44`,
            transition: 'width 300ms ease',
          }}
        />
      </div>
    </div>
  )
}

function SpeakerIcon({ size = 14, color }: { size?: number; color: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 20 20"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M3.5 7.5h3l4-3v11l-4-3h-3z"
        stroke={color}
        strokeWidth="1.5"
        strokeLinejoin="round"
        fill={color}
        fillOpacity="0.15"
      />
      <path
        d="M13.5 7.5c1 .8 1 4.2 0 5"
        stroke={color}
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      <path
        d="M15.5 5.5c2 1.5 2 7.5 0 9"
        stroke={color}
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  )
}

function StopIcon({ size = 14, color }: { size?: number; color: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 20 20"
      fill="none"
      aria-hidden="true"
    >
      <rect x="5" y="5" width="10" height="10" rx="1.5" fill={color} />
    </svg>
  )
}

function LoadingDots({ color }: { color: string }) {
  return (
    <span
      style={{ display: 'inline-flex', alignItems: 'center', gap: 3, height: 14 }}
      aria-hidden="true"
    >
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          style={{
            width: 4,
            height: 4,
            borderRadius: '50%',
            background: color,
            animation: 'voiceDot 1s ease-in-out infinite',
            animationDelay: `${i * 0.15}s`,
          }}
        />
      ))}
    </span>
  )
}

function MicIcon({ size = 14, color }: { size?: number; color: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <rect x="9" y="3" width="6" height="11" rx="3" fill={color} fillOpacity="0.18" stroke={color} strokeWidth="1.5" />
      <path
        d="M5 11a7 7 0 0 0 14 0"
        stroke={color}
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      <path d="M12 18v3" stroke={color} strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  )
}

function SpeakButton({
  available,
  voiceSessionActive,
  accent,
  accentHex,
  onClick,
}: {
  available: boolean
  voiceSessionActive: boolean
  accent: string
  accentHex: string
  onClick: () => void
}) {
  const disabled = !available || voiceSessionActive
  const label = !available
    ? 'Speak unavailable'
    : voiceSessionActive
      ? 'Voice session active'
      : 'Speak'
  const color = accent
  const borderColor = `${accentHex}55`
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      className="cursor-pointer transition-colors duration-150"
      style={{
        marginTop: 8,
        width: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
        padding: '8px 12px',
        borderRadius: 'var(--w-radius-pill)',
        border: `1px solid ${borderColor}`,
        background: 'transparent',
        color,
        fontFamily: 'var(--w-font-sans)',
        fontSize: 12,
        fontWeight: 600,
        letterSpacing: 0.2,
        opacity: disabled ? 0.55 : 1,
        cursor: disabled ? 'not-allowed' : 'pointer',
      }}
    >
      <MicIcon size={14} color={color} />
      <span>{label}</span>
    </button>
  )
}

type VoiceButtonState = 'idle' | 'loading' | 'playing' | 'error'

function VoiceInsightButton({
  state,
  available,
  accent,
  accentHex,
  onClick,
}: {
  state: VoiceButtonState
  available: boolean
  accent: string
  accentHex: string
  onClick: () => void
}) {
  const labelByState: Record<VoiceButtonState, string> = {
    idle: 'Listen to insight',
    loading: 'Generating…',
    playing: 'Stop',
    error: 'Couldn’t play',
  }
  const disabled = !available || state === 'loading'
  const label = available ? labelByState[state] : 'Listen unavailable'

  const isError = state === 'error'
  const color = isError ? 'var(--w-tensions-ink)' : accent
  const bg =
    state === 'playing'
      ? `${accentHex}1f`
      : state === 'loading'
        ? `${accentHex}14`
        : isError
          ? 'rgba(184, 76, 58, 0.10)'
          : 'transparent'
  const borderColor = isError
    ? 'rgba(184, 76, 58, 0.35)'
    : `${accentHex}55`

  return (
    <>
      <style>{`
        @keyframes voiceDot {
          0%, 80%, 100% { opacity: 0.25; transform: scale(0.85); }
          40% { opacity: 1; transform: scale(1); }
        }
      `}</style>
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        aria-label={label}
        aria-pressed={state === 'playing'}
        className="cursor-pointer transition-colors duration-150"
        style={{
          marginTop: 12,
          width: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 8,
          padding: '8px 12px',
          borderRadius: 'var(--w-radius-pill)',
          border: `1px solid ${borderColor}`,
          background: bg,
          color,
          fontFamily: 'var(--w-font-sans)',
          fontSize: 12,
          fontWeight: 600,
          letterSpacing: 0.2,
          opacity: disabled ? 0.55 : 1,
          cursor: disabled ? 'not-allowed' : 'pointer',
        }}
      >
        {state === 'loading' ? (
          <LoadingDots color={color} />
        ) : state === 'playing' ? (
          <StopIcon size={12} color={color} />
        ) : (
          <SpeakerIcon size={14} color={color} />
        )}
        <span>{label}</span>
      </button>
    </>
  )
}

type EdgeDetailPopupProps = {
  connection: Connection
  position: { x: number; y: number }
  connectionNumber?: number
  node1?: Node
  node2?: Node
  onClose: () => void
}

export function EdgeDetailPopup({
  connection,
  position,
  connectionNumber,
  node1,
  node2,
  onClose,
}: EdgeDetailPopupProps) {
  const popupRef = useRef<HTMLDivElement>(null)
  const mode: WeaveMode = connection.mode ?? 'weave'
  const meta = MODE_META[mode]
  const accentHex = MODE_ACCENT_HEX[mode]
  const boardId = useBoardId()

  const buildRequest = useCallback(() => {
    if (!node1 || !node2) return null
    const p1 = nodeToVoicePayload(node1)
    const p2 = nodeToVoicePayload(node2)
    if (!p1 || !p2) return null
    return {
      connectionLabel: connection.label,
      connectionExplanation: connection.explanation,
      node1: p1,
      node2: p2,
    }
  }, [connection.label, connection.explanation, node1, node2])

  const fromId = connection.from.replace(/^node-/, '')
  const toId = connection.to.replace(/^node-/, '')

  const handlePlayed = useCallback(
    (metrics: {
      durationListened: number
      completed: boolean
      insightLength: number
      totalLatency: number
    }) => {
      trackEvent('voice_insight_played', {
        boardId,
        targetId: `connection:${boardId}:${fromId}:${toId}`,
        durationMs: Math.round(metrics.durationListened * 1000),
        metadata: {
          connectionLabel: connection.label,
          nodeIds: [fromId, toId],
          durationListened: metrics.durationListened,
          completed: metrics.completed,
          insightLength: metrics.insightLength,
          totalLatency: metrics.totalLatency,
          mode,
        },
      })
    },
    [boardId, connection.label, fromId, toId, mode],
  )

  const { state: voiceState, trigger: triggerVoice } = useVoiceInsight({
    buildRequest,
    onPlayed: handlePlayed,
  })

  const voiceAvailable = Boolean(node1 && node2)

  const voiceSession = useVoiceSession()
  const voiceSessionActive = voiceSession.status !== 'idle'

  const handleSpeak = useCallback(() => {
    if (!node1 || !node2) return
    if (voiceSessionActive) return
    void beginVoiceSession({
      boardId,
      connectionContext: buildConnectionContext(connection),
      nodeContent: buildNodeContent(node1, node2),
    })
  }, [boardId, connection, node1, node2, voiceSessionActive])

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleKey)
    return () => document.removeEventListener('keydown', handleKey)
  }, [onClose])

  const popupWidth = 340
  const popupHeight = 240
  const x = Math.min(position.x, window.innerWidth - popupWidth - 16)
  const y = Math.min(position.y + 12, window.innerHeight - popupHeight - 16)

  return createPortal(
    <div className="fixed inset-0" style={{ zIndex: 50 }} onClick={onClose}>
      <div
        ref={popupRef}
        className="fixed"
        style={{
          left: x,
          top: y,
          width: popupWidth,
          background: '#fffdf6',
          border: '1px solid var(--w-line)',
          borderRadius: 'var(--w-radius-lg)',
          boxShadow: 'var(--w-shadow-float)',
          padding: 18,
          zIndex: 50,
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          className="flex items-center"
          style={{ marginBottom: 12, gap: 8 }}
        >
          <span
            className="inline-flex items-center"
            style={{
              gap: 6,
              padding: '4px 10px',
              borderRadius: 'var(--w-radius-pill)',
              background: meta.bg,
              color: meta.ink,
              fontFamily: 'var(--w-font-sans)',
              fontSize: 11,
              fontWeight: 600,
              letterSpacing: 0.2,
            }}
          >
            <ModeGlyph mode={mode} size={12} color={meta.ink} />
            <span>{connection.type}</span>
          </span>
          <div style={{ flex: 1 }} />
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="cursor-pointer transition-colors duration-150"
            style={{
              width: 24,
              height: 24,
              borderRadius: 6,
              border: 'none',
              background: 'transparent',
              color: 'var(--w-ink-faint)',
              fontSize: 14,
              lineHeight: 1,
              padding: 0,
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = 'var(--w-paper-dim)'
              e.currentTarget.style.color = 'var(--w-ink-soft)'
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'transparent'
              e.currentTarget.style.color = 'var(--w-ink-faint)'
            }}
          >
            ×
          </button>
        </div>

        <p
          style={{
            margin: 0,
            marginBottom: 14,
            fontFamily: 'var(--w-font-display)',
            fontSize: 14,
            lineHeight: 1.55,
            color: 'var(--w-ink)',
            textWrap: 'pretty',
          }}
        >
          {connection.explanation}
        </p>

        <div
          style={{
            padding: 12,
            borderRadius: 10,
            background: `linear-gradient(180deg, ${accentHex}1f, transparent)`,
            border: '1px solid var(--w-line-soft)',
          }}
        >
          <StatBar
            label="Strength"
            value={connection.strength}
            accent={meta.accent}
            accentHex={accentHex}
          />
          <StatBar
            label="Surprise"
            value={connection.surprise}
            accent={meta.accent}
            accentHex={accentHex}
            isLast
          />
        </div>

        <VoiceInsightButton
          state={voiceState}
          available={voiceAvailable}
          accent={meta.accent}
          accentHex={accentHex}
          onClick={triggerVoice}
        />

        <SpeakButton
          available={voiceAvailable}
          voiceSessionActive={voiceSessionActive}
          accent={meta.accent}
          accentHex={accentHex}
          onClick={handleSpeak}
        />

        <div
          className="flex items-center justify-between"
          style={{
            marginTop: 12,
            fontFamily: 'var(--w-font-mono)',
            fontSize: 10,
            color: 'var(--w-ink-faint)',
            letterSpacing: 0.5,
          }}
        >
          <span>
            {connectionNumber !== undefined ? `CONN #${connectionNumber} · ` : ''}
            {meta.label.toUpperCase()}
          </span>
          <span>esc</span>
        </div>
      </div>
    </div>,
    document.body,
  )
}
