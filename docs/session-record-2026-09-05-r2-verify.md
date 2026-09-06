# Session record — 2026-09-05 — R2 verify on prod (OQ14 split verdict, unweighted run 1; B3 pending clearance)

> Provenance note: written 2026-09-05 (local; prod clock 2026-09-06 UTC) at the
> close of the sitting, from the transcript and `docs/reads/revival-r2-verify.md`.
> Prod figures are quoted from that record, which carries the producing queries.
>
> Dispatch: "R2 — Verify on prod: OQ14, unweighted pair, determinism, Q18",
> issued 2026-09-05 from the planning layer; third of four. Roles were strict:
> Daniel executed the one prod write (run 1) from his own terminal; Claude Code
> prepared the command, verified through `WEAVE_PROD_RO_DATABASE_URL` only, and
> at no point held a write credential or JWT.

## What shipped

- **Part A — PR #46** (`feat/r2-run-params`, merged by Daniel): `uniform_weights`
  and `page_size` as validated request-body parameters, both recorded in
  `generation_metadata.parameters`; 34 netlify tests green; tsc + eslint clean.
- **Part B — PR #47** (`reads/revival-r2-verify`, draft, not merged):
  `docs/reads/revival-r2-verify.md` with header (runs SHA `02078ae`, dashboard
  max-rows **1000**), preflight P1–P5, B0 baseline, runbook, B1, B2 (27/27),
  B5, B6, the OQ14 stop, contradicts-dispatch, query map, appendices.
- **This record.**
- **Prod writes by Claude Code: zero.** One prod row was written, by Daniel: run 1,
  `253c9a8c-5170-4461-86e0-e9c9fece9cbd`, `trigger_reason r2_unweighted`.
  Flag-never-delete: it stays.

## Sequence of the sitting

1. Confirmed PR #45 merged (`2cda592`); `main` reset to `origin/main`; Part A
   built on `feat/r2-run-params`, tests/tsc/eslint green, PR #46 opened.
2. Reads branch cut; record header created **before any query**; P1–P5 run.
3. B0 baseline (RO) at `T0 = 2026-09-06 02:24:31 UTC`: exports of the five
   read types (1,349 rows all-time), all embeddings (101), qualifying voice
   sessions with the anchor hop synthesized in SQL (16). Expected values
   computed by importing the **real R1 modules** over the exports; SQL
   composite-join cross-check identical cell for cell: 191 events in window
   (65/58/10/30/28); attribution 186 = 178 + 8 + 0; pairs 65/58/58/7/0 and
   30/28/28/2/0; voice 16, all anchors to live endpoints; live node set 71.
4. Daniel merged #46, supplied max-rows = 1000; header updated.
5. Daniel ran run 1 (`uniform_weights: true`, live set, page 500) and pasted the
   response. RO: exactly one new row, `user_id` = his uid, parameters as
   ratified. Expected values re-derived at run 1's `generated_at`.
6. **Method incident.** The first expected pass was bundled from the reads
   branch at `2cda592` — cut before #46 merged — so `resolveEvents` ignored the
   `uniformWeights` option; every count matched but `max_raw_weight` read 8.616
   vs observed 6.385. Rebased the branch onto `origin/main` (`02078ae`, the
   deployed SHA), rebuilt, and the weights agreed to 1e-9. Recorded in the read
   as the checkout-currency rule applying to expected values, not only to
   absence claims.
7. B2: 27/27 gate lines match. B6: 36/36 top events located, `w_eff` recomputed
   within 1e-6, `user_turns` 4/4. B5 facts extracted.
8. Daniel: *"There is no visibility."* OQ14 **not visible** → §5 stop. B3 not
   requested; B4 not attempted. Diagnosis written (below). PR #47 body updated.

## OQ14 — what "not visible" means here

