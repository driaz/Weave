import {
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  type EdgeProps,
} from '@xyflow/react'
import { getEdgeColor } from '../utils/edgeColors'

export type WeaveEdgeData = {
  label: string
  explanation: string
  type: string
  strength: number
  surprise: number
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
  if (!edgeData) return null

  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  })

  const colors = getEdgeColor(edgeData.type)
  const strokeWidth = 1.5 + edgeData.strength * 2.5

  return (
    <>
      <BaseEdge
        id={id}
        path={edgePath}
        style={{
          stroke: colors.stroke,
          strokeWidth,
          opacity: 0.7,
        }}
      />

      <EdgeLabelRenderer>
        <div
          className="nodrag nopan pointer-events-auto cursor-pointer
            text-[11px] leading-tight px-2 py-0.5 rounded-full shadow-sm
            hover:shadow-md transition-shadow duration-150"
          style={{
            position: 'absolute',
            transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
            backgroundColor: colors.bg,
            borderWidth: '1px',
            borderStyle: 'solid',
            borderColor: colors.border,
            color: colors.text,
          }}
        >
          {edgeData.label}
        </div>
      </EdgeLabelRenderer>
    </>
  )
}
