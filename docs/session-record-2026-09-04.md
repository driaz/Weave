# Session record — 2026-09-04 — D7 diagnosis + click/close orphan pairing (read-only)

> Provenance note: written 2026-09-04 at the close of the sitting that produced
> it, from the sitting transcript and `docs/reads/d7-diagnosis.md`. Prod
> figures below are quoted from the read report, which carries the producing
> queries; nothing here is re-derived from the database.
>
> Dispatch: "D7 diagnosis + click/close orphan gap (read-only)", issued
> 2026-09-04 from the planning layer. Two questions, one `docs/reads/`
> inventory, one session record, one PR. No fixes, no schema, no code.
> Executed as a read-only session with exactly two permitted write surfaces:
> the read report and this record. PR opened at session close, not merged.

## What shipped

- **`docs/reads/d7-diagnosis.md`** — third occupant of the `docs/reads/` class.
  Header states read time (`2026-09-04 21:30:03 UTC`), repo SHA `1b2cfff`,
  database (prod, `wndfikmpifyqkgivmnwv`), role `weave_readonly`, preflight
  P1–P5 verbatim, and the decay sentence. Every count sits under its query;
  the two throwaway scripts are reproduced in full as appendices; a
  deduplicated query map closes the document.
- **This record.**
- **Zero writes to prod.** No snapshot pipeline invocation, no OQ14, no
  temp tables. The only credential used was `WEAVE_PROD_RO_DATABASE_URL`
  via `--db-url`; no auth friction occurred, nothing was retried.

## Sequence of the sitting

