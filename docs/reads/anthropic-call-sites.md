# F0 — Anthropic call-site preflight (read-only)

> **Point-in-time read, 2026-09-16.** Static read of the working tree only. No code, env var, prompt,
> or logging change. No stage-2 execution, no snapshot run, no database connection.
> **Repo SHA:** `c67fe70` (`origin/main` after PR #50; `git fetch` ran before the branch was cut —
> local `main` was 3 commits behind and was not used).
> **Search space precondition:** every claim of absence below is a claim about tracked files at that
> SHA. Deployed Fly / Netlify state and env vars on those hosts were not observed.
>
> **Findings in this document decay; the search map in §6 does not.**

## 0. Headline findings

| # | Finding |
| - | ------- |
| H1 | **The voice turn is not on Opus 4.6.** `conversationOrchestrator.ts:8` pins `claude-opus-4-7`. The dispatch premise ("swap from Opus 4.6") holds only for connection analysis (`src/api/claude.ts:12`) and the offline deposit summarizer (`scripts/summarizeVoiceSession.mjs:71`). |
| H2 | **Model strings are literals in 8 places**, across 3 distinct ids. Only stage 2 has a single named home (`netlify/lib/stage2/models.mjs:3-4`). Table in §2b. |
| H3 | **No runtime call site sends `thinking`, `output_config.effort`, or any budget.** The only site that sends `thinking` is the offline summarizer script (`{ type: 'adaptive' }`, line 186). No site anywhere sends effort. |
| H4 | **Two different handlers answer to `/api/claude`.** The Fly one (`media-server/src/index.ts:257`) is what the client uses. The Netlify one (`netlify/functions/claude-proxy.ts:46`) has no caller in the repo, checks no auth, and forwards the body verbatim. |
| H5 | **More than four surfaces exist.** Beyond voice / theme v2 / narrative v2 / connections: narrative title, voice-insight, tweet description, YouTube description, and three offline scripts. Reported per the stop condition; read continued. |
| H6 | **Time-to-first-chunk for a voice turn is not derivable today.** No event or log line marks Claude request start or first delta. Nearest brackets in §4. |
| H7 | **Token usage is recorded for exactly one surface** (connection analysis, in `weave_events`). Voice turns and all of stage 2 discard `usage`. |

Every request body below is built from static constants plus runtime *content* (system string, messages).
No `model`, `max_tokens`, `thinking`, or `stream` value is computed at runtime, so the
"cannot be determined statically" stop condition did not fire on any item.

## 1. Call-site inventory

Cardinality check. Expected, derived from literals: 10 `api.anthropic.com` URL literals + 2 Fly
`PROXY_URL` literals = **12**. Processed, derived from `fetch(` sites that target either: **12**. Match.

