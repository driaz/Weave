import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ReactFlow,
  Background,
  Controls,
  Panel,
  type Node,
  type Edge,
  type OnNodesChange,
  type ReactFlowInstance,
  applyNodeChanges,
} from '@xyflow/react'
import { TextCardNode } from './components/TextCardNode'
import { ImageCardNode } from './components/ImageCardNode'
import { LinkCardNode } from './components/LinkCardNode'
import { PdfCardNode } from './components/PdfCardNode'
import { AddNodeButton } from './components/AddNodeButton'
import { WeaveButton } from './components/WeaveButton'
import { WeaveEdge, type WeaveEdgeData } from './components/WeaveEdge'
import { EdgeDetailPopup } from './components/EdgeDetailPopup'
import { useStaggeredEdges } from './hooks/useStaggeredEdges'
import type { Connection } from './api/claude'
import { generateNodeId } from './utils/nodeId'
import { readFileAsDataUrl, isImageFile } from './utils/imageUtils'
import { isUrl, fetchLinkMetadata, extractDomain } from './utils/linkUtils'
import { isPdfFile, renderPdfThumbnail } from './utils/pdfUtils'

const nodeTypes = {
  textCard: TextCardNode,
  imageCard: ImageCardNode,
  linkCard: LinkCardNode,
  pdfCard: PdfCardNode,
}

const edgeTypes = {
  weave: WeaveEdge,
}

const initialNodes: Node[] = []

export function App() {
  const [nodes, setNodes] = useState<Node[]>(initialNodes)
  const [connections, setConnections] = useState<Connection[]>([])
  const [selectedEdge, setSelectedEdge] = useState<{
    connection: Connection
    position: { x: number; y: number }
  } | null>(null)
  const reactFlowRef = useRef<ReactFlowInstance<Node, Edge<WeaveEdgeData>> | null>(null)
  const edges = useStaggeredEdges(connections)

  // Debug: log edges with node ID validation
  useEffect(() => {
    if (edges.length === 0) return
    const nodeIds = new Set(nodes.map((n) => n.id))
    for (const edge of edges) {
      const sourceValid = nodeIds.has(edge.source)
      const targetValid = nodeIds.has(edge.target)
      console.log(
        `Edge ${edge.id}: ${edge.source} ${sourceValid ? '✓' : '✗ MISSING'} → ${edge.target} ${targetValid ? '✓' : '✗ MISSING'}`,
        edge.data,
      )
    }
  }, [edges, nodes])

  const onNodesChange: OnNodesChange = useCallback(
    (changes) => setNodes((nds) => applyNodeChanges(changes, nds)),
    [],
  )

  const onEdgeClick = useCallback(
    (_event: React.MouseEvent, edge: Edge<WeaveEdgeData>) => {
      const conn = connections.find(
        (c) => c.from === edge.source && c.to === edge.target,
      )
      if (!conn) return
      setSelectedEdge({
        connection: conn,
        position: { x: _event.clientX, y: _event.clientY },
      })
    },
    [connections],
  )

  const onDragOver = useCallback((event: React.DragEvent) => {
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
  }, [])

  const onDrop = useCallback(
    async (event: React.DragEvent) => {
      event.preventDefault()

      const files = Array.from(event.dataTransfer.files)
      const instance = reactFlowRef.current
      if (!instance) return

      const clientX = event.clientX
      const clientY = event.clientY
      let offset = 0

      // Handle image files
      const imageFiles = files.filter(isImageFile)
      for (let i = 0; i < imageFiles.length; i++) {
        const file = imageFiles[i]
        const imageDataUrl = await readFileAsDataUrl(file)
        const position = instance.screenToFlowPosition({
          x: clientX + offset * 30,
          y: clientY + offset * 30,
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
        offset++
      }

      // Handle PDF files
      const pdfFiles = files.filter(isPdfFile)
      for (let i = 0; i < pdfFiles.length; i++) {
        const file = pdfFiles[i]
        const pdfDataUrl = await readFileAsDataUrl(file)
        const { thumbnailDataUrl, pageCount } =
          await renderPdfThumbnail(pdfDataUrl)
        const position = instance.screenToFlowPosition({
          x: clientX + offset * 30,
          y: clientY + offset * 30,
        })

        setNodes((prev) => [
          ...prev,
          {
            id: generateNodeId(),
            type: 'pdfCard',
            position,
            data: {
              pdfDataUrl,
              fileName: file.name,
              label: '',
              thumbnailDataUrl,
              pageCount,
            },
          },
        ])
        offset++
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
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onEdgeClick={onEdgeClick}
        onInit={(instance) => {
          reactFlowRef.current = instance
        }}
        onDrop={onDrop}
        onDragOver={onDragOver}
        fitView
        proOptions={{ hideAttribution: true }}
      >
        <Background />
        <Controls position="bottom-right" />
        <Panel position="top-center">
          <WeaveButton
            onResult={(result) => {
              console.log(
                `Weave: ${connections.length} → ${result.connections.length} connections:`,
                result.connections,
              )
              setSelectedEdge(null)
              setConnections(result.connections)
            }}
          />
        </Panel>
        <Panel position="bottom-left">
          <AddNodeButton />
        </Panel>
        {nodes.length === 0 && (
          <Panel position="top-left" className="!inset-0 !m-0 flex items-center justify-center pointer-events-none">
            <p className="text-gray-400 text-lg font-light select-none">
              Drop content or click + to begin
            </p>
          </Panel>
        )}
      </ReactFlow>
      {selectedEdge && (
        <EdgeDetailPopup
          connection={selectedEdge.connection}
          position={selectedEdge.position}
          onClose={() => setSelectedEdge(null)}
        />
      )}
    </div>
  )
}
