import { useState, useCallback, useRef, useEffect } from 'react'
import { useReactFlow } from '@xyflow/react'
import { generateNodeId } from '../utils/nodeId'
import { readFileAsDataUrl, isImageFile } from '../utils/imageUtils'
import { fetchLinkMetadata, isUrl, extractDomain } from '../utils/linkUtils'
import { isPdfFile, renderPdfThumbnail } from '../utils/pdfUtils'
import { trackEvent } from '../services/eventTracker'
import { useBoardId } from '../hooks/useBoardId'
import { embedNodeAsync } from '../services/embeddingService'
import { enrichLinkNode } from '../services/linkEnrichment'
import { buildProcessingLogAppender, createNodeLogger } from '../utils/logger'

export function AddNodeButton() {
  const { addNodes, screenToFlowPosition, updateNodeData, getNodes, setNodes } = useReactFlow()
  const boardId = useBoardId()
  const [menuOpen, setMenuOpen] = useState(false)
  const [linkInputMode, setLinkInputMode] = useState(false)
  const [linkUrl, setLinkUrl] = useState('')
  const [fetchingLink, setFetchingLink] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const pdfInputRef = useRef<HTMLInputElement>(null)
  const linkInputRef = useRef<HTMLInputElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  const closeMenu = useCallback(() => {
    setMenuOpen(false)
    setLinkInputMode(false)
    setLinkUrl('')
  }, [])

  useEffect(() => {
    if (!menuOpen) return
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        closeMenu()
      }
    }
    const handleClick = (e: MouseEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        closeMenu()
      }
    }
    document.addEventListener('keydown', handleEscape)
    // Capture phase: React Flow's pan handler stops mousedown propagation
    // for canvas clicks. Capture-phase listeners fire before any target
    // can call stopPropagation, so the click-outside check still runs.
    document.addEventListener('mousedown', handleClick, true)
    return () => {
      document.removeEventListener('keydown', handleEscape)
      document.removeEventListener('mousedown', handleClick, true)
    }
  }, [menuOpen, closeMenu])

  useEffect(() => {
    if (linkInputMode && linkInputRef.current) {
      linkInputRef.current.focus()
    }
  }, [linkInputMode])

  const getCenterPosition = useCallback(() => {
    return screenToFlowPosition({
      x: window.innerWidth / 2,
      y: window.innerHeight / 2,
    })
  }, [screenToFlowPosition])

  const handleAddText = useCallback(() => {
    const nodeId = generateNodeId()
    addNodes({
      id: nodeId,
      type: 'textCard',
      position: getCenterPosition(),
      data: { text: '' },
    })
    trackEvent('item_added', {
      targetId: `node:${boardId}:${nodeId}`,
      boardId,
      metadata: { node_type: 'textCard' },
    })
    setMenuOpen(false)
  }, [addNodes, getCenterPosition, boardId])

  const handleAddImage = useCallback(() => {
    fileInputRef.current?.click()
    setMenuOpen(false)
  }, [])

  const handleFileChange = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0]
      if (!file || !isImageFile(file)) return

      const imageDataUrl = await readFileAsDataUrl(file)
      const nodeId = generateNodeId()
      addNodes({
        id: nodeId,
        type: 'imageCard',
        position: getCenterPosition(),
        data: { imageDataUrl, fileName: file.name, label: '' },
      })
      trackEvent('item_added', {
        targetId: `node:${boardId}:${nodeId}`,
        boardId,
        metadata: { node_type: 'imageCard' },
      })
      const imageLogger = createNodeLogger(
        nodeId,
        boardId,
        buildProcessingLogAppender(nodeId, setNodes),
      )
      embedNodeAsync(
        boardId,
        nodeId,
        'imageCard',
        {
          imageDataUrl,
          fileName: file.name,
          label: '',
        },
        imageLogger,
      )

      e.target.value = ''
    },
    [addNodes, getCenterPosition, boardId, setNodes],
  )

  const handleAddPdf = useCallback(() => {
    pdfInputRef.current?.click()
    setMenuOpen(false)
  }, [])

  const handlePdfFileChange = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0]
      if (!file || !isPdfFile(file)) return

      const pdfDataUrl = await readFileAsDataUrl(file)
      const { thumbnailDataUrl, pageCount } =
        await renderPdfThumbnail(pdfDataUrl)

      const nodeId = generateNodeId()
      addNodes({
        id: nodeId,
        type: 'pdfCard',
        position: getCenterPosition(),
        data: {
          pdfDataUrl,
          fileName: file.name,
          label: '',
          thumbnailDataUrl,
          pageCount,
        },
      })
      trackEvent('item_added', {
        targetId: `node:${boardId}:${nodeId}`,
        boardId,
        metadata: { node_type: 'pdfCard' },
      })
      const pdfLogger = createNodeLogger(
        nodeId,
        boardId,
        buildProcessingLogAppender(nodeId, setNodes),
      )
      embedNodeAsync(
        boardId,
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

      e.target.value = ''
    },
    [addNodes, getCenterPosition, boardId, setNodes],
  )

  const handleLinkSubmit = useCallback(async () => {
    const trimmed = linkUrl.trim()
    if (!trimmed || fetchingLink) return

    const urlToFetch = isUrl(trimmed)
      ? trimmed
      : isUrl(`https://${trimmed}`)
        ? `https://${trimmed}`
        : null

    if (!urlToFetch) return

    setFetchingLink(true)

    // Create node immediately with loading state
    const nodeId = generateNodeId()
    const domain = extractDomain(urlToFetch)
    addNodes({
      id: nodeId,
      type: 'linkCard',
      position: getCenterPosition(),
      data: {
        url: urlToFetch,
        title: domain || urlToFetch,
        description: '',
        imageUrl: '',
        domain,
        type: 'generic',
        loading: true,
      },
    })
    trackEvent('item_added', {
      targetId: `node:${boardId}:${nodeId}`,
      boardId,
      metadata: { node_type: 'linkCard' },
    })

    // Close menu immediately
    setMenuOpen(false)
    setLinkInputMode(false)
    setLinkUrl('')

    // Fetch metadata and update node
    const metadata = await fetchLinkMetadata(urlToFetch)
    updateNodeData(nodeId, {
      ...metadata,
      loading: false,
    })

    const linkLogger = createNodeLogger(
      nodeId,
      boardId,
      buildProcessingLogAppender(nodeId, setNodes),
    )
    enrichLinkNode({
      boardId,
      nodeId,
      url: urlToFetch,
      metadata,
      patchNodeData: (patch) => updateNodeData(nodeId, patch),
      getCurrentNodeData: () =>
        getNodes().find((n) => n.id === nodeId)?.data as
          | Record<string, unknown>
          | undefined,
      logger: linkLogger,
    })

    setFetchingLink(false)
  }, [linkUrl, fetchingLink, addNodes, getCenterPosition, updateNodeData, getNodes, setNodes, boardId])

  const handleLinkKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') {
        handleLinkSubmit()
      }
      if (e.key === 'Escape') {
        setMenuOpen(false)
        setLinkInputMode(false)
        setLinkUrl('')
      }
      e.stopPropagation()
    },
    [handleLinkSubmit],
  )

  return (
    <div
      ref={containerRef}
      style={{
        position: 'absolute',
        bottom: 24,
        left: 24,
        zIndex: 20,
      }}
    >
      {menuOpen && (
        <div
          className="absolute"
          style={{
            bottom: 'calc(100% + 8px)',
            left: 0,
            zIndex: 50,
            background: 'var(--w-card)',
            borderRadius: 'var(--w-radius-md)',
            border: '1px solid var(--w-line)',
            boxShadow: 'var(--w-shadow-float)',
            padding: 6,
            minWidth: 160,
          }}
        >
          {linkInputMode ? (
            <div style={{ padding: '6px 10px', minWidth: 220 }}>
              <input
                ref={linkInputRef}
                type="url"
                value={linkUrl}
                onChange={(e) => setLinkUrl(e.target.value)}
                onKeyDown={handleLinkKeyDown}
                onBlur={() => {
                  if (!fetchingLink) closeMenu()
                }}
                placeholder="Paste a URL..."
                disabled={fetchingLink}
                className="w-full outline-none"
                style={{
                  fontFamily: 'var(--w-font-sans)',
                  fontSize: 13,
                  color: 'var(--w-ink)',
                  background: 'transparent',
                  border: 'none',
                }}
                aria-label="URL for link card"
              />
              {fetchingLink && (
                <p
                  style={{
                    marginTop: 4,
                    fontSize: 11,
                    fontFamily: 'var(--w-font-mono)',
                    color: 'var(--w-ink-faint)',
                  }}
                >
                  Fetching...
                </p>
              )}
            </div>
          ) : (
            <>
              <button
                onClick={handleAddText}
                className="w-full text-left cursor-pointer transition-colors duration-150"
                style={{
                  padding: '8px 10px',
                  fontSize: 13,
                  fontFamily: 'var(--w-font-sans)',
                  color: 'var(--w-ink)',
                  background: 'transparent',
                  border: 'none',
                  borderRadius: 'var(--w-radius-sm)',
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = 'var(--w-paper-dim)'
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = 'transparent'
                }}
              >
                Text Card
              </button>
              <button
                onClick={handleAddImage}
                className="w-full text-left cursor-pointer transition-colors duration-150"
                style={{
                  padding: '8px 10px',
                  fontSize: 13,
                  fontFamily: 'var(--w-font-sans)',
                  color: 'var(--w-ink)',
                  background: 'transparent',
                  border: 'none',
                  borderRadius: 'var(--w-radius-sm)',
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = 'var(--w-paper-dim)'
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = 'transparent'
                }}
              >
                Image Card
              </button>
              <button
                onClick={() => setLinkInputMode(true)}
                className="w-full text-left cursor-pointer transition-colors duration-150"
                style={{
                  padding: '8px 10px',
                  fontSize: 13,
                  fontFamily: 'var(--w-font-sans)',
                  color: 'var(--w-ink)',
                  background: 'transparent',
                  border: 'none',
                  borderRadius: 'var(--w-radius-sm)',
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = 'var(--w-paper-dim)'
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = 'transparent'
                }}
              >
                Link Card
              </button>
              <button
                onClick={handleAddPdf}
                className="w-full text-left cursor-pointer transition-colors duration-150"
                style={{
                  padding: '8px 10px',
                  fontSize: 13,
                  fontFamily: 'var(--w-font-sans)',
                  color: 'var(--w-ink)',
                  background: 'transparent',
                  border: 'none',
                  borderRadius: 'var(--w-radius-sm)',
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = 'var(--w-paper-dim)'
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = 'transparent'
                }}
              >
                PDF Card
              </button>
            </>
          )}
        </div>
      )}
      <button
        onClick={() => setMenuOpen(!menuOpen)}
        className="flex items-center justify-center cursor-pointer transition-transform duration-150 hover:scale-105 active:scale-95"
        style={{
          width: 44,
          height: 44,
          borderRadius: '50%',
          background: 'var(--w-standard-bg-soft)',
          color: 'var(--w-standard-accent)',
          fontSize: 20,
          fontWeight: 600,
          fontFamily: 'var(--w-font-sans)',
          lineHeight: 1,
          border: '1px solid var(--w-line)',
          boxShadow: 'var(--w-shadow-lift)',
          padding: 0,
        }}
        aria-label="Add new card"
        aria-expanded={menuOpen}
        aria-haspopup="true"
      >
        +
      </button>
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        onChange={handleFileChange}
        className="hidden"
        aria-hidden="true"
      />
      <input
        ref={pdfInputRef}
        type="file"
        accept=".pdf,application/pdf"
        onChange={handlePdfFileChange}
        className="hidden"
        aria-hidden="true"
      />
    </div>
  )
}
