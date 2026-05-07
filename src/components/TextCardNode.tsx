import {
  useState,
  useCallback,
  useRef,
  useEffect,
  useMemo,
  type CSSProperties,
} from 'react'
import { Handle, Position, type NodeProps, useReactFlow } from '@xyflow/react'
import { useNodeHighlightStatus } from '../hooks/useSelectedNode'
import { useBoardId } from '../hooks/useBoardId'
import { embedNodeAsync } from '../services/embeddingService'
import { buildProcessingLogAppender, createNodeLogger } from '../utils/logger'

export type TextCardData = {
  text: string
}

const CARD_WIDTH = 280

const HANDLE_STYLE: CSSProperties = {
  background: 'var(--w-ink-faint)',
  border: 'none',
  width: 6,
  height: 6,
}

const QUOTE_OPENERS = ['"', '"', '“', '«', '「', "'", '‘']
const QUOTE_CLOSERS_RX = /["'"'»」]/

function autoResize(textarea: HTMLTextAreaElement) {
  textarea.style.height = 'auto'
  textarea.style.height = `${textarea.scrollHeight}px`
}

type ParsedQuote = { kind: 'quote'; quote: string; source: string | null }
type ParsedNote = { kind: 'note'; text: string }

function parseText(raw: string): ParsedQuote | ParsedNote {
  const text = raw.trim()
  if (!text) return { kind: 'note', text: '' }

  const first = text[0]
  if (!QUOTE_OPENERS.includes(first)) {
    return { kind: 'note', text }
  }

  // Walk forward to find the matching closing quote and any trailing
  // attribution after an em dash, en dash, or hyphen separator.
  const inner = text.slice(1)
  const closerMatch = inner.match(QUOTE_CLOSERS_RX)
  if (!closerMatch || closerMatch.index === undefined) {
    // No closing quote — strip the opener and treat as a quote without a
    // source. Better than rendering a broken note.
    return { kind: 'quote', quote: inner.trim(), source: null }
  }

  const quote = inner.slice(0, closerMatch.index).trim()
  const rest = inner.slice(closerMatch.index + 1).trim()

  let source: string | null = null
  const dashMatch = rest.match(/^[—–-]\s*(.+)$/)
  if (dashMatch) source = dashMatch[1].trim()
  else if (rest.length > 0) source = rest

  return { kind: 'quote', quote, source }
}

export function TextCardNode({ id, data }: NodeProps) {
  const { text } = data as TextCardData
  const [editing, setEditing] = useState(!text)
  const [value, setValue] = useState(text)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const { updateNodeData, setNodes } = useReactFlow()
  const boardId = useBoardId()
  const { isSelected, isConnected } = useNodeHighlightStatus(id)

  useEffect(() => {
    if (editing && textareaRef.current) {
      textareaRef.current.focus()
      autoResize(textareaRef.current)
    }
  }, [editing])

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      setValue(e.target.value)
      autoResize(e.target)
    },
    [],
  )

  const finishEditing = useCallback(() => {
    setEditing(false)
    updateNodeData(id, { text: value })
    if (value !== text && value.trim().length > 0 && boardId) {
      const logger = createNodeLogger(
        id,
        boardId,
        buildProcessingLogAppender(id, setNodes),
      )
      embedNodeAsync(boardId, id, 'textCard', { text: value }, logger)
    }
  }, [id, value, text, boardId, updateNodeData, setNodes])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') {
        finishEditing()
      }
      e.stopPropagation()
    },
    [finishEditing],
  )

  const parsed = useMemo(() => parseText(text || ''), [text])
  const isQuote = parsed.kind === 'quote'

  const highlightClass = `${isConnected ? ' node-highlight' : ''}${isSelected ? ' selected-node-highlight' : ''}`.trim()

  // Container style varies by mode: note gets the warm yellow tint and a
  // softer shadow; quote uses the standard cream-on-white card.
  const containerStyle: CSSProperties = isQuote
    ? {
        width: CARD_WIDTH,
        background: 'var(--w-card)',
        borderRadius: 'var(--w-radius-lg)',
        boxShadow: 'var(--w-shadow-card)',
        border: '1px solid var(--w-line)',
        borderLeft: '3px solid var(--w-standard-accent)',
        padding: '18px 20px 14px',
        fontFamily: 'var(--w-font-sans)',
        color: 'var(--w-ink)',
      }
    : {
        width: CARD_WIDTH,
        background: '#fef4d4',
        borderRadius: 'var(--w-radius-lg)',
        border: '1px solid rgba(60, 40, 10, 0.08)',
        boxShadow:
          '0 1px 2px rgba(60,40,10,0.08), 0 8px 20px rgba(60,40,10,0.10)',
        padding: '14px 16px',
        fontFamily: 'var(--w-font-display)',
        color: '#4a3a1e',
      }

  const editorStyle: CSSProperties = isQuote
    ? {
        width: '100%',
        minHeight: 60,
        background: 'transparent',
        border: 'none',
        outline: 'none',
        resize: 'none',
        overflow: 'hidden',
        fontFamily: 'var(--w-font-display)',
        fontSize: 15,
        fontStyle: 'italic',
        lineHeight: 1.4,
        color: 'var(--w-ink)',
      }
    : {
        width: '100%',
        minHeight: 60,
        background: 'transparent',
        border: 'none',
        outline: 'none',
        resize: 'none',
        overflow: 'hidden',
        fontFamily: 'var(--w-font-display)',
        fontSize: 13,
        lineHeight: 1.5,
        color: '#4a3a1e',
      }

  return (
    <div
      style={containerStyle}
      className={highlightClass || undefined}
    >
      {editing ? (
        <textarea
          ref={textareaRef}
          value={value}
          onChange={handleChange}
          onBlur={finishEditing}
          onKeyDown={handleKeyDown}
          className="nodrag nowheel nopan"
          style={editorStyle}
          placeholder={isQuote ? 'Type a quote…' : 'Type something…'}
        />
      ) : isQuote ? (
        <div
          onDoubleClick={() => {
            setValue(text)
            setEditing(true)
          }}
          style={{ cursor: 'text' }}
        >
          <p
            style={{
              margin: 0,
              fontFamily: 'var(--w-font-display)',
              fontSize: 15,
              fontStyle: 'italic',
              fontWeight: 400,
              lineHeight: 1.4,
              color: 'var(--w-ink)',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
            }}
          >
            “{parsed.quote}”
          </p>
          {parsed.source && (
            <p
              style={{
                margin: 0,
                marginTop: 10,
                fontFamily: 'var(--w-font-sans)',
                fontSize: 11,
                color: 'var(--w-ink-soft)',
              }}
            >
              — {parsed.source}
            </p>
          )}
        </div>
      ) : (
        <div
          onDoubleClick={() => {
            setValue(text)
            setEditing(true)
          }}
          style={{ cursor: 'text' }}
        >
          <p
            style={{
              margin: 0,
              fontFamily: 'var(--w-font-display)',
              fontSize: 13,
              lineHeight: 1.5,
              color: '#4a3a1e',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              maxHeight: 200,
              overflow: 'hidden',
            }}
          >
            {parsed.text
              ? parsed.text.length > 240
                ? `${parsed.text.slice(0, 240)}…`
                : parsed.text
              : 'Double-click to edit…'}
          </p>
          {parsed.text && (
            <p
              style={{
                margin: 0,
                marginTop: 10,
                fontFamily: 'var(--w-font-mono)',
                fontSize: 9,
                color: 'rgba(60, 40, 10, 0.4)',
                letterSpacing: 0.5,
              }}
            >
              NOTE
            </p>
          )}
        </div>
      )}
      <Handle type="source" position={Position.Right} style={HANDLE_STYLE} />
      <Handle type="target" position={Position.Left} style={HANDLE_STYLE} />
    </div>
  )
}
