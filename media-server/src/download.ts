import { spawn } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Download a video to {workDir}/video.mp4 via yt-dlp. Caps resolution at 720p
 * and merges to mp4 so ffmpeg has a single container to read.
 *
 * Returns the absolute path to the downloaded file.
 *
 * TODO: handle authenticated content (Twitter/X often requires cookies for
 * full-quality downloads). For v1 we accept whatever yt-dlp can grab anonymously.
 */
export async function downloadVideo(url: string, workDir: string): Promise<string> {
  await mkdir(workDir, { recursive: true })
  const outPath = join(workDir, 'video.mp4')

  await runProcess('yt-dlp', [
    '-o', outPath,
    '--format', 'bestvideo[height<=720]+bestaudio/best[height<=720]',
    '--merge-output-format', 'mp4',
    '--no-playlist',
    '--quiet',
    url,
  ])

  return outPath
}

function runProcess(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { stdio: ['ignore', 'inherit', 'inherit'] })
    proc.once('error', reject)
    proc.once('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`${cmd} exited with code ${code}`))
    })
  })
}