| # | Purpose | Fetch site | Invocation path | Runtime? |
| - | ------- | ---------- | --------------- | -------- |
| 1 | **Voice V2 turn** (opening + follow-up) | `src/services/voice/conversationOrchestrator.ts:99` | browser → Fly `/api/claude` (site 4) → Anthropic. Sole caller: `vadController.ts:1967` | yes |
| 2 | **Connection analysis** (weave / deeper / tensions), proxied | `src/api/claude.ts:104` | browser → Fly `/api/claude` (site 4) → Anthropic. Taken when `VITE_ANTHROPIC_API_KEY` is unset (`claude.ts:471-472`) | yes |
| 3 | Connection analysis, direct | `src/api/claude.ts:532` | browser → Anthropic directly, with `anthropic-dangerous-direct-browser-access`. Taken when `VITE_ANTHROPIC_API_KEY` is set | yes (local-key path) |
| 4 | **Fly streaming proxy** upstream leg | `media-server/src/index.ts:272` | Fly → Anthropic. Serves sites 1 and 2 | yes |
| 5 | Netlify proxy upstream leg | `netlify/functions/claude-proxy.ts:21` | Netlify → Anthropic. **No caller in `src/`, `netlify/`, `media-server/`, or `scripts/`** | deployed, uncalled from repo |
| 6 | **Theme v2** (stage 2a), one call per cluster | `netlify/lib/stage2/claude.ts:17` via `extract-snapshot-themes.ts:123` | Netlify function direct. Route `/api/extract-snapshot-themes` (`:171`). No caller in `src/` | yes |
| 7 | **Narrative v2** (stage 2b) | same fetch site, via `generate-snapshot-narrative.ts:161` | Netlify function direct. Route `/api/generate-snapshot-narrative` (`:215`). No caller in `src/` | yes |
| 8 | Narrative **title** | same fetch site, via `generate-snapshot-narrative.ts:173` | same function, best-effort second call | yes |
| 9 | **Voice insight** (connection reflection, pre-V2 voice path) | `netlify/functions/voice-insight.ts:144` | browser (`useVoiceInsight.ts:141`, `:251`) → Netlify function → Anthropic | yes |
| 10 | **Tweet description** | `netlify/lib/tweetDescription.ts:97` | browser (`linkEnrichment.ts:363`) → `generate-tweet-description` → Anthropic. Also Fly (`media-server/src/description.ts:58`, via `WEAVE_NETLIFY_FN_URL`) and `scripts/sweep-corpus-embeddings.mjs` → same Netlify function | yes |
| 11 | **YouTube description** | `netlify/lib/youtubeDescription.ts:58` | browser (`linkEnrichment.ts:305`) → `generate-content-description` → Anthropic. Also `netlify/functions/backfill-youtube-descriptions.ts:134` and `scripts/backfill-youtube-descriptions.ts:224` | yes |
| 12 | Theme, offline script | `scripts/run-themes.mjs:48` | terminal → Anthropic | offline |
| 13 | Narrative, offline script | `scripts/run-narrative.mjs:52` | terminal → Anthropic | offline |
| 14 | Voice-session deposit summary | `scripts/summarizeVoiceSession.mjs:176` | terminal → Anthropic | offline |

Rows 6–8 share one fetch site, so 14 logical surfaces map onto 12 fetch sites.

No Anthropic SDK is installed (`package.json`, `media-server/package.json`: no `anthropic` entry). Every
site is raw `fetch` with `anthropic-version: 2023-06-01`. No site sends an `anthropic-beta` header.
`supabase/` contains migrations only; there are no edge functions.

## 2. Request body per call site

### 2a. Bodies

