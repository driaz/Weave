let counter = 1

export function generateNodeId(): string {
  counter++
  return String(counter)
}
