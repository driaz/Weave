# opener-timing

Times the opening voice turn from the Speak click to the first audio bytes reaching the
player, split into the gaps below. It drives the real app in headless Chromium as the dev
test user, with a fake microphone, and reads the app's own voice telemetry, so no mic and no
person are needed.

| Gap | From → to |
| --- | --- |
| click→session.started | Speak click → `voice.session.started` (create_voice_session RPC) |
| session.started→ready | → `voice.session.ready` (mic + AudioContext + worklet) |
| ready→turn.started | → `voice.turn.started` (snapshot + retrieval, `snapshotFetchLatencyMs`) |
| turn.started→request_sent | → `voice.claude.request_sent` |
| request_sent→first_text | → `voice.claude.first_text_delta` (Claude TTFT) |
| first_text→tts.requested | → first `voice.tts.segment_requested` (first sentence complete) |
| tts.requested→segment_added | → first `voice.mux.segment_added` (TTS response headers) |
| segment_added→first_audio | → first `voice.mux.segment_writing` (PCM handed to the player) |

## Run it

```bash
# 1. Mock Claude (cloud sessions have no Anthropic key). Skip it if you have
#    a real key in media-server/.env and point VITE_CLAUDE_PROXY_URL there.
node scripts/opener-timing/mock-claude.mjs            # :8787, ttft 2300 ms, 270 chars/s

# 2. Local media server for /api/tts-stream (real ElevenLabs).
cd media-server && npm run dev                        # needs ELEVENLABS_* in media-server/.env

# 3. App, pointed at both.
VITE_CLAUDE_PROXY_URL=http://localhost:8787/api/claude \
VITE_WEAVE_MEDIA_URL=http://localhost:3000 npm run dev

# 4. Once per dev project: seed the test user's board so the opener does
#    prod's reads (snapshot, edge + node embeddings).
node scripts/opener-timing/seed-dev.mjs

# 5. Run.
node scripts/opener-timing/run.mjs --runs 5 --label "distributed memory" --deposit-fixture
```

`run.mjs` needs `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `E2E_DEV_EMAIL` and
`E2E_DEV_PASSWORD`, plus a resolvable `playwright` (not a project dependency). In a cloud
session, prefix Node commands with `NODE_USE_ENV_PROXY=1` so `fetch` uses the egress proxy.

## What is real and what isn't

- **Real:** the app code path, dev Supabase reads (snapshot, edge vector, node band RPC,
  board resolution), ElevenLabs TTS through the local media server, the segmenter and mux.
- **Synthetic:** Claude, when using `mock-claude.mjs`. Its TTFT is an input. Use it to time
  everything around Claude, not Claude itself.
- **Synthetic:** the deposit corpus with `--deposit-fixture`. The test user can't write
  deposits, so the fixture serves 72 rows × 3072-d (prod's size on 2026-11-17) after
  `--deposit-delay` ms (default 1400, derived from prod `ready→deposit_corpus`).
- **Not covered:** Fly (the TTS hop runs locally, so TTS TTFB reads lower than prod's), the
  device's network and mic-permission cost, and cold starts.

## Prod numbers

`prod-openers.sql` gives the same gaps (except the click, which prod doesn't log) from
`voice_sessions.processing_log` over the last 30 days. Run it with the read-only prod URL, or
paste it into the read-only Supabase connector.
