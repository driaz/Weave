import { spawn } from 'node:child_process'
import { join } from 'node:path'

/**
 * Probe the duration of a media file in seconds via ffprobe.
 * Returns the floor of the parsed value, or 0 if probe fails — the caller
 * treats 0 as "short" (under-10-min tier), which is the safer default than
 * silently dropping the request.
 */
export async function probeDuration(mediaPath: string): Promise<number> {
  const out = await runProcessOutput('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    mediaPath,
  ])
  const seconds = Number.parseFloat(out.trim())
  return Number.isFinite(seconds) ? Math.floor(seconds) : 0
}

/**
 * Trim the source video to the first N seconds and re-mux to mp4. The
 * embedding model accepts video/mp4 directly (probe confirmed), so no frame
 * extraction is needed — we send the trimmed clip as one inlineData part.
 *
 * Defaults to 120s, the documented Gemini Embedding 2 cap for video input.
 */
export async function trimVideo(
  videoPath: string,
  workDir: string,
  seconds = 120,
): Promise<string> {
  const outPath = join(workDir, 'trimmed.mp4')
  await runProcess('ffmpeg', [
    '-y',
    '-i', videoPath,
    '-t', String(seconds),
    '-c', 'copy',
    '-movflags', '+faststart',
    outPath,
  ])
  return outPath
}

/**
 * Extract a standalone audio track. With no `seconds` cap, returns the full
 * audio (used for over-10-min media analysis). With a cap, returns the first N
 * seconds (used for the embedding payload, which is bounded at ~2 min).
 *
 * The output filename includes the duration so a single workDir can hold both
 * the full audio (for analysis) and the trimmed audio (for embedding) without
 * one clobbering the other.
 */
export async function extractAudio(
  videoPath: string,
  workDir: string,
  seconds?: number,
): Promise<string> {
  const suffix = seconds ? `${seconds}s` : 'full'
  const outPath = join(workDir, `audio.${suffix}.opus`)
  const args = ['-y', '-i', videoPath]
  if (seconds) args.push('-t', String(seconds))
  args.push('-vn', '-c:a', 'libopus', '-b:a', '64k', outPath)
  await runProcess('ffmpeg', args)
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

function runProcessOutput(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'inherit'] })
    let out = ''
    proc.stdout.on('data', (chunk) => {
      out += chunk.toString()
    })
    proc.once('error', reject)
    proc.once('close', (code) => {
      if (code === 0) resolve(out)
      else reject(new Error(`${cmd} exited with code ${code}`))
    })
  })
}
