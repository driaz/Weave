# Voice v2 — PCM Streaming Validation

**Status:** Validated end-to-end on May 10, 2026. Three legs of the cascade proven independently. `/api/tts-stream` endpoint shipped to `weave-media.fly.dev`. Client-side integration pending (see "Next steps").

**Audience:** Future-Daniel debugging voice v2, or referencing the decisions baked into the new endpoint and prototypes.

---

## TL;DR

The cascade architecture for voice v2 — `Claude SSE → ElevenLabs PCM streaming → browser playback` — has every leg validated:

- **Claude SSE** was shipped previously (`/api/claude` on Fly.io)
- **ElevenLabs PCM streaming** validated tonight via direct curl, then via Fly.io proxy
- **Browser PCM playback** validated tonight via two prototypes (whole-file decode, chunked scheduling)

The new endpoint `POST /api/tts-stream` is live in production, JWT-gated, streaming raw `pcm_24000` bytes through to the client. Existing `/api/tts` (MP3) left untouched as fallback.

What's left is mechanical integration of the prototypes into Weave's client code. No research questions remain.

---

## ⚠️ Format gotcha (the one thing that will bite you)

ElevenLabs' streaming endpoint splits parameters across query string and JSON body — and they're inverses of each other:

- `output_format=pcm_24000` → **URL query parameter**
- `optimize_streaming_latency` → **JSON body field** (as integer, not string)

A naive port that puts `output_format` in the body silently gets ignored and you receive default MP3 bytes interpreted as PCM (sounds like static). A naive port that puts `optimize_streaming_latency` in the query string gets ignored and you lose the latency optimization.

This was the gotcha that consumed a back-and-forth with ElevenLabs tech support during the Professor Alan (Plato) project in August 2025. It's still the gotcha in May 2026. Document this aggressively.

**Note:** `optimize_streaming_latency` has been deprecated by ElevenLabs as of 2025 — Turbo and Flash models handle latency natively. The new `/api/tts-stream` endpoint does NOT send this parameter. Plato's original code (and the reference curl below) still includes it for historical accuracy.

---

## Reference curl (known-good, May 2026)

This is the validated curl against ElevenLabs directly. Use it to confirm the format works whenever you're debugging.

```bash
export KEY="..."        # ElevenLabs API key (must have text_to_speech permission)
export VOICE="..."      # ElevenLabs voice ID

curl -X POST \
  "https://api.elevenlabs.io/v1/text-to-speech/$VOICE/stream?output_format=pcm_24000" \
  -H "xi-api-key: $KEY" \
  -H "Content-Type: application/json" \
  --data '{
    "text": "Hello from a curl test.",
    "model_id": "eleven_turbo_v2_5",
    "optimize_streaming_latency": 2,
    "voice_settings": {
      "stability": 0.6,
      "similarity_boost": 0.8,
      "style": 0.2,
      "use_speaker_boost": true
    }
  }' \
  --output test.pcm

# Playback (raw signed 16-bit LE mono at 24kHz)
ffmpeg -f s16le -ar 24000 -ac 1 -i test.pcm test.wav && open test.wav
```

**Why not ffplay?** ffplay 7.1.1 removed the `-ac` flag. Use `-ch_layout mono` instead, or use the ffmpeg → WAV → open pattern above (more reliable across versions).

**Expected output:** ~300KB file, ~6 seconds of audio, ffmpeg confirms `pcm_s16le, 24000 Hz, mono`.

---

## Reference curl (through Fly.io proxy)

For testing the production path:

```bash
# Get JWT from prod browser console:
# (await window.supabase.auth.getSession()).data.session.access_token

export JWT="..."

curl -N -X POST "https://weave-media.fly.dev/api/tts-stream" \
  -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json" \
  -d '{"text":"Streaming PCM test through Fly proxy."}' \
  -o test-stream.pcm \
  -D headers.txt

grep -i content-type headers.txt   # should be: content-type: audio/pcm
ffmpeg -f s16le -ar 24000 -ac 1 -i test-stream.pcm test-stream.wav && open test-stream.wav
```

The proxy passes bytes through without modification — the resulting file should be identical in structure to the direct curl output, just routed through Fly.

---

## Request specification

### Direct to ElevenLabs

