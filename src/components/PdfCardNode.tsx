import {
  useState,
  useCallback,
  useEffect,
  useRef,
  type CSSProperties,
} from 'react'
import { Handle, Position, type NodeProps, useReactFlow } from '@xyflow/react'
import { useNodeHighlightStatus } from '../hooks/useSelectedNode'
import { createPortal } from 'react-dom'
import { renderPdfPage } from '../utils/pdfUtils'
import { trackEvent } from '../services/eventTracker'
import { useBoardId } from '../hooks/useBoardId'
import { useCancelNodeSelect } from '../hooks/useCancelNodeSelect'

export type PdfCardData = {
  pdfDataUrl: string
  fileName: string
  label: string
  thumbnailDataUrl: string
  pageCount: number
}

const CARD_WIDTH = 280
const PREVIEW_WIDTH = 72
const LINE_WIDTHS = ['80%', '95%', '95%', '65%', '95%', '95%', '65%', '95%']

const HANDLE_STYLE: CSSProperties = {
  background: 'var(--w-ink-faint)',
  border: 'none',
  width: 6,
  height: 6,
}

function stripExtension(fileName: string): string {
  const lastDot = fileName.lastIndexOf('.')
  return lastDot > 0 ? fileName.substring(0, lastDot) : fileName
}

function PdfLightbox({
  pdfDataUrl,
  fileName,
  pageCount,
  onClose,
}: {
  pdfDataUrl: string
  fileName: string
  pageCount: number
  onClose: () => void
}) {
  const [currentPage, setCurrentPage] = useState(1)
  const [pageImageUrl, setPageImageUrl] = useState('')
  const [renderedPage, setRenderedPage] = useState(0)

  const loading = renderedPage !== currentPage

  useEffect(() => {
    let cancelled = false

    renderPdfPage(pdfDataUrl, currentPage, 800).then((url) => {
      if (!cancelled) {
        setPageImageUrl(url)
        setRenderedPage(currentPage)
      }
    })

    return () => {
      cancelled = true
    }
  }, [pdfDataUrl, currentPage])

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
      if (e.key === 'ArrowLeft' && currentPage > 1) {
        setCurrentPage((p) => p - 1)
      }
      if (e.key === 'ArrowRight' && currentPage < pageCount) {
        setCurrentPage((p) => p + 1)
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [onClose, currentPage, pageCount])

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-black/70"
      onClick={(e) => {
        e.stopPropagation()
        onClose()
      }}
      role="dialog"
      aria-modal="true"
      aria-label={`PDF preview: ${fileName}`}
    >
      <div
        className="relative flex flex-col items-center"
        onClick={(e) => e.stopPropagation()}
      >
        {loading ? (
          <div className="w-[600px] h-[400px] flex items-center justify-center">
            <div className="shimmer w-full h-full rounded-lg" />
          </div>
        ) : (
          <img
            src={pageImageUrl}
            alt={`${fileName} page ${currentPage}`}
            className="max-w-[90vw] max-h-[80vh] object-contain rounded-lg shadow-2xl"
          />
        )}

        {pageCount > 1 && (
          <div className="flex items-center gap-4 mt-4">
            <button
              onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
              disabled={currentPage <= 1}
              className="px-3 py-1.5 text-sm text-white bg-white/20 rounded-md hover:bg-white/30 disabled:opacity-30 disabled:cursor-default cursor-pointer transition-colors"
              aria-label="Previous page"
            >
              Previous
            </button>
            <span className="text-sm text-white/80">
              {currentPage} / {pageCount}
            </span>
            <button
              onClick={() => setCurrentPage((p) => Math.min(pageCount, p + 1))}
              disabled={currentPage >= pageCount}
              className="px-3 py-1.5 text-sm text-white bg-white/20 rounded-md hover:bg-white/30 disabled:opacity-30 disabled:cursor-default cursor-pointer transition-colors"
              aria-label="Next page"
            >
              Next
            </button>
          </div>
        )}
      </div>
    </div>,
    document.body,
  )
}

function PaperPreview() {
  return (
    <div
      aria-hidden="true"
      className="flex flex-col"
      style={{
        width: PREVIEW_WIDTH,
        background: '#faf6ec',
        borderRight: '1px solid var(--w-line)',
        padding: '12px 8px',
        gap: 5,
        flexShrink: 0,
      }}
    >
      {LINE_WIDTHS.map((w, i) => (
        <span
          key={i}
          style={{
            display: 'block',
            width: w,
            height: 3,
            borderRadius: 1,
            background: 'rgba(42, 37, 33, 0.12)',
          }}
        />
      ))}
    </div>
  )
}

