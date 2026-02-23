import { useCallback, useState } from 'react'
import {
  ReactFlow,
  Background,
  Controls,
  Panel,
  type Node,
  type OnNodesChange,
  applyNodeChanges,
} from '@xyflow/react'
import { TextCardNode } from './components/TextCardNode'
import { AddNodeButton } from './components/AddNodeButton'

const nodeTypes = {
  textCard: TextCardNode,
}

const initialNodes: Node[] = [
  {
    id: '1',
    type: 'textCard',
    position: { x: 250, y: 200 },
    data: { text: 'Drag me around the canvas. Zoom and pan to explore.' },
  },
]

export function App() {
  const [nodes, setNodes] = useState<Node[]>(initialNodes)

  const onNodesChange: OnNodesChange = useCallback(
    (changes) => setNodes((nds) => applyNodeChanges(changes, nds)),
    [],
  )

  return (
    <div className="w-screen h-screen">
      <ReactFlow
        nodes={nodes}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        fitView
      >
        <Background />
        <Controls position="bottom-right" />
        <Panel position="bottom-left">
          <AddNodeButton />
        </Panel>
      </ReactFlow>
    </div>
  )
}