| Element | Location | Value |
|---------|----------|-------|
| Method | — | POST |
| URL path | — | `/v1/text-to-speech/{VOICE_ID}/stream` |
| `output_format` | **Query param** | `pcm_24000` |
| `xi-api-key` | Header | API key |
| `Content-Type` | Header | `application/json` |
| `text` | Body | The text to synthesize |
| `model_id` | Body | `eleven_turbo_v2_5` |
| `voice_settings` | Body | Nested object (see below) |
| `optimize_streaming_latency` | Body | Integer (deprecated — omit in new code) |

### Through Weave's proxy

| Element | Location | Value |
|---------|----------|-------|
| Method | — | POST |
| URL | — | `https://weave-media.fly.dev/api/tts-stream` |
| `Authorization` | Header | `Bearer <JWT>` (Supabase access token) |
| `Content-Type` | Header | `application/json` |
| `text` | Body | The text to synthesize |

Everything else (voice, model, voice settings, format) is handled server-side. Client only sends text.

### Voice settings (production values, ported from Plato)

```json
{
  "stability": 0.6,
  "similarity_boost": 0.8,
  "style": 0.2,
  "use_speaker_boost": true
}
```

These are Plato's tuned values for a contemplative philosophical voice. May want to re-tune for Weave's tone; not blocking.

### Response format

Raw signed 16-bit little-endian mono PCM at 24kHz. No WAV header. No container.

- Bytes per sample: 2
- Bytes per second: 48,000 (24,000 samples × 2 bytes)
- Typical file: ~300KB for 6 seconds of speech

---

## `/api/tts-stream` endpoint (Fly.io)

**File:** `media-server/src/index.ts`
**Branch shipped:** `feat/tts-pcm-stream` (merged to main, deployed May 10, 2026)
**Image:** `weave-media:deployment-01KRA9SSX1554PAA5GYGERTKWM`

### Behavior

