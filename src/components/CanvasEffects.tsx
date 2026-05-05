import type { CSSProperties } from 'react'
import type { WeaveMode } from '../types/board'

// Hex literals are required for the ambient wash because we append an
// alpha suffix (e.g. "#f8ecc844") and CSS var() references can't be
// alpha-mixed inside a gradient stop. Keep these in sync with the bg-soft
// tokens declared in src/index.css.
const MODE_BG_SOFT_HEX: Record<WeaveMode, string> = {
  weave: '#f8ecc8',
  deeper: '#dfe9dd',
  tensions: '#f6d8cf',
}

const MODE_INK: Record<WeaveMode, string> = {
  weave: 'var(--w-standard-ink)',
  deeper: 'var(--w-deeper-ink)',
  tensions: 'var(--w-tensions-ink)',
}

const MODE_ACCENT: Record<WeaveMode, string> = {
  weave: 'var(--w-standard-accent)',
  deeper: 'var(--w-deeper-accent)',
  tensions: 'var(--w-tensions-accent)',
}

const MODE_GLOW: Record<WeaveMode, string> = {
  weave: 'var(--w-standard-glow)',
  deeper: 'var(--w-deeper-glow)',
  tensions: 'var(--w-tensions-glow)',
}

const THINKING_LINES: Record<WeaveMode, string[]> = {
  weave: [
    'reading reading reading reading',
    'clustering around attention',
    'finding: slow thinking…',
  ],
  deeper: [
    'peeling back surface themes',
    'underneath: ritual, reverence',
    'the body reads too…',
  ],
  tensions: [
    'cross-referencing claims',
    'pull: prescription vs self-help',
    'surfacing contradictions…',
  ],
}

function Spinner({ color, size = 14 }: { color: string; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      style={{ animation: 'spin 0.9s linear infinite' }}
      aria-hidden="true"
    >
      <circle
        cx="8"
        cy="8"
        r="6"
        stroke={color}
        strokeOpacity="0.2"
        strokeWidth="2"
        fill="none"
      />
      <path
        d="M 8 2 A 6 6 0 0 1 14 8"
        stroke={color}
        strokeWidth="2"
        fill="none"
        strokeLinecap="round"
      />
    </svg>
  )
}

export function CanvasAmbience({ mode }: { mode: WeaveMode }) {
  const tint = `${MODE_BG_SOFT_HEX[mode]}44`
  return (
    <div
      aria-hidden="true"
      style={{
        position: 'absolute',
        inset: 0,
        pointerEvents: 'none',
        zIndex: 1,
        background: `radial-gradient(ellipse 80% 60% at 50% 50%, ${tint} 0%, transparent 60%)`,
        transition: 'background 600ms ease',
      }}
    />
  )
}

type WeavingProps = {
  mode: WeaveMode | null
}

export function WeavingShimmer({ mode }: WeavingProps) {
  const active = mode !== null
  const glow = MODE_GLOW[mode ?? 'weave']
  const containerStyle: CSSProperties = {
    position: 'absolute',
    inset: 0,
    zIndex: 4,
    pointerEvents: 'none',
    overflow: 'hidden',
    opacity: active ? 1 : 0,
    transition: 'opacity 300ms ease',
  }
  const bandStyle: CSSProperties = {
    position: 'absolute',
    top: 0,
    bottom: 0,
    width: '40%',
    background: `linear-gradient(90deg, transparent, ${glow}, transparent)`,
    animation: active ? 'weave-shimmer-sweep 2.4s ease-in-out infinite' : 'none',
  }
  return (
    <div style={containerStyle} aria-hidden="true">
      <div style={bandStyle} />
    </div>
  )
}

export function ThinkingPanel({ mode }: WeavingProps) {
  const active = mode !== null
  const resolved: WeaveMode = mode ?? 'weave'
  const ink = MODE_INK[resolved]
  const accent = MODE_ACCENT[resolved]
  const lines = THINKING_LINES[resolved]

  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        position: 'absolute',
        top: 72,
        right: 16,
        width: 280,
        zIndex: 20,
        background: '#fffdf6',
        borderRadius: 'var(--w-radius-lg)',
        boxShadow: 'var(--w-shadow-card)',
        border: '1px solid var(--w-line)',
        padding: 16,
        fontFamily: 'var(--w-font-mono)',
        opacity: active ? 1 : 0,
        pointerEvents: active ? 'auto' : 'none',
        transition: 'opacity 300ms ease',
      }}
    >
      <div
        className="flex items-center"
        style={{ gap: 8, marginBottom: 12 }}
      >
        <Spinner color={accent} />
        <span
          style={{
            fontSize: 11,
            fontWeight: 600,
            color: ink,
            letterSpacing: 0.5,
            textTransform: 'uppercase',
          }}
        >
          Claude is weaving
        </span>
      </div>

      {lines.map((line, i) => {
        const isLast = i === lines.length - 1
        return (
          <div
            key={i}
            style={{
              fontSize: 11,
              lineHeight: 1.6,
              color: isLast ? ink : 'var(--w-ink-faint)',
            }}
          >
            <span style={{ color: 'var(--w-ink-faint)' }}>{'> '}</span>
            <span>{line}</span>
            {isLast && (
              <span
                aria-hidden="true"
                style={{
                  display: 'inline-block',
                  width: 6,
                  height: 11,
                  marginLeft: 2,
                  background: accent,
                  verticalAlign: 'middle',
                  animation: 'weave-cursor-blink 1s step-end infinite',
                }}
              />
            )}
          </div>
        )
      })}
    </div>
  )
}
