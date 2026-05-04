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
import { trackEvent } from '../services/eventTracker'
import { useBoardId } from '../hooks/useBoardId'
import { useCancelNodeSelect } from '../hooks/useCancelNodeSelect'

export type ImageCardData = {
  imageDataUrl: string
  fileName: string
  label: string
}

const CARD_WIDTH = 250
const IMAGE_HEIGHT = 200

const HANDLE_STYLE: CSSProperties = {
  background: 'var(--w-ink-faint)',
  border: 'none',
  width: 6,
  height: 6,
}

const CARD_BASE: CSSProperties = {
  width: CARD_WIDTH,
  background: 'var(--w-card)',
  borderRadius: 'var(--w-radius-lg)',
  boxShadow: 'var(--w-shadow-card)',
  border: '1px solid var(--w-line)',
  overflow: 'hidden',
  fontFamily: 'var(--w-font-sans)',
  color: 'var(--w-ink)',
  userSelect: 'none',
}

function stripExtension(fileName: string): string {
  const lastDot = fileName.lastIndexOf('.')
  return lastDot > 0 ? fileName.substring(0, lastDot) : fileName
}

function ImageLightbox({
  imageDataUrl,
  fileName,
  onClose,
}: {
  imageDataUrl: string
  fileName: string
  onClose: () => void
}) {
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 cursor-pointer"
      onClick={(e) => {
        e.stopPropagation()
        onClose()
      }}
      role="dialog"
      aria-modal="true"
      aria-label={`Full view of ${fileName}`}
    >
      <img
        src={imageDataUrl}
        alt={fileName}
        className="max-w-[90vw] max-h-[90vh] object-contain rounded-lg shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      />
    </div>,
    document.body,
  )
}

export function ImageCardNode({ id, data }: NodeProps) {
  const { imageDataUrl, fileName, label } = data as ImageCardData
  const [showLightbox, setShowLightbox] = useState(false)
  const defaultLabel = stripExtension(fileName)
  const [editingLabel, setEditingLabel] = useState(!label)
  const [labelValue, setLabelValue] = useState(label || defaultLabel)
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
        metadata: { node_type: 'imageCard' },
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
        metadata: { node_type: 'imageCard' },
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
  const hasLabel = displayLabel.trim().length > 0

  return (
    <>
      <div style={CARD_BASE} className={highlightClass || undefined}>
        {imageDataUrl ? (
          <img
            src={imageDataUrl}
            alt={displayLabel}
            draggable={false}
            onDoubleClick={openLightbox}
            style={{
              display: 'block',
              width: CARD_WIDTH,
              height: IMAGE_HEIGHT,
              objectFit: 'cover',
              cursor: 'pointer',
            }}
          />
        ) : (
          <div
            className="w-stripe-placeholder"
            style={{
              position: 'relative',
              width: CARD_WIDTH,
              height: IMAGE_HEIGHT,
            }}
          >
            <span
              style={{
                position: 'absolute',
                top: '50%',
                left: '50%',
                transform: 'translate(-50%, -50%)',
                fontFamily: 'var(--w-font-mono)',
                fontSize: 10,
                color: 'rgba(60, 50, 30, 0.5)',
                background: 'rgba(255, 255, 255, 0.7)',
                padding: '3px 8px',
                borderRadius: 4,
                letterSpacing: 0.4,
              }}
            >
              image
            </span>
          </div>
        )}

        {(editingLabel || hasLabel) && (
          <div
            className="flex items-center"
            style={{
              gap: 8,
              padding: '10px 14px',
              fontSize: 11,
              color: 'var(--w-ink-soft)',
            }}
          >
            <span
              style={{
                fontFamily: 'var(--w-font-mono)',
                fontSize: 10,
                fontWeight: 600,
                letterSpacing: 0.6,
                color: 'var(--w-ink-soft)',
                textTransform: 'uppercase',
                flexShrink: 0,
              }}
            >
              IMG
            </span>
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
                  flex: 1,
                  minWidth: 0,
                  background: 'transparent',
                  border: 'none',
                  outline: 'none',
                  fontFamily: 'var(--w-font-sans)',
                  fontSize: 11,
                  fontStyle: 'italic',
                  color: 'var(--w-ink-soft)',
                }}
                placeholder={defaultLabel}
              />
            ) : (
              <p
                onDoubleClick={() => {
                  setLabelValue(displayLabel)
                  setEditingLabel(true)
                }}
                style={{
                  margin: 0,
                  flex: 1,
                  minWidth: 0,
                  fontFamily: 'var(--w-font-sans)',
                  fontSize: 11,
                  fontStyle: 'italic',
                  color: 'var(--w-ink-soft)',
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  cursor: 'text',
                }}
              >
                {displayLabel}
              </p>
            )}
          </div>
        )}

        <Handle type="source" position={Position.Right} style={HANDLE_STYLE} />
        <Handle type="target" position={Position.Left} style={HANDLE_STYLE} />
      </div>
      {showLightbox && (
        <ImageLightbox
          imageDataUrl={imageDataUrl}
          fileName={fileName}
          onClose={closeLightbox}
        />
      )}
    </>
  )
}
