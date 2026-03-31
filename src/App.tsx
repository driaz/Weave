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
import {
  WeaveEdge,
  EdgeLabelClickContext,
  type WeaveEdgeData,
} from './components/WeaveEdge'
import { EdgeDetailPopup } from './components/EdgeDetailPopup'
import { BoardSwitcher } from './components/BoardSwitcher'
import { useStaggeredEdges } from './hooks/useStaggeredEdges'
import { useBoardStorage } from './hooks/useBoardStorage'
import type { Connection } from './api/claude'
import type { WeaveMode } from './types/board'
import { generateNodeId } from './utils/nodeId'
import { readFileAsDataUrl, isImageFile } from './utils/imageUtils'
import { isUrl, fetchLinkMetadata, fetchTweetImage, extractDomain } from './utils/linkUtils'
import { isPdfFile, renderPdfThumbnail } from './utils/pdfUtils'
import { HighlightContext, type HighlightState } from './hooks/useSelectedNode'
import { trackEvent } from './services/eventTracker'
import { BoardIdContext } from './hooks/useBoardId'
import { embedNodeAsync } from './services/embeddingService'

const nodeTypes = {
  textCard: TextCardNode,
  imageCard: ImageCardNode,
  linkCard: LinkCardNode,
  pdfCard: PdfCardNode,
}

const edgeTypes = {
  weave: WeaveEdge,
}

