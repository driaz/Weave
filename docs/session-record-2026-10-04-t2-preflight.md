# Session record — 2026-10-04 — Dispatch #56: t2 pre-registration read

> Provenance note: written at the close of the sitting, from the transcript.
> Prod read-only only (`weave_readonly` via `WEAVE_PROD_RO_DATABASE_URL`). No
> writes, no code changes, no snapshot generation, no Anthropic calls.
>
> Dispatch: "#56 — t2 pre-registration read", sections A–G. Deliverable:
> `docs/reads/t2-preflight.md`. PR opened, not merged.

## What happened

1. **Checkout currency first.** `git fetch` showed local `main` one commit
   behind (`e54a031` → `bb23d8f`, PR #55). Fast-forwarded, then cut
   `reads/t2-preflight` from `origin/main`.
2. **RO preconditions.** Read opened `2026-10-04 16:27:57 UTC`. Role
   `weave_readonly`, no RLS bypass; `readonly_audit_select` (`qual = true`) on
   all 8 tables read; SELECT-only grants; single tenant.
3. **Window frozen.** "Since t1" = (`2026-09-07T02:37:59.815Z`,
   `2026-10-04 16:27:57+00`]. Upper bound fixed at the read-open instant so a
   re-run reproduces the counts.
4. **Sections A–G** run as SQL against the t1 row and the live tables; tables
   generated from query output, not transcribed. Every SQL block in the read
   was re-executed from the document before commit; B was diffed against its
   source output (identical).

## Gates

- A: 12 + 21 = 33 expected (t1 summary), 33 returned.
- B: 91 qualifying events → 165 expected (event, key) pairs → 165 resolved =
  48 (the 33) + 37 + 74 + 6 + 0. Per-node table sums to 48.
- C.4: T1 window reproduces t1's `events_read.by_type` (28 / 58 / 10) and
  voice (16) exactly; both windows' board rows sum to their totals.
- D: 71 t1 keys = 71 with rows, 0 archived; live 81 = 71 + 10.

## Findings that bear on the next step

- **Pinned run keeps archived keys.** The dispatch assumed archived t1 nodes
  drop from a pinned run via the map builder; at `bb23d8f` they do not
  (`generate.ts:80-89`). Count-neutral today: 0 t1 keys are archived.
- **Pinning parameter is `pin_node_set_from_snapshot_id`**; there is no
  `node_set` request field. `trigger_reason` is any string (no CHECK).
- **Pinned runs count live non-pinned engagement as `dropped.absent`**
  (`engagement.ts:281-306`).
- **F1 confound** = 2 qa sessions on shouko ⟷ Naruto (both t1
  unclustered_attended, neither an anchor); 2 qualifying closes (417,744 ms and
  2,501 ms) attributed via browser `session_id`. Excluding them changes no
  re-engagement flag.
- **Board with most roster engagement at t1 depends on the measure**:
  Philosophy and Art by count and by t1-decayed weight, Tech and Business by
  undecayed weight (0.9 % margin). Since t1: Abusrdity on every measure.
- **Second archived-but-live row** (`8a8d45a9…:45`, 2026-09-24), outside the t1
  set. Recorded, not investigated.
- Snapshot code is unchanged since t1's deployed SHA `bc22795`;
  `STAGE2_MODEL` is still `claude-opus-4-7`; t1.md §9's `netlify.toml`
  timeout fix is still not applied.

## Not done (by design)

No interpretation, no predictions, no snapshot generation, no merge.
