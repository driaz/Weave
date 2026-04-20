import { mapSupabaseError, PermissionError } from './errors'
import { requireClient, requireUserId } from './session'

const BUCKET = 'weave-media'
const DEFAULT_SIGNED_URL_EXPIRY_SECONDS = 60 * 60 // 1 hour

/**
 * Upload a blob to the weave-media bucket.
 *
 * `path` is the full object key inside the bucket. Callers construct
 * it (e.g. `${userId}/${boardId}/${nodeId}.png`). The module enforces
 * that the path begins with the caller's user_id because Storage RLS
 * does the same — failing early here gives a cleaner error than a
 * generic RLS denial.
 *
 * Returns the stored path (same value that was passed in).
 */
export async function upload(file: Blob, path: string): Promise<string> {
  const client = requireClient()
  const userId = await requireUserId()

  if (!path.startsWith(`${userId}/`)) {
    throw new PermissionError(
      `media.upload: path must start with "${userId}/" to satisfy storage RLS`,
    )
  }

  const { data, error } = await client.storage
    .from(BUCKET)
    .upload(path, file, { upsert: true, contentType: file.type || undefined })

  if (error) throw mapSupabaseError(error, `media.upload(${path})`)
  return data.path
}

/**
 * Generate a short-lived signed URL for a previously uploaded object.
 * `expiresIn` is in seconds; defaults to 1 hour.
 */
export async function getSignedUrl(
  path: string,
  expiresIn: number = DEFAULT_SIGNED_URL_EXPIRY_SECONDS,
): Promise<string> {
  const client = requireClient()
  await requireUserId()

  const { data, error } = await client.storage
    .from(BUCKET)
    .createSignedUrl(path, expiresIn)

  if (error) throw mapSupabaseError(error, `media.getSignedUrl(${path})`)
  return data.signedUrl
}

export async function remove(path: string): Promise<void> {
  const client = requireClient()
  await requireUserId()

  const { error } = await client.storage.from(BUCKET).remove([path])
  if (error) throw mapSupabaseError(error, `media.delete(${path})`)
}
