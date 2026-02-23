import { useCallback } from 'react'
import { useReactFlow } from '@xyflow/react'

let nodeIdCounter = 1

export function AddNodeButton() {
  const { addNodes, screenToFlowPosition } = useReactFlow()

  const handleAdd = useCallback(() => {
    const position = screenToFlowPosition({
      x: window.innerWidth / 2,
      y: window.innerHeight / 2,
    })

    nodeIdCounter++
    addNodes({
      id: String(nodeIdCounter),
      type: 'textCard',
      position,
      data: { text: '' },
    })
  }, [addNodes, screenToFlowPosition])

  return (
    <button
      onClick={handleAdd}
      className="w-10 h-10 rounded-full bg-white border border-gray-200 shadow-sm flex items-center justify-center text-gray-400 text-2xl font-light hover:text-gray-700 hover:shadow-md hover:border-gray-300 hover:scale-105 active:scale-95 transition-all duration-150 cursor-pointer"
      aria-label="Add new text card"
    >
      +
    </button>
  )
}
