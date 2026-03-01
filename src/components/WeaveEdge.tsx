import { createContext, useContext } from 'react'
import {
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  Position,
  type EdgeProps,
} from '@xyflow/react'
import type { WeaveMode } from '../types/board'
import type { Connection } from '../api/claude'
import { getEdgeColor } from '../utils/edgeColors'

type EdgeLabelClickHandler = (
  connection: Connection,
  position: { x: number; y: number },
) => void

export const EdgeLabelClickContext = createContext<EdgeLabelClickHandler>(
  () => {},
)

export type WeaveEdgeData = {
  label: string
  explanation: string
  type: string
  strength: number
  surprise: number
  mode?: WeaveMode
  connectionIndex?: number
  edgeOffset?: number
  activeLayer?: WeaveMode
  connection?: Connection
}

const OFFSET_PX = 60

/** Return the base control-point delta for a given handle position. */
function controlPointDelta(
  position: Position,
  dist: number,
): [number, number] {
  const d = dist * 0.25
  switch (position) {
    case Position.Right:
      return [d, 0]
    case Position.Left:
      return [-d, 0]
    case Position.Bottom:
      return [0, d]
    case Position.Top:
      return [0, -d]
    default:
      return [d, 0]
  }
}

/**
 * Compute a cubic bezier that follows the same handle-direction logic as
 * React Flow's default bezier but with control points shifted perpendicular
 * to the source→target line by `offset` pixels.
 */
function getOffsetBezierPath(
  sourceX: number,
  sourceY: number,
  sourcePosition: Position,
  targetX: number,
  targetY: number,
  targetPosition: Position,
  offset: number,
): [string, number, number] {
  const dx = targetX - sourceX
  const dy = targetY - sourceY
  const dist = Math.sqrt(dx * dx + dy * dy) || 1

  // Perpendicular unit vector
  const nx = -dy / dist
  const ny = dx / dist
  const perpX = nx * offset
  const perpY = ny * offset

  // Base control-point offsets from handle direction
  const [s1dx, s1dy] = controlPointDelta(sourcePosition, dist)
  const [t1dx, t1dy] = controlPointDelta(targetPosition, dist)

  // Shift control points perpendicular to the edge direction
  const cp1x = sourceX + s1dx + perpX
  const cp1y = sourceY + s1dy + perpY
  const cp2x = targetX + t1dx + perpX
  const cp2y = targetY + t1dy + perpY

  const path = `M ${sourceX},${sourceY} C ${cp1x},${cp1y} ${cp2x},${cp2y} ${targetX},${targetY}`

  // Label position at t = 0.5 of the cubic bezier
  const t = 0.5
  const mt = 1 - t
  const labelX =
    mt * mt * mt * sourceX +
    3 * mt * mt * t * cp1x +
    3 * mt * t * t * cp2x +
    t * t * t * targetX
  const labelY =
    mt * mt * mt * sourceY +
    3 * mt * mt * t * cp1y +
    3 * mt * t * t * cp2y +
    t * t * t * targetY

  return [path, labelX, labelY]
}

export function WeaveEdge({
  id,
  sourceX,
  sourceY,
  sourcePosition,
  targetX,
  targetY,
  targetPosition,
  data,
}: EdgeProps) {
  const edgeData = data as WeaveEdgeData | undefined
  const onLabelClick = useContext(EdgeLabelClickContext)
  if (!edgeData) return null

  const offset = (edgeData.edgeOffset ?? 0) * OFFSET_PX

  let edgePath: string
  let labelX: number
  let labelY: number

  if (offset === 0) {
    ;[edgePath, labelX, labelY] = getBezierPath({
      sourceX,
      sourceY,
      sourcePosition,
      targetX,
      targetY,
      targetPosition,
    })
  } else {
    ;[edgePath, labelX, labelY] = getOffsetBezierPath(
      sourceX,
      sourceY,
      sourcePosition,
      targetX,
      targetY,
      targetPosition,
      offset,
    )
  }

  const colors = getEdgeColor(edgeData.mode)
  const strokeWidth = 1.5 + edgeData.strength * 2.5

  // Layer visibility: full opacity when active, dimmed when another layer is focused
  const active =
    (edgeData.mode ?? 'weave') === edgeData.activeLayer
  const pathOpacity = active ? 0.7 : 0.05

  return (
    <>
      <BaseEdge
        id={id}
        path={edgePath}
        interactionWidth={0}
        style={{
          stroke: colors.stroke,
          strokeWidth,
          opacity: pathOpacity,
          transition: 'opacity 200ms ease',
          pointerEvents: 'none',
        }}
      />

      {active && (
        <EdgeLabelRenderer>
          <div
            className="nodrag nopan pointer-events-auto cursor-pointer
              text-[11px] leading-tight px-2 py-0.5 rounded-full
              shadow-sm hover:shadow-md transition-shadow duration-150"
            style={{
              position: 'absolute',
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
              backgroundColor: '#FFFFFF',
              borderWidth: '1px',
              borderStyle: 'solid',
              borderColor: colors.border,
              color: colors.text,
            }}
            onClick={(e) => {
              if (edgeData.connection) {
                onLabelClick(edgeData.connection, {
                  x: e.clientX,
                  y: e.clientY,
                })
              }
            }}
          >
            {edgeData.label}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  )
}
