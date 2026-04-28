# weave-media

Background media-processing server for Weave. Receives a node id + URL, downloads
the video via yt-dlp, runs **Gemini 3.1 Flash Lite** (high thinking) for media
analysis, generates a multimodal Gemini Embedding 2 vector that overwrites the
client-side text-only embedding, and writes everything back to Supabase.

This is a **separate deployment** (Fly.io) from the main Vite app. Same git repo,
independent `package.json`, `tsconfig.json`, and `node_modules`.

## Two-tier processing

Branch on ffprobe duration (cutoff: 10 min):

|                | Analysis input            | Embedding input                                  |
| -------------- | ------------------------- | ------------------------------------------------ |
| Under 10 min   | full video + full audio   | trimmed video (2 min) + 2 min audio + transcript + media_analysis |
| Over 10 min    | full audio only           | 2 min audio + transcript + media_analysis (no video) |

Long-form content (podcasts, lectures) is almost always a talking head or
static visual — paying $5+ to send 30 min of video buys no signal the audio
doesn't already carry. Revisit when pricing drops or when a content type
demands it.

Audio is never sampled: at Flash Lite pricing, full audio is under 4¢ even
for a 30-minute podcast.

## Status

Pipeline is implemented end-to-end (download, ffprobe, two-tier ffmpeg,
analysis, embedding, Supabase write-back). Backfill script is still a stub.

## Design decisions (revised after probe + persistence audit)

The implementation spec proposed a few things that were revised after empirical
checks. Captured here so the rationale isn't lost:

### 1. No frame sampling — send the trimmed MP4 directly

The spec proposed sampling video at 1 FPS and sending up to 120 frames as image
parts, with a fallback to 6 keyframes if the per-request image cap was hit.

**Probe result** (`scripts/probe-embedding-multimodal.mjs` in the main repo):
`gemini-embedding-2-preview` accepts `video/mp4` as `inlineData` directly.
A 5-second test MP4 sent as one part returns a 3072-dim vector. So the pipeline
is just: `ffmpeg -t 120 trimmed.mp4` + send. No frame extraction, no 6-image cap
to worry about.

### 2. Server fetches its own transcript via Supadata — does not read from Supabase

The spec proposed reading `nodes.data.transcript` from Supabase, with a 15s
polling fallback if the client hasn't persisted it yet.

**Persistence audit result**: client-side node updates are debounced 500ms, then
saved via a full-board replace RPC. Best case: ~600-800ms after `updateNodeData`.
Worst case: never (if the user navigates away inside the debounce window).
Polling Supabase from the server is a real race we can't engineer around.

Cleanest fix: have the server hit Supadata itself (via the same Netlify function
or directly with the Supadata API key). Costs one duplicate transcript fetch
(rounding error vs. download + ffmpeg + embedding cost).

### 3. No Netlify proxy — server validates Supabase JWT directly

The spec proposed a Netlify function that validates the user's Supabase JWT and
forwards to the Fly server with a shared secret. Two reasons to skip it:

- The Fly server can verify Supabase JWTs natively (Supabase publishes the JWT
  secret; one `jose` call). Removes a hop and a cold-start.
- A shared-secret model means anyone with the secret can request processing
  for any node. Direct JWT verification gives the server real per-user context
  for authorization (verify the requesting user owns the board/node).

If a proxy is wanted later for rate limiting or request logging, it's one new
Netlify function and the server can keep accepting either auth mode.

## Required migration before first run

`src/supabase.ts` calls a `patch_node_data(p_node_id, p_board_id, p_user_id, p_patch)`
RPC defined in [`../supabase/migrations/015_patch_node_data_rpc.sql`](../supabase/migrations/015_patch_node_data_rpc.sql).
Apply it to dev with `supabase db push`, then promote to prod per the
workflow in the root CLAUDE.md before deploying the Fly server. The RPC
is granted to `service_role` only — no client-side callers.

## Local development

```bash
cd media-server
npm install            # creates package-lock.json (commit it)
cp .env.example .env   # fill in Supabase + Gemini + Supadata keys
npm run dev            # tsx watch on src/index.ts
curl http://localhost:3000/health
```

## Deployment

```bash
fly deploy             # uses Dockerfile + fly.toml
fly secrets set SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
                GEMINI_API_KEY=... SUPADATA_API_KEY=... \
                WEAVE_ALLOWED_ORIGINS=https://your-netlify-site.netlify.app
```

`fly.toml` sets `auto_stop_machines = true` and `min_machines_running = 0` —
the machine scales to zero when idle. Cold start is ~10-15s with yt-dlp +
ffmpeg in the image. Acceptable for a background pipeline triggered by node
creation.
