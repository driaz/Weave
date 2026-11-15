# Read: pipeline trigger precedes node save

**Date:** 2026-11-15 · **Kind:** read only. No code change, no fix · **Row:** "Pipeline trigger precedes node save (~20 s) — fast runs can't attach log or content"
**Base:** `origin/main` @ `9a58147`, fetched at session start.
**Prod data:** the read-only Supabase connector (`supabase_read_only_user`, which bypasses RLS). All queries ran 2026-11-15 ~06:55–07:20 UTC.

## 0. Answer

1. **The row's premise is half wrong.** The client does fire `/process` before the node row exists, but the trigger itself does no harm, because Fly does no node lookup when the request arrives. Damage happens only when a run's **first node write** (the `media_analysis` patch, or the final `logger.persist`) lands before the node's **first save**. On current code that first save usually lands **~1–6 s** after the card is added, not ~20 s. The ~20 s figure comes from the 10-07 run (23.4 s). That run and the 10-09 one (16.1 s) are the only two slow first saves on record, both on pre-#76 code, and their cause is not established (§3.3).
2. **Prod has 15 unresolved runs, and none is a plumbing bug.** They fall into three classes:
   - **8 real races.** The card was saved, but the run finished first, by 0.1–5 s.
   - **4 lost cards.** The card was never saved and was re-added later under the same client id. All happened on a cold load before #76 shipped.
   - **3 user deletes.** The user deleted the card before the run finished.
