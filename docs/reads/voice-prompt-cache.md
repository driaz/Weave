# Voice turn prompt-cache read (Phase 0, read-only)

> **Point-in-time read, 2026-10-08.** Static read of tracked files plus one read-only prod query
> (`$WEAVE_PROD_RO_DATABASE_URL`, `voice_sessions.processing_log` for baseline session `4949baac`)
> and free `count_tokens` calls against `claude-opus-5`. No code, prompt, proxy or logging change.
> No `cache_control` was added.
> **Repo SHA:** `bc88467` (`origin/main` after PR #70; `git fetch` ran and local `main` was
> fast-forwarded before the branch was cut).
> **Search space precondition:** absence claims (e.g. "no `cache_control` anywhere") cover tracked
> files at that SHA. Deployed Fly/Netlify code was not observed directly. The Fly handler is taken to
> be the deployed one per the F1 / #55 prod sessions, which behave as this code predicts.

## 0. Headline findings

| # | Finding |
| - | ------- |
| H1 | **The opener and follow-ups share only `role.txt` (~739 tokens).** Cadence is the second section of `system`, and it differs by turn type (`cadence-opening` vs `cadence-followup`). The opener also inserts RECENT THINKING (~1440 tokens) ahead of the connection and node sections. So the dispatch's predicted pattern ("opener creates, follow-ups read") holds only for a role-sized prefix. The full stable prefix is first **written by follow-up #1 and read from follow-up #2 on**. |
| H2 | **The volatile content sits inside `system`, after the stable content.** RELATED MATERIAL (per turn) and SURFACED THIS SESSION (grows as items surface) are the last two sections of the single `system` string. The stable prefix therefore ends at NODE CONTENT, and **`messages[]` history cannot be cached across turns** while those blocks stay in `system`, because the render order is system → messages. |
| H3 | **The candidate stable prefix clears the minimum.** Follow-up prefix (role + cadence-followup + connection + node) ≈ **1652 tokens**, against Opus 5's 512-token minimum. Role alone ≈ 739, which also clears it. |
| H4 | **The proxy carries `cache_control`.** Fly parses the JSON and re-serializes `{...body, stream: true}`. That is not byte-for-byte, but it is structurally lossless: system blocks, nested `cache_control` and top-level fields all survive. Caching is GA, so the beta header the proxy doesn't forward is not needed. |
| H5 | **The snapshot is not refetched per turn.** It is fetched once, at the opener, and is absent from follow-up prompts by design. Connection and node context are computed once at Speak click and stay byte-stable for the session. |
| H6 | **No new instrumentation is needed to verify.** `voice.claude.response_complete` already logs the full merged `usage`: `cache_read_input_tokens`, `cache_creation_input_tokens` and the `cache_creation.ephemeral_5m/1h` split. Confirmed in prod (all 0 on both baseline turns). |
| H7 | **The baseline session can't show the full win.** `4949baac` had one follow-up. Under the recommended placement, follow-up #1 reads only the role prefix, and the first full read is follow-up #2. The verification session needs **≥ 3 turns** (opener + 2 follow-ups), with gaps under 5 minutes. |

**Stop conditions: none fired.** The proxy can carry `cache_control` (§3), the prefix is above the
minimum (§4), and the snapshot is fetched once (§5).

## 1. Request shape (Q1, Q6)

Body assembly: `src/services/voice/conversationOrchestrator.ts:125-133`.

```
POST https://weave-media.fly.dev/api/claude          (conversationOrchestrator.ts:7, :119)
{
  model:         'claude-opus-5'                      :8 / :126
  max_tokens:    4096                                 :9 / :127
  thinking:      { type: 'adaptive' }                 :128
  output_config: { effort: 'low' }                    :129
  system:        <ONE STRING>                         :130  (no blocks today)
  messages:      ConversationMessage[] (string content):131
  stream:        true                                 :132
}
```

`system` is one string, built by `buildSystemPrompt` (`src/services/voice/buildSystemPrompt.ts:51-81`)
as sections joined by `'\n\n'`, with `---` separators between them. Ordered contents:

