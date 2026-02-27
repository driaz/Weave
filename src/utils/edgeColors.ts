import type { WeaveMode } from '../types/board'

export type EdgeColorSet = {
  stroke: string
  bg: string
  border: string
  text: string
  fill: string
}

const COLORS: Record<WeaveMode, EdgeColorSet> = {
  weave: {
    stroke: '#4A7BF7',
    bg: '#EEF2FF',
    border: '#A5B4FC',
    text: '#3B5CC6',
    fill: '#4A7BF7',
  },
  deeper: {
    stroke: '#D97706',
    bg: '#FFFBEB',
    border: '#FCD34D',
    text: '#B45309',
    fill: '#D97706',
  },
  tensions: {
    stroke: '#E11D48',
    bg: '#FFF1F2',
    border: '#FDA4AF',
    text: '#BE123C',
    fill: '#E11D48',
  },
}

export function getEdgeColor(mode?: WeaveMode): EdgeColorSet {
  return COLORS[mode ?? 'weave']
}
