# Session record — 2026-09-05 — Revival preflight R0 (read-only)

> Provenance note: written 2026-09-05 (local; prod clock 2026-09-06 UTC) at the
> close of the sitting that produced it, from the sitting transcript and
> `docs/reads/revival-preflight.md`. Prod figures below are quoted from the
> read report, which carries the producing queries; nothing here is re-derived
> from the database.
>
> Dispatch: "R0 — Revival preflight (read-only)", issued 2026-09-05 from the
> planning layer. First of four revival dispatches (R0 preflight → R1 build →
> R2 verify → R3 prompt v2 + t1). Seven facts, one `docs/reads/` record, one
> session record, one PR. No code changes, no fixes, no OQ14, no pipeline
> invocation. Executed with exactly two permitted write surfaces: the read
> report and this record. PR opened at session close, not merged.

## What shipped

- **`docs/reads/revival-preflight.md`** — fourth occupant of the `docs/reads/`
  class. Header states read time (`2026-09-06 01:08:52 UTC`), repo SHA
  `e5cd3fd`, database (prod, `wndfikmpifyqkgivmnwv`), role `weave_readonly`,
  preflight P1–P5 verbatim, and the decay sentence. Facts F1–F7 each carry
  their queries inline; the throwaway reproduction script is Appendix A; a
  deduplicated query map and file/line map close the document.
- **This record.**
- **Zero writes to prod.** Only `WEAVE_PROD_RO_DATABASE_URL` via `--db-url`
  (read from `.env`, never echoed). No auth friction, nothing retried, nothing
  installed. No Management API, no service role, no CLI auth flow.

## Sequence of the sitting

