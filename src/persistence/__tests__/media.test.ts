import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { persistence, PermissionError } from '../index'
import { createTestUser, hasServiceRole, type TestUser } from './setup'

describe.skipIf(!hasServiceRole())('persistence.media', () => {
  let user: TestUser
  const objectPaths: string[] = []

  beforeAll(async () => {
    user = await createTestUser('media')
  })

  afterAll(async () => {
    // Best-effort cleanup: delete any uploaded test objects via admin
    // client so cleanup survives RLS edge cases.
    for (const path of objectPaths) {
      await user.admin.storage.from('weave-media').remove([path]).catch(() => {})
    }
    await user.cleanup()
  })

  it('uploads, signs, fetches, and deletes a small file', async () => {
    const path = `${user.userId}/test-${Date.now()}.txt`
    objectPaths.push(path)

    const blob = new Blob(['hello weave'], { type: 'text/plain' })
    const stored = await persistence.media.upload(blob, path)
    expect(stored).toBe(path)

    const signedUrl = await persistence.media.getSignedUrl(path, 60)
    expect(signedUrl).toMatch(/^https?:\/\//)

    const fetched = await fetch(signedUrl)
    expect(fetched.ok).toBe(true)
    const text = await fetched.text()
    expect(text).toBe('hello weave')

    await persistence.media.delete(path)
    const removed = objectPaths.indexOf(path)
    if (removed >= 0) objectPaths.splice(removed, 1)
  })

  it('rejects uploads to another user\'s path with PermissionError', async () => {
    const otherPath = `00000000-0000-0000-0000-000000000000/evil.txt`
    const blob = new Blob(['nope'], { type: 'text/plain' })
    await expect(persistence.media.upload(blob, otherPath)).rejects.toBeInstanceOf(
      PermissionError,
    )
  })

  it('blocks signed-URL generation for another user\'s object (RLS)', async () => {
    // Upload as test user
    const path = `${user.userId}/private-${Date.now()}.txt`
    objectPaths.push(path)
    await persistence.media.upload(new Blob(['secret']), path)

    // Create a second user and sign them in on the shared client
    const other = await createTestUser('media-other')
    try {
      // Other user tries to access our path — storage RLS should hide it
      // so createSignedUrl returns an error.
      await expect(
        persistence.media.getSignedUrl(path, 60),
      ).rejects.toThrow()
    } finally {
      await other.cleanup()
      // Re-sign as the original test user so afterAll cleanup works
      await user.signIn()
    }
  })
})
