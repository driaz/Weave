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
import { ReflectView } from './components/ReflectView'
import { UserMenu } from './components/UserMenu'
import { HydrationSourceIndicator } from './components/HydrationSourceIndicator'
import { DevEnvBadge } from './components/DevEnvBadge'
import { CanvasSkeleton } from './components/CanvasSkeleton'
import { SaveErrorToast } from './components/SaveErrorToast'
import { useStaggeredEdges } from './hooks/useStaggeredEdges'
import { useBoardStorage } from './hooks/useBoardStorage'
import type { Connection } from './api/claude'
import type { WeaveMode } from './types/board'
import { generateNodeId } from './utils/nodeId'
import { readFileAsDataUrl, isImageFile } from './utils/imageUtils'
import { isUrl, fetchLinkMetadata, extractDomain } from './utils/linkUtils'
import { isPdfFile, renderPdfThumbnail } from './utils/pdfUtils'
import { HighlightContext, type HighlightState } from './hooks/useSelectedNode'
import { trackEvent } from './services/eventTracker'
import { BoardIdContext } from './hooks/useBoardId'
import { CancelNodeSelectContext } from './hooks/useCancelNodeSelect'
import { embedNodeAsync } from './services/embeddingService'
import { enrichLinkNode } from './services/linkEnrichment'
import { supabase } from './services/supabaseClient'
import { buildProcessingLogAppender, createNodeLogger } from './utils/logger'

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
    hydrationError,
    createBoard,
    switchBoard,
    renameBoard,
    deleteBoard,
    saveCurrentBoard,
    markBoardClean,
    queueSideEffect,
    saveError,
    dismissSaveError,
    rollbackSignal,
    hydrationRevision,
  } = useBoardStorage()

  const [view, setView] = useState<'canvas' | 'reflect'>('canvas')

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

  // Defer node_selected emission so double-clicks (which fire two
  // single clicks before dblclick) can cancel it when a lightbox
  // opens. Lightbox open handlers call cancelPendingNodeSelect.
  const nodeSelectTimeoutRef = useRef<number | null>(null)

  const cancelPendingNodeSelect = useCallback(() => {
    if (nodeSelectTimeoutRef.current !== null) {
      window.clearTimeout(nodeSelectTimeoutRef.current)
      nodeSelectTimeoutRef.current = null
    }
  }, [])

  const handleNodeClick = useCallback(
    (_: React.MouseEvent, node: Node) => {
      setHighlightState((prev) =>
        prev?.type === 'node' && prev.nodeId === node.id
          ? null
          : { type: 'node', nodeId: node.id },
      )
      cancelPendingNodeSelect()
      const boardId = currentBoard.id
      const nodeId = node.id
      nodeSelectTimeoutRef.current = window.setTimeout(() => {
        nodeSelectTimeoutRef.current = null
        trackEvent('node_selected', {
          targetId: `node:${boardId}:${nodeId}`,
          boardId,
        })
      }, 500)
    },
    [currentBoard.id, cancelPendingNodeSelect],
  )

  useEffect(() => {
    return () => {
      if (nodeSelectTimeoutRef.current !== null) {
        window.clearTimeout(nodeSelectTimeoutRef.current)
      }
    }
  }, [])

  const clearHighlight = useCallback(() => {
    setHighlightState(null)
    setPopupEdge(null)
  }, [])

  // Sync state when switching boards, when hydration completes, after a
  // save rollback (Supabase write failed → revert React state to the
  // last-synced snapshot the hook still has in `currentBoard`), or when
  // background revalidation produces a different store than the cache
  // seeded (e.g. image nodes the cache couldn't fit under quota).
  const prevBoardIdRef = useRef(currentBoard.id)
  const prevHydratingRef = useRef(hydrating)
  const prevRollbackRef = useRef(rollbackSignal)
  const prevHydrationRevRef = useRef(hydrationRevision)
  useEffect(() => {
    const boardChanged = currentBoard.id !== prevBoardIdRef.current
    const hydrationJustFinished =
      prevHydratingRef.current && !hydrating
    const rolledBack = rollbackSignal !== prevRollbackRef.current
    const revalidated = hydrationRevision !== prevHydrationRevRef.current

    if (boardChanged || hydrationJustFinished || rolledBack || revalidated) {
      const freshNodes = currentBoard.nodes.map((n) => ({
        id: n.id,
        type: n.type,
        position: n.position,
        data: n.data,
      }))
      setNodes(freshNodes)
      setConnections(currentBoard.connections)
      markBoardClean(currentBoard.id, freshNodes, currentBoard.connections)
      if (boardChanged) {
        setHighlightState(null)
        setPopupEdge(null)
      }
      prevBoardIdRef.current = currentBoard.id
    }
    prevHydratingRef.current = hydrating
    prevRollbackRef.current = rollbackSignal
    prevHydrationRevRef.current = hydrationRevision
  }, [
    currentBoard.id,
    currentBoard.nodes,
    currentBoard.connections,
    hydrating,
    rollbackSignal,
    hydrationRevision,
    markBoardClean,
  ])

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

  // Intentional delete: confirmation → local state cleanup → queue an
  // embedding archive to fire AFTER the next successful Supabase save
  // for this board. If the save rolls back (node reappears on canvas),
  // the archive side-effect is dropped and the embedding stays active.
  const deleteNode = useCallback(
    (nodeId: string) => {
      const confirmed = window.confirm(
        'Delete this node? This will remove it from the canvas and archive its data.',
      )
      if (!confirmed) return

      setNodes((prev) => prev.filter((n) => n.id !== nodeId))
      setConnections((prev) =>
        prev.filter((c) => c.from !== nodeId && c.to !== nodeId),
      )

      const boardId = currentBoard.id
      queueSideEffect(boardId, async () => {
        if (!supabase) return
        const { error } = await supabase
          .from('weave_embeddings')
          .update({ archived_at: new Date().toISOString() })
          .eq('board_id', boardId)
          .eq('node_id', nodeId)
        if (error) {
          console.warn(
            '[Weave] Failed to archive embedding for deleted node:',
            error.message,
          )
        }
      })

      trackEvent('item_deleted', {
        targetId: `node:${boardId}:${nodeId}`,
        boardId,
      })
    },
    [currentBoard.id, queueSideEffect],
  )

  // Intercept React Flow's built-in Delete/Backspace removal so it routes
  // through the confirmation flow. Non-removal changes (position, selection)
  // pass through untouched.
  const onNodesChange: OnNodesChange = useCallback(
    (changes) => {
      const passthrough: typeof changes = []
      for (const change of changes) {
        if (change.type === 'remove') {
          deleteNode(change.id)
        } else {
          passthrough.push(change)
        }
      }
      if (passthrough.length > 0) {
        setNodes((nds) => applyNodeChanges(passthrough, nds))
      }
    },
    [deleteNode],
  )

  // Track when the edge detail popup was opened (for duration_ms on close)
  const edgeOpenedAtRef = useRef<number | null>(null)

  const closeEdgeDetail = useCallback(() => {
    if (popupEdge && edgeOpenedAtRef.current) {
      const durationMs = Date.now() - edgeOpenedAtRef.current
      const conn = popupEdge.connection
      const from = conn.from.replace(/^node-/, '')
      const to = conn.to.replace(/^node-/, '')
      trackEvent('connection_description_closed', {
        targetId: `connection:${currentBoard.id}:${from}:${to}`,
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

      trackEvent('connection_label_clicked', {
        targetId: `connection:${currentBoard.id}:${from}:${to}`,
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
      trackEvent('board_switched', { targetId: `board:${boardId}`, boardId })
    },
    [nodes, connections, saveCurrentBoard, switchBoard],
  )

  const handleCreateBoard = useCallback(() => {
    saveCurrentBoard(nodes, connections)
    const newBoardId = createBoard()
    trackEvent('board_created', { targetId: `board:${newBoardId}`, boardId: newBoardId })
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
          targetId: `node:${currentBoard.id}:${nodeId}`,
          boardId: currentBoard.id,
          metadata: { node_type: 'imageCard' },
        })
        const imageLogger = createNodeLogger(
          nodeId,
          currentBoard.id,
          buildProcessingLogAppender(nodeId, setNodes),
        )
        embedNodeAsync(
          currentBoard.id,
          nodeId,
          'imageCard',
          {
            imageDataUrl,
            fileName: file.name,
            label: '',
          },
          imageLogger,
        )
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
          targetId: `node:${currentBoard.id}:${nodeId}`,
          boardId: currentBoard.id,
          metadata: { node_type: 'pdfCard' },
        })
        const pdfLogger = createNodeLogger(
          nodeId,
          currentBoard.id,
          buildProcessingLogAppender(nodeId, setNodes),
        )
        embedNodeAsync(
          currentBoard.id,
          nodeId,
          'pdfCard',
          {
            thumbnailDataUrl,
            fileName: file.name,
            label: '',
            pageCount,
          },
          pdfLogger,
        )
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
        targetId: `node:${currentBoard.id}:${nodeId}`,
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

      const linkLogger = createNodeLogger(
        nodeId,
        currentBoard.id,
        buildProcessingLogAppender(nodeId, setNodes),
      )
      enrichLinkNode({
        boardId: currentBoard.id,
        nodeId,
        url: text,
        metadata,
        patchNodeData: (patch) => {
          setNodes((prev) =>
            prev.map((node) =>
              node.id === nodeId
                ? { ...node, data: { ...node.data, ...patch } }
                : node,
            ),
          )
        },
        getCurrentNodeData: () =>
          reactFlowRef.current?.getNodes().find((n) => n.id === nodeId)?.data as
            | Record<string, unknown>
            | undefined,
        logger: linkLogger,
      })
    }

    document.addEventListener('paste', handlePaste)
    return () => document.removeEventListener('paste', handlePaste)
  }, [setNodes, currentBoard.id])

  if (view === 'reflect') {
    return (
      <>
        <ReflectView onBack={(target) => {
          if (target) {
            handleSwitchBoard(target.boardId)
            setTimeout(() => {
              reactFlowRef.current?.fitView({
                nodes: [{ id: target.nodeId }],
                duration: 500,
                padding: 0.5,
              })
            }, 150)
          }
          setView('canvas')
        }} />
        <DevEnvBadge />
      </>
    )
  }

  if (hydrationError) {
    return (
      <div className="w-screen h-screen flex items-center justify-center bg-gray-50">
        <div className="max-w-md text-center flex flex-col items-center gap-4">
          <h2 className="text-lg text-gray-700">Can't load your canvas</h2>
          <p className="text-sm text-gray-500">{hydrationError}</p>
          <button
            onClick={() => window.location.reload()}
            className="px-3 py-1.5 text-sm text-gray-600 bg-white border border-gray-200
              rounded-md hover:text-gray-800 hover:border-gray-300 shadow-sm cursor-pointer"
          >
            Retry
          </button>
        </div>
        <DevEnvBadge />
      </div>
    )
  }

  if (hydrating) {
    return (
      <>
        <CanvasSkeleton />
        <DevEnvBadge />
      </>
    )
  }

  return (
    <BoardIdContext.Provider value={currentBoard.id}>
    <CancelNodeSelectContext.Provider value={cancelPendingNodeSelect}>
    <div className="w-screen h-screen relative">
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
              // Normalise ids at ingest: Claude sometimes emits
              // `node-N` (self-propagating once it lands in the
              // existing-connection context). Strip the prefix so
              // state, localStorage, edge jsonb, and context loopback
              // are all uniformly bare. Breaks the format lottery.
              const normalised = result.connections.map((c) => ({
                ...c,
                from: c.from.replace(/^node-/, ''),
                to: c.to.replace(/^node-/, ''),
              }))
              setConnections((prev) => [...prev, ...normalised])
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
        <Panel position="top-right">
          <div className="flex items-center gap-2">
            <button
              onClick={() => setView('reflect')}
              className="px-3 py-1.5 text-xs text-gray-500 bg-white/90 border border-gray-200 rounded-md hover:text-gray-700 hover:border-gray-300 shadow-sm cursor-pointer"
            >
              Reflect
            </button>
            <UserMenu />
          </div>
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
      <HydrationSourceIndicator />
      <DevEnvBadge />
      {saveError && (
        <SaveErrorToast message={saveError} onDismiss={dismissSaveError} />
      )}
    </div>
    </CancelNodeSelectContext.Provider>
    </BoardIdContext.Provider>
  )
}
