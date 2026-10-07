# Phase 0 read — `node_processing_log`

**Date:** 2026-10-07 · **Branch:** `fix/node-processing-log` (cut from freshly fetched `origin/main` @ `6000ce5`) · **Kind:** read-only, no code or schema changes

**Search space and its preconditions.** `git grep` over tracked files at `6000ce5`. Live probes ran against **Weave-Dev only** (`bxbhjybahfyeqytwpkry`, confirmed from `SUPABASE_URL`). They were read-only `select`s through PostgREST with the dev service key, from a throwaway script that was deleted afterwards. Nothing was run against prod. Untracked local files, deployed Fly/Netlify builds that differ from `main`, and SQL functions that exist in a database but not in `supabase/migrations/` are **outside** this search space.

**Verdict:** none of the three stop conditions in the dispatch fire. But the code contradicts two premises the dispatch treats as fixed (§6), and the dispatch says to stop and report in that case. Phase 1 has **not** started.

---

## P0.1 — Server-side writers to `nodes.data`

There are seven app-level writers across three keys. That matches the expected seven / three. Below them are two SQL functions that do the actual `update nodes`.

| # | Writer (`file:line`) | Key written | Mechanism | Auth key | Identity held at write |
|---|---|---|---|---|---|
| W1 | `media-server/src/process.ts:104` | `media_analysis` | `patchNodeData` → `patch_node_data` (016) | Fly service role (`media-server/src/supabase.ts:10`) | `(board_id, _clientNodeId, user_id)` |
| W2 | `media-server/src/process.ts:151` | `contentDescription` | `patchNodeData` → `patch_node_data` (016) | Fly service role | `(board_id, _clientNodeId, user_id)` |
| **W3** | **`media-server/src/logger.ts:106`**: `persist()`, called at `process.ts:178` (`embed.budget`), `:205` (`embed.server`), `:221` and `:228` (`media.pipeline`) | **`processing_log`** | `append_processing_log` (021) | Fly service role | **`(board_id, _clientNodeId, user_id)`, no uuid** |
| W4 | `netlify/functions/backfill-youtube-descriptions.ts:166-169` | `contentDescription` | direct `update({ data: {...blob, contentDescription} })` | Netlify service role (`:58`) | `nodes.id` uuid |
| W5 | `scripts/backfill-youtube-descriptions.ts:246-249` | `contentDescription` | direct `update({ data: ... })` | operator service role (`:79`) | `nodes.id` uuid |
| W6 | `scripts/sweep-corpus-embeddings.mjs:403` | `contentDescription` | `patch_node_data` (016) | operator service role (`:87`) | `(board_id, _clientNodeId, user_id)` **and** `nodes.id` uuid (`p.nodeUuid`, `:294`) |
| **W7** | **`scripts/sweep-corpus-embeddings.mjs:578`** (`appendLog`, called at `:502` `embed.budget` and `:554` `embed.sweep`) | **`processing_log`** | `append_processing_log` (021) | operator service role | `(board_id, _clientNodeId, user_id)` passed; **uuid `p.nodeUuid` also in scope** |

SQL layer: `supabase/migrations/016_patch_node_data_by_client_id.sql:44` (`update nodes`, top-level merge) and `supabase/migrations/021_append_processing_log.sql:46` (`update nodes`, array append into `processing_log`). No trigger or other function writes `nodes.data.processing_log`. 040's `processing_log` writes go to `voice_sessions` only.

**The `processing_log` subset is two writers: W3 (Fly) and W7 (operator script).** Both go through the 021 RPC. **Netlify has no `processing_log` writer.** Its only `nodes.data` writer, W4, writes `contentDescription`.

Every writer authenticates with a service-role key. None uses an anon or user key, so no insert policy is needed for D6.

## P0.2 — Readers of `nodes.data.processing_log`

| Reader (`file:line`) | Consumes |
|---|---|
| `src/utils/logger.ts:157` (`buildProcessingLogAppender`): reads the in-memory array to append the next client entry | client entries only |

That is the whole list. Nothing renders `processing_log` to a user-facing surface. Hydration (`src/persistence/hydration.ts`) and save (`src/persistence/syncBoard.ts`) pass `data` through as an opaque blob. Nothing in `netlify/lib/snapshot`, `netlify/lib/stage2`, or `media-server/src` reads it. Past measurements of it (e.g. the 0/85 count) were ad-hoc SQL in `docs/`, not code paths. **No reader needs repointing**, so Phase 3 is a no-op.

## P0.3 — Voice entry shape (`voice_sessions.processing_log`)

The server-built entry in `create_voice_session` (`040_voice_session_rpcs.sql:121-140`):

```
{ "phase": "launch.anchor_edge_resolved" | "launch.anchor_edge_unresolved",
  "outcome": "success" | "degraded",
  "ts": "YYYY-MM-DDTHH24:MI:SS.MSZ",       -- text, UTC ISO-8601 with ms
  "detail": { boardId, clientFrom, clientTo, mode, source: "server_resolve", anchorEdgeId | reason } }
```

`end_voice_session` (`:186`) appends the client buffer verbatim. Those entries have the `LogEvent` shape: `{ phase, source, outcome, ts, durationMs?, detail?, correlationId?, parentCorrelationId? }`. The node-side writers W3 and W7 emit the same `LogEvent` shape. W7 uses `source: 'script'`.

Phase names are lowercase dotted (`<surface>.<action>[.<qualifier>]`). The timestamp field is `ts`. The payload field is `detail`, not `payload`. `outcome` is a first-class sibling of `phase`.

