export type EdgeColorSet = {
  stroke: string
  bg: string
  border: string
  text: string
  fill: string
}

const DEFAULT_EDGE_COLOR: EdgeColorSet = {
  stroke: '#4A7BF7',
  bg: '#EEF2FF',
  border: '#A5B4FC',
  text: '#3B5CC6',
  fill: '#4A7BF7',
}

export function getEdgeColor(): EdgeColorSet {
  return DEFAULT_EDGE_COLOR
}
