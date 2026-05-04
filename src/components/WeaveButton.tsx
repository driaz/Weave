import {
  useState,
  useCallback,
  useEffect,
  useRef,
  type CSSProperties,
} from 'react'
import { useReactFlow } from '@xyflow/react'
import type { WeaveMode } from '../types/board'
import { analyzeCanvas, type Connection, type WeaveResult } from '../api/claude'
import { trackEvent } from '../services/eventTracker'
import { useBoardId } from '../hooks/useBoardId'

type WeaveState = 'idle' | 'loading' | 'error' | 'no-new'

type ModeMeta = {
  label: string
  hint: string
  ink: string
  bg: string
  bgSoft: string
  accent: string
  glow: string
  loading: string
}

const MODE_META: Record<WeaveMode, ModeMeta> = {
  weave: {
    label: 'Standard',
    hint: 'FIND WHAT CONNECTS',
    ink: 'var(--w-standard-ink)',
    bg: 'var(--w-standard-bg)',
    bgSoft: 'var(--w-standard-bg-soft)',
    accent: 'var(--w-standard-accent)',
    glow: 'var(--w-standard-glow)',
    loading: 'Weaving…',
  },
  deeper: {
    label: 'Go Deeper',
    hint: "UNEARTH WHAT'S UNDERNEATH",
    ink: 'var(--w-deeper-ink)',
    bg: 'var(--w-deeper-bg)',
    bgSoft: 'var(--w-deeper-bg-soft)',
    accent: 'var(--w-deeper-accent)',
    glow: 'var(--w-deeper-glow)',
    loading: 'Going deeper…',
  },
  tensions: {
    label: 'Find Tensions',
    hint: 'SURFACE WHAT PULLS APART',
    ink: 'var(--w-tensions-ink)',
    bg: 'var(--w-tensions-bg)',
    bgSoft: 'var(--w-tensions-bg-soft)',
    accent: 'var(--w-tensions-accent)',
    glow: 'var(--w-tensions-glow)',
    loading: 'Finding tensions…',
  },
}

// `var(...)` strings can't be alpha-mixed, so the ring color uses the same
// hex literal that the corresponding token resolves to. Keep these in sync
// with the tokens in src/index.css.
const MODE_ACCENT_HEX: Record<WeaveMode, string> = {
  weave: '#c9942f',
  deeper: '#3a7359',
  tensions: '#b84c3a',
}

const ALL_MODES: WeaveMode[] = ['weave', 'deeper', 'tensions']

