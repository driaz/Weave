# Read: speculative follow-up retrieval during the silence timer

2026-11-21. Base: `origin/main` at `c4107a7` (fetched this session). Prod
numbers come from the read-only connector (session `ba766fc2`, 2026-11-20,
8 Scribe follow-up turns). Dev timings from this machine.

## Question

Can the follow-up turn's retrieval work (inline embed + node-band RPC) run
during the 1.5 s silence timer, on Scribe's partial transcript, and be reused
at commit? And why is the follow-up node-band RPC slower than the ~0.24 s the
opener comment cites?

## Premises, with file:line

| # | Premise | Where | Holds? |
|---|---------|-------|--------|
| P1 | The turn waits a fixed 200 ms VAD debounce + 1500 ms timer before commit | `src/services/voice/vadController.ts:88` (`SILENCE_TIMER_MS = 1500`), `:91` (`VAD_MIN_SILENCE_DURATION_MS = 200`), timer at `:1260–1286` | yes |
| P2 | Retrieval runs serially after the transcript: embed → deposit band → node band → manifest → Claude | `vadController.ts:1432` (`embedText`), `:1450` (await pending admissions), `:1473` (blend), `:1478` (`runRetrieval`), `:1516` (manifest), `:1527` (`runSentenceChunkedSpeech`) | yes |
| P3 | `runConversationTurn` awaits `supabase.auth.getSession()` before the fetch | `src/services/voice/conversationOrchestrator.ts:118`, marker `:122` | yes |
| P4 | Scribe partials are already streaming during the timer | partials arrive on the socket, but `sttStreamClient.ts:259` drops them ("partial_transcript and warning are not used") | **partly**: they arrive, the client throws them away. The change has to surface them. |
| P5 | The node band marks rows surfaced as a side effect | `vadController.ts:746–749` (`filterUnseen`, then `surfacedRefIds.add`), admission via returned `admit` `:750–773` | yes |
| P6 | The deposit band admits to working memory and marks surfaced as a side effect | `vadController.ts:893–915` | yes |
| P7 | The RPC itself is a pure read | `src/services/voice/retrievalContext.ts:166–190`; migration `038` is `stable security invoker` | yes |
| P8 | The utterance row reuses the inline embedding; `undefined` falls back to a background embed | `vadController.ts:1499–1506`; `voiceSessionController.ts:177–182` | yes |
| P9 | The query vector blends this turn with the prior user turn's raw vector, which only changes at the commit | `vadController.ts:1473–1476`; `retrievalContext.ts:129–135` | yes. The prior is fixed for the whole timer window, so a speculative blend equals the commit-time blend. |
| P10 | Retrieval inputs (board, anchor, connections, live node ids) are fixed for the session | `vadController.ts:251` (`private readonly opts`), never reassigned after `:336` | yes |
| P11 | Embeds and RPCs can be aborted | `@google/genai` `EmbedContentConfig.abortSignal`; PostgREST builder `.abortSignal()` | yes |

## Prod timings (ba766fc2)

`stt.source → request_sent` per follow-up turn, broken down:

| turn | textLen | embed ms | deposit band | node-band RPC ms | manifest → request_sent ms |
|------|--------:|---------:|-------------:|-----------------:|---------------------------:|
| ff6d177a | 150 | 291 | 2 | 366 | 125 |
| 942e25d2 | 834 | 435 | 1 | 914 | 773 |
| e20ae085 | 669 | 372 | 2 | 819 | 161 |
| 98bd037a | 167 | 339 | 1 | 408 | 132 |
| 578c5e0b | 381 | 386 | 1 | 715 | 174 |
| 732c86ed | 588 | 406 | 1 | 691 | 329 |
| f4ad75a5 | 87 | 344 | 1 | 408 | 82 |
| 4d840c82 | 110 | 270 | 0 | 669 | 140 |

Silence-timer starts per turn: 2, 21, 17, 4, 5, 15, 1, 1. A cancelled timer
lived 0.20–1.16 s (most 0.3–0.9 s). The final Scribe transcript arrived
70–230 ms after the timer expired.

So there is a real window. The work to hide is 0.66–1.35 s (embed + RPC), and
the window is 1.5 s plus the 70–230 ms Scribe tail.

