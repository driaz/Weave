export type EdgeColorSet = {
  stroke: string
  bg: string
  border: string
  text: string
  fill: string
}

const EDGE_COLORS: Record<string, EdgeColorSet> = {
  thematic: { stroke: '#6B8DD6', bg: '#EFF6FF', border: '#BFDBFE', text: '#1D4ED8', fill: '#6B8DD6' },
  aesthetic: { stroke: '#9B8FD6', bg: '#FAF5FF', border: '#E9D5FF', text: '#7E22CE', fill: '#9B8FD6' },
  metaphorical: { stroke: '#D6A56B', bg: '#FFFBEB', border: '#FDE68A', text: '#B45309', fill: '#D6A56B' },
  genealogical: { stroke: '#6BD68D', bg: '#F0FDF4', border: '#BBF7D0', text: '#15803D', fill: '#6BD68D' },
  causal: { stroke: '#D66B6B', bg: '#FEF2F2', border: '#FECACA', text: '#B91C1C', fill: '#D66B6B' },
  temporal: { stroke: '#6BC5D6', bg: '#ECFEFF', border: '#A5F3FC', text: '#0E7490', fill: '#6BC5D6' },
  structural: { stroke: '#8B8B8B', bg: '#F9FAFB', border: '#D1D5DB', text: '#4B5563', fill: '#8B8B8B' },
  contrasting: { stroke: '#D6A86B', bg: '#FFF7ED', border: '#FED7AA', text: '#C2410C', fill: '#D6A86B' },
}

const FALLBACK: EdgeColorSet = {
  stroke: '#9CA3AF', bg: '#F9FAFB', border: '#E5E7EB', text: '#4B5563', fill: '#9CA3AF',
}

export function getEdgeColor(type: string): EdgeColorSet {
  const normalized = type.toLowerCase().trim()
  return EDGE_COLORS[normalized] ?? FALLBACK
}
