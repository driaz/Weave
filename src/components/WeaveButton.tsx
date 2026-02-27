import { useState, useCallback, useMemo } from 'react'
import { useReactFlow } from '@xyflow/react'
import type { WeaveMode } from '../types/board'
import { analyzeCanvas, type Connection, type WeaveResult } from '../api/claude'
import { getEdgeColor } from '../utils/edgeColors'

type WeaveState = 'idle' | 'loading' | 'error'

const MODE_LABELS: Record<WeaveMode, { label: string; loading: string }> = {
  weave: { label: 'Weave', loading: 'Weaving...' },
  deeper: { label: 'Go Deeper', loading: 'Going deeper...' },
  tensions: { label: 'Find Tensions', loading: 'Finding tensions...' },
}

const LAYER_OPTIONS: { key: WeaveMode | 'all'; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'weave', label: 'Weave' },
  { key: 'deeper', label: 'Go Deeper' },
  { key: 'tensions', label: 'Find Tensions' },
]

export function WeaveButton({
  connections,
  activeLayer,
  onLayerChange,
  onResult,
  onClear,
}: {
  connections: Connection[]
  activeLayer: WeaveMode | 'all'
  onLayerChange: (layer: WeaveMode | 'all') => void
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
        const result = await analyzeCanvas(nodes, mode, connections)
        onResult(result, mode)
        setState('idle')
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
    (key: WeaveMode | 'all') => {
      if (key === 'all') {
        onLayerChange('all')
        return
      }
      if (availableModes.has(key)) {
        // Already generated — just switch visibility
        onLayerChange(key)
      } else {
        // Not yet generated — run the weave
        handleWeave(key)
      }
    },
    [availableModes, onLayerChange, handleWeave],
  )

  const isLoading = state === 'loading'
  const loadingText = loadingMode
    ? MODE_LABELS[loadingMode].loading
    : 'Weaving...'
  const hasConnections = connections.length > 0

  return (
    <div className="flex flex-col items-center gap-1.5">
      {/* Primary Weave button */}
      <button
        onClick={() => handleWeave('weave')}
        disabled={isLoading}
        className={`
          px-4 py-1.5 rounded-full text-sm font-medium shadow-sm border
          transition-all duration-150 cursor-pointer
          ${state === 'idle' ? 'bg-white border-gray-200 text-gray-700 hover:shadow-md hover:border-gray-300' : ''}
          ${state === 'loading' ? 'bg-white border-gray-200 text-gray-400 animate-pulse cursor-default' : ''}
          ${state === 'error' ? 'bg-red-50 border-red-200 text-red-500' : ''}
        `}
        aria-label="Analyze canvas and find connections"
      >
        {state === 'idle' && 'Weave'}
        {state === 'loading' && loadingText}
        {state === 'error' && 'Error'}
      </button>

      {/* Layer toggle pills — visible after first weave */}
      {hasConnections && !isLoading && (
        <div className="flex flex-col items-center gap-1">
          <div className="flex items-center gap-1">
            {LAYER_OPTIONS.map(({ key, label }) => {
              const isActive = activeLayer === key
              const isGenerated = key === 'all' || availableModes.has(key)
              const colors = key === 'all' ? null : getEdgeColor(key)

              return (
                <button
                  key={key}
                  onClick={() => handlePillClick(key)}
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
                          backgroundColor: colors ? colors.fill : '#374151',
                          color: '#FFFFFF',
                          borderWidth: '1px',
                          borderStyle: 'solid',
                          borderColor: colors ? colors.fill : '#374151',
                        }
                      : undefined
                  }
                >
                  {colors && (
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
                  )}
                  {label}
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
