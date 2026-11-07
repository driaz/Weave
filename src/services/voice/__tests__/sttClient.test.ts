import { describe, expect, it } from 'vitest'
import { STT_TOO_LARGE_MESSAGE, sttFailureMessage } from '../sttClient'

describe('sttFailureMessage', () => {
  it('maps 413 to a plain message without the raw proxy body', () => {
    const body = '{"error":"stt_upload_too_large","maxBytes":25165824}'
    const msg = sttFailureMessage(413, body)
    expect(msg).toBe(STT_TOO_LARGE_MESSAGE)
    expect(msg).not.toContain('{')
  })

  it('keeps the existing raw message for other statuses', () => {
    expect(sttFailureMessage(502, 'upstream down')).toBe('STT proxy error (502): upstream down')
  })
})
