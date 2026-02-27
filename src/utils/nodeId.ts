let counter = 1

export function generateNodeId(): string {
  counter++
  return String(counter)
}

export function resetNodeIdCounter(value: number): void {
  counter = value
}

export function getNodeIdCounter(): number {
  return counter
}
