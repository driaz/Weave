import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ReactFlow,
  Background,
  Controls,
  Panel,
  type Node,
  type OnNodesChange,
  type ReactFlowInstance,
  applyNodeChanges,
} from '@xyflow/react'
import { TextCardNode } from './components/TextCardNode'
import { ImageCardNode } from './components/ImageCardNode'
import { LinkCardNode } from './components/LinkCardNode'
import { AddNodeButton } from './components/AddNodeButton'
import { generateNodeId } from './utils/nodeId'
import { readFileAsDataUrl, isImageFile } from './utils/imageUtils'
import { isUrl, fetchLinkMetadata, extractDomain } from './utils/linkUtils'

const nodeTypes = {
  textCard: TextCardNode,
  imageCard: ImageCardNode,
  linkCard: LinkCardNode,
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
  const reactFlowRef = useRef<ReactFlowInstance | null>(null)

  const onNodesChange: OnNodesChange = useCallback(
    (changes) => setNodes((nds) => applyNodeChanges(changes, nds)),
    [],
  )

  const onDragOver = useCallback((event: React.DragEvent) => {
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
  }, [])

  const onDrop = useCallback(
    async (event: React.DragEvent) => {
      event.preventDefault()

      const files = Array.from(event.dataTransfer.files)
      const imageFiles = files.filter(isImageFile)
      if (imageFiles.length === 0) return

      const instance = reactFlowRef.current
      if (!instance) return

      const clientX = event.clientX
      const clientY = event.clientY

      for (let i = 0; i < imageFiles.length; i++) {
        const file = imageFiles[i]
        const imageDataUrl = await readFileAsDataUrl(file)
        const position = instance.screenToFlowPosition({
          x: clientX + i * 30,
          y: clientY + i * 30,
        })

        setNodes((prev) => [
          ...prev,
          {
            id: generateNodeId(),
            type: 'imageCard',
            position,
            data: { imageDataUrl, fileName: file.name, label: '' },
          },
        ])
      }
    },
    [setNodes],
  )

  useEffect(() => {
    const handlePaste = async (e: ClipboardEvent) => {
      const active = document.activeElement
      if (
        active instanceof HTMLInputElement ||
        active instanceof HTMLTextAreaElement ||
        (active instanceof HTMLElement && active.isContentEditable)
      ) {
        return
      }

      const text = e.clipboardData?.getData('text/plain')?.trim()
      if (!text || !isUrl(text)) return

      e.preventDefault()

      const instance = reactFlowRef.current
      if (!instance) return

      const position = instance.screenToFlowPosition({
        x: window.innerWidth / 2,
        y: window.innerHeight / 2,
      })

      // Create node immediately with loading state
      const nodeId = generateNodeId()
      const domain = extractDomain(text)

      setNodes((prev) => [
        ...prev,
        {
          id: nodeId,
          type: 'linkCard',
          position,
          data: {
            url: text,
            title: domain || text,
            description: '',
            imageUrl: '',
            domain,
            type: 'generic',
            loading: true,
          },
        },
      ])

      // Fetch metadata and update the node
      const metadata = await fetchLinkMetadata(text)

      setNodes((prev) =>
        prev.map((node) =>
          node.id === nodeId
            ? { ...node, data: { ...metadata, loading: false } }
            : node,
        ),
      )
    }

    document.addEventListener('paste', handlePaste)
    return () => document.removeEventListener('paste', handlePaste)
  }, [setNodes])

  return (
    <div className="w-screen h-screen">
      <ReactFlow
        nodes={nodes}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onInit={(instance) => {
          reactFlowRef.current = instance
        }}
        onDrop={onDrop}
        onDragOver={onDragOver}
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
