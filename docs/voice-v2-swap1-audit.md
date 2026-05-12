# Voice v2 — Swap 1 Audit (Pre-implementation)

**Goal:** replace the MP3 playback path used by the connection-card "Listen to insight" button with PCM streaming from `/api/tts-stream`, behind a `VITE_USE_TTS_STREAM` (or `localStorage`) feature flag.

**Scope of this document:** audit only. No code changes. Findings are factual — observations and recommendations are deferred to the final Summary section.

---

## 1. Listen button — location and trigger

### Where it lives

There is exactly **one** listen button in the codebase. It is rendered inside the edge-detail popup, not on the cards themselves.

- Button component: [VoiceInsightButton in EdgeDetailPopup.tsx:279-361](src/components/EdgeDetailPopup.tsx#L279-L361)
- Mounted inside the popup at [EdgeDetailPopup.tsx:553-559](src/components/EdgeDetailPopup.tsx#L553-L559)
- The popup itself is rendered in App.tsx — single mount point at [App.tsx:681-694](src/App.tsx#L681-L694), gated on `popupEdge` state.
- The hook providing state + trigger: [useVoiceInsight at EdgeDetailPopup.tsx:427-430](src/components/EdgeDetailPopup.tsx#L427-L430)

### How the click handler works (step-by-step)

The `onClick` prop is `triggerVoice` from `useVoiceInsight`. The function body is [useVoiceInsight.ts:95-186](src/hooks/useVoiceInsight.ts#L95-L186):

1. If `state === 'loading'` → no-op (early return).
2. If `state === 'playing'` → call `stop()` (acts as a toggle / stop button).
3. If `audioRef.current` already holds an `HTMLAudioElement` (i.e. audio was previously generated for this hook instance) → reset `currentTime = 0` and call `.play()` — **cached MP3 replay**, no network call.
4. Otherwise: call `buildRequestRef.current()` to build the `VoiceInsightRequest`. If null → flash error.
5. `setState('loading')`, mark `tapStartRef = Date.now()`.
6. `POST /.netlify/functions/voice-insight` (JSON body: `connectionLabel`, `connectionExplanation`, `node1`, `node2`). Returns `{ insight: string }`.
7. Read `VITE_WEAVE_MEDIA_URL` env. Throw if unset.
8. `POST ${VITE_WEAVE_MEDIA_URL}/api/tts` with `{ text: insight }`.
9. `await ttsRes.blob()` — full MP3 buffered in memory.
10. `URL.createObjectURL(blob)`, then `new Audio(audioUrl)`.
11. Attach `onended` (→ emit metrics + `setState('idle')`) and `onerror` (→ flash error) handlers.
12. Stash refs: `audioRef`, `audioUrlRef`, `insightLengthRef`, `totalLatencyRef`.
13. `await audio.play()`, mark `playStartRef = Date.now()`, `setState('playing')`.
14. On any throw: `cleanupAudio()` (revokes object URL, drops refs) + `flashError()` (2s error flash, then back to idle).

### Duplication / drift

**No duplication.** Grep across `src/**.tsx`:

- The string `useVoiceInsight` appears only in `useVoiceInsight.ts` (definition) and `EdgeDetailPopup.tsx` (consumer).
- `/api/tts` appears only in `useVoiceInsight.ts:149`.
- No "listen" button exists in `TextCardNode`, `ImageCardNode`, `LinkCardNode`, `PdfCardNode`, `WeaveButton`, etc. The "Listen to insight" affordance is only attached to AI connection / weave edges, not to individual content cards.

Single call site → swap 1 has a clean blast radius.

---

## 2. Current TTS request path

[useVoiceInsight.ts:149-158](src/hooks/useVoiceInsight.ts#L149-L158):

```ts
const ttsRes = await fetch(`${mediaUrl}/api/tts`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ text: insight }),
})
if (!ttsRes.ok) {
  throw new Error(`tts HTTP ${ttsRes.status}`)
}
const blob = await ttsRes.blob()
```

### Shape

- **Method/URL:** `POST {VITE_WEAVE_MEDIA_URL}/api/tts`
- **Headers:** `content-type: application/json` only. **No `Authorization` header.** The current `/api/tts` endpoint on Fly is unauthenticated (confirmed in [media-server/src/index.ts:79-135](media-server/src/index.ts#L79-L135) — no `verifyUserToken` call). The validation doc notes this as a known issue: `voice-v2-validation.md:170`.
- **Body:** `{ text: insight }` — the insight string returned by `/.netlify/functions/voice-insight`.
- **No correlation ID** in headers or body.
- **No request-side timeout** (relies on browser default).

### Response

- Full MP3 blob, buffered in memory via `await ttsRes.blob()`. Not chunk-decoded — the entire response is read before playback starts.
- Server side: `Content-Type: audio/mpeg`, `Transfer-Encoding: chunked`, body piped from ElevenLabs (`output_format: mp3_44100_128`, model `eleven_flash_v2_5`). See [media-server/src/index.ts:102-134](media-server/src/index.ts#L102-L134). The server streams but the client buffers fully before play — the streaming nature of the response is wasted today.

### Error handling / retries / timeouts

- **No retries.** Single attempt at `/voice-insight`, single attempt at `/api/tts`. Any non-2xx → `throw` → caught by outer `try`/`catch` → `cleanupAudio()` + `flashError()` (2s "Couldn't play" state, then back to idle).
- **No timeout / `AbortController`.** A hung request would leave the button stuck in `loading` until the browser kills the socket.
- Errors go to `console.warn('[voice-insight] pipeline failed:', …)`. Nothing persisted, nothing tracked to `weave_events`.

---

## 3. Current MP3 playback abstraction

### There is no `PcmStreamPlayer`-shaped abstraction.

Playback is **inline `new Audio(url)`** inside `useVoiceInsight`. The hook itself plays the dual role of:

- Pipeline orchestrator (insight fetch → TTS fetch → playback)
- Player state machine (`'idle' | 'loading' | 'playing' | 'error'`)
- Audio resource owner (refs for the audio element + object URL)

### Surface area the hook exposes today

[useVoiceInsight.ts:198](src/hooks/useVoiceInsight.ts#L198):

```ts
return { state, trigger, stop }
```

- `state: VoiceState` — `'idle' | 'loading' | 'playing' | 'error'`
- `trigger(): Promise<void>` — toggles between fetch+play / stop / cached replay
- `stop(): void` — pause + emit `voice_insight_played` with `completed: false`

### Lifecycle internals (private to the hook)

- `audioRef: HTMLAudioElement | null`
- `audioUrlRef: string | null` (object URL — must be revoked)
- `insightLengthRef`, `totalLatencyRef`, `tapStartRef`, `playStartRef` — metric refs
- `onPlayedRef`, `buildRequestRef` — stable refs to caller-provided callbacks
- `errorTimerRef` — `setTimeout` handle for the 2s error flash

### Callbacks the hook fires

- `audio.onended` → `emitPlayed(true)` (completed listen) → `setState('idle')`
- `audio.onerror` → `flashError()`
- Optional caller-provided `onPlayed({ durationListened, completed, insightLength, totalLatency })` — wired up by EdgeDetailPopup to fire a `voice_insight_played` event (see §5).

### What this means for `PcmStreamPlayer`

There is no pre-existing player interface to match. The cleanest swap is one of:

- (A) Build `PcmStreamPlayer` as a **standalone class**, replace the inline `new Audio(...)` + `audio.play()` + `audio.onended` + `audio.onerror` block inside `useVoiceInsight` with `player = new PcmStreamPlayer(...)` and equivalent events. Keep the `{ state, trigger, stop }` external API of `useVoiceInsight` unchanged.
- (B) Branch *inside* `useVoiceInsight` on the flag — if `VITE_USE_TTS_STREAM` is true, use the new player; otherwise keep the existing `new Audio()` path. The hook's external API still doesn't change.

Either approach keeps the EdgeDetailPopup untouched (it only reads `state` and calls `trigger` / `stop`). See recommendations in the Summary.

---

## 4. Playback lifecycle and state

### Re-click during playback (same card)

`triggerVoice()` sees `state === 'playing'` → calls `stop()`. `stop()` pauses the audio, emits `voice_insight_played` with `completed: false`, and `setState('idle')`. Behaves as a Stop button. The audio element itself is **not destroyed** — `audioRef` still points to it and `audioUrlRef` still holds the object URL. The next click hits the cached-replay path (step 3 in §1).

### Click on a *different* connection mid-playback

This is more subtle and is a **latent issue worth flagging**.

In App.tsx, the popup is mounted as `{popupEdge && <EdgeDetailPopup connection={popupEdge.connection} …/>}` ([App.tsx:681-694](src/App.tsx#L681-L694)).

Clicking a different edge label calls `onLabelClick`, which does **not close the popup first** — it just calls `setPopupEdge({ connection, position })` with a new connection ([App.tsx:332-335](src/App.tsx#L332-L335)). React reuses the same `EdgeDetailPopup` instance (no `key` set) and the `useVoiceInsight` hook is **not re-instantiated**. Consequences:

- The previously-cached `audioRef` (for connection A) survives across the switch to connection B.
- Audio for connection A continues playing in the background.
- `buildRequest` updates to point at connection B's data (memoized on connection identity at [EdgeDetailPopup.tsx:386-397](src/components/EdgeDetailPopup.tsx#L386-L397)).
- If the user clicks Listen on connection B while A is still playing: state is `'playing'`, so the hook treats the click as a Stop for A. Click again → `state === 'idle'` but `audioRef.current` is still non-null → cached-replay path → **plays A's audio, not B's**.
- The only way to break the cache and get a fresh request for B is to close the popup (sets `popupEdge` to null → EdgeDetailPopup unmounts → cleanup useEffect at [useVoiceInsight.ts:188-196](src/hooks/useVoiceInsight.ts#L188-L196) runs).

This is not visible behavior under typical use (users probably close the popup before opening another), but the swap implementation should either preserve this quirk or fix it. Recommendation in the Summary.

### "Currently playing" state read by other UI

**No.** Voice state lives entirely inside the `useVoiceInsight` hook's `useState`. There is no Zustand store (grep for `zustand`/`create(` confirms — the only `create` matches are persistence helpers, not state stores). No other UI reads "is voice currently playing." No global "now-playing" indicator.

### Stop mechanism

- **Click-again-to-stop** on the same button when `state === 'playing'`. Same affordance, same button — label flips to "Stop" and the icon changes to a stop square ([EdgeDetailPopup.tsx:292-297, 350-356](src/components/EdgeDetailPopup.tsx#L292-L297)).
- **No explicit stop button** elsewhere.
- **No navigation-based cancel** — closing the popup unmounts `EdgeDetailPopup`, which fires the cleanup useEffect ([useVoiceInsight.ts:188-196](src/hooks/useVoiceInsight.ts#L188-L196)). That cleanup calls `cleanupAudio()` (pause + revoke object URL + drop refs) and, if playback was active, emits `voice_insight_played` with `completed: false`.
- **No `AbortController`** for in-flight fetches. If the popup is closed while `/voice-insight` or `/api/tts` is in flight, the request keeps running; only the audio element teardown is handled.

---

## 5. Existing observability

### What gets logged today

Two surfaces:

**(1) `console.warn` only** — three sites in `useVoiceInsight.ts`:

- [L110](src/hooks/useVoiceInsight.ts#L110) — `'[voice-insight] replay failed'` when cached `audio.play()` rejects.
- [L166](src/hooks/useVoiceInsight.ts#L166) — `'[voice-insight] audio element error'` from `audio.onerror`.
- [L179-182](src/hooks/useVoiceInsight.ts#L179-L182) — `'[voice-insight] pipeline failed:'` for any thrown error from the fetch/play chain.

These are *not* tagged through the structured `createNodeLogger` / `persist()` / `append_processing_log` pipeline. The voice flow does not own a node, so the node-scoped logger doesn't naturally fit. It just writes to the browser console.

**(2) One Supabase event** — `voice_insight_played` via `trackEvent` ([EdgeDetailPopup.tsx:409-422](src/components/EdgeDetailPopup.tsx#L409-L422)):

```ts
trackEvent('voice_insight_played', {
  boardId,
  targetId: `connection:${boardId}:${fromId}:${toId}`,
  durationMs: Math.round(metrics.durationListened * 1000),
  metadata: {
    connectionLabel, nodeIds: [fromId, toId],
    durationListened, completed, insightLength, totalLatency, mode,
  },
})
```

Fires only on `audio.onended` (completed) or `stop()` (interrupted) — i.e. only when a playback session ends. There is no event for `voice_insight_requested`, `tts_first_byte`, `tts_error`, or `tts_played` at the start of audio.

### Correlation / turn-level IDs

**None.** No `playbackId`, no `correlationId`, no `X-Request-Id`. Grep confirms:

```
$ grep -rn "playbackId\|correlationId\|X-Request-Id\|requestId" src/ media-server/src/
(no matches)
```

The only ID floating around is `sessionId = crypto.randomUUID()` in [eventTracker.ts:4](src/services/eventTracker.ts#L4), but that's per-browser-session, not per-voice-turn. There is no thread between a client click and a Fly log line today.

### Voice events in the logger taxonomy

The structured logger (`createNodeLogger`) is **node-scoped** — used by AddNodeButton, TextCardNode, and App.tsx for image / pdf / link nodes (transcript fetch, embedding, etc.). Voice events do not live in this namespace. They exist only as:

- `console.warn` lines (unstructured, client-side only)
- `voice_insight_played` rows in `weave_events` (Supabase)

No `voice.*` namespace exists. No equivalent of `tts-stream.*` exists on the client side today.

### Fly side (existing)

On `/api/tts` ([media-server/src/index.ts:79-135](media-server/src/index.ts#L79-L135)) the Pino events are minimal: `tts.config`, `tts.fetch`, `tts.upstream` — only on error paths. No success event.

On `/api/tts-stream` ([media-server/src/index.ts:137-229](media-server/src/index.ts#L137-L229)) the Pino events are richer:

- `tts-stream.config` (error: missing env)
- `tts-stream.request` (info, on every request, with `textLength`)
- `tts-stream.upstream` (info before fetch with URL; error on fetch fail; error on non-2xx)
- `tts-stream.upstream` (info on stream opened)
- `tts-stream.complete` (info on end, with `bytesStreamed`)
- `tts-stream.pipe` (error on stream-pipe error)

`req.log` is the Fastify-bound Pino instance, so each entry already carries `reqId` (Fastify's per-request id). But that `reqId` is server-internal and not echoed back to the client — the client cannot find its own request in the logs without a header-passed correlation ID.

---

## 6. Fly side — `/api/tts-stream` request handling

### Does it read a correlation ID from headers?

**No.** [media-server/src/index.ts:137-229](media-server/src/index.ts#L137-L229) reads:

- `req.headers.authorization` for the JWT
- `req.body.text` for the input

No `X-Request-Id`, no `X-Playback-Id`, no header-extracted correlation. The only request-level identifier in the logs is Fastify's auto-generated `reqId`, which the client never sees.

### Pino log events emitted

Reproducing from §5 for the Fly section:

| Phase | Level | Trigger | Notable fields |
|---|---|---|---|
| `tts-stream.config` | error | missing `ELEVENLABS_API_KEY` or `_VOICE_ID` | — |
| `tts-stream.request` | info | request received (post-validation) | `textLength` |
| `tts-stream.upstream` | info | before ElevenLabs fetch | `url` |
| `tts-stream.upstream` | error | fetch threw | `err` |
| `tts-stream.upstream` | error | non-2xx from ElevenLabs | `status`, `detail` (500-char slice) |
| `tts-stream.upstream` | info | stream opened (after ok check) | `status` |
| `tts-stream.complete` | info | nodeStream `'end'` event | `bytesStreamed` |
| `tts-stream.pipe` | error | nodeStream `'error'` event | `err` |

All carry Fastify's `reqId` automatically (default Pino-Fastify behavior).

### Phase 2 implication

To thread a client `playbackId` through Fly logs, a small Fly-side change is needed:

- Read e.g. `req.headers['x-playback-id']` at the top of the handler.
- Either bind it to a child logger (`const log = req.log.child({ playbackId })`) and use that for all subsequent logs, or include `playbackId` in each existing log call's first-arg object.
- No protocol change — the header is optional; missing → log lines just lack `playbackId` and behavior is unchanged.

This is small (one-line per log call, or one child-logger line) but it is a Fly-side change to add to the Phase 2 plan.

---

## 7. Open questions / risks

### Surprises

1. **`/api/tts` is unauthenticated; `/api/tts-stream` is JWT-gated.** Today's client doesn't send a Supabase access token for TTS. Swap 1 must add `Authorization: Bearer <token>` (same pattern as `fetchClaudeViaProxy` at [src/api/claude.ts:96-121](src/api/claude.ts#L96-L121)). This is the only path-level behavioral change beyond MP3→PCM.

2. **Streaming on `/api/tts` today is wasted.** The server pipes ElevenLabs through `Transfer-Encoding: chunked`, but the client reads `await ttsRes.blob()` — i.e. waits for the full body before playback. Swap 1's win is real: PCM via Web Audio with chunked playback is the first time the client honors the stream.

3. **Cached-audio quirk across different connections.** §4 details: clicking Listen on connection B while connection A is still cached replays A's audio rather than generating new audio for B. Today this is masked by the popup-close-before-reopen UX, but the PcmStreamPlayer rewrite is a good moment to fix it (e.g. invalidate the cached player whenever `connection` identity changes, by keying the hook or threading a connection-id into a memo).

4. **No `AbortController` anywhere in the voice path.** In-flight fetches survive popup-close. With streaming PCM, an abandoned stream that keeps reading bytes is more wasteful than an abandoned MP3 blob. Swap 1 should introduce an `AbortController` paired with the player's `stop()`.

5. **Voice events are not in the structured logger.** Today the only persisted voice signal is one Supabase event at the end. Phase 1 of swap 1 (per the validation doc, §"Observability requirements") wants first-audio latency, AudioContext transitions, underruns, and phase-tagged errors. These need a new client logger surface — probably a free-standing voice logger that emits `console.info` events tagged with `[Weave Voice]` and writes correlated rows to `weave_events`, since the existing `createNodeLogger` is node-scoped and voice has no owning node.

### Things that complicate a clean flag-gated swap

- **Cached replay**. The flag check has to wrap not just the initial fetch+play but also the cached-replay branch ([useVoiceInsight.ts:103-114](src/hooks/useVoiceInsight.ts#L103-L114)). If the user toggles the flag mid-session while audio is cached, behavior is undefined unless the player is invalidated. Probably fine to declare "flag is read once at hook init" and document the constraint.
- **The hook does both pipeline orchestration and player ownership.** A clean swap really wants the player extracted first. Two options sketched in §3 — preference goes to (A) for cleanliness, (B) for minimum diff.

### Ambiguities needing your decision before Phase 1

1. **Flag source.** Validation doc says `VITE_USE_TTS_STREAM` (env). Your prompt says `localStorage`. Env-var flag means build-time and uniform per deploy; localStorage means per-user, per-browser, runtime-toggleable. Which? (Recommendation: `localStorage` toggle that defaults to reading `VITE_USE_TTS_STREAM` — gives both build-default and per-session override.)
2. **Cached-replay quirk on connection switch — preserve, or fix as part of swap 1?** Fixing is small (key the hook on `connection.from + connection.to`); preserving is also small (no change).
3. **Player extraction.** Option (A) — standalone `PcmStreamPlayer` class with its own `play(reader, opts)`, `stop()`, `onFirstAudio`, `onEnded`, `onError` surface, swapped into `useVoiceInsight` — vs option (B) — branch inside the hook on the flag. (A) is cleaner and sets up Swap 2 (cascade streaming) better; (B) is fewer lines today.
4. **Phase 2 correlation header name.** `X-Playback-Id` (specific) or `X-Request-Id` (generic, but conventional)? My weak preference is `X-Playback-Id` because Phase 2's `/api/claude` flow will eventually want its own ID and conflating them creates confusion in Fly logs.

---

## Summary

### Observations

- The TTS surface is **small and well-contained**: one button, one hook, one call site. No drift across card types. Swap 1's blast radius is limited to `useVoiceInsight.ts` and (optionally) a new `PcmStreamPlayer` module. `EdgeDetailPopup` doesn't need to change.
- The current playback abstraction is **inline `new Audio()`**, not a named player. There is no existing interface for `PcmStreamPlayer` to match; we are introducing the abstraction.
- **The flow is observability-poor.** One per-session ID, one terminal Supabase event, three `console.warn`s. The Plato-port observability spec in `voice-v2-validation.md` cannot be satisfied by the current logger primitives — voice will need its own logger surface.
- **`/api/tts` is unauthenticated; `/api/tts-stream` is JWT-gated.** The swap is a path change *and* an auth-mode change. The Claude proxy pattern in `src/api/claude.ts` is the existing template.
- **The Fly side is in good shape.** `/api/tts-stream` already emits the right Pino events; it just doesn't read a correlation ID from headers yet. Adding one is a ~5-line change.

### Recommendations (for your decision)

- **Extract `PcmStreamPlayer` as a standalone class** (Option A in §3). The `useVoiceInsight` hook's external API (`{ state, trigger, stop }`) stays identical; only the internals swap. This sets up Swap 2 — sentence-chunked cascade streaming — for a much cleaner integration, since the player will already own the AudioContext and the queue.
- **Flag = `localStorage` with `VITE_USE_TTS_STREAM` as build default.** Lets you toggle per browser session without redeploying while still giving Netlify-deploy control.
- **Fix the cached-replay-on-connection-switch quirk as part of the swap.** Easiest: re-instantiate the player whenever `connection.from`/`connection.to` change (memoized key in the hook). Cheap insurance against a confusing UX edge case during dogfooding.
- **Introduce `AbortController` paired with `stop()`.** Required for the streaming path anyway; backport into the MP3 fallback path while we're in there.
- **Plan the Fly correlation-header change explicitly into Phase 2.** Add `playbackId = req.headers['x-playback-id']` to the `/api/tts-stream` handler, bind it to a child logger, leave header optional (no breaking change).
- **Introduce a `[Weave Voice]` client logger** in `utils/logger.ts` (or new `utils/voiceLogger.ts`) that emits structured `voice.tts.*` events to console and, on lifecycle moments (first audio, completed, error), to `weave_events`. Keep it node-agnostic since voice has no owning node.

### File is ready for review.
