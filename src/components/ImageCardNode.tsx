import { useState, useCallback, useEffect, useRef } from 'react'
import { Handle, Position, type NodeProps, useReactFlow } from '@xyflow/react'
import { useNodeHighlight } from '../hooks/useNodeHighlight'
import { createPortal } from 'react-dom'

export type ImageCardData = {
  imageDataUrl: string
  fileName: string
  label: string
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
      onClick={onClose}
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

  return (
    <>
      <div
        className={`rounded-lg border border-gray-200 bg-white shadow-sm overflow-hidden${highlighted ? ' node-highlight' : ''}`}
      >
        <img
          src={imageDataUrl}
          alt={label || defaultLabel}
          draggable={false}
          onDoubleClick={openLightbox}
          className="w-[250px] h-[200px] object-cover cursor-pointer"
        />
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
              onDoubleClick={() => {
                setLabelValue(label || defaultLabel)
                setEditingLabel(true)
              }}
            >
              {label || defaultLabel}
            </p>
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
        <ImageLightbox
          imageDataUrl={imageDataUrl}
          fileName={fileName}
          onClose={closeLightbox}
        />
      )}
    </>
  )
}
