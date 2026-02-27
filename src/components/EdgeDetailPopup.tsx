import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import type { Connection } from '../api/claude'
import { getEdgeColor } from '../utils/edgeColors'

type EdgeDetailPopupProps = {
  connection: Connection
  position: { x: number; y: number }
  onClose: () => void
}

function ScoreBar({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-[10px] text-gray-400 w-14 shrink-0">{label}</span>
      <div className="flex-1 h-1.5 bg-gray-100 rounded-full overflow-hidden">
        <div
          className="h-full rounded-full transition-all duration-300"
          style={{ width: `${value * 100}%`, backgroundColor: color }}
        />
      </div>
      <span className="text-[10px] text-gray-400 w-6 text-right">{Math.round(value * 100)}%</span>
    </div>
  )
}

export function EdgeDetailPopup({ connection, position, onClose }: EdgeDetailPopupProps) {
  const popupRef = useRef<HTMLDivElement>(null)
  const colors = getEdgeColor()

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleKey)
    return () => document.removeEventListener('keydown', handleKey)
  }, [onClose])

  // Clamp position to keep popup within viewport
  const popupWidth = 280
  const popupHeight = 180
  const x = Math.min(position.x, window.innerWidth - popupWidth - 16)
  const y = Math.min(position.y + 12, window.innerHeight - popupHeight - 16)

  return createPortal(
    <div className="fixed inset-0 z-50" onClick={onClose}>
      <div
        ref={popupRef}
        className="fixed rounded-lg border border-gray-200 bg-white shadow-lg p-3 w-[280px]"
        style={{ left: x, top: y }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Type badge */}
        <span
          className="inline-block text-[10px] font-medium px-2 py-0.5 rounded-full mb-2"
          style={{
            backgroundColor: colors.bg,
            borderWidth: '1px',
            borderStyle: 'solid',
            borderColor: colors.border,
            color: colors.text,
          }}
        >
          {connection.type}
        </span>

        {/* Explanation */}
        <p className="text-sm text-gray-700 leading-relaxed mb-3">
          {connection.explanation}
        </p>

        {/* Score bars */}
        <div className="flex flex-col gap-1.5">
          <ScoreBar label="Strength" value={connection.strength} color={colors.fill} />
          <ScoreBar label="Surprise" value={connection.surprise} color={colors.fill} />
        </div>
      </div>
    </div>,
    document.body,
  )
}
