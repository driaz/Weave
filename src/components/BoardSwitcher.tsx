import { useState, useRef, useEffect, useCallback } from 'react'
import type { BoardSummary } from '../hooks/useBoardStorage'

const MODE_DOT_COLORS = [
  'var(--w-standard-accent)',
  'var(--w-deeper-accent)',
  'var(--w-tensions-accent)',
] as const

function dotColorForBoard(boardId: string, index: number): string {
  // Stable color rotation: prefer index, but fall back to a cheap hash of
  // the id so a board's dot color survives reordering.
  const seed =
    index >= 0
      ? index
      : Array.from(boardId).reduce((acc, ch) => acc + ch.charCodeAt(0), 0)
  return MODE_DOT_COLORS[seed % MODE_DOT_COLORS.length]
}

type BoardSwitcherProps = {
  currentBoardId: string
  currentBoardName: string
  currentNodeCount: number
  allBoards: BoardSummary[]
  onCreateBoard: () => string
  onSwitchBoard: (boardId: string) => void
  onRenameBoard: (boardId: string, newName: string) => void
  onDeleteBoard: (boardId: string) => boolean
}

export function BoardSwitcher({
  currentBoardId,
  currentBoardName,
  currentNodeCount,
  allBoards,
  onCreateBoard,
  onSwitchBoard,
  onRenameBoard,
  onDeleteBoard,
}: BoardSwitcherProps) {
  const [open, setOpen] = useState(false)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const [pendingRenameId, setPendingRenameId] = useState<string | null>(null)
  const renameInputRef = useRef<HTMLInputElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  const closeMenu = useCallback(() => {
    setOpen(false)
    setRenamingId(null)
    setConfirmDeleteId(null)
  }, [])

  useEffect(() => {
    if (!open) return
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
    // Capture phase: React Flow's pan handler calls stopPropagation on
    // mousedown before it bubbles, so a regular listener never fires for
    // clicks on the canvas. Capture-phase listeners run on the way down
    // from the root, before any target can stop propagation.
    document.addEventListener('mousedown', handleClick, true)
    return () => {
      document.removeEventListener('keydown', handleEscape)
      document.removeEventListener('mousedown', handleClick, true)
    }
  }, [open, closeMenu])

  useEffect(() => {
    if (renamingId && renameInputRef.current) {
      renameInputRef.current.focus()
      renameInputRef.current.select()
    }
  }, [renamingId])

  useEffect(() => {
    if (!pendingRenameId) return
    const board = allBoards.find((b) => b.id === pendingRenameId)
    if (board) {
      setRenamingId(board.id)
      setRenameValue(board.name)
      setPendingRenameId(null)
    }
  }, [pendingRenameId, allBoards])

  useEffect(() => {
    if (!confirmDeleteId) return
    const timer = setTimeout(() => setConfirmDeleteId(null), 3000)
    return () => clearTimeout(timer)
  }, [confirmDeleteId])

  const handleRenameStart = useCallback(
    (boardId: string, currentName: string) => {
      setRenamingId(boardId)
      setRenameValue(currentName)
    },
    [],
  )

  const handleRenameConfirm = useCallback(() => {
    if (renamingId && renameValue.trim()) {
      onRenameBoard(renamingId, renameValue.trim())
    }
    setRenamingId(null)
  }, [renamingId, renameValue, onRenameBoard])

  const handleRenameKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') handleRenameConfirm()
      if (e.key === 'Escape') setRenamingId(null)
    },
    [handleRenameConfirm],
  )

  const handleDelete = useCallback(
    (boardId: string) => {
      if (confirmDeleteId === boardId) {
        onDeleteBoard(boardId)
        setConfirmDeleteId(null)
      } else {
        setConfirmDeleteId(boardId)
      }
    },
    [confirmDeleteId, onDeleteBoard],
  )

  return (
    <div className="relative" ref={containerRef}>
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center select-none cursor-pointer transition-colors duration-150"
        style={{
          gap: 10,
          padding: '7px 12px 7px 14px',
          borderRadius: 8,
          background: open ? 'var(--w-paper-dim)' : 'transparent',
          border: 'none',
        }}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span
          className="truncate"
          style={{
            fontFamily: 'var(--w-font-display)',
            fontSize: 15,
            fontWeight: 600,
            letterSpacing: '-0.2px',
            color: 'var(--w-ink)',
            maxWidth: 180,
          }}
        >
          {currentBoardName}
        </span>
        <span
          style={{
            fontFamily: 'var(--w-font-mono)',
            fontSize: 10,
            color: 'var(--w-ink-faint)',
            padding: '2px 6px',
            borderRadius: 4,
            background: 'var(--w-paper-dim)',
          }}
        >
          {currentNodeCount}
        </span>
        <svg
          width="10"
          height="10"
          viewBox="0 0 10 10"
          fill="none"
          style={{
            transform: open ? 'rotate(180deg)' : 'rotate(0deg)',
            transition: 'transform 150ms ease',
          }}
        >
          <path
            d="M 2 4 L 5 7 L 8 4"
            stroke="var(--w-ink-soft)"
            strokeWidth="1.4"
            strokeLinecap="round"
            strokeLinejoin="round"
            fill="none"
          />
        </svg>
      </button>

      {open && (
          <div
            className="absolute"
            style={{
              top: 'calc(100% + 6px)',
              left: 0,
              width: 280,
              background: 'var(--w-card)',
              borderRadius: 'var(--w-radius-md)',
              boxShadow: 'var(--w-shadow-float)',
              border: '1px solid var(--w-line)',
              padding: 6,
              zIndex: 50,
            }}
            role="listbox"
          >
            {allBoards.map((board, index) => {
              const isActive = board.id === currentBoardId
              const dot = dotColorForBoard(board.id, index)
              return (
                <div
                  key={board.id}
                  className="group flex items-center cursor-pointer transition-colors duration-150"
                  style={{
                    gap: 10,
                    padding: '8px 10px',
                    borderRadius: 'var(--w-radius-sm)',
                    background: isActive ? 'var(--w-paper-dim)' : 'transparent',
                  }}
                  onMouseEnter={(e) => {
                    if (!isActive)
                      e.currentTarget.style.background = 'var(--w-paper-dim)'
                  }}
                  onMouseLeave={(e) => {
                    if (!isActive)
                      e.currentTarget.style.background = 'transparent'
                  }}
                  role="option"
                  aria-selected={isActive}
                  onClick={() => {
                    if (renamingId || isActive) return
                    onSwitchBoard(board.id)
                    setOpen(false)
                  }}
                  onDoubleClick={() => handleRenameStart(board.id, board.name)}
                >
                  <span
                    aria-hidden="true"
                    style={{
                      width: 6,
                      height: 6,
                      borderRadius: 999,
                      background: dot,
                      flexShrink: 0,
                    }}
                  />
                  {renamingId === board.id ? (
                    <input
                      ref={renameInputRef}
                      value={renameValue}
                      onChange={(e) => setRenameValue(e.target.value)}
                      onBlur={handleRenameConfirm}
                      onKeyDown={handleRenameKeyDown}
                      className="flex-1 outline-none min-w-0"
                      style={{
                        fontFamily: 'var(--w-font-sans)',
                        fontSize: 13,
                        fontWeight: 500,
                        color: 'var(--w-ink)',
                        background: 'var(--w-card)',
                        border: '1px solid var(--w-line)',
                        borderRadius: 4,
                        padding: '1px 4px',
                      }}
                    />
                  ) : (
                    <span
                      className="flex-1 truncate min-w-0"
                      style={{
                        fontFamily: 'var(--w-font-sans)',
                        fontSize: 13,
                        fontWeight: isActive ? 600 : 500,
                        color: 'var(--w-ink)',
                      }}
                    >
                      {board.name}
                    </span>
                  )}
                  <span
                    style={{
                      fontFamily: 'var(--w-font-mono)',
                      fontSize: 10,
                      color: 'var(--w-ink-faint)',
                      flexShrink: 0,
                    }}
                  >
                    {board.nodeCount}
                  </span>
                  {allBoards.length > 1 && renamingId !== board.id && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        handleDelete(board.id)
                      }}
                      className="shrink-0 transition-opacity duration-150 cursor-pointer"
                      style={{
                        fontFamily: 'var(--w-font-sans)',
                        fontSize: 10,
                        padding: '0 4px',
                        borderRadius: 4,
                        border: 'none',
                        background:
                          confirmDeleteId === board.id
                            ? 'var(--w-tensions-bg-soft)'
                            : 'transparent',
                        color:
                          confirmDeleteId === board.id
                            ? 'var(--w-tensions-accent)'
                            : 'var(--w-ink-faint)',
                        opacity: confirmDeleteId === board.id ? 1 : 0,
                      }}
                      onMouseEnter={(e) => {
                        if (confirmDeleteId !== board.id)
                          e.currentTarget.style.opacity = '1'
                      }}
                      onMouseLeave={(e) => {
                        if (confirmDeleteId !== board.id)
                          e.currentTarget.style.opacity = '0'
                      }}
                      aria-label={`Delete ${board.name}`}
                    >
                      {confirmDeleteId === board.id ? 'Delete?' : '×'}
                    </button>
                  )}
                </div>
              )
            })}

            <button
              onClick={() => {
                const newId = onCreateBoard()
                setPendingRenameId(newId)
              }}
              className="w-full text-left cursor-pointer transition-colors duration-150"
              style={{
                marginTop: 4,
                padding: '8px 10px',
                borderTop: '1px solid var(--w-line-soft)',
                fontFamily: 'var(--w-font-sans)',
                fontSize: 13,
                color: 'var(--w-standard-accent)',
                background: 'transparent',
                border: 'none',
                borderTopWidth: 1,
                borderTopStyle: 'solid',
                borderTopColor: 'var(--w-line-soft)',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = 'var(--w-standard-bg-soft)'
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = 'transparent'
              }}
            >
              <span style={{ fontWeight: 600 }}>+</span> New board
            </button>
          </div>
      )}
    </div>
  )
}
