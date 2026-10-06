# Warm-boot save — does the client save fire from stale cached state?

> **This is a point-in-time read, as of 2026-10-06 UTC. Findings only. No fix is proposed.**
>
> **Read opened:** `2026-10-06 19:11:57 UTC` (`select now()` at first RO connection).
> **Repo SHA:** `c072fa2` (`origin/main`, freshly fetched). Branch `reads/warm-boot-save` cut from `origin/main`.
> **Database:** Weave prod (`wndfikmpifyqkgivmnwv`). **Role:** `weave_readonly` via `WEAVE_PROD_RO_DATABASE_URL`. No writes and no temp objects; CTEs only.
> **Follows:** `docs/reads/board-sync-11.md`, which raised the hypothesis in its step 6.
>
> **Findings in this document decay; the query map does not.**

---

## 0. Preconditions and dispatch premises

| precondition | state |
|---|---|
| Checkout currency | `git fetch`; branch cut from `origin/main` = `c072fa2` (includes #66 / 042) |
| RO identity | `weave_readonly` |
| 042 on prod | `md5(prosrc)` = `32017a1e…`, verified after the push (MIGRATIONS.md 042 block) |
| User population | 1 distinct `user_id` in `boards` and `weave_events`, so "same user" = all events |

**Premises found wrong or untestable (flagged, not worked around):**

1. **"7 of 8 boards, 0–8.6 s."** That figure came from `board-sync-11` §5, which looked only at load/switch events on the **same board**. The dispatch asks for the nearest load/switch event **for the same user**. On that basis the answer is **8 of 8, gap 0.063–6.138 s** (§B.1). Both the count and the range change.
2. **"Count edit-class events: node moved/edited, connection created."** `weave_events` has **no** event type for node moves, card text edits or connection creation. The recorded edit classes are `item_added`, `item_deleted`, `weave_triggered` and `board_created`. So "0 edit events" means **0 recorded** edit events. A drag or text edit between load and save cannot be ruled out from events.
3. **Item 8 (post-042 skip-guard check) can't be tested yet.** **No board has been saved since 042 reached prod.** All 9 boards still show exactly 1 distinct `nodes.updated_at`, every one older than the 042 push, and there are no `weave_events` after 2026-10-06 18:00 UTC. §B.4 gives the query to run after the next real session.

---

## Phase 0 — code trace

### A.1 Boot on a warm cache

`ProtectedRoute` mounts `App` only once auth has loaded **and** a user exists (`src/auth/ProtectedRoute.tsx:9-19`), so `user.id` is set from App's first render.

| # | step | where | triggered by |
|---|---|---|---|
| 1 | Cache read: `buildStoreFromCache()` assembles the store from the localStorage board list, last-active id and per-board cache | `useBoardStorage.ts:160-171` → `hydration.ts:285-315` | the hook's `useState` initializer, on first render |
| 2 | `hydrating` starts **false** when the cache was usable | `useBoardStorage.ts:178` | same |
| 3 | State hydrate: React `nodes`/`connections` seeded from `currentBoard` (cache) | `App.tsx:101-111` | `useState` initializers |
| 4 | Sync effect on mount: all four triggers are false (`boardChanged`, `hydrationJustFinished`, `rolledBack`, `revalidated`), so **`markBoardClean` is not called** | `App.tsx:195-224` | mount |
| 5 | Debounced save effect arms a 500 ms timer (`hydrating` is false) | `App.tsx:259-274` | mount, then every change to the `nodes`/`connections` reference |
| 6 | Fresh fetch: `fetchFromSupabase(lastActiveBoard)` loads every board's nodes and edges, with image URL signing | `useBoardStorage.ts:236-253` → `hydration.ts:241-268` | mount (`authLoading` is already false) |
| 7 | Cache rewritten from the fetch, unconditionally | `useBoardStorage.ts:277` (`writeStoreToCache`) | fetch success |
| 8 | State replace, **only if `!storesEqual(prev, finalNext)`**: `setStore`, `setHydrationRevision` → the sync effect's `revalidated` branch → `setNodes(fetched)` + `markBoardClean(fetched)` | `useBoardStorage.ts:282-294` → `App.tsx:202-219` | fetch success |
| 9 | On fetch failure with a warm cache: stay on the cache. No reseed and no `markBoardClean` | `useBoardStorage.ts:301-313` | fetch failure |

**`storesEqual` is content-blind** (`useBoardStorage.ts:739-754`). It compares `lastActiveBoard`, board ids, and per board only `updatedAt`, `name`, node count and connection count. `updatedAt` is `boards.updated_at` from the fetch (`hydration.ts:238`), and step 7 writes that same string into the cache.
- `boards.updated_at` is advanced only by `replace_board_contents` (and board rename/create). Server-side node writers do not touch it: `patch_node_data` (016) and `append_processing_log` (021) update `nodes` only.
- So if the browser's last contact with a board was a boot fetch rather than a save, the next warm boot's fetch compares **equal** even when node content changed on the server. Step 8 then never runs: no reseed, and **no `markBoardClean` for the whole session**.

### A.2 Board switch

| # | step | where |
|---|---|---|
| 1 | `handleSwitchBoard` calls **`saveCurrentBoard(nodes, connections)` for the departing board**, immediately (no debounce) | `App.tsx:375-382` |
| 2 | `switchBoard`: `setStore({lastActiveBoard})` and `putLastActiveBoard` | `useBoardStorage.ts:573-581` |
| 3 | Sync effect `boardChanged`: `setNodes(store board)` + `markBoardClean(store board)` | `App.tsx:196-219` |
| 4 | Debounce re-arms; the signature now matches, so it is skipped unless something mutates | `App.tsx:259-274` |

The destination board's state comes from the **store**. That is whatever the boot fetch loaded, or the cache if the fetch failed or hadn't landed, or the last save snapshot. **A switch never re-fetches.**

### A.3 Every save path (two independent passes agree: 4 = 4)

All content writes go through `syncBoardToSupabase` (`syncBoard.ts:287`). Its only non-test caller is `runSupabaseSave` (`useBoardStorage.ts:352-388`), which runs saves one at a time and skips when `!user?.id` or `!supabase`.

| # | call site | trigger | state the payload is built from | guards |
|---|---|---|---|---|
| A | `App.tsx:265-266` → `saveCurrentBoard` → `useBoardStorage.ts:434` | 500 ms debounce after any change to the `nodes`/`connections` reference: user edits, non-user mutators (A.5), **and mount** | React `nodes`/`connections` captured when the timer was set; board id read live from `storeRef` (`:406`) | `hydrating` (`App.tsx:260`); signature equal to `lastSavedSignatures` (`:410-413`); auth |
| B | `App.tsx:377` (`handleSwitchBoard`) | user switches board; immediate | current React `nodes`/`connections`, saved as the **departing** board | signature; auth |
| C | `App.tsx:386` (`handleCreateBoard`) | user creates a board; immediate | same as B | signature; auth |
| D | `useBoardStorage.ts:546` (`createBoard`) | user creates a board | a fresh empty board | auth only |

There is no `beforeunload`, `pagehide` or `visibilitychange` save and no interval timer (`App.tsx:248-251` only tracks events).

`lastSavedSignatures` is written at:
- `:420`: optimistic pin in `saveCurrentBoard`.
- `:492` / `:494`: restored on save failure.
- `:513`: inside `markBoardClean`.
- `:537`: `createBoard` seeding the empty signature.
- `:564` and `:693`: deleted when the createBoard save fails and after a board delete.

`markBoardClean` has **one caller**, the sync effect (`App.tsx:219`). It runs only on board change, cold hydration finishing, rollback, or revalidation.

### A.4 Answer to item 3: can a save fire between hydrate-from-cache and fetch-complete?

**Yes.** The path is save path A, armed on mount:

```ts
// App.tsx:259-268
useEffect(() => {
  if (hydrating) return            // false on a warm cache (useBoardStorage.ts:178)
  ...
  saveTimeoutRef.current = setTimeout(() => {
    saveCurrentBoard(nodes, connections)   // nodes = cache-seeded (App.tsx:101-108)
  }, 500)
}, [nodes, connections, saveCurrentBoard, hydrating])
```

```ts
// useBoardStorage.ts:410-413
const signature = computeSaveSignature(nodes, connections)
if (lastSavedSignatures.current.get(boardId) === signature) {   // map is empty on a fresh page
  return
}
```

On a fresh page `lastSavedSignatures` is an empty `Map` (`:189`), and step A.1-4 never seeds it. `get(boardId)` is therefore `undefined` and **any** signature passes. The save carries the cache-seeded nodes and connections:
- every `data` key the cache holds, including `processing_log` and `contentDescription`, as of the cache's last write;
- minus the binary fields stripped on save.

**The mechanism has a name: the mount run of App's debounced save effect, with no clean-signature seed on the warm path.** It is suppressed only if the fetch lands first **and** `storesEqual` is false, so that A.1-8 reseeds and calls `markBoardClean` before the timer fires. React Flow's `dimensions` changes (`App.tsx:303-317`) replace the `nodes` array during mount measurement, which keeps re-arming the timer and widens the window in which the fetch can win.

Two more windows hand the same un-seeded state to path B:
- **`storesEqual` true** (A.1): no reseed for the whole session, so the first switch-away (path B) or debounce (path A) saves cache-era content.
- **Fetch failure with a warm cache** (A.1-9): the same, for the whole session.

Under a **cold** boot, `hydrating` is true, so the save effect returns early. `hydrationJustFinished` then reseeds and calls `markBoardClean`, and the follow-up debounce is skipped. **A cold boot does not save on its own.**

### A.5 Non-user state mutators (re-arm the debounce)

| file:line | changes | changes the signature? |
|---|---|---|
| `App.tsx:217-218` | reseed from store | no (seeded at `:219`) |
| `App.tsx:78` via `useBoardStorage.ts:483` | edge ids onto connections after a save | no (`id` excluded since 041) |
| `App.tsx:314` (`onNodesChange` passthrough) | React Flow `dimensions` / selection | no, but **delays the timer** |
| `logger.ts:148-167` appenders (wired at `App.tsx:437,489,574`, `AddNodeButton.tsx:112,166,238`, `TextCardNode.tsx:100`) | appends `data.processing_log` | **yes** |
| `App.tsx:563-569`, `:581-589`; `AddNodeButton.tsx:230,245` | link metadata, `loading`, transcripts, `contentDescription`, `imageBase64` presence | **yes** |
| `App.tsx:687-697` | connections from a weave | yes (user-initiated) |

None of the signature-changing mutators runs on a plain boot. They fire from add, paste or drop enrichment and weave callbacks. Image URL signing happens inside the fetch (`hydration.ts:121,136`) and reaches React only via the reseed.

### A.6 Item 4: `computeSaveSignature`

- **Contents** (`saveSignature.ts`):
  - per node: `id`, `type`, `position`, and `data` with 7 transient keys reduced to `_has_<key>` booleans;
  - connections whole, **minus `id`** (041);
  - everything key-sorted.
- **Does a hydrate-from-cache produce a signature that differs from the last-saved one?** Not exactly: **there is no last-saved signature** on a fresh page. The comparison is against `undefined`, so a no-edit boot save is not "a change that looks real". It is **unconditional**, unless `markBoardClean` ran first.
- **Does a fetch landing after a stale save trigger a second save?**
  - **No, on its own.** If `storesEqual` is false, A.1-8 reseeds from the fetch and calls `markBoardClean` with the fetched state. The re-armed debounce then compares equal and skips. If `storesEqual` is true, nothing changes in React state at all.
  - **It does leave a split.** If the fetch read the DB **before** the stale save committed, the client now shows fetched (fresh) state while the DB holds the stale save. The two are reconciled only by the next real edit's save. That save sends the fresh state; under 042 it restores round-tripped keys, and it restores omitted keys only if they are still in the row.
  - If the fetch read **after** the commit, the client takes the stale state as truth, and the cache is rewritten with it (A.1-7).

### A.7 Hazards seen in passing (independent pass; reasoned from code, not reproduced; out of scope)

- **Stale timer on switch.** The debounce timer's `nodes` closure and `storeRef`'s live board id can disagree for one render on a switch, because `handleSwitchBoard` does not clear `saveTimeoutRef`. That could save the old board's nodes into the new board.
- **Enrichment lands on the wrong board.** Async enrichment and logger appenders match on per-board node ids only, so a callback that lands after a switch can patch the same-id node on the new board.
- **No unload flush.** Edits made in the last 500 ms before close are not saved.

---

## Phase 1 — data (prod, RO)

### B.1 The 8 client-saved boards (item 5)

There are 9 boards. **Parenting** is excluded by name: its single node was last written by the 07-28 sweep RPC (`nodes.updated_at` 07-28 05:45:19), not by a client save. That leaves **8**. For each, `boards.updated_at` equals its single `nodes.updated_at` exactly (same RPC transaction, so the same `now()`).

| board | last save (pre-042) | nearest preceding load/switch (same user) | event board | gap (s) | edit events between | any event between | warm/cold |
|---|---|---|---|---:|---:|---:|---|
| Death | 08-29 17:02:53.180 | `board_switched` 17:02:48.929 | Death (destination) | 4.252 | 0 | 0 | not knowable |
| Career | 09-13 21:13:38.098 | `board_switched` 21:13:36.639 | Tech and Business (**away** from Career) | 1.459 | 0 | 0 | not knowable |
| Depression | 09-13 21:14:32.583 | `board_switched` 21:14:32.133 | Depression (destination) | 0.450 | 0 | 0 | not knowable |
| Abusrdity | 10-03 09:00:48.290 | `board_switched` 09:00:47.053 | Relationships (**away**) | 1.238 | 0 | 0 | not knowable |
| Relationships | 10-04 16:58:55.661 | `board_switched` 16:58:55.599 | Abusrdity (**away**) | 0.063 | 0 | 0 | not knowable |
| Geopolitics | 10-04 16:59:09.860 | `session_started` 16:59:07.192 | Geopolitics | 2.668 | 0 | 0 | not knowable |
| Tech and Business | 10-05 22:47:20.154 | `session_started` 22:47:15.027 | Tech and Business | 5.127 | 0 | 0 | not knowable |
| Philosophy and Art | 10-06 15:01:27.275 | `session_started` 15:01:21.137 | Philosophy and Art | 6.138 | 0 | 0 | not knowable |

**Gate:** 8 = **8 load- or switch-adjacent** + **0 others** ✓. **Range: 0.063–6.138 s.**

`weave_events.timestamp` is insert-arrival time, so the gaps include event-insert latency.

The 8 split by trigger, and each group maps to one save path:

| group | boards | gap after the event | save path |
|---|---|---|---|
| boot | Geopolitics, Tech and Business, Philosophy and Art | 2.7–6.1 s after `session_started` | **A** (mount debounce) |
| switch-away | Career, Abusrdity, Relationships | 0.06–1.5 s after switching to **another** board | **B** (departing-board save) |
| switch-to | Death, Depression | 0.45–4.3 s after switching **to** the board | not explained by any path; see verdict |

The switch-away saves are informative. Path B saves the departing board only if its signature differs from `lastSavedSignatures`, and there were 0 recorded edits on those boards since page load. So in each of those three sessions, **nothing had marked the departing board clean**. That fits either the never-seeded warm-boot path (A.1, with `storesEqual` true or the fetch not yet landed) or an unrecorded edit (premise 2).

Session timelines, abridged (full query in the map):
- Relationships: `session_started` on Relationships 16:58:50.995 → switch to Abusrdity 16:58:55.599 → Relationships saved 16:58:55.661.
- Abusrdity: `session_started` on Abusrdity 09:00:39.729 → switch to Relationships 09:00:47.053 → Abusrdity saved 09:00:48.290. That is 8.6 s after boot without a boot save surviving as the last save.
- Philosophy and Art: `session_started` 15:01:21.137 → saved 15:01:27.275 → `session_ended` 15:01:34.250. No other event in the session.

### B.2 Edit events between load and save (item 6)

Every one of the 8 has **0** `item_added`, `item_deleted`, `weave_triggered` or `board_created` events between the load event and the save. In fact there are **0 events of any type** in between. **Partition: 8 zero + 0 nonzero = 8** ✓. Premise 2 bounds what "zero" means: moves and text edits are not recorded.

### B.3 Warm vs cold (item 7)

**There is no boot or cache marker.** `session_started` and `board_switched` rows carry **no** `metadata` keys at all, and no event type records hydration source, cache hit or boot-fetch outcome. The client's `logHydrationSource` / `logSyncOutcome` (`useBoardStorage.ts`) log to the console only. **The 8 cannot be partitioned into warm and cold from data.** → **Backlog row:** a boot marker on `session_started` carrying `cache_hit`, the hydration source, and boot-fetch outcome and duration.

**By code, not data:** a cold boot does not save on its own (A.4), so a no-edit save tied to a boot implies a warm cache, *if* premise 2's unrecorded edits are excluded. That applies to Geopolitics, Tech and Business and Philosophy and Art. It is an inference.

### B.4 Post-042 skip guard (item 8)

**Not testable at this read.** No board has been saved since 042 reached prod: every board still has 1 distinct `updated_at`, and there are no events after 18:00 UTC. To run after the next real session:

```sql
select b.name, count(*) nodes, count(distinct n.updated_at) distinct_upd, max(n.updated_at)
from nodes n join boards b on b.id = n.board_id
group by b.name having max(n.updated_at) > '2026-10-06 18:47:55+00';
-- expect distinct_upd > 1 on any board saved with fewer than all nodes changed
```

---

## Verdict

**The mechanism is confirmed by code trace. Whether these 8 specific saves carried stale content is not decidable from the available data.**

The code leaves no ambiguity. On a warm-cache boot the clean signature is never seeded, so App's mount-armed debounce (path A) saves the cache-seeded state unconditionally. It loses only if the boot fetch lands first **and** `storesEqual` reports a difference. Because `storesEqual` is content-blind and server-side node writers never advance `boards.updated_at`, server-only changes since the browser's last fetch are invisible to revalidation. In that case the board is never reseeded or marked clean for the session, and the next debounce or switch-away (path B) saves the cache-era content too. A cold boot does not save on its own.

The data is consistent with this:
- All 8 client-saved boards were last saved 0.063–6.138 s after a load or switch, with 0 recorded events of any kind in between.
- The three switch-away saves prove the departing board had not been marked clean.

But the data cannot show:
- whether each boot was warm;
- whether each payload differed from the DB;
- whether an unrecorded drag or text edit occurred.

The two switch-to saves (Death, Depression) are not explained by any traced path. Path B saves the *departing* board, and the destination is reseeded and marked clean (A.2-3). They are left unexplained here; candidates include the stale-timer hazard in A.7 and an unrecorded edit.

**Since 042,** a stale save no longer deletes keys the client omits. It still overwrites any key the client round-trips with its cached value: `processing_log` always, and `contentDescription` / `media_analysis` when the cache holds an older value.

**What would decide it:**
1. **A persisted boot marker:** `cache_hit`, `storesEqual` result, fetch-landed-before-first-save, and an event per save with its path (A/B/C/D). This is the backlog row in B.3.
2. **Or a dev reproduction**, using the existing dev harness and no client change:
   - load a board in a browser so the cache is warm and the last contact is a fetch;
   - `patch_node_data` a key on the server;
   - reload, and capture the first `replace_board_contents` request body;
   - the hypothesis predicts the body lacks the patched key and lands before the fetch, or even when `storesEqual` is true.

---

## Query map

```sql
-- B.1 / B.2: last save per client-saved board vs nearest preceding load/switch (same user), events between
with s as (
  select b.id, b.name, b.user_id, max(n.updated_at) upd
  from boards b join nodes n on n.board_id = b.id
  where b.name <> 'Parenting' group by 1,2,3),
ld as (
  select s.*, (select e from weave_events e
     where e.user_id = s.user_id and e.event_type in ('session_started','board_switched')
       and e."timestamp" <= s.upd order by e."timestamp" desc limit 1) ev
  from s)
select name, upd, (ev).event_type, (ev)."timestamp", (ev).board_id::text = id::text same_board,
  extract(epoch from upd - (ev)."timestamp") gap_s,
  (select count(*) from weave_events e where e.user_id = ld.user_id
     and e."timestamp" > (ev)."timestamp" and e."timestamp" <= upd
     and e.event_type in ('item_added','item_deleted','weave_triggered','board_created')) edits_between,
  (select count(*) from weave_events e where e.user_id = ld.user_id
     and e."timestamp" > (ev)."timestamp" and e."timestamp" <= upd) any_between
from ld order by upd;

-- Uniform updated_at per board (also B.4 precondition)
select b.name, count(*), count(distinct n.updated_at), min(n.updated_at), max(n.updated_at), b.updated_at
from nodes n join boards b on b.id = n.board_id group by b.name, b.updated_at;

-- B.3: any metadata on load/switch events (→ 0 rows)
select k, count(*) from weave_events, jsonb_object_keys(coalesce(metadata,'{}')) k
where event_type in ('session_started','board_switched') group by 1;

-- Session timelines
select session_id, "timestamp", event_type, board_id, target_id from weave_events
where session_id in (/* sessions from B.1 */) order by session_id, "timestamp";
```
