# #11 — migration 030 vs 019/020 node-update semantics

> **This is a point-in-time read, as of 2026-10-06 UTC. Findings only. No fix, no 042 draft, no sync design.**
>
> **Read opened:** `2026-10-06 18:09:09 UTC` (`select now()` at first RO connection). Last query `18:15:16 UTC`.
> **Repo SHA:** `c2ad858` (`origin/main`, freshly fetched; local `main` fast-forwarded from `4549d9b` before the read). Branch `reads/board-sync-11` cut from `origin/main`.
> **Database:** Weave prod (`wndfikmpifyqkgivmnwv`). **Role:** `weave_readonly` via `WEAVE_PROD_RO_DATABASE_URL` only. Zero writes to any persistent relation. **Disclosure:** one query created a session-scoped `TEMP VIEW` (in `pg_temp`, dropped at disconnect). That is a catalog object, not data, but it is recorded here because the dispatch says "zero prod writes". All later queries use CTEs.
> **Dispatch:** #11 read. The hypothesis under test is "030 is the clobber mechanism".
>
> **Findings in this document decay; the query map does not.** To verify a count, re-run the query shown with it.

---

## 0. Preconditions and dispatch premises

| precondition | state | how established |
|---|---|---|
| Checkout currency | `git fetch` then `pull --ff-only`: local `main` = `origin/main` = `c2ad858` | `git fetch origin && git pull --ff-only origin main` |
| RO identity | `weave_readonly`, `rolbypassrls = f`, `rolsuper = f` | `select current_user; select rolname, rolbypassrls, rolsuper from pg_roles where rolname = current_user;` |
| RLS visibility | `readonly_audit_select` with `qual = true` on every table read (`nodes, boards, weave_embeddings, weave_events`). Counts are whole-table. | `select tablename, qual from pg_policies where policyname = 'readonly_audit_select';` |
| **Live function bodies** | **Observed, byte-exact.** `md5(prosrc)` on prod equals `md5` of the `$$…$$` body in the repo file: `replace_board_contents` = **041** (`662739c9…`, returns `jsonb`); `patch_node_data(text,…)` = **016** (`01b662c1…`); `append_processing_log` = **021** (`2d8edc7c…`). | §A.0 query |

**Premises found wrong or unobservable (flagged, not worked around):**

1. **"Use the 10-05 repair record for the 030 applied timestamp."** No repair record exists in the repo. `grep -rniI repair` over `docs/`, `MIGRATIONS.md`, `README.md`, `Claude.md` and `supabase/` finds nothing about migration history. `weave_readonly` gets `permission denied for schema supabase_migrations`, so prod migration history can't be read with this role. **The era boundary used below is the owner-recorded prod apply date in `MIGRATIONS.md` ("027–030 applied manually via terminal on 2026-06-05"). That is a file claim, not an observation.** It turns out not to matter at day resolution: **0 live nodes were created on 2026-06-05**, and every server-write event dated in Phase 1 falls weeks after it (earliest 2026-07-24). A wrong boundary would have to be off by more than seven weeks to move any count.
2. **"`computeSaveSignature` now strips `id` (041)."** It strips the **connection** `id` (the server `edges.id` written back after a save), not the node id. Node `id` is still in the signature. See §C.

---

## Phase 0 — text diff (no DB)

### A.1 The node-update path, verbatim

**019** (`019_replace_board_contents_merge_node_data.sql:99-112`), the merge:

```sql
    if v_existing_id is not null then
      update nodes
         set card_type    = v_node->>'card_type',
             ...
             image_url    = v_node->>'image_url',
             data         = data || coalesce(v_node->'data', '{}'::jsonb)
       where id = v_existing_id;
```

**020** (`020_replace_board_contents_skip_node_noops.sql:95-121`), merge plus skip-unchanged:

```sql
    if v_existing_id is not null then
      update nodes
         set card_type    = v_node->>'card_type',
             ...
             data         = data || coalesce(v_node->'data', '{}'::jsonb)
       where id = v_existing_id
         and (
              card_type    is distinct from v_node->>'card_type'
           or link_type    is distinct from v_node->>'link_type'
           or position_x   is distinct from coalesce((v_node->>'position_x')::double precision, 0)
           or position_y   is distinct from coalesce((v_node->>'position_y')::double precision, 0)
           or title        is distinct from v_node->>'title'
           or description  is distinct from v_node->>'description'
           or url          is distinct from v_node->>'url'
           or source       is distinct from v_node->>'source'
           or text_content is distinct from v_node->>'text_content'
           or image_url    is distinct from v_node->>'image_url'
           or data         is distinct from (data || coalesce(v_node->'data', '{}'::jsonb))
         );
```

