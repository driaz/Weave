// Upload cap for /api/stt. Sits under Whisper's 25 MB request cap. Fastify's
// bodyLimit does not govern this route: the multipart parser bypasses the body
// reader, so this per-file limit is the only size gate. At today's 48 kHz
// 16-bit mono WAV (96 KB/s) that is ~4.3 min of audio.
export const STT_BODY_LIMIT = 24 * 1024 * 1024

export const sttMultipartOptions = {
  limits: {
    fileSize: STT_BODY_LIMIT,
    files: 1,
    fields: 0,
  },
}

/** True for @fastify/multipart's per-file overflow (thrown by toBuffer()). */
export function isUploadTooLarge(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: unknown }).code === 'FST_REQ_FILE_TOO_LARGE'
  )
}
