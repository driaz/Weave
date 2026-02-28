import { useState, useRef, useEffect, useCallback } from 'react'
import type { BoardSummary } from '../hooks/useBoardStorage'

type BoardSwitcherProps = {
  currentBoardId: string
  currentBoardName: string
  allBoards: BoardSummary[]
  onCreateBoard: () => void
  onSwitchBoard: (boardId: string) => void
  onRenameBoard: (boardId: string, newName: string) => void
  onDeleteBoard: (boardId: string) => boolean
}

export function BoardSwitcher({
  currentBoardId,
  currentBoardName,
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
  const menuRef = useRef<HTMLDivElement>(null)
  const renameInputRef = useRef<HTMLInputElement>(null)

  // Click outside or Escape to close
  useEffect(() => {
    if (!open) return
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpen(false)
        setRenamingId(null)
        setConfirmDeleteId(null)
      }
    }
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false)
        setRenamingId(null)
        setConfirmDeleteId(null)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    document.addEventListener('keydown', handleEscape)
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
      document.removeEventListener('keydown', handleEscape)
    }
  }, [open])

  // Focus rename input when entering rename mode
  useEffect(() => {
    if (renamingId && renameInputRef.current) {
      renameInputRef.current.focus()
      renameInputRef.current.select()
    }
  }, [renamingId])

  // Reset confirm delete after timeout
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
    <div ref={menuRef} className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 px-3 py-1.5 bg-white border border-gray-200
          rounded-lg shadow-sm hover:shadow-md transition-shadow duration-150
          text-sm text-gray-700 cursor-pointer select-none"
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className="max-w-[160px] truncate">{currentBoardName}</span>
        <svg
          className={`w-3 h-3 text-gray-400 transition-transform duration-150 ${open ? 'rotate-180' : ''}`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {open && (
        <div
          className="absolute top-full left-0 mt-1 bg-white border border-gray-200
            rounded-lg shadow-md py-1 min-w-[220px] z-50"
          role="listbox"
        >
          {allBoards.map((board) => (
            <div
              key={board.id}
              className={`group flex items-center gap-1 px-3 py-1.5 cursor-pointer
                ${board.id === currentBoardId ? 'bg-gray-50' : 'hover:bg-gray-50'}`}
              role="option"
              aria-selected={board.id === currentBoardId}
              onClick={() => {
                if (renamingId || board.id === currentBoardId) return
                onSwitchBoard(board.id)
                setOpen(false)
              }}
              onDoubleClick={() => handleRenameStart(board.id, board.name)}
            >
              {renamingId === board.id ? (
                <input
                  ref={renameInputRef}
                  value={renameValue}
                  onChange={(e) => setRenameValue(e.target.value)}
                  onBlur={handleRenameConfirm}
                  onKeyDown={handleRenameKeyDown}
                  className="flex-1 text-sm text-gray-700 bg-white border border-blue-300
                    rounded px-1 py-0 outline-none min-w-0"
                />
              ) : (
                <span className="flex-1 text-sm text-gray-700 truncate min-w-0">
                  {board.name}
                </span>
              )}

              {allBoards.length > 1 && renamingId !== board.id && (
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    handleDelete(board.id)
                  }}
                  className={`shrink-0 text-[10px] px-1 rounded transition-colors duration-150
                    ${
                      confirmDeleteId === board.id
                        ? 'text-red-600 bg-red-50'
                        : 'text-gray-300 hover:text-gray-500 opacity-0 group-hover:opacity-100'
                    }`}
                  aria-label={`Delete ${board.name}`}
                >
                  {confirmDeleteId === board.id ? 'Delete?' : '×'}
                </button>
              )}
            </div>
          ))}

          <div className="border-t border-gray-100 mt-1 pt-1">
            <button
              onClick={() => {
                onCreateBoard()
                setOpen(false)
              }}
              className="w-full text-left px-3 py-1.5 text-sm text-gray-500
                hover:bg-gray-50 hover:text-gray-700 transition-colors duration-150 cursor-pointer"
            >
              + New Board
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