export function App() {
  const {
    currentBoard,
    allBoards,
    hydrating,
    createBoard,
    switchBoard,
    renameBoard,
    deleteBoard,
    saveCurrentBoard,
    storageError,
    dismissStorageError,
  } = useBoardStorage()

  const [nodes, setNodes] = useState<Node[]>(() =>
    currentBoard.nodes.map((n) => ({
      id: n.id,
      type: n.type,
      position: n.position,
      data: n.data,
    })),
  )
  const [connections, setConnections] = useState<Connection[]>(
    currentBoard.connections,
  )
  const [activeLayer, setActiveLayer] = useState<WeaveMode>('weave')
  const [highlightState, setHighlightState] = useState<HighlightState>(null)
  // Separate state for the popup — can be open alongside any highlight mode
  const [popupEdge, setPopupEdge] = useState<{
    connection: Connection
    position: { x: number; y: number }
  } | null>(null)
  const reactFlowRef = useRef<ReactFlowInstance<
    Node,
    Edge<WeaveEdgeData>
  > | null>(null)
  const edges = useStaggeredEdges(connections, activeLayer, highlightState)

  const handleNodeClick = useCallback(
    (_: React.MouseEvent, node: Node) => {
      setHighlightState((prev) =>
        prev?.type === 'node' && prev.nodeId === node.id
          ? null
          : { type: 'node', nodeId: node.id },
      )
    },
    [],
  )

  const clearHighlight = useCallback(() => {
    setHighlightState(null)
    setPopupEdge(null)
  }, [])

  // Sync state when switching boards or when hydration completes
  const prevBoardIdRef = useRef(currentBoard.id)
  const prevHydratingRef = useRef(hydrating)
  useEffect(() => {
    const boardChanged = currentBoard.id !== prevBoardIdRef.current
    const hydrationJustFinished =
      prevHydratingRef.current && !hydrating

    if (boardChanged || hydrationJustFinished) {
      setNodes(
        currentBoard.nodes.map((n) => ({
          id: n.id,
          type: n.type,
          position: n.position,
          data: n.data,
        })),
      )
      setConnections(currentBoard.connections)
      if (boardChanged) {
        setHighlightState(null)
        setPopupEdge(null)
      }
      prevBoardIdRef.current = currentBoard.id
    }
    prevHydratingRef.current = hydrating
  }, [currentBoard.id, currentBoard.nodes, currentBoard.connections, hydrating])

  // Track session lifecycle
  useEffect(() => {
    trackEvent('session_started', { boardId: currentBoard.id })

    const handleEnd = () => {
      trackEvent('session_ended', { boardId: currentBoard.id })
    }
    window.addEventListener('beforeunload', handleEnd)

    return () => {
      window.removeEventListener('beforeunload', handleEnd)
    }
    // Only fire once on mount — board ID captured at load time
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Debounced auto-save (500ms) — skip while hydrating to avoid saving stripped data
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (hydrating) return

    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current)
    }
    saveTimeoutRef.current = setTimeout(() => {
      saveCurrentBoard(nodes, connections)
    }, 500)

    return () => {
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current)
      }
    }
  }, [nodes, connections, saveCurrentBoard, hydrating])

  const onNodesChange: OnNodesChange = useCallback(
    (changes) => setNodes((nds) => applyNodeChanges(changes, nds)),
    [],
  )

  // Track when the edge detail popup was opened (for duration_ms on close)
  const edgeOpenedAtRef = useRef<number | null>(null)

  const closeEdgeDetail = useCallback(() => {
    if (popupEdge && edgeOpenedAtRef.current) {
      const durationMs = Date.now() - edgeOpenedAtRef.current
      const conn = popupEdge.connection
      const edgeId = `weave-${conn.from.replace(/^node-/, '')}-${conn.to.replace(/^node-/, '')}`
      trackEvent('connection_description_closed', {
        targetId: edgeId,
        boardId: currentBoard.id,
        durationMs,
      })
    }
    edgeOpenedAtRef.current = null
    setPopupEdge(null)
    // If the highlight was from a connection label click, clear it too
    setHighlightState((prev) =>
      prev?.type === 'connection' ? null : prev,
    )
  }, [popupEdge, currentBoard.id])

  const onLabelClick = useCallback(
    (connection: Connection, position: { x: number; y: number }) => {
      edgeOpenedAtRef.current = Date.now()
      setPopupEdge({ connection, position })

      // Edge case: if label is already highlighted (node mode), keep node highlight
      const from = connection.from.replace(/^node-/, '')
      const to = connection.to.replace(/^node-/, '')
      setHighlightState((prev) => {
        if (
          prev?.type === 'node' &&
          (prev.nodeId === from || prev.nodeId === to)
        ) {
          // Label belongs to currently selected node — keep node highlight
          return prev
        }
        // Switch to connection highlight mode
        return { type: 'connection', connection, position }
      })

      // Derive edge ID from connection fields
      const edgeId = `weave-${from}-${to}`
      trackEvent('connection_label_clicked', {
        targetId: edgeId,
        boardId: currentBoard.id,
        metadata: {
          connection_type: connection.type,
          strength: connection.strength,
          surprise: connection.surprise,
          mode: connection.mode,
        },
      })
    },
    [currentBoard.id],
  )

  const handleSwitchBoard = useCallback(
    (boardId: string) => {
      saveCurrentBoard(nodes, connections)
      switchBoard(boardId)
      setActiveLayer('weave')
      trackEvent('board_switched', { boardId })
    },
    [nodes, connections, saveCurrentBoard, switchBoard],
  )

  const handleCreateBoard = useCallback(() => {
    saveCurrentBoard(nodes, connections)
    const newBoardId = createBoard()
    trackEvent('board_created', { boardId: newBoardId })
    return newBoardId
  }, [nodes, connections, saveCurrentBoard, createBoard])

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

        const nodeId = generateNodeId()
        setNodes((prev) => [
          ...prev,
          {
            id: nodeId,
            type: 'imageCard',
            position,
            data: { imageDataUrl, fileName: file.name, label: '' },
          },
        ])
        trackEvent('item_added', {
          targetId: `${currentBoard.id}:${nodeId}`,
          boardId: currentBoard.id,
          metadata: { node_type: 'imageCard' },
        })
        embedNodeAsync(currentBoard.id, nodeId, 'imageCard', {
          imageDataUrl,
          fileName: file.name,
          label: '',
        })
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

        const nodeId = generateNodeId()
        setNodes((prev) => [
          ...prev,
          {
            id: nodeId,
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
        trackEvent('item_added', {
          targetId: `${currentBoard.id}:${nodeId}`,
          boardId: currentBoard.id,
          metadata: { node_type: 'pdfCard' },
        })
        embedNodeAsync(currentBoard.id, nodeId, 'pdfCard', {
          thumbnailDataUrl,
          fileName: file.name,
          label: '',
          pageCount,
        })
        offset++
      }
    },
    [setNodes, currentBoard.id],
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
      trackEvent('item_added', {
        targetId: `${currentBoard.id}:${nodeId}`,
        boardId: currentBoard.id,
        metadata: { node_type: 'linkCard' },
      })

      // Fetch metadata and update the node
      const metadata = await fetchLinkMetadata(text)

      setNodes((prev) =>
        prev.map((node) =>
          node.id === nodeId
            ? { ...node, data: { ...metadata, loading: false } }
            : node,
        ),
      )

      if (metadata.type === 'twitter') {
        // Fetch tweet image async — don't block the card render
        fetchTweetImage(text).then((tweetImage) => {
          if (tweetImage.imageBase64 && tweetImage.imageMimeType) {
            setNodes((prev) =>
              prev.map((node) =>
                node.id === nodeId
                  ? {
                      ...node,
                      data: {
                        ...node.data,
                        imageBase64: tweetImage.imageBase64,
                        imageMimeType: tweetImage.imageMimeType,
                      },
                    }
                  : node,
              ),
            )
          }
        })

        // Delay embedding for tweets to allow image fetch to complete
        setTimeout(() => {
          setNodes((prev) => {
            const current = prev.find((n) => n.id === nodeId)
            if (current) {
              embedNodeAsync(currentBoard.id, nodeId, 'linkCard', {
                ...current.data,
                loading: false,
              })
            }
            return prev
          })
        }, 8000)
      } else {
        // Embed immediately for non-twitter linkCards
        embedNodeAsync(currentBoard.id, nodeId, 'linkCard', {
          ...metadata,
          loading: false,
        })
      }
    }

    document.addEventListener('paste', handlePaste)
    return () => document.removeEventListener('paste', handlePaste)
  }, [setNodes, currentBoard.id])

  return (
    <BoardIdContext.Provider value={currentBoard.id}>
    <div className="w-screen h-screen relative">
      {storageError && (
        <div className="absolute top-0 left-0 right-0 z-50 bg-amber-50 border-b border-amber-200 px-4 py-2 text-sm text-amber-800 flex items-center justify-between">
          <span>{storageError}</span>
          <button
            onClick={dismissStorageError}
            className="text-amber-600 hover:text-amber-800 ml-4 text-xs cursor-pointer"
            aria-label="Dismiss warning"
          >
            Dismiss
          </button>
        </div>
      )}
      <HighlightContext.Provider value={highlightState}>
      <EdgeLabelClickContext.Provider value={onLabelClick}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onInit={(instance) => {
          reactFlowRef.current = instance
        }}
        onDrop={onDrop}
        onDragOver={onDragOver}
        onNodeClick={handleNodeClick}
        onPaneClick={clearHighlight}
        fitView
        proOptions={{ hideAttribution: true }}
      >
        <Background />
        <Controls position="bottom-right" />
        <Panel position="top-center">
          <WeaveButton
            connections={connections}
            activeLayer={activeLayer}
            onLayerChange={setActiveLayer}
            onResult={(result, mode) => {
              clearHighlight()
              setConnections((prev) => [...prev, ...result.connections])
              setActiveLayer(mode)
            }}
            onClear={() => {
              clearHighlight()
              setConnections([])
              setActiveLayer('weave')
            }}
          />
        </Panel>
        <Panel position="top-left">
          <BoardSwitcher
            currentBoardId={currentBoard.id}
            currentBoardName={currentBoard.name}
            allBoards={allBoards}
            onCreateBoard={handleCreateBoard}
            onSwitchBoard={handleSwitchBoard}
            onRenameBoard={renameBoard}
            onDeleteBoard={deleteBoard}
          />
        </Panel>
        <Panel position="bottom-left">
          <AddNodeButton />
        </Panel>
        {nodes.length === 0 && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <p className="text-gray-400 text-lg font-light select-none">
              Drop content or click + to begin
            </p>
          </div>
        )}
      </ReactFlow>
      </EdgeLabelClickContext.Provider>
      </HighlightContext.Provider>
      {popupEdge && (
        <EdgeDetailPopup
          connection={popupEdge.connection}
          position={popupEdge.position}
          onClose={closeEdgeDetail}
        />
      )}
    </div>
    </BoardIdContext.Provider>
  )
}
