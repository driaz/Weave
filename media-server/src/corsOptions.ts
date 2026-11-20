// Chrome caps Access-Control-Max-Age at 2 h (Firefox at 24 h). Without the
// header, browsers cache a preflight for only ~5 s, so every voice turn paid a
// fresh OPTIONS round trip before its first STT, Claude and TTS request (prod:
// the first TTS segment of a turn ran ~140 ms slower than the second).
export const CORS_PREFLIGHT_MAX_AGE_S = 7200

export function buildCorsOptions(allowedOrigins: string[]) {
  return {
    origin: allowedOrigins,
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Playback-Id', 'X-Recording-Id'],
    maxAge: CORS_PREFLIGHT_MAX_AGE_S,
  }
}