1. `git fetch origin`. Local `main` was at `ff0b4f8`, four PRs behind
   `origin/main` (`e5cd3fd`, which includes PR #43 D7). Branch
   `reads/revival-preflight` cut from `origin/main`.
2. Read D7 (`docs/reads/d7-diagnosis.md`) and its Appendix A for the verbatim
   reproduction shape; read the pipeline source, the theme extractor, the
   narrative function, the standalone scripts, and every voice reader in the
   repo before touching the database.
3. Read file created with its header **before any query ran**.
4. Preflight P1–P5. P1: `git log 1b2cfff..HEAD` over code paths is empty —
   pipeline code unchanged since D7 and since the census. P2/P5:
   `weave_readonly`, not superuser, SELECT-only on 15 relations. P3:
   `readonly_audit_select` with `qual = true` on 13/13 base tables. P4:
   `weave_events` has no QA marker (restated); none of the six weighted types
   carries `voice_session_id`; `user_id` uniform.
5. Data delta since D7: **none.** 2,705 events, 101 embeddings, identical
   per-type counts; newest event 2026-09-04 02:17 UTC.
6. F2 reproduction: verbatim copies of lines 76–89, 111–158, 181–202,
   326–377, 404–435 over `psql` JSON exports, run scoped (as `:389`) and
   unscoped. SQL composite-join cross-check per type and per board agreed
   cell-for-cell on first derivation.
7. F3/F4/F6/F7 queries; F1/F5 from code. All cardinality gates closed on first
   derivation; no expected figure was adjusted.
8. Report, this record, PR.

## The seven facts, headline form

| fact | verdict |
|---|---|
| **F1** board predicate by layer | Layer 1 (events read, `:389`) is the one live board predicate. Map (`:349`) and clustering (same `nodes` array, `:457`) carry a predicate that is a tautology under the default (board list derived from the same table) and a real filter only under an explicit `board_ids` request body. Board id reaches the pipeline via optional body field, else derived; never active-board state, never hardcoded. Anchors: top-3 by normalized weight, **per cluster**, after clustering. |
| **F2** size of the exclusion | **Hit difference = 0.** Scoped 2,433 = 2,058 + 359 + 16; unscoped 2,446 = 2,058 + 359 + 29. The 13 keys removed are all absent-misses on board `aa4183ba…` (no embeddings at all). `weightMap` byte-identical across runs. Structural today: key-board = event-board on 2,488/2,488 weighted rows. D7's 2,446 / 359+29 reproduces exactly. |
| **F3** OQ15 | supabase-js against PostgREST, `select('*')`, no `.range()`/`.limit()`/order. Exact-predicate row count **2,642** (> 1,000) → **code-confirmed exposure**. No prod read-only API credential locally (`.env` is dev) → **cap unconfirmed**; Daniel reads it from the dashboard. Horizons: 70 days = **309** (fits), 210 days = **2,642** (the whole 136-day table; does not fit). |
| **F4** execution + insert | Netlify function at `/api/generate-profile-snapshot`, POST, no browser call site, no schedule; only caller `npm run snapshot:test` against `netlify dev` (dev env). Client `createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)` — **service role**. Insert `:539-543` sets no `user_id`. Five RLS policies re-read from prod, unchanged from census T5; `user_id` nullable default `auth.uid()`; `FORCE` off. OQ14 shape restated: service-role row → `user_id NULL` → invisible to `select_own`. Not run. |
| **F5** entanglement | Resolvers (`:114-121`, `:125-132` byte-identical; `resolveNodeTarget` `:152-158`) and `lightboxClosedWeight` are already pure module-level values. The map builder (`:346-377` + `:404-408`) and weight loop (`:410-448`) are **straight-line handler code**, not functions; they read `supabase`, `boardIds`, `events` and write `nodes`, `nodesExcludedNoEmbedding`, `weightMap`, `rulesApplied`, `eventsUnmatchedByType`, `maxRawWeight`. An extracted `buildWeightMap(events, nodeKeys)` returns exactly the four values the insert path already reads by name. Line-434 comment quoted; D7 showed it wrong. |
| **F6** voice predicates | **No voice read exists on the snapshot or theme path.** `session_kind = 'real'` is applied in SQL once, in the `real_voice_session_deposits` view (036), consumed by the voice retrieval band. `ended_at is not null` and `anchor_edge_id is not null` are applied **nowhere** as filters in the repo. Counts: real **25** / QA 62 / total 87; real ∧ ended ∧ anchored = **16**; `user_turns` for those n=16, min 2, **median 7.5**, max 23, none zero. QA control median 0. |
| **F7** timestamps for decay | `weave_events.timestamp` = server `now()` at insert arrival (restated). Real `ended_at`: **0 null / 25 not null**. Resolving events older than 70 days: closes **338/396**, `item_added` **72/80**, `lightbox_closed` **92/117**. Real voice sessions by `ended_at`: 4 / 4 / **17** / 0 / 0 / 0 across the 42-day buckets; nothing older than 111 days. |

## What surprised me

- **The board predicate discards nothing today.** The dispatch framed it as a
  defect to be sized; the size is 0 hits. Every weighted event's key board is
  its own board, and the board list is derived from the very table the map is
  built from, so the events-read filter can only remove absent-misses. It is
  still a defect in form — an explicit `board_ids` body cuts map, clustering
  and events together, which is a board-scoped snapshot — but it is not where
  engagement is being lost.
- **The 210-day horizon is the whole table.** `weave_events` is 136 days old.
  A 210-day read is 2,642 rows and still needs pagination; only the 70-day
  read (309) fits under a 1,000 cap.
- **Nothing on the snapshot path reads voice.** F6's three predicates had
  nowhere to be. Two of them (`ended_at`, `anchor_edge_id`) are not applied as
  filters anywhere in the repo at all.
- **Decay has little to act on inside 70 days.** 85–90% of resolving
  engagement for the v2-roster types is older than 70 days; the entire real
  voice population sits inside 111 days, most of it in the 84–125 day band.
- **The deposits backfill iterates QA sessions too.** `summarizeVoiceSession.mjs
  --all` has no kind filter; the `real_` view is what keeps QA deposits out
  of the band. Noted, not a finding for this dispatch.

## Contradicts the dispatch (also in the read's §8)

- "The difference in hits is the engagement the current scoping discards" →
  0 hits; 13 absent-miss keys.
- "If F1 shows the map or clustering is also board-scoped" → only under an
  explicit `board_ids` body, which no caller supplies; the default combination
  (events scoped / map + clustering unscoped) is what F2 sized.
- F6 presumes a voice read on the snapshot or theme path; none exists.
- F3 empirical confirmation was not possible (no prod RO API credential;
  service role excluded).

## Could not test, and why

- **PostgREST `max-rows` value.** Project API config, not a database object;
  no prod anon key locally. Code-confirmed exposure only.
- **OQ14 insert visibility.** Excluded by the dispatch.
- **Explicit-`board_ids` scoping.** No caller in the repo; not sized.

## Stop conditions checked

None triggered. No auth friction; RO role saw every table; verbatim copies ran
read-only over exports; F2 unscoped run reproduced D7 exactly (zero data
delta); every cardinality gate closed on first derivation.
