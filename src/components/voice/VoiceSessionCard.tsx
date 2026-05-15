import { useVoiceSession } from '../../hooks/useVoiceSession'
import {
  voiceUserClickedClose,
  voiceUserClickedRetry,
  voiceUserClickedStop,
} from '../../services/voice/voiceSessionManager'
import type { VoiceSessionStatus } from '../../services/voice/voiceSessionStore'

const STATE_LABEL: Record<VoiceSessionStatus, string> = {
  idle: '',
  initializing: 'Setting up…',
  listening: 'Your turn',
  user_speaking: 'Listening…',
  processing_user_turn: 'Thinking…',
  assistant_speaking: 'Claude is speaking…',
  error: '',
}

const ACCENT = 'var(--w-standard-accent)'
const ACCENT_HEX = '#c9942f'
const ERROR_INK = 'var(--w-tensions-ink)'
const ERROR_HEX = '#b84c3a'

function MicIcon({ size = 22, color }: { size?: number; color: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <rect x="9" y="3" width="6" height="11" rx="3" fill={color} />
      <path
        d="M5 11a7 7 0 0 0 14 0"
        stroke={color}
        strokeWidth="1.8"
        strokeLinecap="round"
      />
      <path d="M12 18v3" stroke={color} strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  )
}

function StopIcon({ size = 12, color }: { size?: number; color: string }) {
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

function CloseIcon({ size = 14, color }: { size?: number; color: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 20 20"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M 5 5 L 15 15 M 15 5 L 5 15"
        stroke={color}
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  )
}

function RetryIcon({ size = 14, color }: { size?: number; color: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 20 20"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M 4 10 A 6 6 0 1 1 6 14.5"
        stroke={color}
        strokeWidth="1.6"
        strokeLinecap="round"
        fill="none"
      />
      <path
        d="M 3 11 L 6 14.5 L 9 11"
        stroke={color}
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </svg>
  )
}

function MicCenterpiece({
  status,
  isErrorRecoverable,
}: {
  status: VoiceSessionStatus
  isErrorRecoverable: boolean
}) {
  const isError = status === 'error'
  const color = isError ? ERROR_HEX : ACCENT_HEX
  const animation =
    status === 'listening'
      ? 'voiceMicListening 2.4s ease-in-out infinite'
      : status === 'user_speaking'
        ? 'voiceMicSpeaking 0.9s ease-in-out infinite'
        : status === 'processing_user_turn'
          ? 'voiceMicProcessing 1.2s linear infinite'
          : 'none'

  const opacity =
    status === 'processing_user_turn' || status === 'assistant_speaking'
      ? 0.4
      : 1

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        marginTop: 6,
        marginBottom: 6,
      }}
    >
      <div
        style={{
          width: 64,
          height: 64,
          borderRadius: '50%',
          background: `radial-gradient(circle at 50% 50%, ${color}33, ${color}10)`,
          border: `1.5px solid ${color}55`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          opacity,
          animation,
        }}
        aria-hidden="true"
      >
        {isError ? (
          <CloseIcon size={22} color={color} />
        ) : (
          <MicIcon size={22} color={color} />
        )}
      </div>
      {/* Screen reader gets the state from the status text below. */}
      {!isError && isErrorRecoverable === false ? null : null}
    </div>
  )
}

type HybridAction =
  | { kind: 'none' }
  | { kind: 'stop' }
  | { kind: 'retry' }

function resolveHybridAction(
  status: VoiceSessionStatus,
  recoverable: boolean,
): HybridAction {
  if (status === 'user_speaking' || status === 'assistant_speaking') {
    return { kind: 'stop' }
  }
  if (status === 'error' && recoverable) return { kind: 'retry' }
  return { kind: 'none' }
}

export function VoiceSessionCard() {
  const state = useVoiceSession()
  if (state.status === 'idle') return null

  const isError = state.status === 'error'
  const recoverable = state.error?.recoverable ?? false
  const hybrid = resolveHybridAction(state.status, recoverable)
  const stateLabel = isError
    ? state.error?.message ?? 'Voice session error'
    : STATE_LABEL[state.status]

  const onHybridClick = () => {
    if (hybrid.kind === 'stop') voiceUserClickedStop()
    else if (hybrid.kind === 'retry') void voiceUserClickedRetry()
  }

  const hybridLabel = hybrid.kind === 'stop' ? 'Stop' : 'Retry'
  const hybridIcon =
    hybrid.kind === 'stop' ? (
      <StopIcon size={12} color={ACCENT} />
    ) : (
      <RetryIcon size={14} color={ACCENT} />
    )

  return (
    <>
      <style>{`
        @keyframes voiceMicListening {
          0%, 100% { transform: scale(1); }
          50% { transform: scale(1.06); }
        }
        @keyframes voiceMicSpeaking {
          0%, 100% { transform: scale(1); }
          50% { transform: scale(1.14); }
        }
        @keyframes voiceMicProcessing {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
      `}</style>
      <div
        role="dialog"
        aria-label="Voice session"
        style={{
          position: 'fixed',
          right: 20,
          bottom: 80,
          width: 320,
          minHeight: 200,
          background: '#fffdf6',
          border: '1px solid var(--w-line)',
          borderRadius: 'var(--w-radius-lg)',
          boxShadow: 'var(--w-shadow-float)',
          padding: 16,
          display: 'flex',
          flexDirection: 'column',
          zIndex: 60,
          fontFamily: 'var(--w-font-sans)',
        }}
      >
        {/* Header */}
        <div className="flex items-center" style={{ marginBottom: 8 }}>
          <span
            style={{
              fontFamily: 'var(--w-font-mono)',
              fontSize: 10,
              letterSpacing: 1,
              textTransform: 'uppercase',
              color: 'var(--w-ink-faint)',
            }}
          >
            Voice
          </span>
          <div style={{ flex: 1 }} />
          <button
            type="button"
            onClick={voiceUserClickedClose}
            aria-label="End voice session"
            className="cursor-pointer transition-colors duration-150"
            style={{
              width: 24,
              height: 24,
              borderRadius: 6,
              border: 'none',
              background: 'transparent',
              color: 'var(--w-ink-faint)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
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
            <CloseIcon size={12} color="currentColor" />
          </button>
        </div>

        {/* Mic centerpiece */}
        <MicCenterpiece status={state.status} isErrorRecoverable={recoverable} />

        {/* State / error text */}
        <div
          style={{
            textAlign: 'center',
            fontFamily: isError ? 'var(--w-font-sans)' : 'var(--w-font-display)',
            fontSize: isError ? 12 : 14,
            lineHeight: 1.4,
            color: isError ? ERROR_INK : 'var(--w-ink-soft)',
            marginTop: 6,
            marginBottom: 12,
            minHeight: 32,
            textWrap: 'pretty',
            padding: isError ? '0 4px' : 0,
          }}
        >
          {stateLabel}
        </div>

        {/* Hybrid button */}
        {hybrid.kind !== 'none' && (
          <button
            type="button"
            onClick={onHybridClick}
            className="cursor-pointer transition-colors duration-150"
            style={{
              width: '100%',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 8,
              padding: '8px 12px',
              borderRadius: 'var(--w-radius-pill)',
              border: `1px solid ${ACCENT_HEX}55`,
              background: `${ACCENT_HEX}14`,
              color: ACCENT,
              fontFamily: 'var(--w-font-sans)',
              fontSize: 12,
              fontWeight: 600,
              letterSpacing: 0.2,
            }}
          >
            {hybridIcon}
            <span>{hybridLabel}</span>
          </button>
        )}
      </div>
    </>
  )
}
