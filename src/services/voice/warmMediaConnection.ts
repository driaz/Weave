import { CLAUDE_PROXY_URL } from './conversationOrchestrator'

/**
 * Fire one throwaway GET /health at each media-server origin the opener is
 * about to call (the Claude proxy and /api/tts-stream; both Fly in prod), so
 * DNS + TCP + TLS are done by the time the real requests go out. The browser
 * keeps the warmed connection in its pool; the real requests (CORS, no
 * credentials) share it because this one is also uncredentialed.
 *
 * Fire-and-forget: never throws, never awaited. A failure just means the real
 * request pays for its own handshake, as before.
 */
export function warmMediaConnection(
  urls: Array<string | undefined> = [
    CLAUDE_PROXY_URL,
    import.meta.env.VITE_WEAVE_MEDIA_URL as string | undefined,
  ],
): void {
  const origins = new Set<string>()
  for (const url of urls) {
    if (!url) continue
    try {
      origins.add(new URL(url).origin)
    } catch {
      // Not a URL: nothing to warm.
    }
  }
  for (const origin of origins) {
    void fetch(`${origin}/health`, { credentials: 'omit', cache: 'no-store' }).catch(() => {})
  }
}