```
              OPENER (assembled upstream,          FOLLOW-UP (assembled in orchestrator,
              vadController.ts:544-552)            conversationOrchestrator.ts:96-106)
 ┌─────────────────────────────────────┐          ┌─────────────────────────────────────┐
 │ 1 role.txt               ~739 tok   │ ═══════  │ 1 role.txt               ~739 tok   │  ← only shared bytes
 ├─────────────────────────────────────┤          ├─────────────────────────────────────┤
 │ 2 cadence-opening.txt               │    ≠     │ 2 cadence-followup.txt              │  ← divergence point
 │ 3 RECENT THINKING (snapshot)        │          │                                     │
 │     framing + narrative ~1440 tok   │          │   (absent: opening-only)            │
 │ 4 CONNECTION CONTEXT                │          │ 3 CONNECTION CONTEXT                │  session-constant
 │ 5 NODE CONTENT                      │          │ 4 NODE CONTENT                      │  session-constant
 │ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ │          │ ─ ─ ─ end of stable prefix ≈1652 ─  │
 │ 6 RELATED MATERIAL   (if present)   │          │ 5 RELATED MATERIAL   (per turn)     │  volatile
 │ 7 SURFACED THIS SESSION (if any)    │          │ 6 SURFACED THIS SESSION (grows)     │  volatile
 └─────────────────────────────────────┘          └─────────────────────────────────────┘
 messages: [ {user: 'Begin.'} ]                   messages: [ {assistant: <opener text>},
   (vadController.ts:1469)                                    {user: t1}, {assistant: a1}, …,
                                                              {user: tN} ]  (appended)
```

- **Snapshot placement:** in `system` (section 3, opener only), not in a user message.
  (`buildSystemPrompt.ts:53-60`; `vadController.ts:547`.)
- **History:** appended. The user transcript is pushed at `vadController.ts:1394` and the
  assistant text at `:1995`, both onto `this.messages` (`:259`). The opener's synthetic
  `'Begin.'` is passed inline (`:1469`) and never enters `this.messages`, so follow-up
  `messages[0]` is the opener's assistant text. Assistant turns are stored as text only: thinking
  blocks are not replayed, consistently on every turn.
  (`initialAssistantMessage`, `:325-330`, has no caller in the repo.)
- **Per-turn content ahead of the stable prefix:** none. `buildSystemPrompt` has no timestamp,
  session id or turn counter. The per-turn pieces (relatedMaterial, workingMemory) all come
  *after* NODE CONTENT. `thinking` and `effort` are constants, so they can't invalidate the cache
  between turns.
- **Q6, same prefix bytes?** No. The opener builds a different shape: different cadence, plus
  RECENT THINKING. The shared prefix is section 1 only.

## 2. Existing `cache_control` (Q2)

None. A repo-wide search (excluding `node_modules`, `dist`) finds `cache_control` only in
`docs/reads/anthropic-call-sites.md:77`, which records its absence. Nothing sets it in the client
(`conversationOrchestrator.ts:125-133`), the Fly proxy (`media-server/src/index.ts:257-302`) or
any Netlify function. The baseline usage agrees: `cache_creation_input_tokens: 0` and
`cache_read_input_tokens: 0` on both turns.

## 3. Fly proxy pass-through (Q3)

`media-server/src/index.ts:257-302`:

- `:35` uses Fastify with the default JSON parser (`bodyLimit` 10 MB), so `req.body` is a parsed object.
- `:265-268` rejects only a missing or non-object body. Nothing is inspected or stripped.
- `:272-279` sends `JSON.stringify({ ...body, stream: true })` upstream. It **re-serializes**, so
  the request is not byte-for-byte. But it is a shallow spread over the parsed object, so every
  top-level key (`system`, `messages`, `thinking`, `output_config`, and a top-level
  `cache_control` if one were sent) passes through, and nested values (system text blocks with
  their `cache_control`) are untouched. The prompt cache keys on the rendered prompt, not on the
  request's JSON bytes, so re-serialization has no effect on hits.
- **Headers:** none of the client's headers are forwarded. The proxy sends a fixed set:
  `x-api-key`, `anthropic-version: 2023-06-01`, `content-type` (`:274-278`). There is no
  `anthropic-beta`. Prompt caching needs no beta header, so nothing is lost.