| # | `model` sent | Defined at | `max_tokens` | `thinking` / effort / budget | `stream` | System prompt source |
| - | ------------ | ---------- | ------------ | ---------------------------- | -------- | -------------------- |
| 1 Voice turn | `claude-opus-4-7` | literal const `MODEL`, `conversationOrchestrator.ts:8` | 2048 (`MAX_TOKENS`, `:9`) | **none sent** | `true` (`:110`) | Opening: caller-assembled override from `vadController.ts:544`. Follow-up: `buildSystemPrompt` (`buildSystemPrompt.ts:40`) over `prompts/role.txt` + `prompts/cadence-opening.txt` or `prompts/cadence-followup.txt` + runtime context blocks |
| 2 Connections, proxied | `claude-opus-4-6` | literal const `MODEL`, `src/api/claude.ts:12` | 4096 (inline literal, `:522`) | **none sent** | not in client body; **forced `true` by Fly** (`index.ts:279`). Client consumes SSE via `consumeAnthropicStream` (`claude.ts:27`) | `getSystemPrompt(mode)` (`:439`) → `WEAVE_PROMPT` / `GO_DEEPER_PROMPT` / `FIND_TENSIONS_PROMPT` (`:131`, `:143`, `:155`) |
| 3 Connections, direct | same const | same | 4096 | none sent | absent (non-streaming JSON) | same |
| 6 Theme v2 | `claude-opus-4-7` | `STAGE2_MODEL`, `netlify/lib/stage2/models.mjs:3`; default in `claude.ts:25` | 1024 (`THEME_MAX_TOKENS`, `prompts.ts:76`) | none sent | absent | `THEME_SYSTEM_PROMPT_V2` (`prompts.ts:8`) |
| 7 Narrative v2 | `claude-opus-4-7` | `STAGE2_MODEL` | 2048 (`NARRATIVE_MAX_TOKENS`, `prompts.ts:77`) | none sent | absent | `NARRATIVE_SYSTEM_PROMPT_V2` (`prompts.ts:34`) |
| 8 Title | `claude-sonnet-4-6` | `TITLE_MODEL`, `models.mjs:4` | 150 (`TITLE_MAX_TOKENS`, `prompts.ts:74`) | none sent | absent | empty string; instruction rides in the user turn via `TITLE_PROMPT_TEMPLATE` (`prompts.ts:69`) |
| 9 Voice insight | `claude-opus-4-7` | literal const `CLAUDE_MODEL`, `voice-insight.ts:10` | 500 (`CLAUDE_MAX_TOKENS`, `:11`) | none sent | absent | inline `SYSTEM_PROMPT` (`voice-insight.ts:13`) |
| 10 Tweet description | `claude-sonnet-4-6` | literal const `CLAUDE_MODEL`, `tweetDescription.ts:17` | 400 (`:18`) | none sent | absent | inline `SYSTEM_PROMPT` (`tweetDescription.ts:20`) |
| 11 YouTube description | `claude-sonnet-4-6` | literal const `CLAUDE_MODEL`, `youtubeDescription.ts:13` | 400 (`:14`) | none sent | absent | inline `SYSTEM_PROMPT` (`youtubeDescription.ts:22`) |
| 12 run-themes | `claude-opus-4-7` | `STAGE2_MODEL`, re-aliased `run-themes.mjs:27` | 1024 (inline literal, `:57`) | none sent | absent | inline `SYSTEM_PROMPT` in the script (`:29`). **Not** `THEME_SYSTEM_PROMPT_V2` |
| 13 run-narrative | `claude-opus-4-7` | `STAGE2_MODEL`, re-aliased `run-narrative.mjs:27` | 2048 (inline literal, `:61`) | none sent | absent | inline `SYSTEM_PROMPT` in the script (`:29`). **Not** `NARRATIVE_SYSTEM_PROMPT_V2` |
| 14 Deposit summary | `claude-opus-4-6` | literal const `MODEL`, `summarizeVoiceSession.mjs:71` | 16000 (inline literal, `:185`) | `thinking: { type: 'adaptive' }` (`:186`). No effort | absent | file `prompts/voiceSessionSummary.txt` (`:137`) |

Sites 4 and 5 are pass-throughs and build no body of their own; see §3.

No site sends `temperature`, `top_p`, `top_k`, `tools`, `tool_choice`, `cache_control`, `output_config`,
an assistant prefill, or `fallbacks`.

### 2b. Model-string literals (the "every constant once, named" check)

| Model id | Literal at | Count |
| -------- | ---------- | ----- |
| `claude-opus-4-7` | `conversationOrchestrator.ts:8`, `voice-insight.ts:10`, `stage2/models.mjs:3` | 3 |
| `claude-opus-4-6` | `src/api/claude.ts:12`, `summarizeVoiceSession.mjs:71` | 2 |
| `claude-sonnet-4-6` | `tweetDescription.ts:17`, `youtubeDescription.ts:13`, `stage2/models.mjs:4` | 3 |

Eight literals, three ids, one shared module (`models.mjs`) covering two of the eight. No model id is
read from an env var anywhere. Related duplicates: the Fly `PROXY_URL` literal appears twice
(`claude.ts:11`, `conversationOrchestrator.ts:7`), the Anthropic URL ten times, and
`anthropic-version` nine times as a bare string against one named constant (`stage2/claude.ts:6`).
Stage-2 `max_tokens` values are named in `prompts.ts` but repeated as bare numbers in the two scripts.

### 2c. What "no thinking param" means per current model (API fact, not a recommendation)

Source: Anthropic API reference, model table cached 2026-06-24.

| Model on the site today | Behaviour when `thinking` is omitted | Default effort when omitted |
| ----------------------- | ------------------------------------ | --------------------------- |
| `claude-opus-4-7` (voice, stage 2, voice-insight) | runs **without** thinking | `high` |
| `claude-opus-4-6` (connections) | runs without thinking | `high` |
| `claude-fable-5-1` (candidate) | thinking is **always on**; omitting the param runs adaptive; `{type:'disabled'}` and `budget_tokens` return 400 | `high`; `low` and `medium` must be sent explicitly as `output_config.effort` |

