import { useState, useCallback, useRef, useEffect } from 'react'
import { Handle, Position, type NodeProps, useReactFlow } from '@xyflow/react'

export type TextCardData = {
  text: string
}

function autoResize(textarea: HTMLTextAreaElement) {
  textarea.style.height = 'auto'
  textarea.style.height = `${textarea.scrollHeight}px`
}

export function TextCardNode({ id, data }: NodeProps) {
  const { text } = data as TextCardData
  const [editing, setEditing] = useState(!text)
  const [value, setValue] = useState(text)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const { updateNodeData } = useReactFlow()

  useEffect(() => {
    if (editing && textareaRef.current) {
      textareaRef.current.focus()
      autoResize(textareaRef.current)
    }
  }, [editing])

  const handleChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setValue(e.target.value)
    autoResize(e.target)
  }, [])

  const finishEditing = useCallback(() => {
    setEditing(false)
    updateNodeData(id, { text: value })
  }, [id, value, updateNodeData])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') {
        finishEditing()
      }
      e.stopPropagation()
    },
    [finishEditing],
  )

  return (
    <div className="rounded-lg border border-gray-200 bg-white px-4 py-3 shadow-sm w-[280px]">
      {editing ? (
        <textarea
          ref={textareaRef}
          value={value}
          onChange={handleChange}
          onBlur={finishEditing}
          onKeyDown={handleKeyDown}
          className="nodrag nowheel nopan text-sm text-gray-800 leading-relaxed w-full resize-none bg-transparent min-h-[60px] outline-none overflow-hidden"
          placeholder="Type something..."
        />
      ) : (
        <p
          className="text-sm text-gray-800 leading-relaxed cursor-text whitespace-pre-wrap break-words"
          onDoubleClick={() => {
            setValue(text)
            setEditing(true)
          }}
        >
          {text || 'Double-click to edit...'}
        </p>
      )}
      <Handle type="source" position={Position.Right} className="!bg-gray-400" />
      <Handle type="target" position={Position.Left} className="!bg-gray-400" />
    </div>
  )
}