**Against D1:** `phase` and `ts` line up. D1 has no `outcome` column and names its bag `payload`. Under D1, `outcome`, `source`, `durationMs`, `detail` and the correlation ids would all have to go inside `payload`. Whether that counts as a material difference is a design call (§6, C2).

## P0.4 — Ownership columns

`boards.user_id` (`008_create_core_schema.sql:21`, RLS `auth.uid() = user_id` at `:35`). `nodes.board_id → boards.id` (`:43`). `nodes` also has its own `nodes.user_id` (`:44`, RLS at `:71`).

D6's join `nodes n join boards b on b.id = n.board_id where b.user_id = auth.uid()` uses columns that really exist. The shorter `n.user_id = auth.uid()` would also work.

## P0.5 — Resolution query

**The dispatch's query cannot run:** `select id from public.nodes where board_id = $1 and node_id = $2`. On dev, PostgREST returns `column nodes.node_id does not exist`. `nodes` has no `node_id` column. The per-board counter is the ReactFlow id, stored as `nodes.data->>'_clientNodeId'` (`src/persistence/syncBoard.ts:118`).

The lookup the code already uses for this identity, in 016, 021, 040 and `fetchNodeBlob` (`media-server/src/supabase.ts:76-83`), is:

```sql
select id from public.nodes
 where board_id = $1
   and user_id  = $2                       -- defense-in-depth, as in 016/021/040
   and data->>'_clientNodeId' = $3;
```

It is still a single-table lookup. Dev probe, read-only:

- 34 nodes, 0 missing `_clientNodeId`.
- 34 distinct `(board_id, _clientNodeId)` keys, 0 duplicates.
- A sample resolve returned 1 row, and it was the right uuid.
- A non-existent id returned 0 rows.

No unique index backs `(board_id, data->>'_clientNodeId')`, so a duplicate is not prevented by the schema. It only happens not to exist on dev today. That is why D2's "exactly one" check matters.

**Archived/deleted nodes.** `nodes` has no archive or soft-delete column. A node removed from the board is hard-deleted by the prune in `replace_board_contents` (042), and 037's trigger archives its embedding row. So no extra filter is needed at this layer. A deleted node shows up as a zero match.

**Zero-match is reachable.** 021's own comment (`:57-63`, notice at `:61-62`) gives the case: the client's 500 ms debounced save may not have persisted the node yet. The other case is a node deleted while the 30–90 s Fly pipeline is still running. Under §5.3, `node_id` would need to be nullable.

---

## Stop-condition evaluation

| Condition | Result |
|---|---|
| A writer holds no identity resolvable to a uuid by single-table lookup | **Does not fire.** W3 resolves via `nodes` alone with `(board_id, user_id, _clientNodeId)`. W7 already holds the uuid. |
| Writer or key count off by more than one from 7 / 3 | **Does not fire.** 7 / 3 exactly. The `processing_log` subset is 2. |
| A reader renders server entries in a way that can't be repointed | **Does not fire.** There are no server-entry readers at all. |

## 6. Premises the code contradicts (stop-and-report)

- **C1. Resolution identity.** D2 and P0.5 key the resolution on a `nodes.node_id` column, and that column does not exist. The real identity is `data->>'_clientNodeId'`, scoped by `board_id`, and by `user_id` in every existing lookup. The fix is mechanical (the query in P0.5 above), but it replaces SQL the dispatch wrote out as fixed. **The planning layer needs to ratify the query, including whether the `user_id` scope stays.**
- **C2. Entry shape.** Voice entries carry `outcome` as a top-level field, and their bag is named `detail`, not `payload`. D1's table has neither an `outcome` column nor a `detail` field. Two options: (a) keep D1 as written and put the whole `LogEvent` minus `phase`/`ts` into `payload`; (b) add an `outcome text` column so the table matches the voice log. **This is the planning layer's decision.**
- **C3. Writer surfaces.** The dispatch puts the processing-log writers across Fly, Netlify and SQL. In the code, the two `processing_log` writers are Fly (W3) and an **operator script** (W7, `scripts/sweep-corpus-embeddings.mjs`). Netlify has none. W7 already holds the node uuid, so it needs no resolution step. Whether a one-shot operator script counts as "server code" for D3 and for T5's grep scope needs ratifying.

## Notes for the planning layer (not stop conditions)

- **Readers.** Phase 3 has nothing to repoint. That also means nothing user-facing will read the new table until a separate PR adds a reader.
- **Leftover RPC.** `append_processing_log` (021) will have zero callers after Phase 2. The non-goals forbid touching existing migrations, so it stays live in the schema. Dropping it would be a separate row of work.
- **T4 harness.** No session can get Daniel's access token: dev sign-in is GitHub OAuth only. The existing integration harness (`src/persistence/__tests__/setup.ts:59-81`) creates disposable users with `auth.admin.createUser` and `signInWithPassword`. T4 can run as owner-user A against stranger-user B and anon, but **not as Daniel's own user**. That needs ratifying.
- **T1/T3 harness.** `replace_board_contents` is `security invoker` and checks `auth.uid()` (042:46, :67). So the "client full board save" in T1 has to run as a harness user, not the service role. The same harness covers this.
- **W2/W6 under D2.** `patch_node_data` already raises an error on a zero match (016:53). It does not detect a 2+ match: it would update every matching row. Phase 2 step 3 puts the D2 guard in front of W1/W2/W6's content writes too. **That is a behavior change on content writes, not only on the log.** It is in scope as worded, but worth flagging.