- Response: the upstream SSE body is piped through untouched (`:297-302`), so `usage` on
  `message_start` / `message_delta` reaches the client intact.

Verdict: the proxy can carry `cache_control`, and no proxy change is needed.

## 4. Token sizing (Q4)

Method: the opener's `assembledSystemPrompt` for `4949baac` (logged on `voice.turn.started`) was
pulled read-only and split into its sections. Variants were then counted with
`POST /v1/messages/count_tokens` on `claude-opus-5`. **Calibration:** counting the full opener
gives **2986**, which exactly equals the prod `input_tokens` for turn `08535419`. Request
scaffolding (`system:"x"` + `'Begin.'`) counts as 12, and ~11 of that is subtracted below.

| Prefix candidate | chars | ≈ tokens |
| --- | ---: | ---: |
| role.txt alone (shared by both turn types) | 2265 | **739** |
| Follow-up stable prefix: role + cadence-followup + connection + node | 4996 | **1652** |
| Opener stable part without RT: role + cadence-opening + connection + node | 4655 | 1543 |
| RECENT THINKING section (framing + narrative) | 4383 | 1429 |
| Full opener system (as sent) | 9045 | 2975 (+11 = 2986 billed) |

**Opus 5 minimum cacheable prefix: 512 tokens.** Both breakpoints clear it (739, 1652).

Per-turn delta for follow-up `298db917`: 3141 billed − 1652 ≈ **1489 tokens**. That is SURFACED
THIS SESSION (3261 chars, 6 entries) plus separators plus history (opener assistant text and the
user transcript). Under the recommended placement, ~53% of that turn's input would be cache
reads. The delta grows as history lengthens and as working memory fills. The stable prefix does
not grow.

These sizes are for one edge. CONNECTION CONTEXT and NODE CONTENT vary by edge, so a sparse
edge's prefix is smaller. The role block alone keeps any prefix above 512.

## 5. Snapshot stability within a session (Q5)

- The snapshot (`getLatestProfileSnapshot`) is called only in `kickOffOpeningTurn`
  (`vadController.ts:532-541`). It is the opener path, shared with retry. The follow-up path
  passes `recentThinking: null` ("opening-only by design", `:1399`), and the orchestrator's
  follow-up build never receives it (`conversationOrchestrator.ts:99-106`).
- Not refetched per turn, and **not in the follow-up prefix at all**. It can't move the follow-up
  boundary.
- `connectionContext` / `nodeContent` are built once, at Speak click
  (`src/components/EdgeDetailPopup.tsx:539-540`). They are stored on `this.opts` and reused on
  every turn (`vadController.ts:548-549`, `:1968-1969`), so they are byte-stable for the session.
- What *does* change per turn is RELATED MATERIAL (`vadController.ts:1335-1363`) and SURFACED THIS
  SESSION (`:1332-1333`). Both come after the stable prefix (H2).

## 6. Usage capture (Q7)

- `conversationOrchestrator.ts:186-192` merges `message_start.message.usage` with every
  `message_delta.usage`, and `:229` emits `voice.claude.response_complete` with
  `{ usage, stopReason }`.
- `vadController.ts:1975-1976` routes markers to `this.logger.event(phase, 'success', detail,
  correlationIds)`, which lands in `voice_sessions.processing_log`. The log is flushed at session
  end.
- Prod row for `4949baac` (both turns) includes `cache_read_input_tokens`,
  `cache_creation_input_tokens`, `cache_creation.ephemeral_5m_input_tokens`,
  `cache_creation.ephemeral_1h_input_tokens`, `input_tokens` and `output_tokens_details.thinking_tokens`.
  **Both cache fields are captured.** The build can be verified with no new instrumentation.

## 7. Recommended `cache_control` placement

Turn `system` from a string into **three text blocks**, with explicit breakpoints on the first two:

```
system: [
  { type: 'text', text: <role>,                                cache_control: { type: 'ephemeral' } },  // BP1
  { type: 'text', text: <cadence [+ RT] + connection + node>,  cache_control: { type: 'ephemeral' } },  // BP2
  { type: 'text', text: <related material + surfaced>  }                                             // volatile, only if non-empty
]
```

Reasoning:

