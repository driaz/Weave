# Voice Persistence Design (Phase 8)

**Status:** Design draft
**Date:** May 15, 2026
**Branch:** `feat/voice-persistence` (off `main`)
**Predecessor:** Voice v2 (shipped, merged to `main`)
**Successor phases:** Phase 9 (profile snapshot injection), Phase 10 (semantic retrieval), Phase 11 (voice events → engagement weighting)

---

## Scope and goals

Phase 8 establishes durable storage for voice sessions and the utterances within them. It does not implement retrieval, summarization, or any reasoning-layer consumption of the stored data — those are Phase 9+.

The phase resolves three things:

1. **Voice content persistence.** Every utterance in every voice session is stored at full fidelity with an embedding, available for future retrieval.
2. **Phase 5's deferred persistence.** Per-turn operational events (Voice v2 emits these to console only today) finally land somewhere durable, on the session row.
3. **Schema commitments that affect downstream work.** The "Begin." sentinel handling and the choice of atomic unit are load-bearing for Phase 10's retrieval design.

Out of scope for Phase 8: retrieval logic, summarization, audio file storage, inspector UI for session replay, per-turn node references. Each is named in *What's deferred* below.

---

## Guiding principle

**Store at high fidelity; decide what to surface at retrieval time.**

Most frontier-lab agent products collapse storage and retrieval — they summarize at ingest because they assume retrieval will be lossy anyway. Weave rejects that. Voice sessions are stored as raw utterances; summaries and selective injection happen later, as a derived layer. The objective is exploration of what high-fidelity, intentional, personalized memory feels like — not a scalable commercial design.

---

## Decision: atomic unit is the utterance, not the turn-pair

**The choice:** one row per speaking event by one party — `{ speaker, text, started_at, ended_at, utterance_index }`. Walkie-talkie produces utterances in strict alternation; future regimes produce them in whatever shape. The utterance survives all of them.

**Rejected alternative: turn-pair as atomic unit.** A `{ user_text, assistant_text }` row is the natural unit *today* under walkie-talkie. Embedding the concatenation gives slightly better retrieval quality right now than embedding the halves independently, because short user utterances ("yeah, exactly") carry context from the assistant turn that's lost when split.

**Why utterance wins:** walkie-talkie is a temporary constraint. Push-to-interrupt is already semi-baked in (the stop button), and the trajectory is toward realtime — months, not years. Turn-pairs break the moment interruptions land: an interrupted assistant turn followed by a new user turn followed by a resumed assistant turn doesn't fit the schema. Migration from turn-pair to utterance later means splitting rows, re-embedding, and updating retrieval code — work that lands right when the next phase is shipping.

**What we give up:** marginally weaker retrieval quality during the walkie-talkie window, because short utterances embedded alone carry less context than they would as part of a pair. Mitigated by the math: short low-content utterances embed to roughly equidistant vectors and don't get retrieved by similarity search anyway. The retrieval-time fix for genuine pair-context needs (Phase 10's problem) is to fetch neighbors by `(session_id, utterance_index)` — a cheap indexed query.

**Rejected alternative: exchanges as a separate grouping table.** An intermediate "exchange" unit — utterances grouped into retrievable units — was considered to preserve turn-pair retrieval behavior under utterance storage. Rejected because there's no clean boundary rule for what makes an exchange across turn-taking regimes. Strict alternation, topic-shift detection, silence gaps, and session-only were all considered; each fails in different ways. Defining exchanges at retrieval time (pull a window of N neighbors) avoids the write-time decision entirely.

---

## Decision: no rolling-context embeddings

**The choice:** embed each utterance as-is. No concatenation with previous utterances.

**Rejected alternative:** embedding each utterance with the previous 1–2 utterances concatenated, on the theory that short utterances ("yeah, exactly") embed weakly alone and need surrounding context to be meaningful.

**Why rejected:** the noise concern was a phantom. With cosine similarity over 3072 dimensions, semantically empty utterances embed to vectors roughly equidistant from everything — they don't match queries and don't pollute retrieval. The top-K cutoff handles them naturally.

More importantly, rolling context can be *actively harmful* for the utterances that matter most. "I miss her." embedded with an unrelated preceding utterance gets diluted; embedded alone, it's a dense, retrievable signal. The substantive utterances are exactly the ones where added context hurts.

The math handles the noise. Embed simply.

---

## Decision: "Begin." sentinel — strip on persist, fail loud

**The choice:** when persisting the first user utterance of a session, detect the literal sentinel and strip it. Detection is strict: the utterance must be the first user utterance, before any assistant utterance has been recorded, and must match the literal string.