function ModeGlyph({
  mode,
  size = 20,
  color,
}: {
  mode: WeaveMode
  size?: number
  color: string
}) {
  const stroke = color
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
          stroke={stroke}
          strokeWidth="1.8"
          strokeLinecap="round"
        />
        <path
          d="M 3 14 Q 10 6, 17 14"
          stroke={stroke}
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
          stroke={stroke}
          strokeWidth="1.8"
          strokeLinecap="round"
        />
        <path
          d="M 10 11 Q 6 13, 4 17"
          stroke={stroke}
          strokeWidth="1.6"
          strokeLinecap="round"
        />
        <path
          d="M 10 11 Q 14 13, 16 17"
          stroke={stroke}
          strokeWidth="1.6"
          strokeLinecap="round"
        />
        <circle cx="10" cy="3" r="1.8" fill={stroke} />
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
        stroke={stroke}
        strokeWidth="1.8"
        strokeLinecap="round"
      />
      <path
        d="M 4 7 L 1 10 L 4 13"
        stroke={stroke}
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M 12 10 L 18 10"
        stroke={stroke}
        strokeWidth="1.8"
        strokeLinecap="round"
      />
      <path
        d="M 16 7 L 19 10 L 16 13"
        stroke={stroke}
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function ArrowNeedle({ color }: { color: string }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 14 14"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M 2 7 L 11 7"
        stroke={color}
        strokeWidth="1.6"
        strokeLinecap="round"
      />
      <path
        d="M 8 4 L 11 7 L 8 10"
        stroke={color}
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function Spinner({ color }: { color: string }) {
  return (
    <svg
      width="16"
      height="16"
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

function Caret({ open, color }: { open: boolean; color: string }) {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 10 10"
      fill="none"
      style={{
        transform: open ? 'rotate(180deg)' : 'rotate(0deg)',
        transition: 'transform 150ms ease',
      }}
      aria-hidden="true"
    >
      <path
        d="M 2 4 L 5 7 L 8 4"
        stroke={color}
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

type WeaveButtonProps = {
  connections: Connection[]
  activeLayer: WeaveMode
  onLayerChange: (layer: WeaveMode) => void
  onResult: (result: WeaveResult, mode: WeaveMode) => void
  onClear: () => void
}

export function WeaveButton({
  connections,
  activeLayer,
  onLayerChange,
  onResult,
  // onClear is intentionally unused in this layout — the bottom bar no
  // longer surfaces a "Clear connections" affordance. Kept in the prop
  // shape so the call site doesn't need to change yet; will be wired up
  // when a settings menu lands.
  onClear: _onClear,
}: WeaveButtonProps) {
  void _onClear
  const [state, setState] = useState<WeaveState>('idle')
  const [loadingMode, setLoadingMode] = useState<WeaveMode | null>(null)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [nodeCountAtClick, setNodeCountAtClick] = useState(0)
  const { getNodes } = useReactFlow()
  const boardId = useBoardId()
  const containerRef = useRef<HTMLDivElement>(null)

  // Close picker on Escape or outside click.
  useEffect(() => {
    if (!pickerOpen) return
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPickerOpen(false)
    }
    const handleClick = (e: MouseEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        setPickerOpen(false)
      }
    }
    document.addEventListener('keydown', handleEscape)
    document.addEventListener('mousedown', handleClick)
    return () => {
      document.removeEventListener('keydown', handleEscape)
      document.removeEventListener('mousedown', handleClick)
    }
  }, [pickerOpen])

  const handleWeave = useCallback(
    async (mode: WeaveMode) => {
      if (state === 'loading') return
      setState('loading')
      setLoadingMode(mode)
      setPickerOpen(false)

      const clickedAt = Date.now()
      const clickedAtIso = new Date(clickedAt).toISOString()

      let nodeCount = 0
      let contextConnectionsSent = 0
      let connectionsReturned = 0
      let connectionsAfterDedup = 0
      let apiLatencyMs = 0
      let promptTokens: number | null = null
      let completionTokens: number | null = null
      let model: string | null = null
      let stopReason: string | null = null
      let skipped = false
      let errorMessage: string | null = null

      try {
        const nodes = getNodes()
        setNodeCountAtClick(nodes.length)
        const strip = (id: string) => id.replace(/^node-/, '')

        const modeConns = connections.filter((c) => c.mode === mode)
        const isFirstRun = modeConns.length === 0
        contextConnectionsSent = modeConns.length

        const connectedNodes = new Set<string>()
        for (const c of modeConns) {
          connectedNodes.add(strip(c.from))
          connectedNodes.add(strip(c.to))
        }

        if (!isFirstRun) {
          const contentNodeIds = nodes
            .filter((n) => {
              if (!n.type) return false
              const d = n.data as Record<string, unknown>
              switch (n.type) {
                case 'textCard':
                  return !!d.text && String(d.text).trim().length > 0
                case 'imageCard':
                  return !!d.imageDataUrl
                case 'linkCard':
                  return !d.loading && !!d.url
                case 'pdfCard':
                  return !!d.pdfDataUrl
                default:
                  return false
              }
            })
            .map((n) => strip(n.id))

          if (
            contentNodeIds.length >= 2 &&
            contentNodeIds.every((id) => connectedNodes.has(id))
          ) {
            console.log(
              `[Weave Debug] All ${contentNodeIds.length} content nodes already connected for mode="${mode}", skipping API call`,
            )
            nodeCount = contentNodeIds.length
            skipped = true
            contextConnectionsSent = 0
            errorMessage = 'all_nodes_connected'
            setState('no-new')
            setTimeout(() => setState('idle'), 2000)
            return
          }
        }

        console.log(
          `[Weave Debug] ${isFirstRun ? 'First run' : 'Re-run'} for mode="${mode}", total connections: ${connections.length}, same-mode: ${modeConns.length}, connected nodes for this mode: ${connectedNodes.size}`,
        )

        const result = await analyzeCanvas(nodes, mode, connections)

        nodeCount = result.diagnostics.nodeCount
        contextConnectionsSent = result.diagnostics.contextConnectionsSent
        apiLatencyMs = result.diagnostics.apiLatencyMs
        promptTokens = result.diagnostics.promptTokens
        completionTokens = result.diagnostics.completionTokens
        model = result.diagnostics.model
        stopReason = result.diagnostics.stopReason
        if (result.diagnostics.skippedApiCall) {
          skipped = true
          errorMessage = 'insufficient_content_nodes'
        }
        connectionsReturned = result.connections.length

        let newConnections: typeof result.connections
        if (isFirstRun) {
          newConnections = result.connections
        } else {
          newConnections = result.connections.filter((c) => {
            const fromConnected = connectedNodes.has(strip(c.from))
            const toConnected = connectedNodes.has(strip(c.to))
            return !fromConnected || !toConnected
          })
        }

        connectionsAfterDedup = newConnections.length

        if (newConnections.length === 0) {
          setState('no-new')
          setTimeout(() => setState('idle'), 2000)
        } else {
          onResult(
            { connections: newConnections, diagnostics: result.diagnostics },
            mode,
          )
          setState('idle')
        }
      } catch (error) {
        console.error('Weave error:', error)
        errorMessage = error instanceof Error ? error.message : String(error)
        setState('error')
        setTimeout(() => setState('idle'), 2000)
      } finally {
        setLoadingMode(null)

        const duplicatesFiltered = Math.max(
          0,
          connectionsReturned - connectionsAfterDedup,
        )

        trackEvent('weave_triggered', {
          boardId,
          timestamp: clickedAtIso,
          durationMs: Date.now() - clickedAt,
          metadata: {
            mode,
            nodeCount,
            contextConnectionsSent,
            connectionsReturned,
            connectionsAfterDedup,
            duplicatesFiltered,
            apiLatencyMs,
            promptTokens,
            completionTokens,
            model,
            stopReason,
            skipped,
            error: errorMessage,
          },
        })
      }
    },
    [state, getNodes, connections, onResult, boardId],
  )

  // Cmd/Ctrl + Enter shortcut runs the active mode.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault()
        handleWeave(activeLayer)
      }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [handleWeave, activeLayer])

  const isLoading = state === 'loading'
  const displayMode: WeaveMode = isLoading && loadingMode ? loadingMode : activeLayer
  const meta = MODE_META[displayMode]
  const accentHex = MODE_ACCENT_HEX[displayMode]

  const pillStyle: CSSProperties = {
    display: 'flex',
    alignItems: 'stretch',
    background: meta.bg,
    borderRadius: 'var(--w-radius-pill)',
    boxShadow: `var(--w-shadow-pop), 0 0 0 1px ${accentHex}22, 0 0 40px ${meta.glow}`,
    transition:
      'background 300ms ease, box-shadow 300ms ease, transform 150ms ease',
    cursor: isLoading ? 'progress' : 'default',
  }

  const hintText = (() => {
    if (isLoading) return `ANALYZING ${nodeCountAtClick} NODES`
    if (state === 'error') return 'SOMETHING SLIPPED — TRY AGAIN'
    if (state === 'no-new') return 'NO NEW CONNECTIONS'
    return `${meta.hint}  ·  ⌘⏎`
  })()

  return (
    <div
      ref={containerRef}
      className="flex flex-col items-center"
      style={{
        position: 'absolute',
        bottom: 24,
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 40,
      }}
    >
      <div className="relative">
        <div style={pillStyle}>
          <button
            type="button"
            onClick={() => {
              if (isLoading) return
              setPickerOpen((prev) => !prev)
            }}
            disabled={isLoading}
            aria-haspopup="listbox"
            aria-expanded={pickerOpen}
            className="flex items-center cursor-pointer select-none"
            style={{
              gap: 8,
              padding: '0 16px 0 18px',
              background: 'transparent',
              border: 'none',
              borderRight: `1px solid ${accentHex}33`,
              color: meta.ink,
              fontFamily: 'var(--w-font-sans)',
              fontSize: 13,
              fontWeight: 500,
            }}
          >
            <ModeGlyph mode={displayMode} size={18} color={meta.ink} />
            <span>{meta.label}</span>
            <Caret open={pickerOpen} color={meta.ink} />
          </button>

          <button
            type="button"
            onClick={() => handleWeave(activeLayer)}
            disabled={isLoading}
            aria-label="Weave: analyze canvas and find connections"
            className="flex items-center cursor-pointer select-none"
            style={{
              gap: 10,
              padding: '14px 24px 14px 20px',
              background: 'transparent',
              border: 'none',
              color: meta.ink,
              fontFamily: 'var(--w-font-display)',
              fontSize: 18,
              fontWeight: 500,
              letterSpacing: '-0.2px',
              cursor: isLoading ? 'progress' : 'pointer',
            }}
          >
            {isLoading ? (
              <>
                <Spinner color={meta.ink} />
                <span>{meta.loading}</span>
              </>
            ) : (
              <>
                <span>Weave</span>
                <ArrowNeedle color={meta.ink} />
              </>
            )}
          </button>
        </div>

        {pickerOpen && !isLoading && (
          <div
            role="listbox"
            aria-label="Weave mode"
            style={{
              position: 'absolute',
              bottom: 'calc(100% + 12px)',
              left: '50%',
              transform: 'translateX(-50%)',
              width: 280,
              background: '#fffdf6',
              borderRadius: 16,
              boxShadow: 'var(--w-shadow-float)',
              border: '1px solid var(--w-line)',
              padding: 8,
              display: 'flex',
              flexDirection: 'column',
              gap: 2,
              animation: 'weave-popover-in 180ms ease',
            }}
          >
            {ALL_MODES.map((m) => {
              const mMeta = MODE_META[m]
              const active = m === activeLayer
              return (
                <button
                  key={m}
                  type="button"
                  role="option"
                  aria-selected={active}
                  onClick={() => {
                    onLayerChange(m)
                    setPickerOpen(false)
                  }}
                  className="flex items-center cursor-pointer text-left transition-colors duration-150"
                  style={{
                    gap: 12,
                    padding: '10px 12px',
                    borderRadius: 10,
                    background: active ? mMeta.bgSoft : 'transparent',
                    border: 'none',
                  }}
                  onMouseEnter={(e) => {
                    if (!active)
                      e.currentTarget.style.background = 'var(--w-paper-dim)'
                  }}
                  onMouseLeave={(e) => {
                    if (!active) e.currentTarget.style.background = 'transparent'
                  }}
                >
                  <ModeGlyph mode={m} size={28} color={mMeta.ink} />
                  <div className="flex flex-col" style={{ flex: 1, gap: 2 }}>
                    <span
                      style={{
                        fontFamily: 'var(--w-font-sans)',
                        fontSize: 13,
                        fontWeight: 600,
                        color: mMeta.ink,
                      }}
                    >
                      {mMeta.label}
                    </span>
                    <span
                      style={{
                        fontFamily: 'var(--w-font-sans)',
                        fontSize: 11,
                        color: 'var(--w-ink-soft)',
                      }}
                    >
                      {mMeta.hint.toLowerCase()}
                    </span>
                  </div>
                  {active && (
                    <span
                      aria-hidden="true"
                      style={{
                        width: 6,
                        height: 6,
                        borderRadius: 999,
                        background: mMeta.accent,
                        flexShrink: 0,
                      }}
                    />
                  )}
                </button>
              )
            })}
          </div>
        )}
      </div>

      <p
        style={{
          textAlign: 'center',
          marginTop: 10,
          marginBottom: 0,
          fontFamily: 'var(--w-font-mono)',
          fontSize: 11,
          color: 'var(--w-ink-soft)',
          letterSpacing: 0.5,
        }}
      >
        {hintText}
      </p>
    </div>
  )
}