1. **BP2 at the end of NODE CONTENT** is the furthest point that is byte-stable across follow-up
   turns. Anything later in `system` changes per turn, and everything in `messages[]` renders after
   `system`.
2. **BP1 on `role`** is the only prefix the opener and follow-ups share. It lets the opener's write
   pay off on follow-up #1 (~739 read), and it makes a retried opener read too. Role is identical
   across sessions in the workspace, so back-to-back sessions within 5 minutes also share it.
   It costs one of 4 allowed breakpoints and a 1.25× write on ~739 tokens.
3. **Use explicit block breakpoints, not top-level automatic `cache_control`.** Automatic caching
   puts the breakpoint on the last cacheable block, the tail of `messages[]`. The next turn's
   prefix diverges earlier, at the volatile `system` sections, so those writes would only be read
   when RELATED MATERIAL and SURFACED were both unchanged from the previous turn. That would be an
   unreliable hit pattern, paying 1.25× on the whole prompt every turn.
4. **Use the same block layout on both paths.** On the opener, BP2 writes the opener-specific
   prefix (~2960 tokens), which is read again only on a retried opener. That is a 1.25× write on
   ~2.2k tokens once per session. The alternative is to skip BP2 on the opener. I recommend
   uniform code for simplicity, but this is a judgment call: Daniel's to make.
5. **Keep TTL at the default 5 minutes.** The baseline gap between turns was ~80 s. Every read
   refreshes the entry. A 1-hour TTL (2× write) only pays off when pauses run past 5 minutes.
6. **Splitting into blocks must preserve prompt text.** Keep the `---` separators inside the
   second and third blocks, so their joined text matches today's string. Any joiner the API adds
   between system blocks is the same on every turn, so it can't affect caching. The build should
   check that `voice.turn.started.assembledSystemPrompt` still logs the joined string.

**Out of scope here, but a larger lever later:** moving RELATED MATERIAL and SURFACED THIS SESSION
out of `system` would let a third breakpoint cache the growing `messages[]` history. Candidates
are a trailing `role: "system"` message (supported on Opus 5, no beta) or the current user turn.
That changes how the model sees the retrieval blocks: a prompt-semantics change, not a body-only
change. It belongs in its own dispatch with a taste check. History is small today (~0.4–1k
tokens by turn 2), so the gain is modest until sessions run long.

## 8. Predicted cache-hit pattern

With §7 placement, for one session with gaps under 5 minutes (≈ values for an edge like `4949baac`):

| Turn | `cache_read_input_tokens` | `cache_creation_input_tokens` | Why |
| --- | ---: | ---: | --- |
| Opener | 0 (or ~739 if another session ran within 5 min) | ~2960 (BP1 739 + BP2 rest) | Cold. Writes role + opener prefix |
| Follow-up #1 | **~739** | **~913** | Role read. BP2 follow-up prefix written for the first time |
| Follow-up #2+ | **~1652** | ~0 | Full stable prefix read |
| Retried opener | ~2960 | ~0 | Opener prefix read |

So the pattern is "opener writes role, follow-up #1 writes the rest, follow-ups #2+ read". It is
not "opener creates, follow-ups read".

**Latency expectation (inference, not measured):** caching removes prefill for ~1.65k of ~3.1k
input tokens. It does not touch thinking or generation time, and in `4949baac` both of those sit
inside request→first-delta (thinking and first text arrived in the same chunk). The prefill share
of the 2143 ms baseline has not been measured, and this read cannot measure it. The drop may be
small relative to session-to-session noise. When verifying, compare request→first-delta for
follow-up #2+ against follow-up #1 *within the same session*, as well as against the 2143 ms
baseline, and treat one session as directional evidence.

## 9. Verification owed after the build (restated, with H7 applied)

One real prod session with **≥ 3 turns** (opener + ≥ 2 follow-ups, each under 5 minutes apart),
read from `voice.claude.response_complete`:

- follow-up #1: `cache_read_input_tokens` ≈ 739 and `cache_creation_input_tokens` > 0;
- follow-up #2+: `cache_read_input_tokens` ≈ the full follow-up prefix (~1.6k on a similar edge);
- request→first-delta on follow-up #2+ compared to follow-up #1 and to the 2143 ms baseline.