**Why:** the sentinel is an artifact of the turn-taking implementation, not user content. A session transcript replayed to Claude six months later (Phase 10) must read as conversation, not as protocol. "Begin." in the transcript is noise that degrades retrieval and confuses replay.

**Fail-loud requirement:** if the detection rule mismatches — e.g., the first user utterance is "begin" lowercase, or "Begin" without the period, or arrives after an assistant utterance — the utterance is written as-is and an error event is logged to `processing_log`. We do not silently swallow user text. The strict rule is intentional: a fuzzy detector that strips legitimate user content is worse than a strict detector that occasionally fails to strip.

**Test coverage:** the detection function gets a unit test covering: exact match, case variants, punctuation variants, sentinel arriving second, sentinel from assistant. The first case strips; all others pass through and log.

---

## Decision: `processing_log` as append-only event array

**The choice:** `processing_log` is a `jsonb` column on `voice_sessions`, structured as an array of event objects: `[{ ts, type, phase, correlationId, ...payload }, ...]`. Matches the existing `weave_events` pattern.

**What goes in it:**

Per-turn operational events:
- Claude streaming start, first-token latency, total tokens, stop reason
- TTS streaming start, first-audio latency, total audio duration
- STT start, finish, duration, model
- Errors at any phase (with phase + correlationId)
- AudioContext state transitions
- Underrun events

Session-level events:
- Session start (with entry-point context: which edge popup, which nodes)
- Session end (with reason: `user_closed` | `idle_timeout` | `error`)
- Model versions, voice settings at session start
- Connection state issues (websocket drops, retries)

