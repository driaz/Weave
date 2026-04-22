import { persistence } from './index'

/**
 * Thrown by `dataUrlToBlob` when the input isn't a parseable base64
 * data URL or a raw base64 payload. Callers (notably
 * `ensureNodeImageUploaded`) catch this and skip the upload instead
 * of letting `atob`'s opaque `InvalidCharacterError` bubble up.
 */
export class InvalidImagePayloadError extends Error {
  constructor(reason: string) {
    super(`dataUrlToBlob: ${reason}`)
    this.name = 'InvalidImagePayloadError'
  }
}

const BASE64_CHARSET_RE = /^[A-Za-z0-9+/]*={0,2}$/

/**
 * Turn a `data:<mime>;base64,<payload>` URL (or a raw base64 string)
 * into a Blob suitable for Supabase Storage. Falls back to the
 * provided `fallbackMime` when the input is a bare payload.
 *
 * Throws `InvalidImagePayloadError` if the payload isn't valid
 * base64 — previously an `atob` `InvalidCharacterError` leaked out
 * when hydration-derived signed URLs accidentally reached this path.
 */
export function dataUrlToBlob(
  dataUrlOrBase64: string,
  fallbackMime = 'image/png',
): Blob {
  const match = dataUrlOrBase64.match(/^data:([^;]+);base64,(.+)$/)
  const mime = match ? match[1] : fallbackMime
  const payload = match ? match[2] : dataUrlOrBase64

  if (!payload || !BASE64_CHARSET_RE.test(payload)) {
    throw new InvalidImagePayloadError(
      'payload is not a valid base64 string',
    )
  }

  let bytes: string
  try {
    bytes = atob(payload)
  } catch (err) {
    throw new InvalidImagePayloadError(
      `atob failed: ${(err as Error).message}`,
    )
  }
  const buffer = new Uint8Array(bytes.length)
  for (let i = 0; i < bytes.length; i++) {
    buffer[i] = bytes.charCodeAt(i)
  }
  return new Blob([buffer], { type: mime })
}

function extensionFromMime(mime: string): string {
  switch (mime) {
    case 'image/png':
      return 'png'
    case 'image/jpeg':
    case 'image/jpg':
      return 'jpg'
    case 'image/gif':
      return 'gif'
    case 'image/webp':
      return 'webp'
    case 'image/svg+xml':
      return 'svg'
    default:
      return 'bin'
  }
}

export function buildNodeImagePath(
  userId: string,
  boardId: string,
  nodeId: string,
  mime: string,
): string {
  return `${userId}/${boardId}/${nodeId}.${extensionFromMime(mime)}`
}

/**
 * Key we stash in a node's `data` blob at hydrate time so subsequent
 * saves know the image is already in Storage and skip the re-upload
 * step. The path itself lives in the DB's `image_url` column; this
 * mirror lets `ensureNodeImageUploaded` decide without re-querying.
 */
export const IMAGE_STORAGE_PATH_KEY = '_imageStoragePath'

/**
 * Pull the first available base64 image out of a node's data blob.
 * Only fields the client holds as inline base64 count — signed URLs
 * (which is what hydration drops into `imageDataUrl` / `imageUrl`)
 * must NOT be treated as upload candidates, or `dataUrlToBlob` will
 * choke on them.
 */
export function extractNodeImage(
  nodeType: string,
  data: Record<string, unknown>,
): { base64: string; mime: string } | null {
  if (nodeType === 'imageCard') {
    const url = data.imageDataUrl
    if (typeof url !== 'string' || url.length === 0) return null
    const match = url.match(/^data:([^;]+);base64,(.+)$/)
    if (!match) {
      // Not a base64 data URL — almost certainly a signed URL from a
      // previous hydrate. Nothing to upload.
      return null
    }
    return { base64: url, mime: match[1] }
  }
  if (nodeType === 'linkCard') {
    const base64 = data.imageBase64
    if (typeof base64 !== 'string' || base64.length === 0) return null
    if (/^https?:\/\//i.test(base64)) return null
    const mime = data.imageMimeType
    return {
      base64,
      mime: typeof mime === 'string' && mime ? mime : 'image/png',
    }
  }
  return null
}

/**
 * Upload a node's image to the weave-media bucket if we don't already
 * have a cached path for it. Cache key is `${boardId}:${nodeId}` so
 * the same image isn't re-uploaded every 500ms save cycle.
 *
 * Architectural skip order (cheap → expensive):
 * 1. `data._imageStoragePath` — hydrate stashes this when the DB row
 *    already had an `image_url`. Zero work needed.
 * 2. In-memory `uploadedPathCache` — populated after a successful
 *    upload within the current session.
 * 3. `extractNodeImage` — last check; returns null if the node's
 *    data doesn't contain fresh base64 content.
 *
 * Returns the storage path on success, `null` if nothing to upload,
 * or throws (caller's responsibility to catch — a failed upload
 * shouldn't kill the rest of the sync).
 */
const uploadedPathCache = new Map<string, string>()

function cacheKey(boardId: string, nodeId: string): string {
  return `${boardId}:${nodeId}`
}

export async function ensureNodeImageUploaded(
  userId: string,
  boardId: string,
  nodeId: string,
  nodeType: string,
  data: Record<string, unknown>,
): Promise<string | null> {
  const stashedPath = data[IMAGE_STORAGE_PATH_KEY]
  if (typeof stashedPath === 'string' && stashedPath.length > 0) {
    // Seed the cache so repeat saves skip even the stash check.
    uploadedPathCache.set(cacheKey(boardId, nodeId), stashedPath)
    return stashedPath
  }

  const cached = uploadedPathCache.get(cacheKey(boardId, nodeId))
  if (cached) return cached

  const image = extractNodeImage(nodeType, data)
  if (!image) return null

  const path = buildNodeImagePath(userId, boardId, nodeId, image.mime)
  const blob = dataUrlToBlob(image.base64, image.mime)
  await persistence.media.upload(blob, path)
  uploadedPathCache.set(cacheKey(boardId, nodeId), path)
  return path
}

/** Drop the memoized path for a node (e.g. after it's deleted). */
export function forgetUploadedImage(boardId: string, nodeId: string): void {
  uploadedPathCache.delete(cacheKey(boardId, nodeId))
}

/** Drop every cached upload for a board (e.g. after the board is deleted). */
export function forgetUploadedImagesForBoard(boardId: string): void {
  const prefix = `${boardId}:`
  for (const key of Array.from(uploadedPathCache.keys())) {
    if (key.startsWith(prefix)) uploadedPathCache.delete(key)
  }
}