1. Validates JWT via `verifyUserToken` (same pattern as `/api/claude` and `/process`)
2. Validates request body: `{ text: string }`, non-empty, ≤ `TTS_MAX_TEXT_LENGTH`
3. Calls ElevenLabs streaming endpoint with the request spec above
4. Pipes `response.body` through to the Fastify reply via `Readable.fromWeb(...)` — no buffering
5. Sets response headers:
   - `Content-Type: audio/pcm`
   - `Transfer-Encoding: chunked`
   - `Cache-Control: no-cache`
   - `X-Accel-Buffering: no` (prevents Fly's edge from buffering — same as `/api/claude`)
6. Structured Pino logs tagged `tts-stream.*` at every phase

### Diverges from `/api/tts` in two ways

1. **JWT-gated** — `/api/tts` is currently unauthenticated (a known issue worth fixing in a separate PR). The new endpoint follows the `/api/claude` auth pattern.
2. **Voice settings differ slightly** — `/api/tts-stream` uses Plato's tuned values (above); `/api/tts` uses `stability: 0.5, similarity_boost: 0.75`. Intentional — the streaming endpoint is for the new voice v2 flow and can have its own defaults.

CORS is handled globally by `@fastify/cors`; new route inherits the allow-list automatically.

---

## Prototype findings

Two prototypes built tonight to validate browser-side playback. The findings inform the integration design.

### Prototype 1: Whole-file PCM playback

Loaded `test.pcm` (from the curl above) via `<input type="file">`, decoded `Int16Array → Float32Array`, played via `AudioContext + AudioBufferSourceNode`.

**Findings:**
- Browser handles raw PCM correctly via Web Audio API
- 24kHz source plays through 44.1kHz hardware context — browser handles resampling automatically (no `AVAudioConverter` equivalent needed, unlike iOS)
- Int16 → Float32 normalization: divide by 32768 (matches Plato's `Int16.max` divisor)
- `audioContext.createBuffer(channels, length, sampleRate)` with the source's native rate is the correct call; the browser handles the rate mismatch

### Prototype 2: Chunked streaming scheduler

Took `test.pcm`, sliced into N-millisecond chunks, fed them into an `AudioContext` scheduler on a simulated network timer. Validated the "schedule, don't push" pattern from Plato translates to Web Audio.

**Settings tested and findings:**

| Setting | Plato value | Web finding |
|---------|-------------|-------------|
| Chunk size | 50ms (1200 samples at 24kHz) | Same — 50ms is the sweet spot |
| Pre-buffer | 2 chunks | Same — 2 chunks survives jitter, 1 underruns |
| Max scheduled | 3 | Used 5 in prototype — both work, depends on network speed |
| First-audio latency | — | 102ms with prebuffer=2, chunk=50ms |
| Network speed handling | n/a in iOS | At 2× realtime, backpressure cap fires; at 0.5×, underruns occur unless prebuffer raised |

**Key insight:** Web Audio's `AudioBufferSourceNode.start(when)` with absolute timing (`audioCtx.currentTime + cumulative_offset`) produces sample-accurate, seam-free playback when each chunk's `nextStartTime` accumulates by `buffer.duration`. No clicks or gaps observed at 50ms chunks during 1× network speed.

**What the prototype is missing (deferred to integration):**
- Real network streaming via `fetch + ReadableStream.getReader()`. Prototype uses `setInterval` to simulate arrival.
- AudioContext lifecycle management (suspend on tab blur, resume on focus, cleanup on session end)
- JWT auth on the fetch
- Error states (network failure mid-stream, ElevenLabs returns 4xx mid-response)

---

## Lessons from Plato (Professor Alan) — what translates

The Plato project (iOS voice companion, Aug 2025, ~3 months of work) yielded learnings that map to Weave's voice v2 at three different levels:

### Direct ports — apply identically to web

- Format: `pcm_24000` is the right choice (intelligibility, low decode delay, no MP3 overhead)
- Chunk size: 50ms (1200 samples at 24kHz, 2400 bytes)
- Pre-buffer: 2 chunks (~100ms) before starting playback
- Backpressure: cap scheduled buffers to avoid memory bloat and preserve cancel responsiveness
- Schedule, don't push: each chunk gets its own short-lived audio source with absolute start time
- Int16 → Float32 normalization: divide by 32768

### Conceptual translations — same problem, different API

- `AVAudioEngine + AVAudioPlayerNode` → `AudioContext + AudioBufferSourceNode`
- `scheduleBuffer(_:completionHandler:)` → `source.start(when)` + `source.onended`
- Actor-backed `BufferQueue` (Swift) → single owner of queue state in JS (class with private fields; JS doesn't have actors)
- Hardware sample rate query → `audioCtx.sampleRate` (validated tonight — 44.1kHz on this MacBook)

### Doesn't apply — iOS-specific

- `AVAudioSession` category management — N/A on web
- Echo guards (3-layer defense) — N/A for one-way TTS playback; revisit if voice v2 step 2 adds STT with simultaneous playback
- `AVAudioConverter` — Web Audio handles resampling implicitly
- `preferredIOBufferDuration` — no equivalent in Web Audio
- `audioSession.setActive(true/false)` thrash — irrelevant on web

### Top-level meta-lessons that absolutely apply

1. **Perceived latency beats actual latency.** First-audio is the headline metric, not total response time.
2. **Voice quality is part of the product.** ElevenLabs Turbo 2.5 over OpenAI Realtime for character warmth — applies to Weave too.
3. **Logging is a feature, not overhead.** Build observability during integration, not after. (Memory: Plato lesson port for voice v2 observability.)
4. **Tag working baselines before architectural experiments.** Voice v2 step 1 ships before step 2; main stays stable; rollback is cheap.
5. **Pragmatism over novelty.** Cascaded HTTP streaming is well-understood. Don't reach for WebSockets or AudioWorklet unless single-source-per-buffer fails to deliver.

---

## Tonight's hard-won lessons

### ElevenLabs key rotation gotcha

New API keys default to **restricted permissions**. The `text_to_speech` permission must be explicitly enabled in the ElevenLabs dashboard or the key returns 401 `missing_permissions` — which looks identical to an invalid key 401 but is fixable without redeploy by editing the key's permissions.

The full recovery path tonight:
1. Accidentally pasted live key in chat (security mistake)
2. Rotated key in ElevenLabs dashboard
3. Updated Fly.io secret + redeployed
4. Prod returned 502s on `/api/tts`
5. Read Fly.io logs: 401 `missing_permissions`
6. Enabled `text_to_speech` permission on new key in dashboard
7. Prod recovered (no redeploy needed — Fly was already using the correct key)

**Total: ~30 minutes.** Logs-first debugging beat grep-for-hardcoded-keys hypothesis decisively.

### `ffplay -ac` deprecation

ffplay 7.1.1 removed the `-ac` flag. Use `-ch_layout mono` instead. Or use the more reliable pattern:

```bash
ffmpeg -f s16le -ar 24000 -ac 1 -i test.pcm test.wav && open test.wav
```

(`-ac` still works in `ffmpeg` itself, only removed from `ffplay`.)

### Two failure modes for ElevenLabs 401

- `invalid_api_key` — wrong key value
- `missing_permissions` — valid key, restricted scopes

Same HTTP status. Different root cause. Read the `detail.status` field in the response body.

---

## Decisions baked in (for future-you reading the code)

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Endpoint structure | New `/api/tts-stream`, leave `/api/tts` untouched | Branch-per-feature pattern; old endpoint is fallback; future deletion possible after voice v2 bakes |
| Web Audio approach | `AudioBufferSourceNode` per chunk, scheduled with absolute timing | Closest analog to Plato's `scheduleBuffer` pattern. AudioWorklet is overkill for "play these chunks." |
| Auth on new endpoint | JWT-gated via Supabase access token | Matches `/api/claude` pattern; `/api/tts` being unauthenticated is a separate issue to fix |
| `optimize_streaming_latency` | Omitted in new endpoint | Deprecated by ElevenLabs; Turbo 2.5 handles latency natively |
| Voice settings | Plato's tuned values (stability 0.6, etc.) | Validated as good baseline; revisit during integration if Weave's voice tone differs |
| Format | `pcm_24000` (24kHz mono 16-bit LE) | Plato's choice — intelligibility + low decode delay + manageable bandwidth |
| Model | `eleven_turbo_v2_5` | Best latency-to-quality for Plato in Aug 2025; verify it hasn't been deprecated when revisiting |
| Sequencing | Swap 1 (output streaming) before Swap 2 (input streaming) | Smaller PR, reversible, prove integration shape before adding cascade complexity |

---

## Next steps

### Voice v2 Swap 1 — client integration (next session)

Goal: Replace `/api/tts` MP3 path with `/api/tts-stream` PCM path. Ship behind feature flag.

**Pre-session:** Audit existing TTS call site in Weave's client. Find where `/api/tts` is called, where MP3 is played back, what UI states hang off it.

**Implementation:**
1. Build `PcmStreamPlayer` class (port chunked playback prototype, add `fetch + ReadableStream.getReader()`, add JWT auth)
2. Wire into existing TTS call site
3. Feature-flag the swap (`VITE_USE_TTS_STREAM` default false)
4. Instrument with debug logger events (see observability section below)
5. Test behind preview branch (per Weave dev/prod Supabase JWT constraint)

**Observability requirements (per Plato lesson port in memory):**
- Single correlation ID per voice turn, threaded across client + Fly logs
- First-audio latency event on every turn — headline KPI
- AudioContext state transition events (created, suspended, resumed)
- Underrun events with millisecond detail
- Errors carry phase + correlation ID

### Voice v2 Swap 2 — cascade streaming (later session)

Goal: As Claude streams text via `/api/claude`, chunk at sentence boundaries, fire TTS calls during generation. First-audio target ~500ms after first Claude token (Plato benchmark).

Deferred until Swap 1 ships and bakes. This is where the real perceived-latency win lives — but Swap 1 alone is a real improvement and worth validating in isolation.

### `/api/tts` cleanup (later, low priority)

The old MP3 endpoint:
- Is unauthenticated (worth fixing)
- Will become vestigial after voice v2 ships
- Can be removed after Swap 1 has baked in prod for 1-2 weeks

Not urgent. Memory will surface this when it matters.

---

## Test fixtures

Saved for next session in `~/scratch/weave-voice-fixtures/`:

- `test.pcm` — 306KB, direct curl output, the test sentence "Hello from a curl test..."
- `test-stream.pcm` — 298KB, proxy curl output, "Streaming PCM from ElevenLabs..."
- `test-stream.wav` — WAV version for QuickTime playback

These are useful for browser playback testing without burning ElevenLabs credits on every iteration.

---

## Pointers

- **Memory entries** (for future Claude sessions): voice v2 validation status, observability principles, voice cadence, key rotation gotchas
- **Plato repo** (for deeper reference): `~/Projects/Plato`, especially `PCMStreamingService.swift` and `Docs/`
- **Fly.io app**: `weave-media` (https://fly.io/apps/weave-media)
- **Code**: `media-server/src/index.ts` (look for the `/api/tts-stream` route)

---

*Validation completed May 10, 2026 in a ~2 hour session. Built on three months of Professor Alan groundwork from August 2025.*
