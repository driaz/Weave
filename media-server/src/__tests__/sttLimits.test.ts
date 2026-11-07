import Fastify from 'fastify'
import multipart from '@fastify/multipart'
import { describe, expect, it } from 'vitest'
import { isUploadTooLarge, STT_BODY_LIMIT, sttMultipartOptions } from '../sttLimits'

function multipartPayload(bytes: number) {
  const boundary = 'weave-test-boundary'
  const head = Buffer.from(
    `--${boundary}\r\n` +
      'Content-Disposition: form-data; name="audio"; filename="audio"\r\n' +
      'Content-Type: audio/wav\r\n\r\n',
  )
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`)
  return {
    payload: Buffer.concat([head, Buffer.alloc(bytes, 1), tail]),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  }
}

describe('STT upload limit', () => {
  it('registers multipart with the named 24 MB constant', () => {
    expect(STT_BODY_LIMIT).toBe(24 * 1024 * 1024)
    expect(sttMultipartOptions.limits.fileSize).toBe(STT_BODY_LIMIT)
  })

  it('recognises the real multipart overflow and maps it to a clean 413', async () => {
    const app = Fastify()
    const maxBytes = 1024
    await app.register(multipart, {
      limits: { ...sttMultipartOptions.limits, fileSize: maxBytes },
    })
    app.post('/stt', async (req, reply) => {
      const part = await req.file()
      try {
        await part!.toBuffer()
      } catch (err) {
        if (isUploadTooLarge(err)) {
          return reply.code(413).send({ error: 'stt_upload_too_large', maxBytes })
        }
        throw err
      }
      return { ok: true }
    })

    const over = await app.inject({ method: 'POST', url: '/stt', ...multipartPayload(maxBytes + 1) })
    expect(over.statusCode).toBe(413)
    expect(over.json()).toEqual({ error: 'stt_upload_too_large', maxBytes })

    const under = await app.inject({ method: 'POST', url: '/stt', ...multipartPayload(maxBytes) })
    expect(under.statusCode).toBe(200)
    await app.close()
  })

  it('does not treat other errors as an overflow', () => {
    expect(isUploadTooLarge(new Error('boom'))).toBe(false)
    expect(isUploadTooLarge({ code: 'FST_INVALID_MULTIPART_CONTENT_TYPE' })).toBe(false)
    expect(isUploadTooLarge(null)).toBe(false)
  })
})
