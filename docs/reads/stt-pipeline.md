# STT pipeline read (H2 S0, read-only)

> **Point-in-time read, 2026-11-18.** Static read of tracked files plus read-only prod queries
> through the Supabase connector (`supabase_read_only_user`, `voice_sessions.processing_log`).
> No code, prompt, proxy or logging change.
> **Repo SHA:** `eddaddf` (`origin/main` after PR #97; `git fetch` ran before the read and the
> branch sits on that commit).
> **Search space precondition:** absence claims cover tracked files at that SHA. Deployed Fly and
> Netlify code was not observed directly. The connector is taken to be scoped to prod
> (`wndfikmpifyqkgivmnwv`) per CLAUDE.md; the project ref is not readable over SQL.

## 0. Headline findings

| # | Finding |
| - | ------- |
| H1 | **Transcript wait after the turn is committed: p50 2.8 s, p90 4.3 s** on the current 16 kHz path (51 turns, 9 sessions, 11-09 to 11-17). Whisper itself is 2.6 s / 4.1 s of that. Encode is ~11 ms and the Fly hop plus upload is ~0.2 s. |
| H2 | **The wait scales with turn length.** Over all 553 turns: Whisper ms ≈ 1733 + 43 × audio seconds (r = 0.71). Turns are long: p50 28 s, p90 66 s, max 128 s. A batch call cannot get under the ~1.7 s intercept. |
| H3 | **The commit itself is 1.7 s after the user stops.** 200 ms worklet silence debounce plus the 1500 ms silence timer. So real end of speech to transcript is about **4.5 s p50 / 6.0 s p90**, and STT is 37% of the 7.5 s p50 from commit to first assistant audio. |
| H4 | **One consumer of the audio, one consumer of the transcript.** Chunks go to `chunkAccumulator` and nowhere else. The transcript is a single string consumed inside `processUserTurn`. No other module touches either. A streaming client can tap `handleAudioChunk` without disturbing the batch path. |
| H5 | **The worklet has no hard-coded sample rate.** Every duration is converted with the `sampleRate` global, and the chunk is 50 ms (800 samples at 16 kHz). The one fixed size is the 16,384-sample ring, which is 1.02 s at 16 kHz and only has to cover the 300 ms pre-roll. |
| H6 | **`STT_MIN_DURATION_MS` gates on the wrong number.** `durationMs` is Whisper's round-trip time, not the audio length. A fast response rejects a valid turn: it has happened once (06-09, an 11-word turn, Whisper answered in 466 ms). Any faster STT makes this fire constantly. |
| H7 | **Premises corrected.** `STT_BODY_LIMIT` is 24 MB, not 10 MB (10 MB is Fastify's JSON `bodyLimit`, which does not govern the multipart route). The Supabase token read is at `sttClient.ts:49-51` and the upload at `:64`. `encodeWav` is called at `vadController.ts:1307`, not ~1231. |

**Stop conditions: none fired.** The corrected premises do not change the shape of the work.

## 1. The path, end of speech to transcript in hand

### 1.1 Capture (always running)

| Step | Where |
| ---- | ----- |
| `getUserMedia` mono, with echo cancellation, noise suppression and AGC | `vadController.ts:958-965` |
| `new AudioContext({ sampleRate: 16000 })`; the browser resamples the mic into it | `vadController.ts:85`, `:978` |
| Worklet module loaded from `/voice/vad-processor.js` | `vadController.ts:76`, `:1012` |
| `AudioWorkletNode`, 1 input, 0 outputs, mono explicit | `vadController.ts:1022-1027` |
| `configure`: RMS 0.02, min speech 200 ms, min silence 200 ms, pre-roll 300 ms | `vadController.ts:87-90`, `:1035-1041` |
| Mic source connected to the node. No `start` yet: the worklet is passive during the opener | `vadController.ts:1054-1060` |

### 1.2 Worklet (`public/voice/vad-processor.js`)

- Every 128-sample quantum is copied into a 16,384-sample ring and updates an RMS EMA with a
  20 ms time constant, armed or not (`:35`, `:39`, `:156-165`).
- Armed and above threshold for `minSpeechSamples`: posts `speech_started`. On the first one of a
  turn it sets `isStreaming` and posts the last `preRollSamples` of the ring as chunk 0
  (`isPreRoll: true`) (`:169-208`).
- While `isStreaming`, it fills a 50 ms buffer and posts each full one as `audio_chunk` with a
  rising `sequence`, as a transferred `Float32Array` (`:229-248`). Streaming continues through
  silence dips until `stop`.
- Below threshold for `minSilenceSamples` while speaking: posts `silence_started` (`:211-226`).
- `stop` clears `isArmed`, `isSpeaking`, `isStreaming` and **drops the partly filled buffer**
  (`:131-138`). Up to 50 ms of tail is lost, all of it inside the 1.7 s of trailing silence.

### 1.3 Controller, during speech

| Event | Handling | Where |
| ----- | -------- | ----- |
| `speech_started` in `listening` | stamps `currentUserSpeechStartedAt`, store → `user_speaking`, resets `chunkAccumulator` and `lastSequence`, logs `voice.turn.started` | `vadController.ts:1128-1158` |
| `speech_started` mid-turn | cancels the silence timer | `:1129`, `:1160-1169` |
| `audio_chunk` | checks `sequence === lastSequence + 1` (a gap is fatal, `audio_stream_corruption`), pushes to `chunkAccumulator` | `:1199-1224` |
| `silence_started` | starts the 1500 ms silence timer | `:1175-1178`, `:86` |

### 1.4 End of speech

Two entry points, same continuation:

- **Silence timer expires** (`:1241-1263`): stamps `currentUserSpeechEndedAt`, logs
  `voice.vad.silence_timer_expired`, sends `stop` to the worklet, store → `processing_user_turn`,
  substep `stt`, calls `processUserTurn()`.
- **Stop button during `user_speaking`** (`:416-435`): same steps, logs `voice.turn.user_ended`.
  No prod turn has ever taken this path.

### 1.5 `processUserTurn` up to the transcript (`vadController.ts:1282-1376`)

1. `mergeFloat32(chunkAccumulator)` into one `Float32Array`, accumulator cleared (`:1291-1293`).
2. Empty → `voice.stt.empty_result`, re-arm, return (`:1295-1305`).
3. `encodeWav(merged, sampleRate)`: 44-byte header plus 16-bit PCM, one synchronous pass
   (`:1307`, `wavEncode.ts:10-40`).
4. Logs `voice.stt.upload_started` with `sizeBytes`, `samples`, `sampleRate` (`:1308-1313`).
5. New `AbortController` stored as `currentTurnAbort`. **The signal is not passed to
   `transcribeAudio`**: an abort is only checked after the fetch settles (`:1315-1323`).
6. `transcribeAudio` (`sttClient.ts:33-110`): `supabase.auth.getSession()` for the JWT (`:49-51`),
   multipart field `audio` (`:53-54`), headers `Authorization` and `X-Recording-Id` = turn id
   (`:56-59`), `POST https://weave-media.fly.dev/api/stt` (`:3`, `:64`). The URL is hard-coded;
   it does not read `VITE_WEAVE_MEDIA_URL`.
7. Failure → `voice.stt.failed`, `store.sttFailed`, **the whole session is torn down**
   (`:1322-1334`).
8. Success → logs `voice.stt.response_received` with `transcriptLength` and `durationMs`
   (`:1336-1344`).

### 1.6 Media server (`media-server/src/index.ts:236-369`)

1. Reads `X-Recording-Id`, verifies the Supabase JWT (`:242-255`).
2. `req.file()` then `toBuffer()`: the whole upload is buffered in memory. Over 24 MB → 413
   (`:263-289`, `sttLimits.ts:5`).
3. Builds a new multipart form: `model=whisper-1`, `response_format=json`, `temperature=0`,
   `language=en` (`:306-315`).
4. `POST https://api.openai.com/v1/audio/transcriptions`, timed as `durationMs` (`:317-334`).
5. Returns `{ transcript, durationMs }` (`:355-368`). Fly logs get `voice.stt.started` and
   `voice.stt.completed`. Those do not reach `processing_log`.

Fly config (`media-server/fly.toml`): one always-on machine, 1 shared CPU, concurrency
`type = "requests"`, soft 2, hard 4. No WebSocket plugin is installed in either package.

## 2. Where the transcript feeds the turn (`vadController.ts:1346-1497`)

All inside `processUserTurn`, in order:

| # | Consumer | Where |
| - | -------- | ----- |
| 1 | Gates: empty → reject; `durationMs < 500` or fewer than 2 words → reject | `:1346-1376` |
| 2 | `embedText(transcript)`, blocking. The vector is the retrieval query and the utterance embedding | `:1391-1401` |
| 3 | `blendQueryVectors` with the prior user turn, then `runRetrieval` | `:1435-1447` |
| 4 | `recordUtterance({ speaker: 'user', text: transcript, startedAt, endedAt, embedding })`, fire and forget | `:1457-1475` |
| 5 | `messages.push({ role: 'user', content: transcript })` | `:1476` |
| 6 | `runSentenceChunkedSpeech`: Claude, segmenter, TTS, multiplexer | `:1488-1497` |

Nothing renders the user's transcript on screen today, so there is no surface for partials.

## 3. Buffer consumers

`chunkAccumulator` (`vadController.ts:260`) is the only holder of user audio outside the worklet.

| Access | Where |
| ------ | ----- |
| Push | `:1224` |
| Read, once, by `mergeFloat32` | `:1291` |
| Reset | `:1137` (turn start), `:1292` (after merge), `:2132` (re-arm), `:2277` (teardown) |

`encodeWav` and `transcribeAudio` each have one production caller (`:1307`, `:1320`). The merged
`Float32Array` and the WAV `Blob` are locals of `processUserTurn`. Audio is never persisted.

## 4. Sample-rate assumptions

| Place | Assumption |
| ----- | ---------- |
| Worklet durations, EMA alpha, chunk size, pre-roll | derived from the `sampleRate` global (`vad-processor.js:50`, `:66`, `:95-109`) |
| Worklet ring | fixed 16,384 samples: 1.02 s at 16 kHz, 0.34 s at 48 kHz |
| `processUserTurn` | reads `audioContext.sampleRate`, falls back to 16000 (`:1290`) |
| `encodeWav` | writes whatever rate it is given |
| Server | none; passes the file through |
| Stale comment | `sttLimits.ts:3-4` still says 48 kHz and ~4.3 min. At 16 kHz (32 KB/s) the cap is ~12.5 min |

Prod log `sampleRate` values: 44100 (05-18 to 07-22), 48000 (08-09 to 11-07), 16000 (11-09 on).
A streaming STT that takes 16 kHz 16-bit PCM needs only a Float32 → Int16 conversion per chunk.

## 5. Baseline

### 5.1 Events used

All from `voice_sessions.processing_log`, joined per turn on `correlationId` (the turn id).

| Mark | Event | Clock |
| ---- | ----- | ----- |
| End of speech (commit) | `voice.vad.silence_timer_expired` `ts` | client wall clock |
| Upload start | `voice.stt.upload_started` `ts`; `detail.samples / detail.sampleRate` = audio seconds | client |
| Transcript in hand | `voice.stt.response_received` `ts`; `detail.durationMs` = Whisper round trip measured on Fly | client / Fly |
| First assistant audio | `voice.turn.processing_complete` `ts` | client |

**Headline metric = `response_received.ts − silence_timer_expired.ts`.**
`voice.vad.silence_started` is verbose-only (`voiceSessionLogger.ts:33-45`) and is not in prod
logs, so the real end of speech is not logged. It is the commit minus 1.7 s by construction
(200 ms debounce + 1500 ms timer).

### 5.2 Cardinality

557 `upload_started` = 553 `response_received` + 3 `stt.failed` + 1 with neither (the turn ended
before the fetch settled). 553 turns expected, 553 measured. 73 sessions.

### 5.3 Numbers (ms unless noted)

| Cohort | Turns | Commit → transcript p50 / p90 | Whisper p50 / p90 | Fly hop + upload p50 / p90 | Encode p50 | Audio p50 / p90 | Commit → first audio p50 / p90 |
| ------ | ----- | ---- | ---- | ---- | ---- | ---- | ---- |
| **16 kHz, 11-09 → 11-17 (current)** | 51 | **2802 / 4293** | 2609 / 4089 | 202 / 332 | 11 | 28 s / 66 s | 7481 / 9167 |
| 48 kHz, 08-09 → 11-07 | 254 | 3534 / 5650 | 3198 / 5183 | 326 / 484 | 29 | 31 s / 64 s | 7907 / 10956 |
| 44.1 kHz, 05-18 → 07-22 | 248 | 3168 / 5353 | 2606 / 4469 | 359 / 1193 | 25 | 22 s / 51 s | 7172 / 10425 |
| Last 30 days, all rates | 120 | 3460 / 5398 | 3171 / 4793 | 285 / 455 | 18 | 34 s / 72 s | 7970 / 10635 |
| All | 553 | 3325 / 5362 | 2883 / 4689 | 325 / 815 | 24 | 27 s / 58 s | 7571 / 10677 |

Whisper p50 by audio length (all 553): under 10 s → 1740; 10–30 s → 2602; 30–60 s → 3612;
60 s and over → 4604.

The current cohort is small (51 turns). The 16 kHz change cut the hop and upload by about
120 ms and did nothing for Whisper time, as expected.

### 5.4 Other things the logs show

- 5,143 silence timers started against 557 expired: about 9 pauses per turn that resume inside
  1.5 s.
- All 3 `stt.failed` are 413s (11-01, 11-07 twice), each ending its session. None since the
  16 kHz change.
- Total user audio across all 553 turns: 276 minutes in six months.

## 6. What a streaming build has to account for

Facts from the read, not a design:

1. The tap point is `handleAudioChunk` (`:1199`). Chunks arrive as 50 ms `Float32Array`s, the
   300 ms pre-roll first.
2. The commit signal exists already: silence-timer expiry or the stop button.
3. `silence_started` fires about 9 times per turn. It is available as an earlier signal.
4. The batch path can stay as a fallback at no cost, because the accumulator is untouched by a
   tap.
5. The duration gate (H6) must move to audio length (`merged.length / sampleRate`) before or with
   any faster STT.
6. A session-level socket needs closing in `teardownSession` (`:2202`) and a per-turn reset in
   `rearmWorklet` (`:2130`).
7. `voice.stt.upload_started` and `voice.stt.response_received` are what this baseline is built
   on. Keeping those names, with a mode field, keeps before and after comparable.
8. Fly's hard limit of 4 concurrent requests would count a relayed WebSocket for its whole life.
9. The existing tests on this path: `sttClient.test.ts`, `wavEncode.test.ts`,
   `vadProcessor.test.ts`, `sttLimits.test.ts`.

## 7. What this read could not do

- Vendor documentation hosts (`elevenlabs.io`, `developers.deepgram.com`,
  `developers.openai.com`) are outside the session's network allowlist. Vendor facts in the
  proposal come from web search results, not the reference pages.
- No live latency test of any streaming STT. The session's ElevenLabs credential answers
  `missing the permission speech_to_text` on the realtime token endpoint.
- Fly logs (`voice.stt.started` / `.completed`) were not read; the split between upload time and
  Fly processing inside the 0.2 s hop is not separated.
