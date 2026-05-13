# Voice v2 — Design Doc

**Status:** Design locked, implementation pending
**Last updated:** May 12, 2026
**Branch (when work begins):** `feat/voice-v2` (off `main`)

This doc consolidates the design decisions for Voice v2 — the full conversational layer that builds on Swap 1's PCM streaming infrastructure. It is the foundation for implementation prompts, not the implementation plan itself.

For prior context, see:
- `docs/voice-v2-validation.md` — PCM streaming validation reference (foundation for Swap 1)
- `docs/voice-v2-swap1-audit.md` — Phase 0 audit of the existing TTS path (Swap 1's audit)
- Memory entries: voice cadence (#10), voice insight (#9), Hume latency tolerance (#26), context architecture (#27), session UI (#28), Voice v2 plan (#21), observability (#23)

---

## 1. What we're building

A working conversational loop where the user can have a real 10-15 minute back-and-forth voice conversation with the assistant about a connection between two nodes. Substance over speed, no interruptions, clear turn-taking, end-to-end persistence.

**Architecture: cascaded (not realtime API).**

```
User speech → mic capture (browser)
            → silence detection (client VAD)
            → Whisper STT (Fly proxy)
            → Claude reasoning (existing /api/claude streaming proxy)
            → ElevenLabs TTS (existing /api/tts-stream PCM streaming)
            → PcmStreamPlayer (existing, Swap 1)
            → audio output
```

Three of the five legs are already built. Voice v2 adds the input side (mic capture + VAD + STT) and the orchestration layer that stitches everything into a turn-taking conversation.

**Why cascaded:** voice-to-voice realtime APIs (Hume, OpenAI Realtime) still have low-quality TTS compared to ElevenLabs. Memory #26 (Hume lesson): latency is acceptable when delivery is good. Cascaded preserves ElevenLabs quality at the cost of some latency.

---

## 2. MVP scope (Q7)

**The floor — what v1 must support:**

The user can:
1. Start a session from a known entry point
2. Have their mic captured when it's their turn to speak, with visual mic state indicator
3. Hear the assistant respond with low-latency PCM playback (Swap 1 architecture)
4. Continue the conversation with Claude having context from prior turns in the session
5. End the session cleanly, with persistence to Supabase

That's it. Ugly OK, polish out of scope.

**Explicitly NOT in v1:**

- Multiple turn-taking UX patterns (pick one, experiment later)
- Push-to-stop / interrupt button (no interruptions, period)
- Multi-board context, profile-snapshot narratives, cross-session memory in prompt
- Audio retention beyond what STT needs
- Tonal analysis of user audio (deferred to v1.x or later)
- Inspector panel re-listen (separate roadmap item)
- Polish: animations, sound effects, tutorial
- Multiple voices, voice picker, settings UI
- Cost monitoring / quota tracking

---

## 3. Entry point (Q4)

**Speak button on `EdgeDetailPopup`, below the existing Listen button.**

- (a) replace Listen vs (b) sit below Listen — **(b), sibling not replacement.** Listen is the MP3 control group; Speak is the new conversational path. Both work. Deletion of Listen happens later, after Voice v2 has baked.

**Session opens with the listen-content TTS as the opening turn.**

The existing connection analysis already ends with a question per memory #10 (5-7 sentence opening, sets up contrast and question). Voice v2 picks up where Listen leaves off: same TTS plays as the assistant's first turn, mic auto-opens after the question lands.

**Conversation is anchored to the connection but can wander.**

`connection_context` field on `voice_sessions` records the starting edge. Drift in conversation is fine; the anchor explains why this session existed.

**Multiple sessions per connection allowed.** Each is a new row. Inspector panel surfaces them later.

---

## 4. Turn-taking (Q1)

**Hybrid: press-to-open + press-or-silence-to-close.**

Lifecycle:
- Session starts: opening TTS plays. Mic remains closed.
- Opening TTS ends: mic **auto-opens** for the user's first turn.
- User speaks: VAD detects voice activity, mic is active.
- User stops speaking: either (a) silence detection fires after N seconds of quiet OR (b) user manually clicks the mic button to close it. Whichever comes first.
- Mic closes, user's audio is finalized and sent to STT.
- STT transcribes, Claude processes, TTS streams response.
- Assistant TTS ends: mic auto-opens again. Repeat.
- User clicks "End conversation" to terminate the session at any time.

**Why hybrid:** silence detection is the most interesting variable to tune (the experiment), but it will misjudge sometimes (coughs, thinking pauses, ambient noise). Without manual override, every misjudge breaks the conversation. With override, misjudges are recoverable.

**Auto-open during normal flow:** the press-to-open is for the *initial* mic opening (entering a session, or after a manual close). During normal conversational flow, mic just becomes available when the assistant finishes. Otherwise, click-friction reintroduces the cost we're trying to avoid.

**Professor Alan lesson (memory):** always-listening-with-mute-during-playback is empirically the wrong answer for this user — that pattern killed Professor Alan's adoption. Hybrid is *not* always-listening; it's user-initiated with auto-resume.

---

## 5. Silence detection (Q2)

**Client-side VAD, Web Audio API, RMS energy + duration threshold.**

**Why client-side, not backend:**
1. Visual feedback is instant — mic icon flips off the moment user stops talking. Backend VAD has network round-trip in this path; feels laggy regardless of conversational latency tolerance.
2. Simpler architecture — no continuous audio stream to server during user turn. Capture, detect, finalize, upload-once at turn end.

**Algorithm for v1:**

- Capture mic via `getUserMedia`
- Route through `AnalyserNode`
- Compute RMS amplitude every ~50ms
- When RMS stays below threshold for N consecutive samples = silence duration met → fire turn-end

**Starting parameters (tunable):**

| Parameter | v1 starting value | Notes |
|---|---|---|
| Energy threshold | ~-50 dB | Tune for user's mic / room. Fixed for v1 (single user, no calibration pass) |
| Silence duration | 1.5 seconds | Generous per Hume lesson — gives space for thinking pauses |
| Min recording duration | 500 ms | Prevent false turn-end before user starts speaking |

**No calibration pass in v1.** Personal tool, one user, tune for your environment. Calibration is a v1.x concern if Weave gets shared.

**Hybrid pattern is the safety net for miscalibration.** If threshold/duration is wrong, manual override recovers gracefully.

---

## 6. Conversation context to Claude (Q3)

**The system prompt is composed of named sections, not a single string.**

v1 ships with four sections; three reserved for future:

```typescript
interface SystemPromptSections {
  role: string              // What Claude is, how it behaves
  cadence: string           // 5-7 sentence opens, 3-5 follow-ups
  connectionContext: string // Edge metadata: type, strength, explanation
  nodeContent: string       // Full analyzed text of both connected nodes

  // Reserved for future, do not build in v1:
  // narrative?: string       // Profile-snapshot-derived narratives
  // sessionMemory?: string   // Prior session summaries
  // boardContext?: string    // Wider board patterns
}
```

The prompt builder assembles these into a single system prompt at the start of each Claude call. Future additions land as additional named sections — additive, never refactor.

**Cadence is mode-selected at composition time.** Opening turns (no prior assistant message in `messages[]`) need a different cadence than follow-up turns — 5-7 sentence analytical arc vs. 2-3 sentence dialogue. Rather than expand the schema to two cadence slots, the prompt builder reads the appropriate cadence file at composition time: `cadence-opening.txt` when `messages[]` is empty, `cadence-followup.txt` otherwise. The schema interface stays clean; the file structure carries the mode distinction.

**Messages array holds the evolving conversation:**

```
system: <composed sections>
assistant: <opening analysis text (the listen-content TTS)>
user: <transcribed turn 1>
assistant: <Claude response 1>
user: <transcribed turn 2>
assistant: <Claude response 2>
...
```

The opening assistant message is the same text that was played via TTS at session start. This means Claude has the opening in its context as its "prior turn" and can build naturally on it.

**Context size projection:**
- 20-30 turns over 10-15 minutes
- User turns ~1-3 sentences each (transcribed speech is bursty/short)
- Assistant turns 5-7 sentence opening + ~2-3 sentence follow-ups
- Plus opening analysis + edge metadata + two nodes' analyzed content
- Estimated total: 10-25K tokens by session end
- Well within Claude Opus 4.7's context window. **No summarization needed in v1.**

**Per memory #26 (Hume lesson):** Claude context can be richer + `max_tokens` generous. The latency cost of more context is acceptable for substance.

---

## 7. Session UI shape (Q5)

**Floating session card, bottom-right corner.**

- Position: bottom-right corner of viewport, ~24px from edges
- Size: ~320 × 220 px
- Appears when Speak is clicked, slides up / fades in
- Disappears on session end
- Does not interfere with EdgeDetailPopup (different region of screen)
- Canvas remains fully visible and browsable during session

**Why bottom-right floating, not modal / sidebar / in-place:**

The conversation can wander, and the canvas is *thinking material*. The user might want to mention "this reminds me of that other connection over there" and benefit from being able to look at it. Anything that covers ≥30% of canvas (modal, sidebar) reduces conversational depth. A small floating card preserves canvas access while voice runs.

**Sidebar (Option B) reserved as A/B alternate.** If floating card feels disconnected from the canvas focus in practice, sidebar is the fallback. Likely path forward if Inspector panel adopts a right-sidebar pattern and unification makes sense.

**Card contents (top to bottom):**

1. **Header strip** (minimal): small label like "Conversation" + X close affordance in top-right corner
2. **State indicator**: clear visual showing current state — `assistant speaking` / `your turn` / `processing`
3. **Mic indicator** (centerpiece, 60-70% of card real-estate): large visual element. Closed state = muted, possibly with assistant-audio waveform animation. Open state = active accent color, with user audio level meter. Processing state = neutral, subtle pulsing.
4. **Hybrid button**: tap to toggle mic. Adaptive label based on state.
5. **End conversation** affordance: separate from the X close in header. Smaller / less prominent than mic, but unambiguous.

**Mic indicator carries visual weight even though card is small.** The card is a compact container; the mic visual inside it is unmistakably the centerpiece. This prevents the "trivial music-player widget" feel.

**No transcript display in v1.** Reading interferes with listening — research shows redundant modality channels degrade attention to both. The conversation lives in audio. QA happens via console logs; readable session history is Inspector panel's job later.

**Three mic states must be instantly distinguishable** — Professor Alan failure mode was partly about ambiguous mic state.

---

## 8. Persistence (Q6)

**Schema: `voice_sessions` (modified) + `voice_turns` (new).**

Memory #25 (audio quality gap) and the conversation today established this. The existing `voice_sessions` table was designed for a realtime API architecture (single audio file, single transcript document) that we've moved away from. The cascaded architecture produces N discrete recordings + N TTS playbacks = relational shape.

**Migration shape (write at Voice v2 implementation start, not now):**

```sql
-- voice_sessions: keep most fields, drop audio_url + transcript (now derived)
-- Add pipeline + ux_pattern for experimentation tagging

ALTER TABLE voice_sessions
  ADD COLUMN pipeline text NOT NULL DEFAULT 'cascaded_v1',
  ADD COLUMN pipeline_config jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN ux_pattern text NOT NULL DEFAULT 'hybrid_v1';

-- (audio_url and transcript columns can stay for now if dropping is risky;
-- they'll just be NULL going forward. Decide at migration time.)

CREATE TABLE voice_turns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES voice_sessions(id) ON DELETE CASCADE,
  ordinal int NOT NULL,
  kind text NOT NULL CHECK (kind IN ('user', 'assistant')),
  text text,                  -- transcribed user speech OR assistant TTS source
  audio_url text,             -- recording URL (user turns), null for assistant (ephemeral)
  events jsonb NOT NULL DEFAULT '[]'::jsonb,  -- per-turn debug telemetry
  started_at timestamptz NOT NULL,
  ended_at timestamptz
);

CREATE INDEX voice_turns_session_id_idx ON voice_turns(session_id);
CREATE INDEX voice_turns_session_ordinal_idx ON voice_turns(session_id, ordinal);

-- RLS: turns inherit through session
ALTER TABLE voice_turns ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users can read own turns"
ON voice_turns FOR SELECT
USING (EXISTS (
  SELECT 1 FROM voice_sessions s
  WHERE s.id = voice_turns.session_id
  AND s.user_id = auth.uid()
));
-- Same shape for INSERT/UPDATE/DELETE.
```

**Persistence timing: per turn, not batched.**

When user finishes speaking → write `voice_turns` row (`kind: 'user'`, `text: transcript`, `ordinal: N`).
When assistant finishes → write `voice_turns` row (`kind: 'assistant'`, `text: response`).

Reasoning: losing a 10-minute conversation to a browser crash would be infuriating. Per-turn writes are cheap and the latency tolerance principle (#26) covers any minor delay.

**Audio retention:**
- User recordings: persist via `audio_url` (decide storage: Supabase Storage vs. Fly disk vs. S3 at implementation time)
- Assistant TTS audio: **do not persist** in v1. The *text* the user heard is the persistent record. Audio is ephemeral.

**Session lifecycle:**
- `started_at` set on Speak click
- `ended_at` set on End conversation click (or page close, or session timeout)

---

## 9. Dev loop (Q8)

**Prompts as files; thin smoke-test runner.**

`role` and `cadence` text live as raw files in the repo, imported at runtime via Vite's `?raw` import. This is the production shape — Voice v2 reads these files at session start to compose the system prompt.

```
prompts/
  role.txt
  cadence-opening.txt
  cadence-followup.txt
```

A thin runner (`scripts/voice-prompt-test.ts`, ~80 lines) loads these files plus a JSON fixture, calls the existing `/api/claude` streaming proxy, prints Claude's tokens as they stream, and prints a final block with TTFT, total latency, token count, and stop reason.

```
fixtures/
  opening.json          # empty messages[], triggers opening cadence
  mid-conversation.json # 4-6 messages, triggers follow-up cadence
```

Run: `npm run voice:prompt-test -- --fixture mid-conversation`

**Framing: this is a smoke test, not an evaluation environment.** It catches structural failures (prompt syntactically broken, Claude generating 6 sentences when cadence says 2-3, role drifting into therapy-speak) before live testing. Audio quality, conversational feel, and turn-shape evaluation happen in the live app — text output cannot evaluate those.

**Why the runner pays for itself despite being smoke-test-only:** the file structure isn't disposable. The same `prompts/*.txt` files load at runtime in Voice v2. The runner is a thin debugging entry point against the same files the live app uses. Edit a prompt, smoke-test in the runner, then load the live app to evaluate audio.

**Latency note:** the runner measures Claude's TTFT and streaming time in isolation. Useful sanity-check (e.g., catching prompt bloat that adds 200ms to TTFT) but not the conversational-feel metric — that's the sum of STT + Claude + TTS-first-audio and only the live app surfaces it.

**Tool #2 and Tool #3: skip.** VAD test page and session-card preview were considered and cut. Same reasoning as before: VAD's hybrid pattern is the safety net for imperfect tuning, session card iterates fast enough via React fast refresh.

---

## 10. Observability requirements

Voice v2 extends Swap 1's observability foundation. Memory #23 (Plato lesson) establishes the principle: build observability *during* integration, not after. Cascaded streams fail *between* streams; you need logs to debug.

**Correlation hierarchy (forward-compatible from Swap 1's playbackId):**

```
sessionId   -- one row in voice_sessions, spans entire conversation
├─ recordingId  -- one user turn (mic open to close)
└─ playbackId   -- one assistant TTS playback (already minted in Swap 1)
```

All three are sibling fields on event records, not nested. Events carry whichever IDs apply to that event's scope.

**v1 event taxonomy (extends Swap 1's `voice.playback.*`):**

- `voice.session.started`, `voice.session.ended`
- `voice.recording.started`, `voice.recording.firstCapture`, `voice.recording.ended`
- `voice.stt.started`, `voice.stt.completed`, `voice.stt.error`
- `voice.claude.started`, `voice.claude.firstToken`, `voice.claude.completed`, `voice.claude.error`
- `voice.playback.*` — already shipped in Swap 1

**Headline KPIs to watch:**

- **Turn-to-turn latency** — from `recording.ended` to `playback.firstAudio`. The "did this feel like a conversation" metric.
- **Audible latency per turn** — already tracked in Swap 1 (`playback.firstAudio.audibleLatencyMs`).
- **STT round-trip time** — `stt.completed.ts - stt.started.ts`.
- **Claude time-to-first-token** — `claude.firstToken.ts - claude.started.ts`.

**Persistence:** Per Swap 1 pattern, events flow through `logVoicePlaybackEvent`-style stub functions to console in v1. The function gets a body swap when Voice v2 wires per-turn writes — events go into `voice_turns.events jsonb` for the turn they belong to.

---

## 11. Audio quality decisions parked here

Per memory #25, PCM at 24kHz (current ElevenLabs Creator tier ceiling) sounds noticeably less clear than MP3 at 44.1kHz. Voice v2 will surface this tension in the conversational use case — the question is whether Creator-tier tuning (model swap, voice settings, voice selection) gets PCM "acceptable enough for conversation," or whether Pro tier ($99/mo) becomes worth it.

**Decision: defer audio tuning until Voice v2 is exercising real conversations.**

Test Voice v2 with current settings (Turbo 2.5 + pcm_24000) first. If conversational use reveals the quality gap is intolerable, run the tuning levers from memory #25:

1. Model swap (Turbo 2.5 → Multilingual v2 or similar quality tier)
2. Voice settings (stability / similarity_boost / style)
3. Voice selection
4. Pro tier upgrade as final lever

Memory the data from real conversations to inform the call.

---

## 12. What's already shipped

For reference, so we know what to build *on top of* and what to leave alone:

- **PCM streaming TTS** (Swap 1): `PcmStreamPlayer`, `/api/tts-stream`, `X-Playback-Id` header threading, `voice.playback.*` event taxonomy
- **Claude streaming proxy**: `POST /api/claude` on weave-media, JWT-gated, SSE
- **Auth + JWT verification pattern**: established in `src/api/claude.ts` and used by `/api/tts-stream`
- **Debug logger Parts 1-2**: shared event shape, `createNodeLogger`, `persist()` to `processing_log` jsonb, `append_processing_log` RPC

What Voice v2 adds:
- Mic capture, client-side VAD, audio finalization
- Whisper STT integration (new Fly route + client wiring)
- Session lifecycle orchestration (state machine for turn-taking)
- Floating session card UI
- System prompt composition (named sections)
- Migration: `voice_sessions` modification + `voice_turns` creation
- Per-turn persistence
- Event taxonomy extensions

---

## 13. Open questions for implementation phase

These are things deliberately left open because they're better answered during implementation than upfront:

1. **Storage location for user audio recordings** — Supabase Storage, Fly disk, S3, something else? Cost and latency tradeoffs to weigh.
2. **Whisper integration shape** — direct OpenAI Whisper API call from Fly, or self-hosted via faster-whisper, or browser-based via Whisper.cpp WASM? Tradeoffs around latency, cost, reliability.
3. **Exact mic indicator visual design** — needs design pass when card component is being built.
4. **State machine modeling** — explicit state library (xstate?) vs. ad-hoc React state? Probably ad-hoc for v1.
5. **Error recovery behaviors** — what happens if STT fails mid-session? Claude times out? Network blip? Define on a per-failure basis during implementation.
6. **Initial text for `role`, `cadence-opening`, and `cadence-followup`** — drafted in design conversation, committed alongside the runner, then iterated live. Starting material is in memory entries #9 (role: analytical observer, non-mirroring) and #10 (cadence: 5-7 sentence opens, 2-3 sentence follow-ups).

---

## 14. Implementation phasing (preview, not commitment)

A rough sketch of what implementation phases might look like, to give a sense of the work ahead. The actual phasing gets refined when implementation prompts are drafted.

- **Phase 0:** Audit existing code (similar to Swap 1 Phase 0). Map all touchpoints in `useVoiceInsight`, `EdgeDetailPopup`, related state, existing TTS flow.
- **Phase 1:** Schema migration (`voice_sessions` modification + `voice_turns` creation, RLS policies, indexes).
- **Phase 2:** Commit initial `prompts/role.txt`, `prompts/cadence-opening.txt`, `prompts/cadence-followup.txt` files. Build the smoke-test runner (`scripts/voice-prompt-test.ts`) and minimal fixtures. Smoke-test the initial prompt text — confirm Claude isn't producing structurally broken output. *Audio-level iteration happens in Phase 10, not here.*
- **Phase 3:** Build the prompt composition module (`buildSystemPrompt({ role, cadence, connectionContext, nodeContent })`) and the Claude conversation orchestrator (handles message history, calls `/api/claude`, manages streaming).
- **Phase 4:** Build Whisper STT integration (Fly route + client upload wiring + event taxonomy).
- **Phase 5:** Build mic capture + client VAD module. Test with hybrid manual override only initially, then enable silence detection.
- **Phase 6:** Build session state machine — the orchestrator that ties everything together.
- **Phase 7:** Build floating session card UI. Wire to state machine.
- **Phase 8:** Wire Speak button into EdgeDetailPopup. Per-turn persistence.
- **Phase 9:** End-to-end QA. First real 10-15 min conversation.
- **Phase 10:** Iterate based on actual conversational feel. This is where audio-level prompt tuning happens — `role` and `cadence` files get edited, hot-reloaded in the live app, evaluated by hearing the result. Also tune VAD threshold and any other live-only parameters. Smoke-test runner remains available throughout for structural regression checks.

Each phase produces its own commits on `feat/voice-v2`. Phases are commits-on-a-branch, not separate branches, same pattern as Swap 1.

---

## 15. Decision audit trail

For each design decision, the reasoning is captured above. Summary of the most consequential choices:

| Decision | Choice | Key reasoning |
|---|---|---|
| Architecture | Cascaded (not realtime API) | ElevenLabs quality > realtime convenience (Hume lesson) |
| Turn-taking pattern | Hybrid (press-to-open + press-or-silence-to-close) | Silence detection is the experiment; manual override is safety net |
| Mic auto-open after assistant turns | Yes | Avoid click friction during normal flow |
| Silence detection location | Client-side (Web Audio API) | Instant UI feedback; simpler architecture |
| Session UI shape | Floating card, bottom-right | Preserve canvas visibility (thinking material) |
| Transcript display | None | Reading interferes with listening |
| Schema shape | Sessions + turns (relational) | Cascaded architecture produces per-turn artifacts |
| Persistence timing | Per turn | Crash resilience > write efficiency |
| Audio retention | User recordings yes, assistant TTS no | Text is the persistent record |
| Dev tooling scope | Smoke-test runner over prompt files | Production prompt structure; runner is thin entry point |
| Audio quality tuning | Deferred to during Voice v2 testing | Need real conversational use to evaluate |

---

## 16. References

- `docs/voice-v2-validation.md` — PCM validation work that grounded Swap 1
- `docs/voice-v2-swap1-audit.md` — Phase 0 audit of TTS path
- `src/services/pcmStreamPlayer.ts` — playback module shipped in Swap 1
- `src/hooks/useVoiceInsight.ts` — current TTS hook, will be extended for Voice v2
- `src/components/EdgeDetailPopup.tsx` — entry point host for the Speak button
- `media-server/src/index.ts` — Fly routes (Claude streaming, TTS streaming)
- `src/api/claude.ts` — JWT pattern reference

Relevant memory entries (numbered as of May 12, 2026):
- #7 — Roadmap (Voice v2 as next item)
- #9 — Voice insight (3-5 sentences for arguments with arc)
- #10 — Voice cadence (5-7 sentence openings, 2-3 follow-ups)
- #21 — Voice v2 plan (original framing)
- #23 — Observability (build during integration, not after)
- #25 — PCM audio quality gap (Creator tier constraints)
- #26 — Latency tolerance (Hume lesson)
- #27 — Context architecture (named sections, not single string)
- #28 — Session UI (floating card, no transcript)
