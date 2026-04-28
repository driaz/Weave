import { rm } from 'node:fs/promises'

/**
 * Remove a working directory and everything in it. Best-effort —
 * a leftover /tmp directory is annoying, not catastrophic.
 */
export async function cleanup(workDir: string): Promise<void> {
  try {
    await rm(workDir, { recursive: true, force: true })
  } catch (err) {
    console.warn('[cleanup] failed to remove', workDir, err)
  }
}