**030** (`030_replace_board_contents_directionless_edges.sql:109-123`). 041 is identical on this path:

```sql
    if v_existing_id is not null then
      update nodes
         set card_type    = v_node->>'card_type',
             ...
             image_url    = v_node->>'image_url',
             data         = coalesce(v_node->'data', '{}'::jsonb)
       where id = v_existing_id;
```

The 030 header states the cause itself (`030:38`): *"Nodes path is byte-for-byte unchanged from 018."* 030 was written against 018's body, not 020's. Its section banner also says `(unchanged from 017)` (`030:85`), and its down-migration note says "re-run migration 018".

**041 = 030 on the node path.** `diff` of the two `$$` bodies shows only three hunks, all on the edge/return path: the `resolved_edges` declaration, its accumulation in the edge loop, and `return resolved_edges`.

### A.2 Behavioural changes, 020 → 030/041

| # | change | 020 | 030 / 041 | consequence |
|---|---|---|---|---|
| 1 | **merge → overwrite** | `data = data \|\| client_data` | `data = client_data` | Any top-level key in the row that the client payload lacks is **deleted** on every save that reaches the row. |
| 2 | **skip-unchanged → always-write** | `WHERE … AND (any column IS DISTINCT FROM …)` | `WHERE id = v_existing_id` only | Every node of the saved board is UPDATEd on every save. `update_nodes_updated_at` (`008:65`) fires for all of them. |
| 3 | `updated_at` meaning | per-node "last really changed" | per-board "last saved" | Observed in prod: **all 9 boards have exactly 1 distinct `nodes.updated_at` across their nodes** (§B.5). |
| 4 | Ordering | unchanged: prune → per-node upsert in payload order → edges → `boards.updated_at` | same | — |
| 5 | Delete handling | unchanged: prune by `_clientNodeId <> all(incoming)` | same | — |
| 6 | Client-side key deletion | could not propagate (019 header tradeoff) | **propagates** | A side effect of 1. 019's audit said the client never removes keys, so nothing depended on this. |
| 7 | INSERT path | `coalesce(p_data,'{}')` | same | — |

### A.3 Server-side writers of `nodes.data` (clobber surface)

Two independent passes were run: (a) my greps and reads, and (b) an independent subagent grep over every top-level directory (excluding `node_modules`, `dist`, `.git`, `.netlify`, plus a second worktree under `.claude/`). **Both found the same 7 writers. Gate closed: 7 = 7.**

| # | writer | file:line | mechanism (live def) | top-level keys written |
|---|---|---|---|---|
| W1 | Fly media server, analysis patch | `media-server/src/process.ts:104-109` → `supabase.ts:26` | `rpc('patch_node_data')`, 016: `data = data \|\| p_patch` | `media_analysis` |
| W2 | Fly media server, tweet description | `media-server/src/process.ts:151-156` → `supabase.ts:26` | `rpc('patch_node_data')`, 016. Only fires for tweets with non-empty analysis and no existing `contentDescription`. | `contentDescription` |
| W3 | Fly media server logger `persist` | `media-server/src/logger.ts:106-111` | `rpc('append_processing_log')`, 021: `jsonb_set(…,'{processing_log}', old \|\| [entry])` | `processing_log` (append, `source:'server'`; phases `embed.budget`, `embed.server`, `media.pipeline`) |
| W4 | Netlify fn `backfill-youtube-descriptions` | `netlify/functions/backfill-youtube-descriptions.ts:165-169` | `.from('nodes').update({ data: { ...blob, contentDescription } })`. **Read-modify-write of the whole column**, not a merge. | `contentDescription` (plus a stale rewrite of every other key) |
| W5 | `scripts/backfill-youtube-descriptions.ts` | `:243-248` | same as W4 | same as W4 |
| W6 | Corpus sweep, phase 2 | `scripts/sweep-corpus-embeddings.mjs:403-408` | `rpc('patch_node_data')`, 016 | `contentDescription` |
| W7 | Corpus sweep `appendLog` | `scripts/sweep-corpus-embeddings.mjs:578` | `rpc('append_processing_log')`, 021 | `processing_log` (append, `source:'script'`; phase `embed.sweep`) |