export function PdfCardNode({ id, data }: NodeProps) {
  const { pdfDataUrl, fileName, label, pageCount } = data as PdfCardData
  const defaultLabel = stripExtension(fileName)
  const [editingLabel, setEditingLabel] = useState(!label)
  const [labelValue, setLabelValue] = useState(label || defaultLabel)
  const [showLightbox, setShowLightbox] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const lightboxOpenedAtRef = useRef<number | null>(null)
  const { updateNodeData } = useReactFlow()
  const { isSelected, isConnected } = useNodeHighlightStatus(id)
  const boardId = useBoardId()
  const cancelPendingNodeSelect = useCancelNodeSelect()

  const openLightbox = useCallback(() => {
    cancelPendingNodeSelect()
    setShowLightbox(true)
    lightboxOpenedAtRef.current = performance.now()
    if (boardId) {
      trackEvent('lightbox_opened', {
        targetId: `node:${boardId}:${id}`,
        boardId,
        metadata: { node_type: 'pdfCard' },
      })
    }
  }, [boardId, id, cancelPendingNodeSelect])

  const closeLightbox = useCallback(() => {
    setShowLightbox(false)
    const openedAt = lightboxOpenedAtRef.current
    lightboxOpenedAtRef.current = null
    if (boardId && openedAt !== null) {
      trackEvent('lightbox_closed', {
        targetId: `node:${boardId}:${id}`,
        boardId,
        durationMs: Math.round(performance.now() - openedAt),
        metadata: { node_type: 'pdfCard' },
      })
    }
  }, [boardId, id])

  useEffect(() => {
    if (editingLabel && inputRef.current) {
      inputRef.current.focus()
      inputRef.current.select()
    }
  }, [editingLabel])

  const finishLabelEdit = useCallback(() => {
    setEditingLabel(false)
    updateNodeData(id, { label: labelValue || defaultLabel })
  }, [id, labelValue, defaultLabel, updateNodeData])

  const handleLabelKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape' || e.key === 'Enter') {
        finishLabelEdit()
      }
      e.stopPropagation()
    },
    [finishLabelEdit],
  )

  const highlightClass = `${isConnected ? ' node-highlight' : ''}${isSelected ? ' selected-node-highlight' : ''}`.trim()
  const displayLabel = label || defaultLabel
  const pagesText = pageCount > 0 ? `PDF · ${pageCount} ${pageCount === 1 ? 'page' : 'pages'}` : 'PDF'

  return (
    <>
      <div
        className={`flex ${highlightClass}`.trim() || undefined}
        onDoubleClick={openLightbox}
        style={{
          width: CARD_WIDTH,
          background: 'var(--w-card)',
          borderRadius: 'var(--w-radius-lg)',
          boxShadow: 'var(--w-shadow-card)',
          border: '1px solid var(--w-line)',
          overflow: 'hidden',
          fontFamily: 'var(--w-font-sans)',
          color: 'var(--w-ink)',
          userSelect: 'none',
          cursor: 'pointer',
        }}
        aria-label={`PDF: ${displayLabel}`}
      >
        <PaperPreview />

        <div
          className="flex-1 flex flex-col"
          style={{ padding: '14px 14px 10px', minWidth: 0 }}
        >
          {editingLabel ? (
            <input
              ref={inputRef}
              type="text"
              value={labelValue}
              onChange={(e) => setLabelValue(e.target.value)}
              onBlur={finishLabelEdit}
              onKeyDown={handleLabelKeyDown}
              className="nodrag nowheel nopan"
              style={{
                width: '100%',
                background: 'transparent',
                border: 'none',
                outline: 'none',
                fontFamily: 'var(--w-font-display)',
                fontSize: 13,
                fontWeight: 500,
                lineHeight: 1.3,
                color: 'var(--w-ink)',
                marginBottom: 6,
              }}
              placeholder={defaultLabel}
            />
          ) : (
            <p
              onDoubleClick={(e) => {
                e.stopPropagation()
                setLabelValue(displayLabel)
                setEditingLabel(true)
              }}
              style={{
                margin: 0,
                marginBottom: 6,
                fontFamily: 'var(--w-font-display)',
                fontSize: 13,
                fontWeight: 500,
                lineHeight: 1.3,
                color: 'var(--w-ink)',
                cursor: 'text',
                display: '-webkit-box',
                WebkitLineClamp: 3,
                WebkitBoxOrient: 'vertical',
                overflow: 'hidden',
              }}
            >
              {displayLabel}
            </p>
          )}

          <p
            style={{
              margin: 0,
              fontFamily: 'var(--w-font-mono)',
              fontSize: 10,
              color: 'var(--w-ink-faint)',
              letterSpacing: 0.4,
            }}
          >
            {pagesText}
          </p>
        </div>

        <Handle type="source" position={Position.Right} style={HANDLE_STYLE} />
        <Handle type="target" position={Position.Left} style={HANDLE_STYLE} />
      </div>
      {showLightbox && (
        <PdfLightbox
          pdfDataUrl={pdfDataUrl}
          fileName={fileName}
          pageCount={pageCount}
          onClose={closeLightbox}
        />
      )}
    </>
  )
}