So the current effort/thinking configuration on the primary candidate (site 1) is: **no thinking, effort
unspecified**. Two further static facts about site 1's consumer: the SSE parser yields only
`content_block_delta` events whose delta type is `text_delta` (`conversationOrchestrator.ts:147-151`) and
returns `null` for every other event type, and it throws only on `error` events or a missing
`message_stop`. It does not read `stop_reason`.

## 3. Proxy shape

| Question | Fly `/api/claude` (`media-server/src/index.ts:257-301`) | Netlify `/api/claude` (`claude-proxy.ts`) |
| -------- | ------------------------------------------------------- | ------------------------------------------ |
| Auth | Supabase bearer token, `verifyUserToken` (`:258-263`) | **none** |
| Accepts `model` from client body? | **Yes.** Body is spread verbatim: `{ ...body, stream: true }` (`:279`) | Yes. Raw request text forwarded (`:19`, `:28`) |
| Overrides `model` server-side? | No | No |
| Allowlist on `model`? | **No.** Any model id the API key can reach is accepted | No |
| `thinking` / `output_config` / effort | **Passed through untouched.** No key of the body is inspected, stripped, or defaulted | Passed through untouched |
| `max_tokens` cap server-side? | No | No |
| Fields it forces | `stream: true` only | none |
| Headers it sets upstream | `x-api-key`, `anthropic-version`, `content-type`. Client cannot supply `anthropic-beta`; none is sent | same three |
| Response | pipes upstream SSE body straight through (`:295-300`); buffering disabled via `X-Accel-Buffering: no` | buffers whole response, returns JSON (`:31-36`). Cannot stream |
| Body validation | must be a JSON object (`:265-268`); Fastify `bodyLimit` 10 MB (`:35`) | none |

Consequence for an experiment, stated as fact: a model or effort change on sites 1 or 2 is a
client-bundle change only. The Fly server needs no redeploy for the body to reach Anthropic, and it
would not block one either.

## 4. Observability — time to first chunk on a voice turn

**Answer: no.** No record exists today from which time-to-first-chunk can be derived.

| Source | What exists | Why it does not answer the question |
| ------ | ----------- | ----------------------------------- |
| Fly logs, `/api/claude` | Handler logs only failures: `phase: 'claude.fetch'` (`index.ts:282`) and `phase: 'claude.upstream'` (`:288-291`). Success path logs nothing of its own. Fastify `logger: true` (`:35`) emits its default `incoming request` / `request completed` pair with `responseTime` | `request completed` on a piped stream marks the end of the response, not the first byte. No first-byte line, no turn id on the request (unlike `/api/stt`, which reads `X-Recording-Id`, and `/api/tts-stream`, which reads `X-Playback-Id`) |
| `weave_events` | Voice persists only `voice.session.started` and `voice.session.ended` (`voiceSessionLogger.ts:47-50`) | No per-turn rows at all |
| `voice_sessions.processing_log` | Every non-verbose voice event, each with a wall-clock ISO `ts` and the turn `correlationId` (`voiceSessionLogger.ts:112-121`) | No event is emitted at Claude request start or at first delta. The stream loop (`vadController.ts:1967-1979`) logs nothing per chunk |

Nearest existing brackets inside `processing_log`, for one follow-up turn:

| Bracket | Event | Site | What it actually measures |
| ------- | ----- | ---- | ------------------------- |
| Before | `voice.stt.response_received` | `vadController.ts:1259-1260` | STT done. Inline embedding and retrieval (`:1342`, `:1358`) still run between this and the Claude fetch |
| Before, closer | `voice.turn.context_manifest` / `voice.retrieval.band` | `:857`, `:646` | Context assembled. Still precedes `supabase.auth.getSession()` and the fetch |
| After | first `voice.tts.segment_requested` with `sequence: 0` | `:1624` | First **complete sentence** out of the segmenter, not first chunk. Overstates first-token latency by the time to generate one sentence |
| After, verbose only | `voice.segmenter.emitted` | `:1703` | Same moment; suppressed unless `localStorage weave.voice.logLevel = 'verbose'` (`voiceSessionLogger.ts:33-45`) |
| End-to-end | `voice.turn.processing_complete` carrying `scheduledLatencyMs`, `audibleLatencyMs` | `:1757-1765` | First audible audio. Includes Claude first sentence + TTS first bytes + mux prebuffer |

