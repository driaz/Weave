import { createStore, get, set, del, keys } from 'idb-keyval'

// Dedicated IndexedDB store for binary data (images, PDFs)
const binaryStore = createStore('weave-binary-db', 'binary-data')

// Key format: boardId:nodeId:field
function makeKey(boardId: string, nodeId: string, field: string): string {
  return `${boardId}:${nodeId}:${field}`
}

// Binary fields per node type
const BINARY_FIELDS: Record<string, string[]> = {
  imageCard: ['imageDataUrl'],
  pdfCard: ['pdfDataUrl', 'thumbnailDataUrl'],
}

export function getBinaryFields(nodeType: string): string[] {
  return BINARY_FIELDS[nodeType] ?? []
}

export async function saveBinaryData(
  boardId: string,
  nodeId: string,
  field: string,
  value: string,
): Promise<void> {
  const key = makeKey(boardId, nodeId, field)
  await set(key, value, binaryStore)
}

export async function loadBinaryData(
  boardId: string,
  nodeId: string,
  field: string,
): Promise<string | undefined> {
  const key = makeKey(boardId, nodeId, field)
  return get<string>(key, binaryStore)
}

export async function deleteBinaryDataForBoard(
  boardId: string,
): Promise<void> {
  const allKeys = await keys(binaryStore)
  const prefix = `${boardId}:`
  const toDelete = allKeys.filter(
    (k) => typeof k === 'string' && k.startsWith(prefix),
  )
  await Promise.all(toDelete.map((k) => del(k, binaryStore)))
}

export async function deleteBinaryDataForNode(
  boardId: string,
  nodeId: string,
): Promise<void> {
  const prefix = `${boardId}:${nodeId}:`
  const allKeys = await keys(binaryStore)
  const toDelete = allKeys.filter(
    (k) => typeof k === 'string' && k.startsWith(prefix),
  )
  await Promise.all(toDelete.map((k) => del(k, binaryStore)))
}