3. **The race loses logs, never content.** Every race-class run produced no `media_analysis`. None of them wrote a `fly.patchNodeData` unresolved row, so each one failed, or found nothing to analyse, in about 1–5 s. Every run that produced analysis took 14–57 s and resolved. The race is a coin flip for sub-second failures: 4 fast failures resolved and 8 did not.
4. **Content was lost only in the lost-card and delete classes.** Four `media_analysis` patches were skipped: 1 on a card lost on a cold load (11-06, pre-#76) and 3 on cards the user deleted mid-run. The skip is correct behaviour in both cases: there was no node to attach to.

Fix-shape inputs are in §6. No fix is proposed here.

## 1. Premises: file:line

| # | Premise (from the row / dispatch) | Where | Holds? |
|---|---|---|---|
| P1 | The client fires `/process` right after the link metadata arrives, without waiting for any save | `src/App.tsx:588` (await metadata) → `:603` `enrichLinkNode`; `src/components/AddNodeButton.tsx:229` → `:240`; `src/services/linkEnrichment.ts:192` (twitter), `:274` (youtube) → `:413` `triggerMediaPipeline` → `:435` `getSession` → fetch with `keepalive` `:454` | Yes |
| P2 | The card enters React state at once with `loading: true`, so it is in the first debounced save | `src/App.tsx:564–577`; `AddNodeButton.tsx:214`; loading is stripped but the node is kept: `useBoardStorage.ts:73–80` | Yes |
| P3 | The debounced save is 500 ms, **trailing**, and re-armed by every `nodes` change | `src/App.tsx:284–301` | Yes |
| P4 | Saves pass the gate and then a signature check; they run one at a time through `pendingSupabaseSave` | `useBoardStorage.ts:452–460`, `:390–427`; `src/hooks/saveGate.ts:59–68` | Yes |
| P5 | A save does board-get, then image uploads across **all** nodes (memoized), then the RPC | `src/persistence/syncBoard.ts:292`, `:314`, `:340` | Yes |
| P6 | The RPC creates the node row (`created_at` = first save) and updates it in place afterwards (042 merge) | `supabase/migrations/042_…:88–152` | Yes |
| P7 | Fly answers 202 at once; the node lookup happens only at write time | `media-server/src/index.ts:70–73`; `process.ts:104` (patch), `:121` (blob read), `:222/:229` (final persist) | Yes. **This is the correction:** the trigger arriving first is harmless; only the first write racing the first save matters |
| P8 | Writers resolve by `(board_id, user_id, _clientNodeId)` exactly-one, otherwise one `write.unresolved` row and no node write | `media-server/src/supabase.ts:31–41`, `:63–80`, `:93–96`; `logger.ts:120–124` | Yes |
| P9 | `node_processing_log.node_id` cascades on node delete | `043_node_processing_log.sql:36` | Yes. This makes the denominator a lower bound (§2) |
| P10 | "~20 s from trigger to node save" | prod, §3 | **No, as a general rule.** True for 2 of 8 race runs, both pre-#76 |

## 2. Inventory and cardinality

**Expected count (from the table's own totals):** `node_processing_log` = 43 rows = `embed.server` 10 + `media.pipeline` failed 4 + `media.pipeline` success 10 + `write.unresolved` 19. The four groups sum to 43. ✓

**Unresolved rows → runs:** 19 rows. Four runs each wrote two rows within 0.3 s: a `fly.patchNodeData` / `media_analysis` row followed by a `fly.logger.persist` / `media.pipeline` row (10-10 cid 36, 11-06 cid 10, 11-14 cid 16, 11-14 cid 19). So there are 19 − 4 = **15 runs**. Each of the 15 has exactly one `intended_phase = media.pipeline` row. ✓ Every unresolved row has `match_count = 0`: no duplicates and no lookup errors.

**Processed:** all 15 runs are classified in §3: 8 + 4 + 3 = 15. ✓

**Denominator:** 14 resolved `media.pipeline` rows + 15 unresolved runs = **29 runs since 043**. This is a lower bound: a resolved run whose node was later deleted lost its rows through the cascade (P9).

## 3. Classification (prod)

Column definitions:
- **Add** is the start of client enrichment, from the node's own client `processing_log` (`ts − durationMs`).
- **Row** is `nodes.created_at`.
- **Log** is the `write.unresolved` timestamp.
- **Clock check:** on 10-07 the client enrichment start (19:01:14.2) matches Fly's `/process` receipt in Fly logs (19:01:14). `weave_events.item_added` lags the client by about 1.5–3 s, because the insert is fire-and-forget. That is why "add" comes from the client log, not from the event.

### 3.1 Class A: real race. The card was saved, but the run finished first (8)

| Date | Board · cid | Type | Add → Log | Add → Row | Row − Log |
|---|---|---|---|---|---|
| 10-07 | 28681bee · 5 | youtube | 18.5 s¹ | 23.4 s | +5.0 s |
| 10-09 | 8a8d45a9 · 51 | twitter | 11.6 s | 16.1 s | +4.5 s |
| 10-12 | b3c1473b · 36 | twitter | 5.0 s | 6.5 s | +1.5 s |
| 10-19 | fa605a85 · 2 | twitter | 3.2 s | 3.4 s | +0.25 s |
| 10-29 | fa605a85 · 8 (3rd add) | twitter | 1.1 s | 1.2 s | +0.12 s |
| 11-01 | 8a8d45a9 · 55 | youtube | 4.2 s | 5.0 s | +0.78 s |
| 11-11 | fa605a85 · 14 | twitter | 2.0 s | 1.5 s | −0.48 s² |
| 11-11 | b3c1473b · 40 | youtube | 2.8 s | 4.1 s | +1.25 s |

¹ Fly logs show the failure at 19:01:17. The unresolved row is timestamped 19:01:32.7, so the final persist landed about 15 s after the failure. That gap is unexplained.
² `created_at` is the insert time, but the row only becomes visible when the RPC transaction commits. The resolve query ran before the commit. The race still lost.

- None of these 8 runs wrote a `fly.patchNodeData` unresolved row. The patch runs only when analysis is non-empty (`process.ts:102–113`), so none of the 8 produced `media_analysis`. **No content was lost in this class; only the run's log was.**
- Compare the 4 resolved `failed` runs: they took 0.86–1.48 s, and their logs landed 0.4–0.8 s **after** the node row. For about 1-second failures the race is a coin flip: 4 won and 8 lost (the 8 lost include the longer ones).
- All 10 resolved successful runs took 14.1–57.0 s, and their node rows already existed 11–56 s before the final log. **No run that produced analysis has ever lost the race.**

### 3.2 Class B: card lost before it was ever saved (4), all pre-#76

| Date | Board · cid | What happened (weave_events) |
|---|---|---|
| 10-29 00:01:23 | fa605a85 · 8 | Session started 13 s before the add. The session ended (reload) 5.6 s after it. |
| 10-29 00:01:40 | fa605a85 · 8 | New session 11 s before the add. That session ended 7.6 s later. |
| 11-06 10:51:44 | fa605a85 · 10 | Session started 6.5 s before the add. The **same session re-added cid 10** 9.8 s later, so the first card was gone from state and the id counter had rolled back. The run produced analysis (patch unresolved at 10:51:53.4). |
| 11-09 07:39:19 | fef6c2a3 · 14 | Session started 1.5 s before the add. No row for cid 14 appeared until 11-10, and that row holds a different tweet. |

These four are the cold-load save-gate loss that #76 closed on 11-13. The two 10-29 runs are Daniel's 10-28 (local time) report: "added a tweet, moved it, card vanished — twice; third attempt stuck." The third attempt is the 10-29 class-A row above. **The unresolved rows did their job:** they are the only server-side trace of those lost cards.

### 3.3 Class C: user deleted the card before the run finished (3)

| Date | Board · cid | Deleted (`item_deleted`) | Run ended |
|---|---|---|---|
| 10-10 | b3c1473b · 36 | 6 s after the add | ~15 s after the add (analysis patch skipped) |
| 11-14 | fa605a85 · 16 | 44 s after the add | 61 s after the add (analysis patch skipped) |
| 11-14 | fa605a85 · 19 | 12 s after the add | 30 s after the add (analysis patch skipped) |

The `weave_embeddings` rows for 11-14 cids 16 and 19 carry `archived_at` at the delete time (migration 037). This confirms the node rows existed and were removed. Correct behaviour.

### 3.4 Plumbing bugs: 0

No unresolved row comes from a slow run against a card that was saved and kept. By the row's own success criterion ("every unresolved row maps to a run that finished before first save; any from a slow run is a plumbing bug"), the two slow-run cases are user deletes, not plumbing.

### 3.5 Why the first save lands 1–6 s after the add, not 0.5 s

From code (P2–P5). This is reasoned, not measured:
- **The trailing debounce restarts on every `nodes` change.** Several changes follow an add in quick succession: the metadata `setNodes`, the enrichment patches, and each client `logger.persist` appended into `data.processing_log` (`buildProcessingLogAppender`, `src/utils/logger.ts:148`). The first save fires 500 ms after the first quiet gap.
- **Each save then makes three network trips** (board-get, an image-upload pass over every node, then the RPC) and may queue behind a save already in flight.
- On cold load, a save attempted while the gate is closed is **dropped, not queued**. Nothing re-arms the timer until the next `nodes` change.

**The 10-07 (23.4 s) and 10-09 (16.1 s) first saves are not explained by the data.** Both landed right after a client `embed.client` persist (10-07: 35.77 → row 37.64; 10-09: 30.03 → row 30.61). That pattern fits earlier save attempts that were dropped or queued, followed by a re-arm from the next change. It does not fit a single slow save. Both cards survived, so the pre-#76 "card lost on fetch" path is ruled out for them. Both runs predate #76. Since #76 there have been 4 runs (all on 11-14: 2 resolved, 2 deleted mid-run) and no class-A or class-B row, which is too few to call.

## 4. Secondary findings (not fixed; noted for the fix sitting)

1. **Instrument gap: the unresolved row drops the run's outcome and duration.** `logUnresolvedWrite` (`supabase.ts:63–80`) records `intended_phase` but not the `outcome` or `durationMs` the persist was carrying. In this read, "fast failure" had to be inferred from the absence of a patch row. One extra field would make §3.1 directly countable.
2. **The server embed is written whether or not the node resolves.** `upsertEmbedding` writes `weave_embeddings` keyed by `(board_id, node_id)`, with no node lookup (`supabase.ts:306`). In the race window, `fetchNodeBlob` returns null (`process.ts:121`), and composition falls back to `fallbackUrl` for missing client fields (`supabase.ts:229–240`). So a server embed inside the window can be composed without the title or tweet text. Whether a later client re-embed overwrites it was **not verified**. This hazard is reasoned from code only.
3. **Client ids are reused across different content.** fef6c2a3 cid 14 has a 10-03 embedding row (James Sexton clip) and an 11-10 node row (a NicoleBehnam tweet). b3c1473b cid 36 was deleted on 10-10 and re-used on 10-12. Anything keyed by `(board, _clientNodeId)` over time (embeddings, `weave_events.target_id`, unresolved rows) can join unrelated cards. This bears on the open unique-index row and on any fix that carries the client id further.

## 5. Browser repro on dev: not run

Attempted only with tooling already in the environment. Three blockers, each verified in this session:
- **No dev sign-in credentials.** `E2E_DEV_EMAIL` / `E2E_DEV_PASSWORD` are **not set** in this session's environment. Only `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` are present (`env`). The 11-15 record says they were added to `weave-dev`, so either they were not saved or this session's container predates them.
- **The client would never fire `/process`.** `VITE_WEAVE_MEDIA_URL` is unset, so `triggerMediaPipeline` returns at `linkEnrichment.ts:420–423` (`no-media-url`). The race cannot occur on this client.
- **Fly is unreachable.** The egress proxy refused `weave-media.fly.dev:443` (`connect_rejected`).

Playwright is pre-installed and loads (`require('playwright')` OK). It was not the blocker. Nothing was installed.

## 6. Inputs for the fix-shape decision (no decision made here)

- The loss being fixed is **observability of fast-failing runs, plus a lost-card trace that is working as intended**. It is not content. The content-loss classes (B, C) are either already fixed (#76) or correct (a deleted card).
- Making the trigger wait for the first save only changes outcomes for runs shorter than about 1–6 s (§3.1), and on prod those are all failures. Two cheaper alternatives:
  - a server-side retry or short wait before an unresolved persist;
  - recording the outcome and duration on the unresolved row (§4.1), which turns the 8 race rows into countable failures with no ordering change.
- Any ordering change on the client needs to survive the trailing-debounce re-arm and the gate-drop behaviour described in §3.5.
- Post-#76 sample size is 4 runs. One more week of prod use would show whether class A still appears now that cold-load drops are gone.
