# Session record — 2026-08-15/16 — #8 preflight read, stale-base error, correction

> Provenance note: written 2026-08-23 as the close-out for the preflight sitting,
> from a handoff drafted 2026-08-16.
> Sources: the #8 preflight handoff, the sitting transcript, PR #39 (body and
> commits), and `docs/reads/preflight-read-8.md`. Zero prod contact in the
> close-out session — nothing here was re-derived from the database; prod figures
> are quoted from the read report, which carries the producing queries.
>
> Timeline (resolved): the read and its correction ran **2026-08-15/16**;
> review and merge of PR #39 followed on **2026-08-23** — merge commit
> `a2d3847`, authored 2026-08-23 15:23:32 -0400 (`mergedAt`
> 2026-08-23T19:23:33Z). The close-out handoff recorded the merge as
> 2026-08-16; that was an error in the planning artifact, adjudicated by
> Daniel and corrected here. The gap between correction and merge is review
> latency, not further work on the report — nothing in the report changed
> after the 2026-08-16 correction.

## What shipped

The #8 preflight read — a point-in-time prod/code inventory feeding the design
sitting where the grain-of-weighting argument happens (edge vs. node vs. region
vs. session). Executed 2026-08-15 as a read-only session with exactly one
permitted write surface: the report itself.

- **`docs/reads/preflight-read-8.md`** — first occupant of the new `docs/reads/`
  document class. Read reports describe what **IS** and therefore go stale;
  session records (this class) describe what **HAPPENED** and do not. Every
  report opens with a header block stating that prod claims are re-verified by
  re-running the stated queries, never by citing the document.
- **49 read-only queries** over `weave_readonly` via `--db-url`. RLS visibility
  was verified as a precondition *before any count was trusted*: the role is
  neither superuser nor `BYPASSRLS`, and visibility rests on an explicit
  `readonly_audit_select` policy (`qual = true`) confirmed present on every
  table counted. Without that check every count in the report could have been
  silently filtered.
- **All five inventories completed.** No partials, no blocks, no workarounds, no
  credential reaches. PR #39 opened at session close, not merged.

## Sequence of the sitting

1. Branch `docs/preflight-read-8` cut; `docs/reads/` created; report drafted
   across the five inventories with file/line citations throughout and every
   prod finding tagged with its producing query.
2. Draft asserted that `docs/session-record-2026-08-13.md` did not exist.
3. PR #39 opened, carrying that assertion in its body as a flagged
   documentation gap.
4. Re-run requested from `main`. The stale base surfaced immediately on
   checkout — local `main` was five commits behind `origin/main`.
5. Delta diagnosed, correction applied, PR body rewritten, PR merged.

## The stale-base error (the important part)

The branch was cut from a **stale local `main`, five commits behind
`origin/main`**. Those five commits were PR #38 — and one of them, `ac6dc67`,
adds `docs/session-record-2026-08-13.md`: the exact file the draft asserted did
not exist.

The searches were not sloppy. `ls docs/` and a repo-wide `find` for
`session-record*` were both executed correctly and both returned nothing.
**The search space itself was stale.** A negative result is a claim about the
search space, not about the world, and nothing in the working tree announces
that the search space is behind.

The sharper point of record: **this is the second consecutive sitting in which
`docs/session-record-2026-08-13.md` was the thing a session needed and did not
read.** First on 2026-08-14, when a fresh session constructed a causal story
from prod state before reading the record. Now on 2026-08-15, through a stale
tree. Two different failure modes, one missed artifact.

Noted as symmetry, not as excuse: the sitting *did* verify the analogous
precondition on the database side (RLS visibility before trusting counts) and
did not verify it on the repository side (checkout currency before trusting
absence). One precondition was checked; its twin was not.

## The correction (2026-08-16)

Diagnosed before any re-run, so the scope of re-verification was known rather
than assumed:

- **The five commits touch no code.** `git diff --name-only deda67a..origin/main`
  returns only `MIGRATIONS.md` and the session record. The file/line map was
  therefore structurally unaffected — established as a fact before re-checking,
  not asserted after.
- Branch rebased onto `main@1a61fc2`.
- **Re-verification scoped to the delta:** 23/23 load-bearing prod counts
  reproduced with **zero drift**; 15/15 spot-checked file/line citations
  resolved unchanged.