## Why the follow-up RPC is slower than 0.24 s

Not settled. What I could rule out:

- **Database time.** `EXPLAIN ANALYZE` of `match_retrieval_context` on prod
  for this session's board (11 rows; `weave_embeddings` is 149 rows / 3.6 MB
  in total): 5 ms warm, 70 ms on a fresh connection (plpgsql compile). Not
  the 0.4–0.9 s.
- **Payload size.** The follow-up query vector is a blend of two
  float32-from-Gemini vectors, so `JSON.stringify` writes full doubles:
  66 KB, against about 31 KB at 5 significant digits (the column is
  `halfvec`, about 3.3 digits). From this machine against dev, full vs
  compact medians were 58 vs 51 ms and 70 vs 58 ms. That's a 10 ms effect,
  not 0.5 s.
- **CORS preflight.** `access-control-max-age: 3600` on PostgREST, so
  preflights are cached.
- **Network RTT.** About 10–15 ms to the Supabase edge from here, and a cold
  TLS connection costs about 30–50 ms.

Left standing: time spent in the browser, not on the wire (main-thread work,
or the auth lock that `fetchWithAuth` takes in supabase-js `2.100.0`). The
long-turn RPCs are the slow ones (834 chars → 914 ms, 669 → 819), and long
turns also leave the most work queued on the main thread right after the
commit. The 773 ms manifest → request_sent outlier is on the longest turn and
points the same way, because that span is also client-only (one
`getSession()`). Supabase sends no `Timing-Allow-Origin`, so resource timing
gives only the request's total duration. Comparing that duration with the
wall-clock await separates wire time from in-browser time. The build logs
both on `voice.retrieval.rpc_timing`, so the next real session answers this.
It reads the duration from a `PerformanceObserver`, because the performance
buffer stops recording at 250 entries, and on dev a canvas session had
already filled it before voice started.

## Design

- **Surface partials.** `SttStream` keeps the latest `partial_transcript`.
  `currentText()` returns committed segments plus the partial. `ScribeTurn`
  passes updates to the controller.
- **When to speculate.** `SPECULATION_DELAY_MS = 300` after the silence timer
  starts, then again on every partial change while the timer runs.
  Speculations are deduped on the normalized text, so a restart with no new
  words reuses the run already in flight or done. The 300 ms skips the
  shortest pauses (cancels under 0.3 s) and gives Scribe's partial time to
  catch up with the last word. Embed + RPC (median about 1.05 s) still
  finishes before the 1.5 s timer and the Scribe tail.
- **Speculation is side-effect free.** It only embeds the partial text,
  blends with the prior (P9), and fetches the RPC rows (P7). The floor, the
  novelty filter, surfaced marking, working-memory admission and the deposit
  band all run at commit, in today's order, on the speculative vector and
  rows. A discarded speculation leaves nothing behind (P5, P6).
- **Reuse at commit.** The speculation is reused only when the final
  transcript equals the speculated text after normalizing (case,
  punctuation, whitespace), and only for the same turn id. Anything else is a
  miss and runs today's serial path.
- **Utterance row.** It reuses the speculative embedding only when the raw
  texts are identical. Otherwise it passes `undefined`, so the row's
  background embed covers the exact final text (P8), off the critical path.
- **Next turn's prior.** It is the raw speculative vector.
- **Abort.** Speech resuming, a turn reset and teardown abort the in-flight
  speculation: the Gemini call through `abortSignal`, the RPC through
  `.abortSignal()`. The user-stop commit does not abort it; it is
  `take`n like a timer commit.
- **Kill switch.** `localStorage.setItem('weave.speculativeRetrieval', '0')`.
  That is also how dev gets the "before" timings.
- **Observability.** One `voice.retrieval.speculation` line per follow-up:
  outcome (hit, miss, or none), runs started, how long the speculation had
  been running at the commit, how long the commit waited for it, and the
  partial and final lengths.

## Non-goals

- The `getSession()` tail (P3) and first token → audio. Noted only.
- Compact vector serialization. Measured at about 10 ms here, so it isn't in
  this change.
- The opener path (`computeOpeningRelatedMaterial`) is unchanged.