So an upper bound on (retrieval tail + auth + Claude time-to-first-sentence) is derivable per turn from
`processing_log` timestamps, joined on `correlationId`. First-chunk latency itself is not.
Opening turns have no STT bracket; their only "before" marker is `voice.turn.started` (`:555`).

For contrast, connection analysis records `apiLatencyMs` (`claude.ts:527`, `:567`), but that is
whole-response wall time, not first token.

## 5. Cost surface

| # | Surface | Tokens recorded? | Where |
| - | ------- | ---------------- | ----- |
| 1 | Voice turn | **No.** The SSE parser never reads `message_start.usage` or `message_delta.usage` | — |
| 2–3 | Connection analysis | **Yes.** `promptTokens`, `completionTokens`, `model`, `stopReason`, `apiLatencyMs` | parsed at `claude.ts:57-68` (proxied) and `:555-564` (direct); persisted as `weave_events` row `weave_triggered`, in `metadata` (`WeaveButton.tsx:447-465`) |
| 6 | Theme v2 | **No.** `callClaude` returns text only and drops `usage` (`stage2/claude.ts:37-42`) | `generation_metadata` gets `theme_extraction_timing_ms`, `theme_extraction_per_cluster_ms`, and the full `theme_user_prompts` (`extract-snapshot-themes.ts:139-148`). Timing and input text, no token counts |
| 7 | Narrative v2 | **No** | `generation_metadata` gets `narrative_timing_ms`, `narrative_input_themes`, `narrative_user_prompt` (`generate-snapshot-narrative.ts:189-196`) |
| 8 | Title | No | — |
| 9 | Voice insight | No. Logs `label` and output `length` in characters (`voice-insight.ts:185-187`) | Netlify function log only |
| 10–11 | Descriptions | No | — |
| 12–13 | Stage-2 scripts | No | — |
| 14 | Deposit summary | Printed, not stored: `tokens in=… out=…` to the terminal (`summarizeVoiceSession.mjs:219-221`) | stdout / stderr only |

No figures are quoted here because none were read: this dispatch opened no database connection. For
connection analysis the numbers are one read-only query away (`weave_events` where
`event_type = 'weave_triggered'`, `metadata->>'promptTokens'`). For stage 2 the stored user prompts
and system prompt constants are sufficient inputs for an offline token count, but no count exists yet.
For voice turns nothing stored gives input size directly; the opening turn's assembled prompt is
logged on `voice.turn.started` (`vadController.ts:555`), follow-up prompts are not.

## 6. Search map (reproducible)

```bash
git fetch origin && git checkout origin/main
grep -rnE "api\.anthropic\.com|/api/claude|@anthropic-ai|claude-(opus|sonnet|haiku|fable|3|4)|anthropic-version|ANTHROPIC_" \
  --include='*.ts' --include='*.tsx' --include='*.js' --include='*.mjs' --include='*.cjs' --include='*.py' \
  --include='*.toml' --include='*.json' --include='*.sql' --include='*.sh' --include='*.yml' --include='*.yaml' . \
  --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=.git --exclude=package-lock.json | grep -v '^./docs/'
grep -rnE "thinking|effort|budget_tokens|output_config|temperature" netlify src/api src/services/voice media-server/src scripts
grep -rnoE "'voice\.[a-z_.]+'" src media-server/src | awk -F: '{print $NF}' | sort | uniq -c
```

## 7. Not done, by design

No code, env, logging, prompt, model, or effort change. No stage-2 or snapshot execution. No
recommendation on model or effort. The duplicated literals in §2b were recorded and left alone.