Reflect's client discards any snapshot with a null/blank `narrative`
(`src/persistence/profileSnapshots.ts:53-57`) and the store then renders the
empty state. Run 1 is a stage-1 row; `narrative` is null by construction
(stage 3 fills it). **A stage-1 snapshot cannot appear in Reflect under any
RLS outcome.** The dispatch designated the UI observation as the OQ14 verdict
on the assumption that the snapshot would appear; that assumption was wrong on
the client code, not on RLS.

The RLS fact is still decidable without a write, because the client takes
`limit(1)` of whatever the policy admits:

| RLS admits run 1? | Reflect shows |
|---|---|
| yes | the **empty state** — the April fixture ("Clarity as cost, not reward") disappears |
| no | the **April fixture, unchanged** |

Daniel then ran the direct authenticated PostgREST read from his terminal (his
token + the public anon key): **two rows, run 1 first.** RLS admits the
pipeline-written row; the §0 question ("visible to the user under RLS") is
**yes**, and census-8 D1 (`user_id NULL` ⇒ invisible) is closed for v2 rows.
The UI verdict stays "not visible" for the client-code reason above. B3 was
not run in this sitting; whether the RLS verdict clears it is the planning
layer's decision.

## B2 gate table (run 1) — 27/27

Every line expected/observed/match is in the record. Headline cells: events
191 = 191 = 191; attribution 186 = 178 + 8 + 0 with per-type 116/113/3/0,
10/8/2/0, 28/25/3/0, 32/32/0/0; pairs 65/58/58/7/0 and 30/28/28/2/0; voice
16 = 16 = 16, 0 unresolved anchors; node set live 71 = 71 = 71; embeddings
101 = 101; `max_raw_weight` 6.384770239 to 1e-9; parameters exact.

## B5 — Q18 facts (run 1, no interpretation)

71 nodes; 7 clusters, sizes 2, 2, 2, 2, 3, 10, 14 (median 2, max 14); 35
clustered, 36 singletons (50.7%); largest cluster 19.7% of the node set; 7/7
clusters span more than one board; 17 anchors, 5 with `w_total = 0`; the
highest-weighted node (`a428492a…:35`, 6.385) is a singleton and so not an
anchor. Top three anchors: `a428492a…:39` (c3; 2.868 = breadth 1.330 + depth
0.873 + recency 0.665), `b3c1473b…:20` (c1; 1.903 = 1.627 + 0.276 + 0),
`a428492a…:23` (c1; 1.536 breadth only).

## What surprised me

- **The OQ14 observation was undecidable by design.** Nobody had read
  `profileSnapshots.ts` against the dispatch's "Reflect appearance is
  expected" line. The row is written, owned, and (on the RLS-side facts)
  admissible; the UI simply cannot render a narrative-less snapshot.
- **The checkout-currency rule bit an expected value.** Counts are
  weight-independent, so every count gate passed while the weight gate failed,
  and the failure pointed at the calculator, not the pipeline. The pipeline was
  right; my working tree was two merges old.
- **Half the corpus is singletons at 0.72**, and the most-engaged node is one
  of them. Facts for Q18, not a verdict.
- **The largest cluster's anchors are not the most-engaged nodes overall**;
  anchors are per-cluster by design (R0/F1), so a 2-node cluster contributes
  two anchors with `w_total = 0`.

## Contradicts the dispatch (also §8 of the record)

- Reflect appearance of a stage-1 row is impossible (narrative guard).
- B6 "by id": `weave_events` provenance entries carry no row id; located by
  type/target/timestamp within 2 ms (32/32) — a row id in `top_events` would
  make this exact.
- Failed `_clientNodeId` hops: none to count (16/16 resolve).
- `absent` 16 → 29 not observable at 70 d (`absent` = 0), as anticipated.
- `nodes_found` is 22 distinct uuids (anchors share endpoints), not 32.

## Not done, and why

- **B3 (run 2, pinned, page 50) and B4 (determinism):** stop condition at OQ14.
  The runbook command is in the record; the pagination proof and the
  determinism diff await clearance.
- **Deleting or editing the r2 row:** out of scope and flag-never-delete.