**Not writers of `nodes.data`** (checked and ruled out):
- Triggers. `update_nodes_updated_at` (`008:65`) writes the `updated_at` column only. `trg_archive_embedding_on_node_delete` (`037:71`) writes `weave_embeddings`.
- `patch_node_data(uuid,…)` from 015 was dropped in `016:21`.
- 040's voice RPCs read nodes only.
- `src/persistence/nodes.ts` CRUD: production calls only `listByBoard`, and its write callers are tests.
- `linkEnrichment.ts`'s `patchNodeData` callback and the client logger: both go to React `setNodes`, then to the DB only through `replace_board_contents`.
- There is no realtime/`postgres_changes` subscription in `src/`, so **the client never learns of a server write except by re-hydrating**.

### A.4 Round-trip analysis, per key

The client save payload is the whole in-memory `node.data` minus 5 binary/marker keys (`syncBoard.ts:105-117`). Hydration loads the whole DB blob into `node.data` (`hydration.ts:101`, `{ ...dataBlob }`). So **the client round-trips a key if and only if that key was in the state it hydrated, or it wrote the key itself.** No key is ever omitted on purpose.

| key | writers | does the client carry it? | 019/020 outcome on a stale save | 030/041 outcome on a stale save |
|---|---|---|---|---|
| `media_analysis` | W1 | Never generated client-side. Present only if hydrated after T1. Fly writes it after the drop, inside the drop session, so the drop session's state never has it. | **survives** (key absent from payload → merge keeps it) | **deleted** |
| `contentDescription` | W2, W4, W5, W6 (and the client itself, `linkEnrichment.ts:152,244`) | Carried if the client generated it or hydrated it. Absent from client state when a server wrote it after the client loaded. | survives if the client lacks the key. If the client has its own value, the client's value wins. | **deleted** if the client lacks the key |
| `processing_log` | W3, W7 (and the client, `logger.ts:143-165`) | **Carried as soon as the node has any client entry.** `embed.client` and `enrich.complete` are appended at drop, before Fly or the sweep can append. | **server entries deleted** (the top-level key is replaced by the client's stale array; `\|\|` is shallow) | server entries deleted |

So the set of keys that 030 *newly* destroys is **`media_analysis`, and `contentDescription` when server-written**. `processing_log` server/script entries are lost to *any* save from stale state under **both** regimes, whenever the client already carries the key. 030 only widens this to nodes whose client state has no `processing_log` at all. The client logger's own comment (`logger.ts:9-13`, `:145-146`: "replace_board_contents merges data jsonb, so existing log entries survive") was true only for client-authored entries, even under 019.

---

## Phase 1 — evidence in prod (RO)

### B.0 Population and era partition

Live nodes: **85**. Partition by `nodes.created_at` against the 2026-06-05 boundary: **pre 58 · day-of 0 · post 27 = 85** ✓ (mutually exclusive and exhaustive). For server-write evidence, the era is assigned by **T1, the server write time**, not by node creation:
- W1–W3 (Fly) run at drop, so T1 ≈ the node's `created_at`.
- W6–W7 (sweep) ran **2026-07-28 05:45:10.913Z – 05:45:43.939Z**. That window is the min/max `ts` of the surviving `source:'script'` entries. Everything the sweep wrote is post-030.

Evidence of a server write must live **outside** `nodes.data`, because the in-blob evidence is exactly what gets clobbered. Two durable sources exist:
- `weave_embeddings.metadata`. Fly upserts `processing:'server'` / `embed_trigger:'media_patch'` / `had_analysis`. The sweep upserts `embed_trigger:'sweep'` / `had_description` / `had_analysis`. The Fly code (`process.ts`) runs `patchNodeData` **before** `upsertEmbedding`, and `patchNodeData` throws on failure. So a Fly-written embedding row with `had_analysis = true` proves the `media_analysis` patch succeeded.
- The sweep plan table in `docs/sweep-run-record.md` (`de` = description chars **before** the sweep, `action = backfill-description`).

**Limits of these sources.** `weave_embeddings` has no `updated_at`, and `created_at` survives upserts, so it dates first creation, not the write. A later upsert overwrites `metadata`, so evidence is a lower bound. Fly's own log retention is about 100 lines, today only (`fly logs -a weave-media --no-tail`: 100 lines, 17:46–18:11 UTC 10-06), so **Fly T1 times are not observable anywhere.**

```sql
-- per-node evidence table (all 85 rows), saved alongside the counts below
with pl as (select n.id, e from nodes n,
  jsonb_array_elements(case when jsonb_typeof(n.data->'processing_log')='array' then n.data->'processing_log' else '[]' end) e)
select n.data->>'_clientNodeId', n.board_id, n.created_at, n.updated_at,
  n.data ? 'media_analysis', n.data ? 'contentDescription',
  (select count(*) from pl where pl.id=n.id and pl.e->>'source'='server') srv,
  (select count(*) from pl where pl.id=n.id and pl.e->>'source'='script') scr,
  w.metadata
from nodes n left join weave_embeddings w on w.board_id=n.board_id::text and w.node_id=n.data->>'_clientNodeId';
```

### B.1 `media_analysis` (W1). Universe: nodes with durable evidence that Fly wrote it

Evidence = key present now, **or** a Fly row with `had_analysis = true`, **or** a sweep row with `had_analysis = true` (meaning the sweep read it from JSONB at 07-28).

| era (by T1) | present | absent | total |
|---|---:|---:|---:|
| pre-030 | 12 | 0 | 12 |
| post-030 | 0 | **7** | 7 |
| **total** | 12 | 7 | **19** ✓ |

The 7 are MeidasTouch, Überkierk, Documenting Saylor, Bearly AI, FactPost, Tony of 1Dime and Big Brain Business. All have `processing:'server'`, `embed_trigger:'media_patch'` and `had_analysis:true` (Fly generation 2–5), and none has `media_analysis` today. **Every post-030 Fly analysis that can be evidenced is gone. Every pre-030 analysis that can be evidenced is present.**

**Survivor bias in the pre row:** the 07-28 sweep overwrote the metadata of every pre-030 Fly row. A pre-030 node that lost its analysis before 07-28 would show `had_analysis:false` and drop out of the universe. So "0 absent pre-030" is not observable as a loss rate. The post-030 row has no such bias, because its evidence (Fly rows dated 07-24 onward) was never overwritten.

### B.2 `processing_log` `source:'server'` entries (W3). Universe: nodes with a Fly embedding row

| era | ≥1 server entry | 0 server entries | total |
|---|---:|---:|---:|
| pre-030 | 0 | 0 | 0 |
| post-030 | 0 | **10** | 10 |
| **total** | 0 | 10 | **10** ✓ |

Universe = `processing = 'server'` or `embed_trigger = 'media_patch'`. That is the 7 above, plus ​𝐥𝐲𝐫𝐚 (`media_patch`, `had_analysis:false`), plus Camus #31 and Daniel Ahmad (older build, `processing:'server'`, no trigger key). On every success path Fly persists at least `embed.server` and `media.pipeline`.

**Fleet-wide: 0 of 85 live nodes carry a single `source:'server'` entry.** Per §A.4, this key is **not 030-discriminating**: the client carries `processing_log` from the moment of drop, so 019 would have lost these entries too.

### B.3 `processing_log` `source:'script'` entries (W7). Universe: nodes with a live sweep embedding row (T1 = 07-28, post-030)

| board | entry present | entry absent |
|---|---:|---:|
| Abusrdity `8a8d45a9` | 0 | **13** |
| Death, Geopolitics, Parenting, Philosophy and Art, Relationships, Tech and Business | 20 | 0 |
| **total (33)** | 20 | 13 ✓ |

### B.4 `contentDescription`. Universe: sweep rows with `had_description = true` (present in JSONB at 07-28)

| | present now | absent now | total |
|---|---:|---:|---:|
| all post-030 | 24 | **5** | **29** ✓ |

The 5 absent are cinesthetic., King Arthur Fan, Lola, matrixbot and RyanPatrick🇺🇸🦅. **All 5 are on Abusrdity, and all 5 are sweep `backfill-description` targets with `de = 0`** (no description before the sweep). The description present at the sweep's re-embed was therefore W6's own `patch_node_data` write. These are server-written keys, lost after 07-28.

**Abusrdity discriminates the two regimes within a single node.** matrixbot and cinesthetic. still have `media_analysis` (written in May, pre-030, and present in every client state since). On the same nodes, they lost the 07-28 `contentDescription` and the `embed.sweep` entry. The losing save carried every key the client had loaded and dropped exactly the keys written after the client's state was formed. That is the overwrite signature. A merge would have kept `contentDescription`.

### B.5 Always-write, observed

```sql
select board_id, count(*) nodes, count(distinct updated_at) from nodes group by 1;
```

All 9 boards: `count(distinct updated_at) = 1`. Each board's last save rewrote every node on it. The one exception in kind is Parenting (`04555951`): 1 node, last touched 07-28 05:45:19 by the sweep RPC itself.

### B.6 Cardinality gates

| gate | expected (independent) | observed | closed |
|---|---|---|---|
| Writers (A.3) | 7 (pass a) | 7 (pass b) | ✓ |
| Node population | 85 (`count(*)`) | pre 58 + day-of 0 + post 27 = 85 | ✓ |
| B.1 | 19 (union of evidence) | 12 + 0 + 0 + 7 = 19 | ✓ |
| B.2 | 10 | 0 + 10 = 10 | ✓ |
| B.3 | 33 live sweep rows (`embed_trigger='sweep' and archived_at is null`) | 20 + 13 = 33 | ✓ |
| B.4 | 29 | 24 + 5 = 29 | ✓ |

---

## Phase 1, step 5 — reconstructed cases

**No case reconstructs cleanly to the dispatch's standard ("timestamps, not inference").** In each case T1 is either a window or a lower bound, and the clobbering save T2 is not individually observable. The cause is §B.5: every save rewrites `updated_at` for the whole board, so only the **last** save on a board is dated. That is a finding in itself, and the 030 always-write behaviour is what produces it. Below is how far each case does reconstruct.

### Case 1 — Abusrdity, sweep writes lost (closest to clean)

- **T1** ∈ [2026-07-28 05:45:10.913Z, 05:45:43.939Z]. This is the sweep window, from surviving `embed.sweep` ts on other boards. The 5 `contentDescription` patches (W6) precede the re-embeds (`sweep-corpus-embeddings.mjs` phase 2 → phase 3), and the embed rows record `had_description:true`.
- **T2** ∈ (07-28 05:45:43Z, 10-03 09:00:48.290Z]. The upper bound is the board's last save, which rewrote all 26 nodes.
- **Key gone at T2:** yes, observed now for 5 `contentDescription` and 13 `embed.sweep` entries.
- **What does not reconstruct:** which save it was, and where its stale state came from. **No session straddles the sweep window** (0 sessions on any board with events both before 05:45:10 and after 05:45:44). Every later session touching Abusrdity begins with `session_started` (07-29 18:48:58, 08-02, 08-03, 08-09 ×2). That rules out "a tab open across T1". The stale state therefore came from somewhere else; see the verdict.

### Case 2 — Big Brain Business (Tech and Business), Fly `media_analysis` lost

- Drop session `7416f276`: `session_started` 10-05 15:01:25.872, `item_added` 15:01:38.468, client `enrich.complete` (`mediaTriggered:true`) 15:01:48.558, last client embed (gen 3) 15:01:49.767, `weave_triggered` 15:03:03.779, voice session to 15:11:15, last event 15:11:19.
- **T1** > 15:01:49.767. The Fly row is generation 5, above the client's gen 3, so Fly read the row after the client's embeds. No upper bound is observable (Fly logs gone).
- Later fresh page loads on this board: 20:07:38, 20:17:44 and 22:47:15. **T2 candidate:** 22:47:20.154, the board's last save, **5.1 s after `session_started` with no user edit event between** (the next event is `board_switched` away at 22:47:27).
- **Key gone:** yes. Whether the loss happened in the drop session (a save after T1 from pre-T1 state) or in a later boot save cannot be told from the DB.

### Case 3 — MeidasTouch (Abusrdity), Fly `media_analysis` + log entries lost

This is the case first documented in `docs/sweep-run-record.md` §"MeidasTouch".
- Drop session `0340bc08`: `item_added` 07-25 03:44:3x. Client log entries at 03:44:44.389, 03:44:49.328, 03:44:59.803 (`enrich.complete`, `mediaTriggered:true`) and 03:45:00.482 (gen 3). Session events continue to 03:49:50, including `item_deleted` and `weave_triggered`, both of which produce a full-board save.
- **T1** > 03:45:00.482 (Fly row gen 4 > client gen 3). **T2:** any save after T1, upper bound 10-03 09:00:48.
- **Key gone:** `media_analysis` absent, 0 server log entries, while the Fly row still records `had_analysis:true, processing:'server'`. If Fly finished before 03:49:50, the drop session's own saves are sufficient. That ordering isn't observable.

### Observation that bounds every case: saves fire at boot and on board switch, without edits

The last save on each board is dated (§B.5), and these are the deltas from the immediately preceding `session_started` or `board_switched` on that board:

| board | last save | preceded by | gap | edit events between |
|---|---|---|---:|---|
| Abusrdity | 10-03 09:00:48.290 | `session_started` 09:00:39.729 | 8.6 s | none |
| Relationships | 10-04 16:58:55.661 | `session_started` 16:58:50.995 | 4.7 s | none |
| Geopolitics | 10-04 16:59:09.860 | `session_started` 16:59:07.192 | 2.7 s | none |
| Tech and Business | 10-05 22:47:20.154 | `session_started` 22:47:15.027 | 5.1 s | none |
| Philosophy and Art | 10-06 15:01:27.275 | `session_started` 15:01:21.137 | 6.1 s | none |
| Depression | 09-13 21:14:32.583 | `board_switched` 21:14:32 | <1 s | none |
| Death | 08-29 17:02:53.180 | `board_switched` 17:02:48 | ~5 s | none |
| Career | 09-13 21:13:38.098 | `session_started` 21:13:09.098 | 29 s | `session_ended` only |
| Parenting | 07-28 05:45:19 | — (sweep RPC) | — | — |

Seven of the eight client-saved boards were last saved within 0–8.6 s of a page load or board switch, with no `item_added`, `item_deleted` or `weave_triggered` event in between. Career (29 s) had only a `session_ended` in between.

---

## Step 6 — `computeSaveSignature` (`src/hooks/saveSignature.ts`, post-041)

- **Includes:** per node `id`, `type` (default `'textCard'`), `position`, and `data` with 7 transient keys (`imageDataUrl, imageBase64, imageUrl, pdfDataUrl, thumbnailDataUrl, loading, _imageStoragePath`) replaced by `_has_<key>` booleans. Connections are included whole **minus `id`** (the 041 change). Everything is key-sorted with `sortedStringify`.
- **A server-only key change cannot trigger a client save on its own.** The signature is computed from client React state only. The client has no realtime subscription (§A.3) and does not poll, so a server write never enters client state until the next hydrate. When a hydrate does bring it in, `markBoardClean` re-seeds the signature from the hydrated state (`App.tsx:195-224` → `useBoardStorage.ts:506-518`), so the new key is "clean", not dirty.
- **The converse is the risk:** the signature check is the only guard against a save, and it compares client state to the *last client-saved* signature, never to the DB. A save whose signature differs for *any* reason ships the whole stale blob. Under 030 that blob replaces the row.

**Code-traced, not observed (a hypothesis for the save-without-edit timings above):** on a **warm-cache** boot, `hydrating` starts `false` (`useBoardStorage.ts:178`). The App sync effect's four triggers (`boardChanged`, `hydrationJustFinished`, `rolledBack`, `revalidated`) are all false at mount, so `markBoardClean` is not called for the cache-seeded nodes. The debounced save effect (`App.tsx:259-276`, 500 ms) then runs against an empty signature map. While auth is loading, `runSupabaseSave` skips (`no auth session`). When `user.id` arrives, `saveCurrentBoard`'s identity changes, which re-fires the effect, and that save would race the boot revalidation fetch (`useBoardStorage.ts:236-300`). If it wins, the **cache** state (as of the last save on that device) is written over the DB. This would explain Case 1, a stale save with no straddling tab. Testing it needs client-side sync logs (`logSyncOutcome`, `logHydrationSource`), which are not persisted. **Not adopted as a finding.**

---

## Verdict

**030 confirmed as the mechanism for `media_analysis` and server-written `contentDescription`; partial overall.**

The text diff is unambiguous. 030 (and 041, byte-identical on this path) was written against 018's body, as its own header says. It reverted 019's merge (`data || p_data` → `p_data`) and 020's skip-unchanged guard, and prod runs exactly that body (md5-verified).

The prod counts fit the confirmed mechanism with no exception:
- All 7 post-030 Fly analyses with durable evidence are gone, and all 12 evidenced pre-030 analyses are present.
- All 5 lost descriptions are sweep-written ones.
- On Abusrdity, a single save removed exactly the keys written after the client's state formed (07-28 descriptions and log entries) while keeping the May-era `media_analysis` it carried. That is overwrite, not merge.
- `updated_at` is board-uniform on all 9 boards, which is the always-write half observed directly.

**What 030 does not explain:**
1. **`processing_log` server/script entries** are lost under 019 as well, because the client carries the key from drop and `||` is shallow. 0 of 85 nodes carry a server entry. This loss predates 030 and needs no 030 to happen.
2. **The source of the stale state.** 030 turns a stale save into data loss, but it does not create staleness. For Abusrdity, no session straddles T1, so "an open tab overwrote a server patch" does not explain the largest loss. A warm-cache boot save (step 6) is a code-level hypothesis consistent with the save-within-seconds-of-boot timings, but it is unverified.
3. **Pre-030 loss rate** is unmeasurable here, because the sweep overwrote pre-030 Fly metadata (survivor bias in B.1).
4. **No clobbering save (T2) is individually dated**, because always-write keeps only the last save per board.

**Out-of-scope observation.** W4 and W5 (the YouTube description backfills) are whole-column read-modify-write. They are their own clobber vector against concurrent client or server writes, independent of 030.

---

## Query map

```sql
-- A.0 live bodies vs repo (compare to md5 of the $$ body in each migration file)
select p.proname, pg_get_function_identity_arguments(p.oid), pg_get_function_result(p.oid), md5(p.prosrc)
from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where n.nspname='public' and p.proname in ('replace_board_contents','patch_node_data','append_processing_log');

-- B.1–B.4 (CTE form)
with v as (
  select n.board_id, n.created_at, n.data, w.metadata m,
    (select count(*) from jsonb_array_elements(case when jsonb_typeof(n.data->'processing_log')='array'
       then n.data->'processing_log' else '[]' end) e where e->>'source'='server') srv,
    (select count(*) from jsonb_array_elements(case when jsonb_typeof(n.data->'processing_log')='array'
       then n.data->'processing_log' else '[]' end) e where e->>'source'='script') scr
  from nodes n left join weave_embeddings w on w.board_id=n.board_id::text and w.node_id=n.data->>'_clientNodeId')
select case when created_at < '2026-06-05' then 'pre' when created_at >= '2026-06-06' then 'post' else 'day-of' end era,
       data ? 'media_analysis' present, count(*)
from v
where data ? 'media_analysis'
   or (m->>'processing'='server' and m->>'had_analysis'='true')
   or (m->>'embed_trigger'='sweep' and m->>'had_analysis'='true')
group by 1,2;
-- B.2: where m->>'processing'='server' or m->>'embed_trigger'='media_patch'  → group by (srv>0)
-- B.3: where m->>'embed_trigger'='sweep'                                      → group by board_id, (scr>0)
-- B.4: where m->>'embed_trigger'='sweep' and m->>'had_description'='true'     → group by data ? 'contentDescription'

-- Sweep window
select min(e->>'ts'), max(e->>'ts') from nodes n, jsonb_array_elements(n.data->'processing_log') e
where e->>'source'='script';

-- Sessions straddling the sweep window (→ 0 rows)
select session_id from weave_events group by 1
having min("timestamp") < '2026-07-28 05:45:10' and max("timestamp") > '2026-07-28 05:45:44';

-- Last save per board vs preceding session_started
with b as (select board_id::text bid, max(updated_at) upd from nodes group by 1)
select bid, upd,
  (select max("timestamp") from weave_events e
    where e.event_type='session_started' and e.board_id::text=b.bid and e."timestamp"<=b.upd)
from b;
```
