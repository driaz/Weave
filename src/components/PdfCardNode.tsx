import { useState, useCallback, useEffect, useRef } from 'react'
import { Handle, Position, type NodeProps, useReactFlow } from '@xyflow/react'
import { useNodeHighlight } from '../hooks/useNodeHighlight'
import { createPortal } from 'react-dom'
import { renderPdfPage } from '../utils/pdfUtils'

export type PdfCardData = {
  pdfDataUrl: string
  fileName: string
  label: string
  thumbnailDataUrl: string
  pageCount: number
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
      onClick={onClose}
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
              onClick={() =>
                setCurrentPage((p) => Math.min(pageCount, p + 1))
              }
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

export function PdfCardNode({ id, data }: NodeProps) {
  const { pdfDataUrl, fileName, label, thumbnailDataUrl, pageCount } =
    data as PdfCardData
  const defaultLabel = stripExtension(fileName)
  const [editingLabel, setEditingLabel] = useState(!label)
  const [labelValue, setLabelValue] = useState(label || defaultLabel)
  const [showLightbox, setShowLightbox] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const { updateNodeData } = useReactFlow()
  const highlighted = useNodeHighlight(id)

  const openLightbox = useCallback(() => setShowLightbox(true), [])
  const closeLightbox = useCallback(() => setShowLightbox(false), [])

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

  const pageLabel =
    pageCount === 1 ? '1 page' : pageCount > 0 ? `${pageCount} pages` : ''

  return (
    <>
      <div
        className={`rounded-lg border border-gray-200 bg-white shadow-sm overflow-hidden${highlighted ? ' node-highlight' : ''}`}
        aria-label={`PDF: ${label || defaultLabel}`}
      >
        {thumbnailDataUrl ? (
          <img
            src={thumbnailDataUrl}
            alt={label || defaultLabel}
            draggable={false}
            onDoubleClick={openLightbox}
            className="w-[250px] h-[180px] object-cover object-top cursor-pointer"
          />
        ) : (
          <div
            className="w-[250px] h-[180px] bg-gray-50 flex items-center justify-center cursor-pointer"
            onDoubleClick={openLightbox}
          >
            <svg
              width="40"
              height="48"
              viewBox="0 0 40 48"
              fill="none"
              aria-hidden="true"
            >
              <rect
                x="0.5"
                y="0.5"
                width="39"
                height="47"
                rx="3"
                fill="white"
                stroke="#D1D5DB"
              />
              <text
                x="20"
                y="30"
                textAnchor="middle"
                fontSize="12"
                fontWeight="600"
                fill="#9CA3AF"
              >
                PDF
              </text>
            </svg>
          </div>
        )}
        <div className="px-3 py-2">
          {editingLabel ? (
            <input
              ref={inputRef}
              type="text"
              value={labelValue}
              onChange={(e) => setLabelValue(e.target.value)}
              onBlur={finishLabelEdit}
              onKeyDown={handleLabelKeyDown}
              className="nodrag nowheel nopan w-full text-xs text-gray-500 bg-transparent outline-none"
              placeholder={defaultLabel}
            />
          ) : (
            <p
              className="text-xs text-gray-500 truncate cursor-text"
              onDoubleClick={(e) => {
                e.stopPropagation()
                setLabelValue(label || defaultLabel)
                setEditingLabel(true)
              }}
            >
              {label || defaultLabel}
            </p>
          )}
          {pageLabel && (
            <p className="text-xs text-gray-400 mt-0.5">{pageLabel}</p>
          )}
        </div>
        <Handle
          type="source"
          position={Position.Right}
          className="!bg-gray-400"
        />
        <Handle
          type="target"
          position={Position.Left}
          className="!bg-gray-400"
        />
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
