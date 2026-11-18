import type { SttSocketFactory, SttSocketHandlers } from '../sttStreamClient'

/** Stand-in for the ElevenLabs realtime socket: records what is sent, lets a test play the server. */
export class FakeSttSocket {
  url = ''
  sent: Array<{ message_type: string; audio_base_64: string; commit: boolean; sample_rate: number }> = []
  closed = false
  private handlers: SttSocketHandlers | null = null

  factory: SttSocketFactory = (url, handlers) => {
    this.url = url
    this.handlers = handlers
    return {
      send: (data) => {
        if (this.closed) throw new Error('socket is closed')
        this.sent.push(JSON.parse(data))
      },
      close: () => {
        this.closed = true
      },
    }
  }

  get created(): boolean {
    return this.handlers !== null
  }

  serverSends(message: Record<string, unknown>): void {
    this.handlers?.onMessage(JSON.stringify(message))
  }

  serverCloses(): void {
    this.handlers?.onClose()
  }
}

/** Lets pending promise callbacks (token resolution, final) run. */
export async function flushPromises(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}
