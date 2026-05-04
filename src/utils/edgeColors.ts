import type { WeaveMode } from '../types/board'

export type EdgeColorSet = {
  stroke: string
  bg: string
  border: string
  text: string
  fill: string
  glow: string
}

const COLORS: Record<WeaveMode, EdgeColorSet> = {
  weave: {
    stroke: 'var(--w-standard-accent)',
    bg: 'var(--w-card)',
    border: 'var(--w-standard-bg)',
    text: 'var(--w-standard-accent)',
    fill: 'var(--w-standard-accent)',
    glow: 'var(--w-standard-glow)',
  },
  deeper: {
    stroke: 'var(--w-deeper-accent)',
    bg: 'var(--w-card)',
    border: 'var(--w-deeper-bg)',
    text: 'var(--w-deeper-accent)',
    fill: 'var(--w-deeper-accent)',
    glow: 'var(--w-deeper-glow)',
  },
  tensions: {
    stroke: 'var(--w-tensions-accent)',
    bg: 'var(--w-card)',
    border: 'var(--w-tensions-bg)',
    text: 'var(--w-tensions-accent)',
    fill: 'var(--w-tensions-accent)',
    glow: 'var(--w-tensions-glow)',
  },
}

export function getEdgeColor(mode?: WeaveMode): EdgeColorSet {
  return COLORS[mode ?? 'weave']
}