- The false claim was **retracted in a new §0**, with the discipline entry it
  earns: *"the file is not in my working tree" is not "the file does not
  exist."*

**Reading the record improved four sections beyond the fix** — the correction
was net-additive, not merely a deletion:

- **§5.7** — the record names the ghost's PK
  `86b0bed0-dee8-405a-83b9-9e0a9b265f03` and `archived_at 2026-08-14 01:13:57`;
  the re-run's `Q42` returns both **byte-for-byte**. The record also supplies
  what prod state alone cannot: the `037` trigger was **not** the writer — a
  manual by-PK `UPDATE` during the promotion sitting was. Exactly the fact whose
  absence produced the 2026-08-14 misdiagnosis.
- **§4.3** — the #5 rule's real asymmetry: `(board_id, client_node_id)` is
  **safe for deletion-path joins, unsafe joined to live nodes**. Engagement
  attribution joins to live nodes (unsafe); the `037` trigger joins on the
  deletion path (safe). A weighting scheme cannot borrow the trigger's precedent
  as license for the same join.
- **§2.4** — #11 is filed as a watch item at **n=0, "not built for."** Observed
  incidence is zero; the exposure is **structural, not demonstrated**. Both
  halves belong in the design argument.
- **§5.2** — the relocation flag **predates the read**: the promotion sitting
  already logged the `extract-snapshot-themes.ts` filter for "system-layer
  relocation at #8 revival." The read's contribution is not the flag but the
  landing spot — **no RPC exists to relocate it into**.

## The force-push adjudication

The correction was applied by `commit --amend` plus `push --force-with-lease` to
the unreviewed branch, holding the handoff's one-commit done criterion (a single
commit containing only the report).

Accepted by Daniel, **on the condition that the error's durable record live
outside the report**. The PR #39 body carried the retraction narrative in the
interim; **this session record is its permanent home**. §0 of the report is a
pointer, not the archive.

Rationale of record: the report is a point-in-time inventory whose findings
decay by design. The error and its cause are what-happened material, and
what-happened material belongs in the record class, which does not go stale.
Had the retraction lived only in §0, it would have aged out with the counts
around it.

## Outcome

PR #39 merged after body-level review plus content spot-checks — the header
block with its base SHA, the §0 retraction, and §6 confirmed questions-only
(**21 questions, zero answers**).

Carried forward from the read, unresolved by design:

- **Anomaly divergences, reported-not-investigated per the pre-registration
  protocol.** Zero-utterance sessions measured **11** against a pre-registered
  8 (all `session_kind = 'qa'`). Sessions with utterances but no deposits
  measured **10** against a pre-registered n=1. No causes hypothesized, no
  follow-up run. Both carried into §6 as questions.
- **Open question 14** — whether a service-role pipeline insert yields a
  client-visible snapshot, given the insert omits `user_id`, the column defaults
  to `auth.uid()`, and the client read is RLS-scoped `auth.uid() = user_id`.
  Prod holds no evidence either way, because the one existing row was
  backfilled rather than pipeline-written. **Flagged as the first thing revival
  verifies empirically** — it is cheap, it is a precondition for observing any
  other revival result, and it cannot be settled by reading.

## Findings filed out of the sitting

- **Checkout currency is a precondition, not a courtesy.** Branches are cut from
  freshly-fetched `origin/main`, never from local `main`. Hardened into
  `Claude.md` this close-out.
- **Absence claims carry their search space.** Before asserting absence, state
  the preconditions the search space itself depends on — checkout currency, RLS
  visibility, migration state. Hardened into `Claude.md` this close-out.
- **The read's headline finding stands unchanged by the correction:** the
  snapshot pipeline has **never run in prod**. One snapshot row exists,
  `trigger_reason = 'fixture'`, zero clusters. `CLUSTER_SIMILARITY_THRESHOLD =
  0.72` has therefore never been validated against production output at all —
  "recalibration" at revival is closer to first calibration.
- **Six defects catalogued, none fixed**, per the read session's no-fixes scope.
  They remain open for the backlog reconciliation sitting, which is separate.

## Context

The `docs/reads/` class was created in this sitting and immediately earned its
own boundary: the class distinction (what IS vs. what HAPPENED) is what forced
the retraction out of §0 and into this file. The document class and the
adjudication that tested it arrived in the same sitting.
