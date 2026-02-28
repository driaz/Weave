import { useState, useCallback, useMemo } from 'react'
import { useReactFlow } from '@xyflow/react'
import type { WeaveMode } from '../types/board'
import { analyzeCanvas, type Connection, type WeaveResult } from '../api/claude'
import { getEdgeColor } from '../utils/edgeColors'

type WeaveState = 'idle' | 'loading' | 'error' | 'no-new'

const MODE_CONFIG: Record<
  WeaveMode,
  { pill: string; button: string; loading: string }
> = {
  weave: { pill: 'Standard', button: 'Weave', loading: 'Weaving...' },
  deeper: { pill: 'Go Deeper', button: 'Go Deeper', loading: 'Going deeper...' },
  tensions: {
    pill: 'Find Tensions',
    button: 'Find Tensions',
    loading: 'Finding tensions...',
  },
}

const TOGGLE_MODES: WeaveMode[] = ['weave', 'deeper', 'tensions']

export function WeaveButton({
  connections,
  activeLayer,
  onLayerChange,
  onResult,
  onClear,
}: {
  connections: Connection[]
  activeLayer: WeaveMode
  onLayerChange: (layer: WeaveMode) => void
  onResult: (result: WeaveResult, mode: WeaveMode) => void
  onClear: () => void
}) {
  const [state, setState] = useState<WeaveState>('idle')
  const [loadingMode, setLoadingMode] = useState<WeaveMode | null>(null)
  const { getNodes } = useReactFlow()

  const handleWeave = useCallback(
    async (mode: WeaveMode) => {
      if (state === 'loading') return
      setState('loading')
      setLoadingMode(mode)

      try {
        const nodes = getNodes()
        const strip = (id: string) => id.replace(/^node-/, '')

        // Only count connections for THIS specific mode — other modes are irrelevant
        const modeConns = connections.filter((c) => c.mode === mode)
        const isFirstRun = modeConns.length === 0

        // Build set of nodes already connected for THIS mode only
        const connectedNodes = new Set<string>()
        for (const c of modeConns) {
          connectedNodes.add(strip(c.from))
          connectedNodes.add(strip(c.to))
        }

        // Pre-check: skip API call if all content nodes already have connections FOR THIS MODE.
        // First run of any mode always proceeds (no connections exist yet).
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
            setState('no-new')
            setTimeout(() => setState('idle'), 2000)
            return
          }
        }

        console.log(
          `[Weave Debug] ${isFirstRun ? 'First run' : 'Re-run'} for mode="${mode}", total connections: ${connections.length}, same-mode: ${modeConns.length}, connected nodes for this mode: ${connectedNodes.size}`,
        )

        const result = await analyzeCanvas(nodes, mode, connections)

        console.log(
          `[Weave Debug] Claude returned ${result.connections.length} connections:`,
          result.connections.map((c) => `${c.from} <-> ${c.to}: ${c.label}`),
        )

        // First run: keep all connections (no mode-specific connections exist yet).
        // Re-run: only keep connections where at least one node is unconnected FOR THIS MODE.
        let newConnections: typeof result.connections

        if (isFirstRun) {
          console.log(
            `[Weave Debug] First run for mode="${mode}", keeping all ${result.connections.length} connections`,
          )
          newConnections = result.connections
        } else {
          newConnections = result.connections.filter((c) => {
            const fromConnected = connectedNodes.has(strip(c.from))
            const toConnected = connectedNodes.has(strip(c.to))
            const hasUnconnectedNode = !fromConnected || !toConnected
            console.log(
              `[Weave Debug]   ${c.from} <-> ${c.to} → from=${fromConnected ? 'connected' : 'NEW'} to=${toConnected ? 'connected' : 'NEW'} → ${hasUnconnectedNode ? 'KEPT' : 'FILTERED'}`,
            )
            return hasUnconnectedNode
          })

          console.log(
            `[Weave Debug] After filter: ${newConnections.length} kept out of ${result.connections.length}`,
          )
        }

        if (newConnections.length === 0) {
          setState('no-new')
          setTimeout(() => setState('idle'), 2000)
        } else {
          onResult({ connections: newConnections }, mode)
          setState('idle')
        }
      } catch (error) {
        console.error('Weave error:', error)
        setState('error')
        setTimeout(() => setState('idle'), 2000)
      } finally {
        setLoadingMode(null)
      }
    },
    [state, getNodes, connections, onResult],
  )

  // Which modes already have connections on the canvas
  const availableModes = useMemo(() => {
    const modes = new Set<WeaveMode>()
    for (const conn of connections) {
      if (conn.mode) modes.add(conn.mode)
    }
    return modes
  }, [connections])

  const handlePillClick = useCallback(
    (mode: WeaveMode) => {
      if (availableModes.has(mode)) {
        // Already generated — just switch visibility
        onLayerChange(mode)
      } else {
        // Not yet generated — run the analysis
        handleWeave(mode)
      }
    },
    [availableModes, onLayerChange, handleWeave],
  )

  const isLoading = state === 'loading'
  const config = MODE_CONFIG[activeLayer]
  const loadingText = loadingMode
    ? MODE_CONFIG[loadingMode].loading
    : config.loading
  const hasConnections = connections.length > 0

  return (
    <div className="flex flex-col items-center gap-1.5">
      {/* Primary action button — re-runs the active mode */}
      <button
        onClick={() => handleWeave(activeLayer)}
        disabled={isLoading}
        className={`
          px-4 py-1.5 rounded-full text-sm font-medium shadow-sm border
          transition-all duration-150 cursor-pointer
          ${state === 'idle' ? 'bg-white border-gray-200 text-gray-700 hover:shadow-md hover:border-gray-300' : ''}
          ${state === 'loading' ? 'bg-white border-gray-200 text-gray-400 animate-pulse cursor-default' : ''}
          ${state === 'error' ? 'bg-red-50 border-red-200 text-red-500' : ''}
          ${state === 'no-new' ? 'bg-gray-50 border-gray-200 text-gray-400 cursor-default' : ''}
        `}
        aria-label="Analyze canvas and find connections"
      >
        {state === 'idle' && config.button}
        {state === 'loading' && loadingText}
        {state === 'error' && 'Error'}
        {state === 'no-new' && 'No new connections'}
      </button>

      {/* Layer toggle pills — visible after first weave */}
      {hasConnections && !isLoading && (
        <div className="flex flex-col items-center gap-1">
          <div className="flex items-center gap-1">
            {TOGGLE_MODES.map((mode) => {
              const isActive = activeLayer === mode
              const isGenerated = availableModes.has(mode)
              const colors = getEdgeColor(mode)

              return (
                <button
                  key={mode}
                  onClick={() => handlePillClick(mode)}
                  className={`
                    flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px]
                    transition-all duration-150 cursor-pointer
                    ${
                      isActive
                        ? 'font-medium'
                        : isGenerated
                          ? 'bg-white border border-gray-200 text-gray-500 hover:border-gray-300 hover:text-gray-700'
                          : 'bg-white border border-dashed border-gray-200 text-gray-400 hover:border-gray-300'
                    }
                  `}
                  style={
                    isActive
                      ? {
                          backgroundColor: colors.fill,
                          color: '#FFFFFF',
                          borderWidth: '1px',
                          borderStyle: 'solid',
                          borderColor: colors.fill,
                        }
                      : undefined
                  }
                >
                  <span
                    className="w-1.5 h-1.5 rounded-full shrink-0"
                    style={{
                      backgroundColor: isActive
                        ? '#FFFFFF'
                        : isGenerated
                          ? colors.stroke
                          : '#9CA3AF',
                    }}
                  />
                  {MODE_CONFIG[mode].pill}
                </button>
              )
            })}
          </div>
          <button
            onClick={onClear}
            className="text-[10px] text-gray-400 hover:text-gray-500
              transition-colors duration-150 cursor-pointer"
          >
            Clear
          </button>
        </div>
      )}
    </div>
  )
}
