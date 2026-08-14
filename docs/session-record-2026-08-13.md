# Session record — 2026-08-13 — PR-3 promotion (migrations 037–039), #2 close

> Provenance note: this record was reconstructed on 2026-08-14, one day after the
> sitting, after the cleanup session discovered the backlog cited this file
> before it had been written. Sources: master backlog (2026-08-13
> reconciliation), PR #37, MIGRATIONS.md apply-status block, and the 2026-08-14
> prod verifications (RO). Bracketed items are terminal-only details known to
> Daniel; everything unbracketed is cross-checked against a written artifact.

## What shipped

PR #37 — migrations 037–039, applied to Weave-Prod from Daniel's terminal on the
evening of 2026-08-13 (Eastern). PR merged same sitting. **Issue #2 (embedding
pipeline soundness) closed with this promotion.**

- **037** — AFTER DELETE trigger on `nodes`
  (`trg_archive_embedding_on_node_delete`) archiving `weave_embeddings` rows on
  `(board_id::text, _clientNodeId)`. SECURITY DEFINER — a session deviation from
  the handoff, accepted as correct because RLS would silently skip cross-role
  rows (fail-soft). Hardened after a review catch with
  `search_path = public, pg_temp` and qualified table references.
  Archive-not-delete rationale (dreaming substrate) recorded in the migration
  header. Client-side archive side-effect queue removed; the `queueSideEffect`
  mechanism was left caller-less per no-adjacent-refactors.
- **038** — `archived_at IS NULL` filter added to `match_retrieval_context`
  (with diagnostics), plus a client-side filter in
  `extract-snapshot-themes.ts` (client-side TS only — flagged for
  system-layer relocation at #8 revival).
- **039** — un-archive-live-rows predicate fix. See adjudication below.

## Sequence of the sitting

1. Handoff authored: option (b) argued as the coherent design; a blocking
   preflight gate installed requiring confirmation that
   `replace_board_contents` is upsert + prune. Preflight finding of record:
   confirmed live at 030:91–146 — the trigger's safety under debounced
   full-board saves rests on this.
2. Claude Code implementation + dev rehearsal: ×5 green on Weave-Dev.
   SECURITY DEFINER deviation surfaced and accepted; `search_path` hardening
   added after the review catch.
3. Prod promotion from Daniel's terminal — inline credential scoped to the
   sitting; eyes checkpoints at the trigger body (verified as-deployed, not
   as-written) and at the 039 data-fix NOTICE. Pushed migrations 37 to 39 one by one in Terminal, deemed successful due to response from Supabase, and verification. 
4. PR #37 merged; #2 closed; backlog reconciled the same day.

## The 039 adjudication (the important part)

039's un-archive predicate emitted an identity-listing NOTICE (count-plus-names
gate, by design). Three rows surfaced:

- **Maxpein** and **Pope Leo XIV** — un-archived, then re-verified by content
  against their cards. Clean. (Re-confirmed un-archived on prod 2026-08-14.)
- **Third row — a generation collision, not a valid revival.** A
  Galloway-content deletion trace sitting at client id 33 on board
  `8a8d45a9…` — an id reused across card generations; the live card at that
  identity is a different tweet (Daniel Ahmad's). The predicate would have
  revived predecessor content as servable (RUST COHLE mode). Caught by the
  names gate — a count-only gate would have blessed it.
- **Resolution:** the ghost row was re-archived manually, by primary key,
  during the same sitting.
  **PK: `86b0bed0-dee8-405a-83b9-9e0a9b265f03`**, `archived_at` stamped
  2026-08-14 01:13:57 UTC (= 2026-08-13 ~9:13 PM Eastern, the promotion
  evening). Note for future readers: this manual by-PK UPDATE is why the row
  carries a post-promotion timestamp with no node-delete event — the 037
  trigger was not the writer. This exact confusion occurred on 2026-08-14 and
  is documented in PR #38's ledger note.

## Findings filed out of the sitting

- **Daniel Ahmad has NO embedding row on prod at all** — the only card in the
  corpus with zero retrieval presence. His card stays dark until #17
  (analysis-at-ingest), where his first honest vector arrives. An archived
  ghost row at his identity alongside his live node is therefore **expected
  state**, not an invariant violation, until #17 ships.
- **Sweep-verification hole (filed as #1 chip):** the sweep record's "verified
  to hold its own content" for Ahmad in fact verified identity, not content —
  it blessed the Galloway ghost sitting at his reused client id. Discipline
  entry: verification must verify the claim, not the label.
- **Generation-ambiguous key rule hardened into #5:** `(board_id,
  client_node_id)` is safe for deletion-path joins, unsafe joined to live
  nodes (prod evidence, n=1, this sitting).
- **#11 watch item (n=0, not built for):** stale full-board saves can prune a
  node the client later restores; the 037 trigger archives correctly on the
  prune, but revival lives on embed writers only — the card stays dark until
  its next embed event.
- Pre-sweep row export discarded (retention window ended verified-on-prod).

## Verified-on-prod addendum (2026-08-14, RO)

- `trg_archive_embedding_on_node_delete` present on `nodes`.
- `match_retrieval_context` body contains the `archived_at is null` filter.
- Maxpein and Pope Leo XIV un-archived.
- Exactly one archived-row-with-live-node identity exists: the Galloway ghost
  above. Expected; resolves at #17.

## Context of the week (for the interlude)

Two credential escalation incidents in the week preceding this sitting
(keychain token read; Management API reach after explicit instruction) →
credential interlude (rotation, keychain ACL, permission audit) scheduled as
REQUIRED. This sitting's terminal-only promotion ceremony is the containment
pattern working: the credential never entered a session.
