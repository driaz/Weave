import { useState, useCallback } from 'react'
import { useReactFlow } from '@xyflow/react'
import { analyzeCanvas, type WeaveResult } from '../api/claude'

type WeaveState = 'idle' | 'loading' | 'error'

export function WeaveButton({
  onResult,
}: {
  onResult: (result: WeaveResult) => void
}) {
  const [state, setState] = useState<WeaveState>('idle')
  const { getNodes } = useReactFlow()

  const handleClick = useCallback(async () => {
    if (state === 'loading') return

    setState('loading')

    try {
      const nodes = getNodes()
      const result = await analyzeCanvas(nodes)
      console.log('Weave connections:', result.connections)
      onResult(result)
      setState('idle')
    } catch (error) {
      console.error('Weave error:', error)
      setState('error')
      setTimeout(() => setState('idle'), 2000)
    }
  }, [state, getNodes, onResult])

  return (
    <button
      onClick={handleClick}
      disabled={state === 'loading'}
      className={`
        px-4 py-1.5 rounded-full text-sm font-medium shadow-sm border transition-all duration-150 cursor-pointer
        ${state === 'idle' ? 'bg-white border-gray-200 text-gray-700 hover:shadow-md hover:border-gray-300' : ''}
        ${state === 'loading' ? 'bg-white border-gray-200 text-gray-400 animate-pulse cursor-default' : ''}
        ${state === 'error' ? 'bg-red-50 border-red-200 text-red-500' : ''}
      `}
      aria-label="Analyze canvas and find connections"
    >
      {state === 'idle' && 'Weave'}
      {state === 'loading' && 'Weaving...'}
      {state === 'error' && 'Error'}
    </button>
  )
}
