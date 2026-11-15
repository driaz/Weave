# Read: client node ids reused for different content on the same board

Date: 2026-11-15 (cloud session, `weave-dev`, prod reads through the read-only Supabase connector).
Base: `origin/main` at `627bacd` (#85 merged). Read-only: no code changed, nothing written to prod.
Backlog row: *Client node ids reused for different content on the same board — read*.

## 0. Answer

- **Reuse is real and has a cause in the code that is still present after #76.** The id counter is never stored. Every load works it out again from the cards that survive (`max(id) + 1`), so deleting the highest-numbered cards frees their ids for the next load (§1).
- **Prod: 19 (board, client id) keys have been issued more than once, 31 extra issues in total.** 21 issues came after a delete (the cause above, still live). 10 came with no delete in between, which is the counter stepping back when a fetch landed (fixed by #76). None of the 31 happened after #76 merged on 11-13 (§2).
- **No stale embedding is live against a new card today.** Of the 14 reused keys that still have a card, 13 embedding rows hold the current card's content. The other one (`8a8d45a9/33`) holds the previous card's content but is archived, so it is not served. The cost there is that the current card has no live embedding at all. There are 0 live orphan embeddings on prod (§3.1).
- **Stale rows do attach in two places, both small.** (a) In the snapshot engagement map, events from an earlier card count toward whichever card holds the id now: 6 `lightbox_closed` and 31 earlier-generation `item_added` events, across reused keys. (b) 3 of the 19 `write.unresolved` rows resolve by client id to a card created after the row. Nothing in the app reads those rows that way today (§3.2, §3.3).

The case the row was filed for, an unarchived embedding on a reused id that changes what Weave connects, **does not occur on prod today**. It is possible in a narrow window, described in §3.1.

## 1. Code (Phase 0 premises, file:line)

| Premise | Finding | Where |
|---|---|---|
| How ids are made | A module-level `counter`. `generateNodeId` increments it **then** returns it, so after `reset(c)` the next id is `c + 1`. | `src/utils/nodeId.ts:1-6` |
| Is the counter persisted? | **No.** `nodeIdCounter` lives only on the in-memory `SerializedBoard`. There's no column or RPC field for it. Every hydration works it out again: `computeNodeIdCounter` returns `max(numeric id) + 1`. | `src/persistence/hydration.ts:183-190`; Supabase path `:219`; cache path `:268` |
| Reset paths | Mount from cache: `reset(board.nodeIdCounter)` (the value worked out at `:268`) | `src/hooks/useBoardStorage.ts:178` |
| | Fetch landing on the board on screen: `reset(max(current, fetched))`, the #76 guard | `useBoardStorage.ts:290-292`, used at `:321` and `:354` |
| | New board: `reset(1)` | `useBoardStorage.ts:570` |
| | Board switch: `reset(store's counter for that board)` | `useBoardStorage.ts:636` |
| | Board delete: `reset(next board's counter)` | `useBoardStorage.ts:722` |
| | Boards not yet fetched: `cached?.nodeIdCounter ?? 1`, replaced when their fetch lands | `src/hooks/bootMerge.ts:66` |
| | Save: the snapshot stores the live global counter, which never steps back in a session | `useBoardStorage.ts:469-476`, `:498` |
| Does a deleted card free its id? | **Within a page load, no**: delete (`src/App.tsx:307-323`) doesn't touch the counter. **Across loads, yes**: the next load works the counter out from the surviving cards, so ids above the new maximum come back. Because of the increment-then-return off-by-one, after a load the next id is `max + 2`. A reload therefore reissues an id only when the deleted ids reach at least `max + 2`, for example when the two highest cards are deleted, or the highest card sits above a gap. | as above |
| Does a never-saved card free its id? | Yes, same mechanism. A card that never reached `nodes` isn't counted on the next load. | `hydration.ts:183-190`, `:219` |
| What #76 covers | It stops the fetch from stepping the counter **back** below ids issued in this page load (the warm-cache case). It does not cover reuse after a delete plus a reload. | `useBoardStorage.ts:288-292` |
| Embedding identity | `weave_embeddings` is unique on `(board_id, node_id)`. Both writers upsert on that key with `archived_at = null`, so a new card's first embed **overwrites and revives** the old row. `embed_generation` carries on from the old card. `created_at` keeps the **first** card's time. | `supabase/migrations/002_create_weave_embeddings.sql:14`; `src/services/embeddingService.ts:284-298`, `:316-336`; `media-server/src/supabase.ts:286-306` |
| Archive on delete | An AFTER DELETE trigger on `nodes` archives by `(board_id, _clientNodeId)`. The migration's header already treats reuse as known and harmless: "un-archive-on-write revives the row on its first embed". | `supabase/migrations/037_archive_embedding_on_node_delete.sql:24-30`, `:52-71` |
| `node_processing_log` keying | `node_id` is the **row uuid** (FK to `nodes`), so ordinary rows can't move to a new card. `write.unresolved` rows have `node_id = null` and carry the client id only in `detail`. | `media-server/src/supabase.ts:63-80` |
| Engagement keying | Snapshot engagement resolves `node:{board}:{id}` targets to the composite key `board:id` and weights every event with no regard to which card held the id. `item_added` is a roster event (recency weight). | `netlify/lib/snapshot/engagement.ts:65-71`, `:93-114`, `:209-211` |
| Event coverage | Every `generateNodeId` call site is paired with an `item_added` event (8 sites). | `src/App.tsx:446/456`, `:492/508`, `:561/581`; `src/components/AddNodeButton.tsx:71/78`, `:97/104`, `:145/158`, `:201/217` |

**Premise corrected (from `trigger-before-save.md` §4.3).** "Board `fef6c2a3` client id 14 has a 10-03 embedding row for one item and an 11-10 node row holding a different one." The row's **`created_at`** is 10-03 because an upsert keeps it. Its **content** belongs to the 11-10 card: a James Sexton clip summary on the Nicole Behnam tweet about James Sexton, `embed_trigger = media_patch`, `embed_generation = 7`. `created_at` on `weave_embeddings` is not evidence of which card a row describes.

## 2. Prod inventory

**Source of truth for "issued".** `item_added` events in `weave_events`, one per `generateNodeId` call (§1). Coverage check: **109 of 109** live nodes have a matching `item_added` event. 0 events are malformed and 0 have a board mismatch. Events are fire-and-forget, so the counts below are lower bounds.

**Expected, derived independently.** Grouping `item_added` by `(board_id, client id)` gives 146 keys and 177 adds. **19 keys** have more than one add, and **31** adds are extra.

**Processed.** Each of the 19 keys, classified:

| Board | Live? | Keys | Ids |
|---|---|---|---|
| `64bc0982` | board deleted | 5 | 13 (×5), 14 (×2), 15 (×3), 17 (×2), 21 (×3) |
| `8a8d45a9` | yes | 3 | 11, 15, 33 |
| `a428492a` | yes | 4 | 12, 14 (×3), 23 (×4), 25 |
| `b3c1473b` | yes | 4 | 26 (×3), 28, 32, 36 |
| `fa605a85` | yes | 2 | 8 (×3), 10 |
| `fef6c2a3` | yes | 1 | 14 (×4) |

5 + 14 = **19 processed = 19 expected.** Live keys: each has exactly 1 live node (0 duplicate live `(board, _clientNodeId)` across all 109 nodes).

**By mechanism.** Each extra issue is classified by whether an `item_deleted` for the key falls between it and the previous issue:

| Class | Extra issues | Keys | Dates | After #76 (≥ 11-13) | Median gap |
|---|---|---|---|---|---|
| R1: delete, then reissue on a later load (cause still live) | 21 | 14 | 04-25 … 11-09 | 0 | ~23 h |
| R2: no delete, counter stepped back on fetch (the #76 cause) | 10 | 8 | 04-30 … 11-10 | 0 | 27 s |

21 + 10 = **31 = 31 expected.** Three keys show both classes, so the key counts sum to 22, not 19. R2 cases happen in the same session 10–30 s apart (for example `b3c1473b/28`, `/32`, `fa605a85/10`), or across back-to-back sessions within a minute (`fa605a85/8`: 3 issues in 34 s). That is the lost-card-on-load pattern from the trigger-before-save read. No reuse has been observed since #76, but that is only two days of data.

## 3. What is keyed by (board, client id), and whether a stale row is live against the new card

### 3.1 `weave_embeddings`

For the 14 live reused keys, the row's `content_summary` was compared with the current card's title, description and URL:

| Outcome | Keys |
|---|---|
| Row holds the **current** card's content (overwritten by its embed) | 13 |
| Row holds the **previous** card's content, **archived** (not served) | 1: `8a8d45a9/33` |
| Row holds previous content, **live** | **0** |

`8a8d45a9/33`: the current card is "Daniel Ahmad" (UBS wealth report, added 07-07). The row is the 06-18 card (Camus / Scott Galloway), archived 08-14. Because the key is unique, the current card has **no live embedding**: it is dark to retrieval and to stage 2. This is the "Galloway ghost" that row #1 tracks.

The 5 keys on the deleted board `64bc0982` all have archived rows. They are inert.

**Live orphans** (unarchived rows with no matching node): **0** on prod. This matters because an orphan is the only state in which a stale vector would be served under a new card's id.

**The window that remains (reasoned from code, not seen on prod).** A live stale row on a reused id needs the old card's row to be unarchived when the new card takes the id. That happens if:

1. the old card was embedded but never reached `nodes`, so no DELETE fires and the trigger never archives (for example, added and deleted before its first save); or
2. the old card is lost on a load without a prune.

From the new card's add until its first embed write lands, the old vector is then served under the new card's id. If that embed fails, the old vector stays. Today's count of 0 live orphans means nothing is in that state right now.

### 3.2 `weave_events.target_id` (engagement)

Events on the 14 live reused keys dated **before** the key's last issue, so they belong to an earlier card:

| Event type | Events | Keys | In the engagement roster? |
|---|---|---|---|
| `node_selected` | 16 | 9 | no |
| `lightbox_opened` | 6 | 5 | no |
| `lightbox_closed` | 6 | 5 | **yes** (breadth, dwell-weighted) |
| `item_added` (earlier generations) | 31 | 19 | **yes** (recency) |
| `connection_description_closed` on an edge touching a reused id | 0 | 0 | yes |

So snapshot engagement gives 6 dwell events and up to 31 recency events from earlier cards to the current one. The events are old (median R1 gap ~23 h; most from April to October), so recency decay limits their weight. Their size in an actual snapshot hasn't been measured.

### 3.3 `node_processing_log`

Ordinary rows are keyed by the node row uuid and can't move to a new card. Of the 19 `write.unresolved` rows, 15 now resolve by `(detail.board_id, detail.node_id)` to a live node. **3 of those resolve to a card created after the row:** `b3c1473b/36` (2 rows from 10-10, card from 10-12) and `fef6c2a3/14` (1 row from 11-09, card from 11-10). The rest resolve to a card from the same minute. No code reads unresolved rows by client id (no reader in `src/` or `netlify/`). A future join on them has to bound by time.

## 4. Secondary findings (not this row's scope)

- **An archived embedding can sit on a live card without any reuse.** `8a8d45a9/45` (Ghassan Abu Sitta): there was one `item_added` (09-24 20:12), the row was archived at 20:36, and the node row was re-created at 20:38 with the same content and no re-embed. A prune and re-insert of the same card fires the archive trigger, and nothing un-archives the row until the next embed. Prod has 2 archived-but-live rows (`/45` and `/33`), so the 037/039 invariant (archived ⟺ deleted or superseded) doesn't hold today.
- **`embed_generation` and `created_at` carry across card generations.** Both are wrong as per-card provenance on a reused key.

## 5. Trigger-before-save closing check (done in passing)

`write.unresolved` rows newer than 2026-11-15 08:40 UTC: **0** (19 rows in total, 0 carrying `intended_outcome` / `duration_ms`). There has been no new unresolved write since the deploy, so the row can't close yet. This is not evidence against #85.

## 6. Queries

All were run through the read-only connector on 2026-11-15. The SQL is summarised here, with full text in the session record:

1. Columns of `nodes`, `weave_embeddings`, `weave_events`, `node_processing_log` (information_schema).
2. `weave_events` with a target, grouped by `event_type` (counts, distinct keys, date range).
3. `item_added` grouped by `(board_id, target_id)`: 146 keys, 177 adds, 19 keys with more than one add, 31 extra, 0 malformed, 0 board mismatch.
4. Per reused key: the add and delete timelines, live node count, node summary, embedding (`created_at`, `archived_at`, `embed_generation`, summary), and whether the board is live.
5. Per live reused key: node title, description and URL against `content_summary` and `embed_trigger`.
6. Second-level timestamps and `session_id` for the no-delete cases.
7. Classification of extra issues by a delete in between (R1 21 / R2 10, 0 after 11-13).
8. `write.unresolved`: rows after the deploy (0), and rows resolving by client id to a live node (15, of which 3 are later generations).
9. Pre-last-issue events on live reused keys, by type, plus connection events touching reused endpoints (0).
10. Archived-but-live rows (2), live orphans (0), and totals (109 nodes, 0 without `_clientNodeId`, 142 embeddings, 107 live, 0 duplicate live keys, 109/109 nodes with an `item_added`).