1. `git fetch origin`. Local `main` was at `ff0b4f8`, two PRs behind
   `origin/main` (`1b2cfff`: PR #41 census, PR #42 Claude.md). Branch
   `reads/d7-diagnosis` cut from `origin/main`, not local `main` — the
   2026-08-15 rule, applied.
2. Preflight P1–P5. P1: `git log ff0b4f8..HEAD` over the attribution files
   is empty — **the pipeline code is unchanged since the census**, so census
   figures were expected to reproduce up to data growth. P2/P5:
   `weave_readonly`, not superuser, SELECT-only on 15 relations. P3:
   `readonly_audit_select` with `qual = true` on 13/13 public base tables.
   P4: **`weave_events` has no QA marker of its own**; the only path is
   `voice_session_id → voice_sessions.session_kind`, and a single `user_id`
   owns every row in both tables.
3. Read file created with its header **before any diagnostic query ran**
   (constraint 7).
4. Code of record read before SQL: both key expressions, the map filters
   (`archived_at is null` + parseable embedding), the silent miss at `:430`,
   the weight gate at `:426` that precedes the lookup, and the board-scope
   filter at `:389` on the events read. Found that nothing in the module is
   exported except the handler — **the resolver and map builder cannot be
   invoked without the insert**. Reported as the entanglement finding; the
   reproduction used verbatim copies of lines 80–89, 111–158, 326–377,
   404–435 over `psql` JSON exports, with instrumentation only around the
   `key in weightMap` test. No Postgres driver exists in `node_modules`, so
   the script consumed exports rather than connecting; nothing was installed.
5. Reproduction. Census scope (all events, matching `C17`): resolved 2,446,
   hits 2,058, **misses 388**. Pipeline scope (board-scoped, weight-gated —
   the code path): resolved 2,433, **misses 375**. Expected count derived
   independently from per-type row counts: 2·(504+454)+(139+135+131+125) =
   2,446 ✅; minus 13 keys on never-read boards = 2,433 ✅.
6. Partition, ordered B1→B8, run on both scopes; SQL cross-check (`X1`)
   agreed with the script on every per-type cell.
7. Q2 pairing implemented as a single parameterised window query (FIFO via a
   running max of closes-minus-clicks), run on C/X and on the lightbox
   control. Zsh's non-splitting of an unquoted loop variable produced one
   empty run; fixed by passing the pair explicitly and re-run.
8. Anomalous sessions traced row-by-row; the popup's close paths read in code
   (overlay, Escape, button emit; board switch, weave result/clear, unmount
   do not).
9. Report body, query map and appendices written; this record written; PR
   opened.

## Reproduced totals vs census

| | census 08-28 | now, census scope | now, pipeline scope |
|---|---:|---:|---:|
| resolved keys | 2,421 | 2,446 | 2,433 |
| hits | 2,033 | 2,058 | 2,058 |
| misses | 388 | **388** | **375** |

The +25 resolved keys are exactly the six-type event growth since 08-28
(+5/+4/+3/+3/+1/+0); all 25 hit. The census's 359/29 split is the B4/B5
split, unchanged. The 13-key scope difference is the `:389` board filter the
census did not apply.

## Q1 partition (M = 375, pipeline scope; census scope in brackets)

| bucket | count | note |
|---|---:|---|
| B1 key-format drift | 0 | regex derived from the map side; every target well-formed |
| B2 grain mismatch | 0 | |
| B3 QA leakage | 0 | **untestable, not absent** — no weighted type ever carries `voice_session_id` |
| B4 target archived | **359** [359] | composite exists, `archived_at not null`; all 359 events precede archival; 131 clicks / 116 closes / 43 `node_selected` / 41 `item_added` / 14 + 14 lightbox |
| B5 target not found | **16** [29] | five keys on board `64bc0982…`, April–May 2026, pre-037; [+13 on a board with no embeddings at all, never read] |
| B6 cross-board composite | 0 | composite reading; under the literal reading every B5 key's bare `node_id` exists elsewhere — coincidence, `node_id` is a per-board counter |
| B7 other map filter | 0 | no null/unparseable embeddings |
| B8 unclassified | 0 | |

Gates: 359 + 16 = 375 ✅; 359 + 29 = 388 ✅; per-type miss recount from the
dump equals per-type B4 + B5 from SQL on all six types ✅.

## Q2 partition (|C| = 504, |X| = 454)

| bucket | count |
|---|---:|
| paired | 452 |
| O1 unpairable | 0 |
| O2 re-click switching | **0** |
| O3 re-click same target | 1 |
| O4 session-terminal | **49** |
| O5 lost close, mid-session | 2 |
| O6 unclassified | 0 |
| unmatched closes | 2 |

Gates: 452 + 0 + 0 + 1 + 49 + 2 + 0 = 504 ✅; 452 + 2 = 454 ✅. Orphans 52
(10.3%); net 50. Control (lightbox): paired 129, O4 5, O5 1, unmatched 2 —
129 + 5 + 1 = 135 ✅, 129 + 2 = 131 ✅; orphan rate 4.4%.

## What surprised me

- **O2 = 0.** Re-click switching was the dispatch's leading hypothesis for the
  gap. It does not occur — and it *cannot* skip the close, because the popup's
  full-viewport overlay is the close handler: any click while the popup is
  open emits `connection_description_closed` first. Both observed switches
  emitted the first edge's close.
- **31 of the 49 terminal orphans are followed by a voice session.** The user
  opens the edge popup, starts voice from it, the voice session ends, and the
  browser session goes quiet with the popup still open. The lightbox has no
  voice path; that is the whole of the 10% vs 4% difference.
- **Every unmatched close in both pairs is an insert-order reversal.** Four
  closes landed 0.13 ms – 185 ms *before* the open/click that produced them.
  In code a close cannot be emitted before its open; `timestamp` is
  `default now()` at insert and inserts are fire-and-forget. Each reversal
  manufactures one unmatched close and one phantom orphan (O3, O5, O5, O4).
- **The pipeline's own comment at `:434` is wrong about its own miss.** "The
  node had no embedding" — 359 of 375 have one; they are archived.
- **`node_id` is not an id.** 31 distinct values over 101 rows, reused per
  board. The dispatch's B4/B5/B6 wording ("key's node id exists…") would
  misclassify by coincidental reuse; the composite reading was applied and the
  literal count reported alongside.

## Contradicts the dispatch (flagged in the read's §3 as well)

- "Nodes table with archived flag" → the map reads `weave_embeddings`; the
  `nodes` table has uuid ids, no `archived_at`, and neither B5 board exists
  in it.
- "Node id" is a per-board counter, not an identifier (above).
- Re-click switching is refuted, not small.
- "Match the census session record from PR #41" → PR #41 contains only
  `docs/reads/census-8.md`; there is no census session record. This record
  follows `docs/session-record-2026-08-15.md`.
- The real resolver/map-builder could not be called; verbatim copies were
  used and cross-checked in SQL.

## Could not test, and why

- **B3.** No row-level QA marker on any weighted type; `user_id` uniform.
  Session co-occurrence with a QA voice session is reported (103/504 clicks,
  14/49 orphans) as co-occurrence, not attribution.
- **PostgREST `max-rows` on the events read.** `.select('*')` with no range;
  2,642 in-scope events exceed the 1,000 default. Project API configuration,
  invisible to `weave_readonly`. Recorded as a hypothesis for revival.
- **Never-embedded vs hard-deleted** for the four B5 keys without an
  `item_deleted` row. Pre-037 state is unrecoverable from prod.
- **Tab-close vs dropped insert** for O4. Indistinguishable from events;
  `session_ended` follows 5/49, consistent with D3's unmount rate.

## Findings filed out of the sitting

- The D7 miss population is **one cause with one long tail**: archived (95.7%)
  and absent (4.3%), both legitimate exclusion, zero signal loss from format,
  grain or cross-board asymmetry. That is the input the revival handoff's D7
  counter specification asked for; the counter's design is not decided here.
- The click/close gap is **session-terminal, voice-adjacent, and not
  switching**. A pair-asymmetry counter ordered by `timestamp` will also see
  the same-tick reversals; that hazard is documented, not resolved.
- Cardinality discipline held: every aggregate carried an independently
  derived expected count and every partition summed on first derivation. No
  expected figure was adjusted.