**Why array-of-events, not keyed-by-utterance:** matches existing pattern (`weave_events`, Phase 5's enriched `weave_triggered` events). Pattern consistency outweighs the small filter cost on "show me events for utterance N" — Postgres jsonb path operators handle that query cheaply.

**Write pattern: buffer client-side, flush on session end.** Events accumulate in memory during the session. The session row is created at session start with `processing_log = '[]'`. At session end (user closes mic modal), the row is updated with the full event array, `ended_at`, and `end_reason`.

If a session crashes mid-conversation, the processing_log is lost but utterances persist (they're written incrementally as they happen). Acceptable tradeoff: utterances are the irreplaceable artifact; operational telemetry is recoverable through other means if needed.

---

## Decision: session boundary is the mic modal

**The choice:** a session starts when the mic modal opens and ends when it closes. No idle-timeout fallback in Phase 8 — keep it simple, add timeout handling later if it proves necessary.

`end_reason` defaults to `'user_closed'`. Other values (`'idle_timeout'`, `'error'`) are reserved for future use.

---

## Schema

### `voice_sessions`

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` | Primary key |
| `user_id` | `uuid` | RLS scope; references `auth.users` |
| `anchor_edge_id` | `uuid` | The edge from EdgeDetailPopup that launched the session; nullable for future entry points. Nodes are reachable via join through the edges table. |
| `board_snapshot` | `jsonb` | Canvas state at session start (node IDs, positions, types — not full content) |
| `started_at` | `timestamptz` | NOT NULL, default `now()` |
| `ended_at` | `timestamptz` | NULL until session ends |
| `end_reason` | `text` | NULL until session ends; one of `'user_closed' \| 'idle_timeout' \| 'error'` |
| `processing_log` | `jsonb` | Default `'[]'`; populated on session end |
| `summary` | `text` | NULL; async-computed in a future phase |

### `voice_utterances`

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` | Primary key |
| `session_id` | `uuid` | FK to `voice_sessions.id` |
| `user_id` | `uuid` | RLS scope; denormalized for policy speed |
| `speaker` | `text` | `'user'` or `'assistant'`; consider a check constraint or enum |
| `text` | `text` | Transcript content; sentinel-stripped for the opening user utterance |
| `embedding` | `vector(3072)` | Gemini Embedding 2, same task type as board nodes for future unified retrieval |
| `utterance_index` | `int` | Monotonic within session, no gaps, client-assigned |
| `started_at` | `timestamptz` | NOT NULL |
| `ended_at` | `timestamptz` | NOT NULL |

### Indexes

- `voice_utterances`: unique B-tree on `(session_id, utterance_index)` — enforces no-duplicate ordering; supports replay and neighbor fetch
- `voice_utterances`: HNSW on `embedding` — semantic retrieval
- `voice_utterances`: B-tree on `user_id` — RLS policy speed
- `voice_sessions`: B-tree on `user_id` — RLS policy speed
- `voice_sessions`: B-tree on `started_at DESC` — recent-sessions queries

### RLS

Standard pattern, matching the post-014 convention of four explicit policies per table (SELECT / INSERT / UPDATE / DELETE) rather than a single `FOR ALL`. Migration 014 superseded the original single-policy style from migration 008; new tables follow the four-policy form.

```sql
ALTER TABLE voice_sessions ENABLE ROW LEVEL SECURITY;

CREATE POLICY voice_sessions_select_own ON voice_sessions
  FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY voice_sessions_insert_own ON voice_sessions
  FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY voice_sessions_update_own ON voice_sessions
  FOR UPDATE TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY voice_sessions_delete_own ON voice_sessions
  FOR DELETE TO authenticated USING (auth.uid() = user_id);

-- Same four-policy pattern for voice_utterances.
```

### `utterance_index` assignment

Client-assigned. The mic-modal session controller maintains a counter that increments on each utterance regardless of speaker. Unique constraint on `(session_id, utterance_index)` ensures a bug (duplicate index, out-of-order write) surfaces loudly via a constraint violation rather than silently corrupting order.

### Write pattern

- **Session start:** `INSERT INTO voice_sessions (id, user_id, anchor_edge_id, anchor_node_ids, board_snapshot, started_at) VALUES (...)` — single row, `processing_log` defaults to `'[]'`.
- **Per utterance:** `INSERT INTO voice_utterances (...)` with embedding generated client-side (or via the Fly proxy) before insert. Sentinel stripped for the opening user utterance per the rule above.
- **Session end:** `UPDATE voice_sessions SET ended_at = ..., end_reason = ..., processing_log = ... WHERE id = ?`. Single update with the accumulated event array.

---

## What's deferred to Phase 10

These are named explicitly because Phase 8's schema needs to *accommodate* them without *implementing* them:

- **Semantic retrieval surfaces.** Phase 10 decides what to search (board nodes only, voice utterances only, unified). Phase 8 ensures voice utterances are embedded in the same vector space as board nodes so unified search is possible.
- **Per-turn node references.** When retrieval pulls nodes into voice conversations, Claude will reference them. A `referenced_nodes` column (or join table) gets added then, not now. Empty columns sitting unused for months are an antipattern.
- **Pair-context recovery at retrieval.** Phase 10's retrieval logic fetches utterance N along with N-1 and N+1 to give Claude pair context. Phase 8's `(session_id, utterance_index)` index makes this a cheap query.
- **Summarization.** Async-computed `summary` text on the session row. Phase 9 or later.
- **Latency budget for retrieval injection.** Phase 10's real design question is not "how do we search" (fast — pgvector HNSW returns in single-digit ms at this scale) but "how much retrieved content do we inject into Claude's context, and how do we compress it." Phase 8 just stores at fidelity; Phase 10 manages the tokens-into-Claude tradeoff.

---

## Open questions

Things noticed during design that don't have answers yet:

1. **Inspector UI for session replay.** Once sessions persist, you'll want to read them back — list view, transcript view, processing_log inspection. Not Phase 8 work, but the schema should support it without further migration. Current schema does (ordered by `utterance_index`, joined to `processing_log`), but the UI shape might surface things we missed.
2. **Audio recording storage.** Mentioned in the roadmap as eventual. Out of Phase 8 scope, but worth knowing: would attach as a `audio_url` or similar on `voice_utterances` (or session-level if recording is per-session, not per-utterance), with files in Supabase Storage.
3. **HNSW performance at 3072 dimensions.** Gemini Embedding 2 produces 3072-dim vectors, which is on the larger side for pgvector HNSW. Performance is fine at small scale (thousands of vectors); worth measuring once a few weeks of real sessions have landed. If it bites, options are quantization (`halfvec` in pgvector 0.7+) or dimensionality reduction.
4. **Embedding cost at scale.** Math estimate: ~10 cents/year at 2–3 hours/week voice usage. Trivial. Worth re-confirming after one month of real usage.
5. **Claude tokens for retrieval injection.** The actual cost driver in the system. Not Phase 8, but worth tracking from day one of Phase 10.

---

## Implementation notes

- Migration number: next available in the existing sequence (likely 020 or later — confirm with Claude Code).
- Branch off `main`, post-Voice-v2 merge.
- Schema-only migration first; client write integration in a follow-up commit so the SQL can be reviewed in isolation.
- Confirm RLS pattern matches the recent Auth RLS cutover (`auth.uid() = user_id`) — not session-scoped via join.
- Sentinel-detection unit test lives with the client persistence module, not in the migration.
- Embedding generation: client-side via Gemini API, same path as board node embeddings. No new server endpoint needed.

---

## Reference

- Voice v2 design doc: `docs/voice-v2-design.md`
- Phase 5 instrumentation: `weave_events`, `weave_triggered` enriched metadata
- RLS cutover: migration referenced in commit history; `auth.uid() = user_id` on all user-scoped tables
- Sentinel commit: `1b6b040`
