# Session record — 2026-09-05 — R1 revival build (dev only, one PR)

> Provenance note: written 2026-09-05 at the close of the sitting that produced
> it, from the sitting transcript. No prod connection of any kind was made in
> this sitting, not even read-only; every database figure below is from the
> dev project (`bxbhjybahfyeqytwpkry`) or from the R0 read
> (`docs/reads/revival-preflight.md`, PR #44).
>
> Dispatch: "R1 — Revival build (dev only, one PR)", issued 2026-09-05 from the
> planning layer, second of four (R0 preflight → R1 build → R2 verify → R3
> prompt v2 + t1). Every parameter was ratified and pre-registered; the build
> implements them as written and reports where the code resisted.

## What shipped

- **`netlify/lib/snapshot/`** — the engagement layer extracted from the
  handler closure into pure modules: `constants.ts` (every ratified value,
  named once), `types.ts`, `engagement.ts` (four-rule roster, one edge
  resolver, decay, `buildWeightMap`, `resolveEvents`, `attribute` with the
  D7 cardinality assert, order-independent `pairAsymmetry`), `clustering.ts`
  (v1 clustering moved verbatim), `generate.ts` (pure core: data in,
  snapshot row + `generation_metadata` out), `reads.ts` (range-paged reads,
  each gated by a `count(*)` on the identical predicate; the first voice read
  on this pipeline), `auth.ts` (caller JWT verification).
- **`netlify/functions/generate-profile-snapshot.ts`** rewritten as the I/O
  shell: verify caller → read → generate → insert with `user_id`.
- **29 unit tests** in `netlify/lib/snapshot/__tests__/` (fixtures, no DB).
  `vitest.config.ts` include widened to `netlify/**/__tests__`.
- **`package.json`** `snapshot:test` now sends `Authorization: Bearer
  $WEAVE_SNAPSHOT_JWT` — the function refuses an unauthenticated call.
- **This record.** PR opened at session close, not merged.

## Sequence of the sitting

1. PR #44 (R0 read) merged to `main` as the dispatch required; `git fetch
   origin && git checkout -B main origin/main`; branch
   `feat/snapshot-revival-v2` cut from `b3a9e5b`.
2. Read R0's F1–F7 and the code paths they cite; then read what R1 needed
   that R0 had not surfaced: the Fly JWT pattern (`media-server` is a
   separate repo; only the client half is here), and the id-space of
   `voice_sessions.anchor_edge_id` (uuid → `edges.source/target_node_id`
   uuids → `nodes.data._clientNodeId` → the bare client id that
   `weave_embeddings.node_id` stores).
3. Wrote constants, types, engagement, clustering, generate, reads, auth, the
   handler, and tests. Ran the netlify suite (29/29), an ad-hoc `tsc` over the
   new modules (clean), eslint on the new modules (clean; one pre-existing
   error in `claude-proxy.ts`, untouched).
4. Executed the three reads plus the pure core against **dev only** through a
   throwaway esbuild bundle (no insert): embeddings gate 54 = 54 (30 live);
   events gate 0 = 0 (dev has no roster/pair events in the last 70 days);
   voice gate 1 = 1 with the anchor resolved through `edges` → `nodes` to
   `connection:c77622eb…:26:12`; that session has 0 user turns, so it is a
   zero-weight event (counted in `attribution.zero_weight_events`, not in
   `resolved`). Clustering produced 4 clusters, 3 cross-board, 18 singletons.
5. Full `npm test`: 306 tests, 305 passed; the one failure was
   `media.test.ts` (Supabase Storage on dev, deadlock `40P01`), which passed
   on rerun and is unrelated to this change.
6. Record written; PR opened.

## Decisions as implemented

| decision | implementation |
|---|---|
| Roster of four | `ENGAGEMENT_RULES` = `lightbox_closed`, `connection_description_closed`, `voice_session`, `item_added`; removed `connection_label_clicked`, `lightbox_opened`, `node_selected` (and `weave_triggered`, which was never in the table). Emitters untouched. |
| One edge resolver | `resolveEdgeTarget` used by both `connection_description_closed` and `voice_session`. |
| Decay per event | `decay(w_rule, age_days, H)`; H by class (`depth` → 42 d, else 14 d); applied inside `attribute` before accumulation. |
| Horizons in the query | `readEvents`: `.gte('timestamp', generated_at − 70 d)`; `readVoiceSessions`: `.gte('ended_at', generated_at − 210 d)`. |
| Global read | No `board_id` predicate anywhere; `board_id` recorded per anchor and per contribution's parent event. |
| Voice predicates system-layer | `.eq('session_kind','real').not('ended_at','is',null).not('anchor_edge_id','is',null)` in the query; `voice_utterances(speaker)` embedded with `.eq('voice_utterances.speaker','user')` so `user_turns` = length of the joined array. |
| Pagination | `.range()` in `READ_PAGE_SIZE` = 500 blocks until a short page; every read then compares `rows_returned` to a head `count(*)` with the identical predicate and throws on mismatch. |
| D7 counter | `attribution.resolved = hit + archived + absent`, overall and per type, asserted by `assertAttributionCardinality` (throws). |
| Pair asymmetry | Per `(session_id, target_id)`: `paired = min`, `orphan_opens = max(0, opens − closes)`, `unmatched_closes = max(0, closes − opens)`; both pairs; over the same 70-day read. |
| Named parameters | `anchor_count` and `pin_node_set_from_snapshot_id` accepted in the request body; `node_set.source` recorded as `live` or `pinned:<id>`. |
| OQ14 | `verifyCaller` reads `Authorization: Bearer`, calls `auth.getUser(jwt)` on the service-role client, and the handler returns 401 without a verified identity; the insert carries `user_id`. |

## Contradicts the dispatch (also in the PR body)

- **Voice curve test values.** §2.7 pre-registers 1.5 / 2.06 / 2.60 / 2.98 /
  3.62 (±0.01) at 4 / 8 / 15 / 23 / 47 turns, but §2.1 ratifies
  `VOICE_BASE = BREADTH_MAX / log₂(MIN_REAL_TURNS + 1)` = 0.6460 and forbids
  hardcoding 0.65. Those five numbers are the 0.65 curve. The derived curve
  gives 1.500 / 2.048 / 2.584 / 2.962 / 3.608; at 8, 15, 23 and 47 turns the
  pre-registered values are 0.012–0.018 outside ±0.01. The test encodes the
  derived values (the ratified derivation is the decision; the table is its
  arithmetic) and the discrepancy is flagged for the planning layer to
  ratify one way or the other. Nothing was hardcoded.
- **`anchor_edge_id` is not a `connection:` target.** It is an `edges.id`
  uuid; the endpoints are node uuids; the map's keys are client ids. The
  voice read therefore performs two further reads (`edges`, then `nodes`) and
  synthesizes `connection:{board}:{from}:{to}` from `nodes.data._clientNodeId`
  (hydration's own rule) before handing it to the shared edge resolver. The
  resolver is the same; the path to it is longer than §2.4 implies.
- **The Fly verification code is not in this repo.** `verifyUserToken` lives in
  `media-server`; only its client half (`src/api/claude.ts`) is here. The
  server-side check implemented is Supabase's `auth.getUser(jwt)`, which is
  what that helper performs; equivalence is asserted on the pattern, not by
  reading its source.
- **`weave_triggered`** was listed as removed from `ENGAGEMENT_RULES`; it was
  never in the table. Nothing to remove.
- **Zero-weight events** (a voice session with 0 user turns, a lightbox close
  with null dwell) are skipped before the lookup, as v1 did, and are therefore
  outside `resolved`. Counted in the additive field
  `attribution.zero_weight_events` so the exclusion is visible.

## Could not verify here, and why

- **The pre-registered effect of the global read** (`dropped.absent` 16 → 29,
  hits unchanged) is a prod figure; this dispatch forbids any prod connection.
  R2.
- **The PostgREST cap value.** Pagination plus the count gate make the
  pipeline correct whatever the cap is; the setting itself is still unread.
- **A real 70-day event population.** Dev has none; the events path is
  exercised by unit tests and by the gate (0 = 0) against dev.
- **OQ14 end-to-end** (insert, then read as the user). R2.
