# Revival Preflight (R0) — board scope, OQ15, execution path, entanglement

> **This is a point-in-time read, as of 2026-09-05 (local); prod clock at first connection was 2026-09-06 UTC.**
>
> **Read opened:** `2026-09-06 01:08:52 UTC` (`select now()` at first connection, P2).
> **Repo SHA:** `e5cd3fdec176dad06b4c65227550197e97b4ef2e` (`origin/main` after
> `git fetch origin`; branch `reads/revival-preflight` cut from it; working tree clean).
> **Database:** Weave prod (`wndfikmpifyqkgivmnwv`).
> **Role:** `weave_readonly` via `WEAVE_PROD_RO_DATABASE_URL` / `--db-url` only.
> No Management API, no service role, no CLI auth flow. No auth friction occurred.
>
> **Findings in this document decay; the query map does not.** Every count is
> verified by re-running the query directly above it, never by citing this file.
>
> Fourth occupant of the `docs/reads/` document class
> ([`preflight-read-8.md`](preflight-read-8.md), [`census-8.md`](census-8.md),
> [`d7-diagnosis.md`](d7-diagnosis.md)). D7 results relied on without re-deriving:
> attribution misses = 359 archived + 16 absent = 375 board-scoped (388 unscoped);
> no key-format drift, no grain mismatch, no cross-board composite miss.

**Scope.** Seven facts (F1–F7) about the snapshot pipeline's engagement layer, read-only,
so that R1 is scoped by evidence. No code changes, no fixes, no OQ14 insert test, no
pipeline invocation; nothing about prompt v2, decay parameters, roster membership, or #11.
Zero writes to prod. This header was created before the first connection; the body was
written after the queries ran.

**Headline.** The board predicate on the events read discards **0 hits** today (13 resolved
keys, all absent-misses on a board with no embeddings). The events read is code-confirmed
exposed to PostgREST `max-rows` (2,642 rows, no range; cap unconfirmed). The pipeline is a
Netlify function inserting with the **service role**. Neither snapshot function reads voice
at all. Both attribution resolvers and the map builder are closures inside the handler that
also performs the insert.

---

## 0. Preflight (all passed; recorded verbatim)

**P1 — checkout currency and code delta.** `git fetch origin` ran first. Local `main` was at
`ff0b4f8` (four PRs behind); branch cut from `origin/main` = `e5cd3fd`. `git status --short`
empty.

```bash
git log --oneline 1b2cfff..HEAD -- netlify/functions/ src/ supabase/migrations/ scripts/ package.json netlify.toml
# → (no output)
git diff --stat 1b2cfff..e5cd3fd
# → docs/reads/d7-diagnosis.md (+1126), docs/session-record-2026-09-04.md (+176)
```

**The pipeline code is unchanged since the D7 SHA** (`1b2cfff`), which was itself unchanged
since the census SHA (`ff0b4f8`). Every file/line citation in D7 resolves unchanged here.

**P2 — role identity.**

```sql
select now(), current_user, current_setting('is_superuser');
-- → 2026-09-06 01:08:52.127661+00 | weave_readonly | off
select rolname, rolbypassrls, rolsuper from pg_roles where rolname = current_user;
-- → weave_readonly | f | f
```

**P3 — RO visibility on every table counted.** `readonly_audit_select` with `qual = true`
present on **13/13** public base tables, including every table this read touches
(`weave_events`, `weave_embeddings`, `voice_sessions`, `voice_utterances`,
`weave_profile_snapshots`). Counts below are whole-table, not RLS-filtered.

```sql
select c.relname, c.relrowsecurity as rls_enabled,
       bool_or(p.polname = 'readonly_audit_select'
               and pg_get_expr(p.polqual, p.polrelid) = 'true') as ro_sees_all
from pg_class c join pg_namespace n on n.oid = c.relnamespace
left join pg_policy p on p.polrelid = c.oid
where n.nspname = 'public' and c.relkind = 'r'
group by c.relname, c.relrowsecurity order by 1;
-- → 13 rows, ro_sees_all = t on all 13 (rls_enabled = f only on edges_dedup_backup_028, unused here)
```

**P4 — QA/test marker on `weave_events` (restated: there is none).** `weave_events` has ten
columns (`id, event_type, target_id, board_id, session_id, timestamp, duration_ms, metadata,
user_id, voice_session_id`); no `session_kind`. The only path to a kind is
`voice_session_id → voice_sessions.session_kind`, and none of the six weighted types ever
carries it. `user_id` is uniform (1 distinct value), so no identity marker exists either.

```sql
select coalesce(vs.session_kind,
         case when e.voice_session_id is null then '(null voice_session_id)' else '(dangling)' end) as kind, count(*)
from weave_events e left join voice_sessions vs on vs.id = e.voice_session_id group by 1 order by 2 desc;
-- → (null voice_session_id) 2540 | qa 115 | real 50        (sum 2705 = table ✅)
select event_type, count(*) filter (where voice_session_id is not null) as with_vsid, count(*)
from weave_events where event_type in ('connection_label_clicked','connection_description_closed','item_added','lightbox_opened','lightbox_closed','node_selected') group by 1;
-- → with_vsid = 0 on all six (454, 504, 125, 131, 135, 139)
select count(distinct user_id) from weave_events;   -- → 1
```

Consequence: every engagement count in this read is un-partitionable by session kind, by
construction. Voice counts (F6/F7) carry `session_kind` explicitly.

**P5 — no write grants.**

```sql
select table_name, string_agg(privilege_type, ',') from information_schema.role_table_grants
where grantee = current_user group by 1 order by 1;
-- → 15 rows (13 tables + 2 views), every row = SELECT only
```

**Tooling.** `psql` 18.4, `node` v22 already present. Nothing installed. No Postgres driver
in `node_modules`; the reproduction script (F2, Appendix A) consumes `psql` JSON exports.

**Data delta since D7 (2026-09-04 21:30 UTC): none.** 2,705 events, 101 embeddings
(71 live / 30 archived, no null embeddings, 101 distinct composites, 12 boards), identical
per-type counts. Newest event `2026-09-04 02:17:19 UTC`. Every D7 figure is expected to
reproduce exactly, and does (F2).

---

## F1 — Board predicate, by layer

All citations are [`netlify/functions/generate-profile-snapshot.ts`](../../netlify/functions/generate-profile-snapshot.ts) @ `e5cd3fd`.

**How the board id reaches the pipeline — request body, else derived; never active-board state, never hardcoded** (`:305-335`):

```ts
    let boardIds: string[] | null = null
    let triggerReason = 'manual'

    try {
      const body = await req.json()
      if (body.board_ids && Array.isArray(body.board_ids)) {
        boardIds = body.board_ids
      }
      ...
    if (!boardIds) {
      const { data: boardRows, error: boardErr } = await supabase
        .from('weave_embeddings')
        .select('board_id')
      ...
      boardIds = [...new Set((boardRows ?? []).map((r: { board_id: string }) => r.board_id))]
    }
```

The optional `board_ids` body field is the only external board input. The sole caller in the
repo, `npm run snapshot:test` ([`package.json:15`](../../package.json)), posts
`{"trigger_reason":"manual_test"}` and no `board_ids`, so the default branch runs: **every
distinct `board_id` in `weave_embeddings`, archived rows included** (no `archived_at` filter
on this list). There is no browser call site (`grep -rn "generate-profile-snapshot" src/` → 0).

**Layer 1 — the `weave_events` read that feeds attribution: SCOPED** (`:386-389`):

```ts
    const { data: eventRows, error: evtErr } = await supabase
      .from('weave_events')
      .select('*')
      .in('board_id', boardIds)
```

Filter on `board_id` only. No `archived`, user, type, time, order, or range predicate.

**Layer 2 — the weightMap build: SCOPED by board (a no-op under the default), plus `archived_at is null`, plus parseable embedding; no user filter** (`:346-350`, `:362-377`, `:404-408`):

```ts
    const { data: embeddingRows, error: embErr } = await supabase
      .from('weave_embeddings')
      .select('board_id, node_id, node_type, embedding, content_summary')
      .in('board_id', boardIds)
      .is('archived_at', null)
    ...
    for (const row of (embeddingRows ?? []) as EmbeddingRow[]) {
      const embedding = parseEmbedding(row.embedding)
      if (!embedding) {
        console.warn(`[Snapshot] Excluding node ${row.board_id}:${row.node_id} — missing or unparseable embedding`)
        nodesExcludedNoEmbedding++
        continue
      }
      nodes.push({
        compositeKey: `${row.board_id}:${row.node_id}`,
        ...
    const weightMap: Record<string, number> = {}
    // Initialize all nodes to 0
    for (const node of nodes) {
      weightMap[node.compositeKey] = 0
    }
```

Rows entering the map: `board_id ∈ boardIds` ∧ `archived_at is null` ∧ `embedding` JSON-parses
to an array. The client is service-role (F4), so RLS applies no user scope. When `boardIds` is
derived from the same table (the default), the `.in()` is a tautology; it becomes a real
filter only when a caller supplies `board_ids`. The archived exclusion is the legitimate one
the dispatch names and stays.

**Layer 3 — the clustering node set: the same `nodes` array as the map** (`:457`, `:468`):

```ts
    const rawClusters = agglomerativeClustering(nodes, CLUSTER_SIMILARITY_THRESHOLD)
    ...
      const memberKeys = memberIndices.map((i) => nodes[i].compositeKey)
```

Clustering runs over every live, parseable embedding on in-scope boards — exactly the map's
key set. It is scoped iff the map is scoped (i.e. iff `board_ids` was supplied). No separate
board predicate exists on clustering.

**Anchor selection — per cluster, after clustering, top-3 by normalized weight** (`:476-488`):

```ts
      // Sort by weight descending for anchor selection
      memberWeights.sort((a, b) => b.weight - a.weight)

      // Anchor nodes: top 3 by weight
      const anchorCount = Math.min(3, memberWeights.length)
      const anchorNodeIds = memberWeights.slice(0, anchorCount).map((m) => m.key)

      // Engagement weight: mean of top 3 (or fewer)
      const topWeights = memberWeights.slice(0, anchorCount).map((m) => m.weight)
      const engagementWeight =
        topWeights.length > 0
          ? topWeights.reduce((sum, w) => sum + w, 0) / topWeights.length
          : 0
```

Quantity: `weightMap[key]` after global normalization (`:442-448`, max → 1.0). Scope: **per
cluster**, `Math.min(3, members)`, so a 2-member cluster has 2 anchors. Not global. Anchors
seed nothing; their downstream use is the `★` prefix in the theme prompt
([`extract-snapshot-themes.ts:106,116`](../../netlify/functions/extract-snapshot-themes.ts)) and
`engagement_weight`. R1 preserves this scope.

**F1 verdict.** One board predicate is live on the default path: **Layer 1, the events read**.
Layers 2 and 3 carry a board predicate that is a tautology by default and a real filter only
under an explicit `board_ids` body. The combination the code applies by default is therefore
*events scoped / map unscoped / clustering unscoped*; F2 sizes exactly that.

---

## F2 — Size of the exclusion

Verbatim copies of `lightboxClosedWeight`, `ENGAGEMENT_RULES`, `resolveNodeTarget`,
`parseEmbedding`, the board list, the map build, and the weight loop (lines 76–89, 111–158,
181–202, 326–334, 346–377, 404–435) run over `psql` exports of the two tables the pipeline
reads, twice: **scoped** (events filtered `board_id ∈ boardIds`, as `:389`) and **unscoped**
(that filter removed). Everything else identical. Instrumentation only around the
`key in weightMap` test; misses split archived/absent by composite lookup against all
`weave_embeddings` rows (D7's B4/B5). Script: Appendix A.

```bash
psql "$WEAVE_PROD_RO_DATABASE_URL" -X -At -c "select json_agg(row_to_json(e)) from (select id, event_type, target_id, board_id, session_id, timestamp, duration_ms, metadata, voice_session_id from weave_events order by timestamp, id) e" > $S/events.json
psql "$WEAVE_PROD_RO_DATABASE_URL" -X -At -c "select json_agg(row_to_json(w)) from (select board_id, node_id, node_type, embedding::text as embedding, content_summary, archived_at, created_at from weave_embeddings order by created_at) w" > $S/embeddings.json
node $S/r0-scope.mjs $S
```

```text
boards_in_scope=12 map_size=71 nodesExcludedNoEmbedding=0 events_total=2705

== scoped: events_read=2642 unmatched_type=1167 zero_weight_gated_keys=0 nodes_with_weight=71/71 max_raw_weight=44.3000
   total  resolved = hit + archived + absent : 2433 = 2058 + 359 + 16 OK
   connection_description_closed  908 = 786 + 116 + 6 OK
   connection_label_clicked       1008 = 870 + 131 + 7 OK
   item_added                     121 = 80 + 41 + 0 OK
   lightbox_closed                131 = 117 + 14 + 0 OK
   lightbox_opened                135 = 121 + 14 + 0 OK
   node_selected                  130 = 84 + 43 + 3 OK

== unscoped: events_read=2705 unmatched_type=1217 zero_weight_gated_keys=0 nodes_with_weight=71/71 max_raw_weight=44.3000
   total  resolved = hit + archived + absent : 2446 = 2058 + 359 + 29 OK
   connection_description_closed  908 = 786 + 116 + 6 OK
   connection_label_clicked       1008 = 870 + 131 + 7 OK
   item_added                     125 = 80 + 41 + 4 OK
   lightbox_closed                131 = 117 + 14 + 0 OK
   lightbox_opened                135 = 121 + 14 + 0 OK
   node_selected                  139 = 84 + 43 + 12 OK

HIT DIFFERENCE (unscoped − scoped) = 0
RESOLVED DIFFERENCE = 13; weightMap identical across runs: true
```

| run | events read | resolved | hit | archived-miss | absent-miss | gate |
|---|---:|---:|---:|---:|---:|---|
| **scoped** (code as written) | 2,642 | 2,433 | **2,058** | 359 | 16 | 2,058+359+16 = 2,433 ✅ |
| **unscoped** | 2,705 | 2,446 | **2,058** | 359 | 29 | 2,058+359+29 = 2,446 ✅ |
| **difference** | 63 | 13 | **0** | 0 | 13 | |

**The unscoped run reproduces D7 exactly**: 2,446 resolved / 359 archived + 29 absent, with
zero data delta (P-data). The scoped run reproduces D7's pipeline scope: 2,433 / 359 + 16.

**The engagement the current scoping discards is 0 hits.** The 13 resolved keys the board
predicate removes (4 `item_added` + 9 `node_selected`) all sit on board `aa4183ba…`, which has
no `weave_embeddings` row under any archival state; they are absent-misses in either run. The
resulting `weightMap` is byte-identical across the two runs (every node's raw weight equal;
`max_raw_weight` 44.30 in both).

**Why this is structural today, not incidental** — every weighted-type event's key board
equals its `board_id`:

```sql
select event_type, count(*) filter (where split_part(target_id,':',2) = board_id) as key_board_eq_event_board,
       count(*) filter (where split_part(target_id,':',2) <> board_id) as differs, count(*)
from weave_events where event_type in ('connection_label_clicked','connection_description_closed','item_added','lightbox_opened','lightbox_closed','node_selected') group by 1 order by 1;
-- → differs = 0 on all six (454, 504, 125, 131, 135, 139)
```

An event on board X can only attribute to nodes on board X, and board X's nodes are in the map
iff board X appears in the board list — which is derived from the same table. So under the
default `board_ids`, the events-read predicate can only ever remove absent-misses. It becomes
lossy in two ways R1 should know about: (a) if a caller supplies `board_ids` (then the map,
clustering and events are all cut to that list — a genuinely board-scoped snapshot, contrary to
the global-reading decision), or (b) if a future event type attributes across boards.

**Independent SQL cross-check** (composite join; the weight gate never fires today, `X4` → 0
zero-weight `lightbox_closed` of 131):

```sql
with resolved as (
  select e.event_type, exists (select 1 from weave_embeddings w where w.board_id = e.board_id) as in_scope,
         unnest(case when e.event_type like 'connection%'
           then array[split_part(target_id,':',2)||':'||split_part(target_id,':',3),
                      split_part(target_id,':',2)||':'||split_part(target_id,':',4)]
           else array[substring(target_id from 6)] end) as ckey
  from weave_events e
  where event_type in ('connection_label_clicked','connection_description_closed','item_added','lightbox_opened','lightbox_closed','node_selected')
    and target_id is not null
    and not (event_type = 'lightbox_closed' and (duration_ms is null or duration_ms <= 0)))
select case when in_scope then 'scoped(in list)' else 'never-read boards' end as scope, event_type, count(*) as resolved,
       count(*) filter (where live.node_id is not null) as hit,
       count(*) filter (where live.node_id is null and anyr.node_id is not null) as archived_miss,
       count(*) filter (where anyr.node_id is null) as absent_miss
from resolved r
left join weave_embeddings live on live.board_id||':'||live.node_id = r.ckey and live.archived_at is null
left join weave_embeddings anyr on anyr.board_id||':'||anyr.node_id = r.ckey
group by 1,2 order by 1 desc,2;
```

| scope | event_type | resolved | hit | archived | absent |
|---|---|---:|---:|---:|---:|
| in list | `connection_description_closed` | 908 | 786 | 116 | 6 |
| in list | `connection_label_clicked` | 1,008 | 870 | 131 | 7 |
| in list | `item_added` | 121 | 80 | 41 | 0 |
| in list | `lightbox_closed` | 131 | 117 | 14 | 0 |
| in list | `lightbox_opened` | 135 | 121 | 14 | 0 |
| in list | `node_selected` | 130 | 84 | 43 | 3 |
| never-read | `item_added` | 4 | 0 | 0 | 4 |
| never-read | `node_selected` | 9 | 0 | 0 | 9 |

Every cell equals the script's per-type line in both runs ✅. Expected count derived
independently from `T0` row counts: 2·(504 + 454) + (139 + 135 + 131 + 125) = **2,446** ✅.

**Unscoped run by `board_id`** (script output; SQL `X1b` in the query map agrees cell-for-cell):

| event `board_id` | in board list | resolved | hit | archived | absent |
|---|---|---:|---:|---:|---:|
| `a428492a…` | yes | 688 | 673 | 15 | 0 |
| `8a8d45a9…` | yes | 655 | 634 | 21 | 0 |
| `b3c1473b…` | yes | 512 | 507 | 5 | 0 |
| `26a0a954…` | yes | 252 | 0 | 252 | 0 |
| `2810ae3a…` | yes | 113 | 113 | 0 | 0 |
| `fef6c2a3…` | yes | 80 | 78 | 2 | 0 |
| `64bc0982…` | yes | 66 | 0 | 50 | 16 |
| `a358f35c…` | yes | 51 | 51 | 0 | 0 |
| **`aa4183ba…`** | **no** | **13** | **0** | **0** | **13** |
| `4c0379a6…` | yes | 11 | 0 | 11 | 0 |
| `74e2d407…` | yes | 3 | 0 | 3 | 0 |
| `04555951…` | yes | 1 | 1 | 0 | 0 |
| `04c9c895…` | yes | 1 | 1 | 0 | 0 |
| **sum** | | **2,446** | **2,058** | **359** | **29** ✅ |

Four boards in the list contribute zero hits (`26a0a954`, `64bc0982`, `4c0379a6`, `74e2d407`
— every embedding on them is archived); that is the D7 B4 population by board, not a scoping
effect. The never-read population is 63 events (`session_started` 24, `board_switched` 12,
`node_selected` 9, `session_ended` 7, `item_added` 4, `board_created` 4, `item_deleted` 3 = 63 ✅).

---

## F3 — OQ15: PostgREST max-rows

**From code: supabase-js against PostgREST, no `.range()`, no `.limit()`, no `order`** (`:386-389`,
quoted in F1). The client is `createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)`
(`:301`) — the REST client, not a direct Postgres connection and not an RPC. The events fetch
is the only `weave_events` read in the pipeline. Neither the embeddings read (`:346-350`) nor
the board-list read (`:326-328`) carries a range either; those return 71 and 101 rows today.

**SQL row count for the exact predicate the read uses:**

```sql
select (select count(*) from weave_events) as all_events,
       (select count(*) from weave_events where board_id in (select distinct board_id from weave_embeddings)) as in_board_scope,
       (select count(distinct board_id) from weave_embeddings) as boards_in_list;
-- → 2705 | 2642 | 12
```

**2,642 > 1,000 with no explicit range: the exposure is code-confirmed.** If the project's
PostgREST `max-rows` is at the 1,000 default the dispatch cites, the pipeline reads the first
1,000 of 2,642 events in whatever order the planner returns them, silently (`event_count`
in the snapshot row would read 1,000). If a revival drops the board predicate, the read is
2,705 rows and the same exposure applies.

**Empirical confirmation: not possible from here; cap unconfirmed.** The only API credentials
available locally are in `.env`: `SUPABASE_URL` / `VITE_SUPABASE_URL` both point at the **dev**
project (`bxbhjybahfyeqytwpkry`), with a dev anon key and a dev service-role key. No prod anon
key exists locally, and the service role is out of bounds for this read regardless. No
read-only prod API path with existing credentials → per the dispatch, stop here. **Daniel reads
the project's API max-rows setting from the dashboard.** No guess is recorded.

**Horizon counts for the same predicate (R1 horizons):**

```sql
select 'scoped' as scope,
       count(*) filter (where timestamp >= now() - interval '70 days') as last_70d,
       count(*) filter (where timestamp >= now() - interval '210 days') as last_210d, count(*) as all_time
from weave_events where board_id in (select distinct board_id from weave_embeddings)
union all
select 'unscoped', count(*) filter (where timestamp >= now() - interval '70 days'),
       count(*) filter (where timestamp >= now() - interval '210 days'), count(*) from weave_events;
select min(timestamp), max(timestamp) from weave_events;
```

| predicate | last 70 days | last 210 days | all time |
|---|---:|---:|---:|
| scoped (`:389`) | **309** | **2,642** | 2,642 |
| unscoped | 309 | 2,705 | 2,705 |
| six weighted types, scoped | 209 | 1,475 | 1,475 |

Table span: `2026-04-23 23:00 UTC` → `2026-09-04 02:17 UTC` (136 days). **The 70-day horizon
fits under 1,000 today (309); the 210-day horizon does not (2,642) — it is the whole table.**
A 210-day read that selects `*` still needs a range or pagination. Restricting the select to
the six weighted types (1,475 in 210 days) does not get under 1,000 either.

---

## F4 — Where the pipeline executes and inserts

**Execution surface: a Netlify function**, `netlify/functions/generate-profile-snapshot.ts`,
routed at `/api/generate-profile-snapshot` (`:589-591`), POST only (`:287`). Not the browser
(no call site in `src/`), not a Fly route, not a scheduled function (`netlify.toml` declares
only a 300 s timeout for `extract-snapshot-themes`). The one invocation surface is manual:

```json
"snapshot:test": "curl -s -X POST http://localhost:8888/api/generate-profile-snapshot -H 'Content-Type: application/json' -d '{\"trigger_reason\":\"manual_test\"}' | node -e '…'"
```

i.e. `netlify dev` on port 8888, whose function process reads `.env` — which points at
**dev**. A prod run would require either the deployed Netlify function URL or a shell with prod
env vars; neither exists in the repo.

**Client and credential: service role, from function env** (`:291-301`):

```ts
  const supabaseUrl = process.env.SUPABASE_URL
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (!supabaseUrl || !supabaseKey) {
    return Response.json(
      { error: 'SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not configured' },
      { status: 500 },
    )
  }

  const supabase = createClient(supabaseUrl, supabaseKey)
```

No user JWT is read from the request; `req` is consumed only for `board_ids` and
`trigger_reason`. The same construction appears in `extract-snapshot-themes.ts:156-165` and
`generate-snapshot-narrative.ts:159-167`.

**The insert** (`:528-543`) — no `user_id` in the row:

```ts
    const snapshotRow = {
      board_ids: boardIds,
      node_count: nodes.length,
      event_count: events.length,
      clusters: clusters,
      bridges: null, // Filled by next pipeline step
      narrative: null, // Filled by later pipeline step
      trigger_reason: triggerReason,
      generation_metadata: generationMetadata,
    }

    const { data: inserted, error: insertErr } = await supabase
      .from('weave_profile_snapshots')
      .insert(snapshotRow)
      .select('id')
      .single()
```

**RLS on `weave_profile_snapshots`, re-read from prod** (not cited from census-8):

```sql
select polname, case polcmd when 'r' then 'SELECT' when 'a' then 'INSERT' when 'w' then 'UPDATE' when 'd' then 'DELETE' else 'ALL' end as cmd,
       polpermissive as permissive, (select array_agg(pg_get_userbyid(r)) from unnest(polroles) r) as roles,
       pg_get_expr(polqual, polrelid) as using_expr, pg_get_expr(polwithcheck, polrelid) as with_check_expr
from pg_policy where polrelid = 'public.weave_profile_snapshots'::regclass order by polname;
select relname, relrowsecurity, relforcerowsecurity, pg_get_userbyid(relowner) from pg_class where oid = 'public.weave_profile_snapshots'::regclass;
select column_name, is_nullable, column_default from information_schema.columns
where table_schema='public' and table_name='weave_profile_snapshots' and column_name in ('user_id','board_ids','trigger_reason','created_at');
```

| polname | cmd | permissive | roles | USING | WITH CHECK |
|---|---|---|---|---|---|
| `readonly_audit_select` | SELECT | t | `{weave_readonly}` | `true` | — |
| `weave_profile_snapshots_delete_own` | DELETE | t | `{authenticated}` | `(auth.uid() = user_id)` | — |
| `weave_profile_snapshots_insert_own` | INSERT | t | `{authenticated}` | — | `(auth.uid() = user_id)` |
| `weave_profile_snapshots_select_own` | SELECT | t | `{authenticated}` | `(auth.uid() = user_id)` | — |
| `weave_profile_snapshots_update_own` | UPDATE | t | `{authenticated}` | `(auth.uid() = user_id)` | `(auth.uid() = user_id)` |

`relrowsecurity = t`, `relforcerowsecurity = f`, owner `postgres`. `user_id` is **nullable**,
default `auth.uid()`; `board_ids` and `trigger_reason` are `NOT NULL` (the latter defaults to
`'unknown'`). Five policies, unchanged from census-8 T5.

**OQ14's shape, restated without running it.** The service role bypasses RLS (owner-level,
`FORCE` off), so the insert succeeds. `auth.uid()` is null under the service role, so the
default writes `user_id = NULL` — no constraint violation. The browser reader
[`getLatestProfileSnapshot`](../../src/persistence/profileSnapshots.ts) runs as
`authenticated` under `select_own`, where `auth.uid() = NULL` is never true. **A pipeline-written
row would be invisible to the Reflect view and the voice opening turn.** Not tested here. Prod
today: 1 row, `trigger_reason = 'fixture'`, `user_id` **not null** (hand-seeded, so it renders).

```sql
select count(*), count(*) filter (where user_id is null) as null_user_id, max(created_at), string_agg(distinct trigger_reason, ',')
from weave_profile_snapshots;
-- → 1 | 0 | 2026-04-17 22:52:00+00 | fixture
```

---

## F5 — Entanglement map

Nothing in the module is exported except the default handler (`:282`) and `config` (`:589`).
The engagement layer is four pieces at module level plus two inline blocks inside the handler.

| piece | boundary | kind | reads | writes | call sites |
|---|---|---|---|---|---|
| `lightboxClosedWeight` | `:80-89` | module fn, pure | `event.duration_ms`; module consts `LIGHTBOX_DWELL_CAP_S` `:76`, `LIGHTBOX_DWELL_LOG_DIVISOR` `:77`, `LIGHTBOX_CLOSED_BASE_WEIGHT` `:78` | — | referenced `:143`; invoked via `rule.weight(event)` `:425` |
| `ENGAGEMENT_RULES` | `:111-150` | module const | `resolveNodeTarget`, `lightboxClosedWeight` | — | `ENGAGEMENT_RULES[event.event_type]` `:414` (only use) |
| inline `connection:` resolver #1 | `:114-121` | arrow fn in rule table, pure | `e.target_id` | — | via `rule.resolve(event)` `:421` |
| inline `connection:` resolver #2 | `:125-132` | arrow fn, **byte-identical to #1** | `e.target_id` | — | via `:421` |
| `resolveNodeTarget` | `:152-158` | module fn (hoisted), pure | `event.target_id` | — | referenced `:136, :140, :144, :148`; invoked via `:421` |
| **map builder** | `:346-377` + `:404-408` | inline in handler, **not a function** | closure: `supabase` `:301`, `boardIds` `:305/:311/:334` | closure: `nodes` `:359`, `nodesExcludedNoEmbedding` `:360`, `weightMap` `:404` | — (straight-line code) |
| **weight loop + normalization** | `:410-448` | inline in handler, **not a function** | closure: `events` `:397`, `weightMap`, `ENGAGEMENT_RULES` | closure: `weightMap` (accumulate `:431`, normalize `:446`), `rulesApplied` `:410/:438`, `eventsUnmatchedByType` `:411/:416`, `maxRawWeight` `:443` | — |

The two `connection:` resolvers are duplicated, not shared (census-8 row 2 of the rule table
already notes this). They and `resolveNodeTarget` are already pure: they read only
`target_id` and return keys. `lightboxClosedWeight` is pure over `duration_ms`.

**What the engagement layer's outputs feed downstream** (the inputs an extracted function
would have to return so the insert path receives the same row):

| closure output | consumed at | lands in |
|---|---|---|
| `weightMap` (normalized) | `:473` `weight: weightMap[key] ?? 0` inside the per-cluster `.map()` | `clusters[].anchor_node_ids`, `clusters[].engagement_weight` |
| `maxRawWeight` | `:522` | `generation_metadata.max_raw_weight_before_normalization` |
| `rulesApplied` | `:524` | `generation_metadata.rules_applied` |
| `eventsUnmatchedByType` | `:525` | `generation_metadata.events_unmatched_by_type` |
| `computeWeightsTiming` (`:402/:450`) | `:516` | `generation_metadata.timing_ms.compute_weights` |
| `events.length` | `:531` | `event_count` |
| `nodes` (map side) | `:457` clustering, `:468` member keys, `:530` | clusters; `node_count` |
| `nodesExcludedNoEmbedding` | `:521`, `:577` | `generation_metadata.nodes_excluded_no_embedding`; HTTP `summary.nodes_excluded` |

**Extraction as pure functions — scoping note, not a refactor.** A `buildWeightMap(events,
nodeKeys)` would take the `WeaveEvent[]` and the map's key list (or `NodeEntry[]`) and return
`{ weightMap, maxRawWeight, rulesApplied, eventsUnmatchedByType }` — four values, all of which
the insert path already reads by those names — plus whatever D7 counter R1 adds (archived /
absent, per D7 F-D7.4). The timer stays at the call site. The resolvers and `ENGAGEMENT_RULES`
need no change to be exported; they already close over nothing but module constants. The map
builder's only impure inputs are the Supabase fetch (`:346-350`) and `boardIds`; a pure
`nodesFromEmbeddingRows(rows)` returning `{ nodes, nodesExcludedNoEmbedding }` would separate
the parse from the fetch. Note the `WeaveEvent` type (`:17-26`) omits `user_id` and
`voice_session_id`, both of which `select('*')` returns; a typed extraction would surface that.

**The line-434 comment, verbatim:**

```ts
        // If key not in weightMap, the node had no embedding — already excluded
```

D7 F-D7.1 established that 359 of the 375 keys this comment describes *have* an embedding
row; they are archived. The comment misdescribes the dominant miss.

---

## F6 — Voice predicate location

**On the snapshot path: no voice read exists.** `generate-profile-snapshot.ts` reads
`weave_embeddings` and `weave_events` only (`:326, :346, :386, :539`);
`extract-snapshot-themes.ts` reads `weave_profile_snapshots` and `weave_embeddings` only
(`:184, :222, :300`); `generate-snapshot-narrative.ts` reads `weave_profile_snapshots` only
(`:187, :295`). None of the three mentions `voice_sessions`, `voice_utterances`,
`session_kind`, `ended_at`, or `anchor_edge_id`. So the three predicates the dispatch asks
about are applied **nowhere on the snapshot or theme path** — neither in SQL nor client-side —
because there is nothing to apply them to. R1 adding a voice band adds the first such read.

**Where each predicate is applied today, anywhere in the repo** (search preconditions: `grep -rn`
over `src netlify scripts supabase/migrations` for `session_kind`, `ended_at`, `anchor_edge_id`,
`.not(`, `.neq(`, `from('voice_sessions')`, `from('voice_utterances')`, excluding `__tests__`
and `types/database.ts`; checkout `e5cd3fd`):

1. **`session_kind = 'real'` — in SQL, as a view.** The only application in the codebase is
   the `real_voice_session_deposits` view
   ([`036_voice_session_kind.sql:54-60`](../../supabase/migrations/036_voice_session_kind.sql)):

   ```sql
   create view real_voice_session_deposits
     with (security_invoker = true) as
     select d.*
     from voice_session_deposits d
     join voice_sessions s on s.id = d.session_id
     where d.superseded_at is null
       and s.session_kind = 'real';
   ```

   consumed by the voice retrieval band, not the snapshot
   ([`depositRetrieval.ts:138-140`](../../src/services/voice/depositRetrieval.ts)):

   ```ts
     const { data, error } = await client
       .from('real_voice_session_deposits')
       .select('id, session_id, type, body, embedding')
   ```

   No client-side `.eq('session_kind', …)` exists anywhere. The deposit *generator*
   `scripts/summarizeVoiceSession.mjs --all` iterates `SELECT id FROM voice_sessions ORDER BY
   started_at` (`:348`) with **no kind filter** — QA sessions get deposits too, which the
   `real_` view then excludes.

2. **`ended_at is not null` — applied nowhere as a filter.** `ended_at` is written
   (`voiceSessions.ts:38`, `voiceSessionController.ts:269, :320`) and never used as a read
   predicate in SQL, view, RPC, or client code.

3. **`anchor_edge_id is not null` — applied nowhere as a filter.** `anchor_edge_id` is read
   once, as a soft join for board resolution, client-side after an unfiltered `.in('id', …)`
   read ([`depositRetrieval.ts:180-190`](../../src/services/voice/depositRetrieval.ts)): a null
   anchor leaves `sourceBoard` null; it does not drop the row.

The live retrieval RPC `match_retrieval_context` (034, re-created 038) is node-only; the
`from voice_utterances` in 032/033 was removed in 034. No SQL function reads voice today.

**Counts (prod).**

```sql
select session_kind, count(*) from voice_sessions group by 1 order by 1;
-- → qa 62 | real 25            (62 + 25 = 87 = select count(*) from voice_sessions ✅)
select (ended_at is not null) as ended, (anchor_edge_id is not null) as anchored, count(*)
from voice_sessions where session_kind = 'real' group by 1,2 order by 1,2;
-- → t f 9 | t t 16              (9 + 16 = 25 ✅; no real session has ended_at null)
select count(*) from voice_sessions where session_kind = 'real' and ended_at is not null and anchor_edge_id is not null;
-- → 16
```

| | real | QA | total |
|---|---:|---:|---:|
| `voice_sessions` | **25** | 62 | 87 ✅ |
| real ∧ `ended_at not null` | 25 | | |
| real ∧ `ended_at not null` ∧ `anchor_edge_id not null` | **16** | (38) | |

**`user_turns` distribution for the 16** (`speaker` values in `voice_utterances` are exactly
`user` 292 / `assistant` 365):

```sql
with s as (select id from voice_sessions where session_kind = 'real' and ended_at is not null and anchor_edge_id is not null),
t as (select s.id, count(u.id) filter (where u.speaker = 'user') as user_turns from s left join voice_utterances u on u.session_id = s.id group by s.id)
select count(*) as n, min(user_turns), percentile_cont(0.5) within group (order by user_turns) as median, max(user_turns),
       count(*) filter (where user_turns = 0) as zero_turn, sum(user_turns) from t;
-- → 16 | 2 | 7.5 | 23 | 0 | 158
-- per-session: 2×3, 3, 4, 6×3, 9, 10, 12, 14, 16, 21, 22, 23   (12 distinct values, 16 sessions ✅)
```

| n | min | median | max | zero-turn sessions | total user turns |
|---:|---:|---:|---:|---:|---:|
| **16** | 2 | **7.5** | 23 | 0 | 158 |

QA control, same three predicates: n = 38, min 0, median **0**, max 6 — the QA population is
overwhelmingly zero-turn stubs, which is why the kind predicate matters.

---

## F7 — Event timestamps for decay

**Column and semantics (restated from D7 §2.1, code re-read at `e5cd3fd`).** The read
selects `*`; the only timestamp column is `weave_events.timestamp`, `timestamptz not null
default now()` ([`001_create_weave_events.sql:10`](../../supabase/migrations/001_create_weave_events.sql)).
The client sets it only when a caller passes one
([`eventTracker.ts:45`](../../src/services/eventTracker.ts): `if (options.timestamp) row.timestamp = options.timestamp`),
which only `weave_triggered` does; every weighted-type row is stamped at **server insert
arrival**, from a fire-and-forget async insert. Decay over `timestamp` is decay over arrival
time; D7 §2.6 measured sub-second arrival reversals within bursts, which is immaterial at
14-day granularity.

**Voice: `ended_at` is populated for every real session.**

```sql
select session_kind, count(*) filter (where ended_at is null) as ended_null, count(*) filter (where ended_at is not null) as ended_not_null, count(*)
from voice_sessions group by 1 order by 1;
-- → qa 2 | 60 | 62      real 0 | 25 | 25
```

Real: **0 null / 25 not null**. (QA has 2 never-ended sessions; irrelevant to the real band.)
Real sessions span `started_at` `2026-05-18 00:14 UTC` → `2026-08-28 21:21 UTC`; `ended_at`
`2026-05-18 00:16` → `2026-08-28 21:40`.

**Age of currently-resolving weighted events** — the three v2-roster types, event grain
(an event "resolves" if ≥ 1 of its keys hits a live map entry), 14-day buckets from
`now()` = `2026-09-06 01:1x UTC`. The board predicate does not change this population
(F2: hits are identical in both scopes).

```sql
with ev as (
  select e.id, e.event_type, e.timestamp as ts,
         unnest(case when e.event_type like 'connection%'
           then array[split_part(target_id,':',2)||':'||split_part(target_id,':',3),
                      split_part(target_id,':',2)||':'||split_part(target_id,':',4)]
           else array[substring(target_id from 6)] end) as ckey
  from weave_events e
  where event_type in ('lightbox_closed','connection_description_closed','item_added')
    and not (event_type = 'lightbox_closed' and (duration_ms is null or duration_ms <= 0))),
hits as (
  select ev.id, ev.event_type, ev.ts, bool_or(live.node_id is not null) as resolves, count(*) filter (where live.node_id is not null) as keys_hit
  from ev left join weave_embeddings live on live.board_id||':'||live.node_id = ev.ckey and live.archived_at is null
  group by 1,2,3)
select event_type,
  count(*) filter (where resolves and age_d < 14) as "0-13d",
  count(*) filter (where resolves and age_d >= 14 and age_d < 28) as "14-27d",
  count(*) filter (where resolves and age_d >= 28 and age_d < 42) as "28-41d",
  count(*) filter (where resolves and age_d >= 42 and age_d < 56) as "42-55d",
  count(*) filter (where resolves and age_d >= 56 and age_d < 70) as "56-69d",
  count(*) filter (where resolves and age_d >= 70) as older,
  count(*) filter (where resolves) as resolving, count(*) filter (where not resolves) as non_resolving, count(*) as all_events, sum(keys_hit) as keys_hit
from (select *, extract(epoch from (now() - ts))/86400 as age_d from hits) h
group by 1 order by 1;
```

| event_type (event grain) | 0–13d | 14–27d | 28–41d | 42–55d | 56–69d | **older (≥70d)** | resolving | non-resolving | all | gate |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| `connection_description_closed` | 7 | 5 | 4 | 32 | 10 | **338** | 396 | 58 | 454 | 396+58 = 454 ✅ |
| `item_added` | 1 | 3 | 1 | 2 | 1 | **72** | 80 | 45 | 125 | ✅ |
| `lightbox_closed` | 6 | 6 | 9 | 4 | 0 | **92** | 117 | 14 | 131 | ✅ |

Key grain (each resolved key that hits; same query without the `bool_or` collapse):

| event_type (key grain) | 0–13d | 14–27d | 28–41d | 42–55d | 56–69d | older | hit keys |
|---|---:|---:|---:|---:|---:|---:|---:|
| `connection_description_closed` | 14 | 10 | 8 | 64 | 17 | 673 | **786** |
| `item_added` | 1 | 3 | 1 | 2 | 1 | 72 | **80** |
| `lightbox_closed` | 6 | 6 | 9 | 4 | 0 | 92 | **117** |

Hit keys 786 / 80 / 117 equal F2's per-type hits ✅. Non-resolving closes: 58 events whose
both keys miss (116 keys) + 6 single-key misses inside resolving events = 122 = D7's 116 + 6 ✅.

**Reading.** 85% of resolving closes (338/396), 90% of `item_added` (72/80) and 79% of
`lightbox_closed` (92/117) are older than 70 days. Within 70 days the populations are 58 / 8 /
25 events. A 70-day horizon at t1 keeps roughly a sixth of today's resolving engagement; the
42–55d bucket for closes (32 events, 64 keys) is a single session burst. The oldest
resolving rows are 2026-04-25 (134 days).

**Age of real voice sessions, 42-day buckets by `ended_at`** (also by `started_at`; identical):

```sql
select case when age_d < 42 then '0-41d' when age_d < 84 then '42-83d' when age_d < 126 then '84-125d'
            when age_d < 168 then '126-167d' when age_d < 210 then '168-209d' else 'older (>=210d)' end as bucket,
       min(age_d)::int, max(age_d)::int, count(*) as real_sessions, count(*) filter (where anchored) as anchored
from (select extract(epoch from (now() - ended_at))/86400 as age_d, anchor_edge_id is not null as anchored
      from voice_sessions where session_kind='real' and ended_at is not null) x
group by 1 order by min(age_d);
```

| bucket | age range (d) | real sessions | of which anchored |
|---|---|---:|---:|
| 0–41d | 8–28 | 4 | 3 |
| 42–83d | 46–79 | 4 | 2 |
| 84–125d | 89–111 | **17** | 11 |
| 126–167d | | 0 | 0 |
| 168–209d | | 0 | 0 |
| older (≥210d) | | 0 | 0 |
| **sum** | | **25** ✅ | **16** ✅ |

Every real session is inside 210 days; 17 of 25 (11 of the 16 anchored) sit in the 84–125 day
band. Nothing is older than 111 days, so at t1 a 210-day voice horizon retains the whole
population and decay is the only lever.

---

## 8. Contradicts the dispatch / could not test

- **"The difference in hits is the engagement the current scoping discards" — it is zero.**
  The dispatch expected the board predicate to be a sized defect. It is a defect in form (a
  board predicate on a global reading), but its effect today is 13 absent-miss keys and 0
  hits, because key-board always equals event-board and the board list comes from the same
  table as the map. R1 should still remove it — the exposure is real under an explicit
  `board_ids` body or any cross-board-attributing event type — but it is not the source of
  discarded engagement.
- **"If F1 shows the map or clustering is also board-scoped…"** — they are, but only under
  an explicit `board_ids` body; the default derives the list from the whole table. The
  combination the code applies by default is *events scoped / map unscoped / clustering
  unscoped*, and F2 sizes exactly that. The fully explicit-`board_ids` case has no caller in
  the repo and was not sized.
- **F6 as worded assumes a voice read exists on the snapshot or theme path.** None does.
  The predicates are reported where they *are* applied (036 view; nowhere for the other
  two) so R1 knows it is adding the first voice read to this pipeline.
- **F3 empirical confirmation could not run**: no prod read-only API credential exists
  locally (`.env` is dev), and the service role is excluded. Code-confirmed exposure; cap
  unconfirmed; setting to be read from the dashboard by Daniel.
- **OQ14 not run** (per dispatch). Shape restated from re-read policies: service-role insert
  → `user_id NULL` → invisible under `select_own`.
- **The real resolvers/map-builder were not called** (co-resident with the insert, F5);
  verbatim copies were used and the SQL cross-check agrees cell-for-cell.
- **Session-record shape.** Follows `docs/session-record-2026-09-04.md`, the most recent in
  the repo's existing shape.

---

## 9. Query map (deduplicated; re-run at revival)

Reconnect: `psql "$WEAVE_PROD_RO_DATABASE_URL" -X`. `$S` is any scratch directory outside the repo.

| id | measures | where used |
|---|---|---|
| `P1` | `git log 1b2cfff..HEAD` over code paths (empty); `git diff --stat` | §0 |
| `P2` | `now()`, `current_user`, `is_superuser`; `pg_roles` bypassrls/super | §0 |
| `P3` | `readonly_audit_select` with `qual = true` on every public base table | §0 |
| `P4` | `weave_events` columns; `voice_session_id → session_kind` join counts; `with_vsid` on six types; distinct `user_id` | §0 |
| `P5` | `role_table_grants` for `current_user` — SELECT only | §0 |
| `T0` | `weave_events` per-type counts (expected-count source) | §0, F2 |
| `T3` | `weave_embeddings` live/archived × embedding-null; distinct composites; boards | §0 |
| `X4` | `lightbox_closed` rows with null/zero `duration_ms` (weight gate) | F2 |
| `KB` | key-board = event-board on all six types | F2 |
| `X1s` | composite-join coverage per type, split in-list / never-read (F2 SQL cross-check) | F2 |
| `X1b` | same, grouped by event `board_id`, with `in_scope` flag | F2 |
| `F8` | events (all types) on boards with no `weave_embeddings` row | F2 |
| `R1` | counts for the exact `:389` predicate: all / in-scope / boards | F3 |
| `R2` | 70-day / 210-day / all-time for scoped, unscoped, six-types-scoped; table span | F3 |
| `C12` | RLS policies on `weave_profile_snapshots`, verbatim; `relrowsecurity`/`relforcerowsecurity`/owner; `user_id` nullability/default; row inventory | F4 |
| `V1` | `voice_sessions` by `session_kind`; total | F6 |
| `V2` | real sessions by (`ended_at not null`, `anchor_edge_id not null`) | F6 |
| `V3` | `voice_utterances.speaker` values | F6 |
| `V4` | `user_turns` distribution for real ∧ ended ∧ anchored (and QA control) | F6 |
| `V5` | `ended_at` null / not-null by kind | F7 |
| `V6` | real sessions in 42-day buckets by `ended_at` (and `started_at`); span | F7 |
| `E2` | resolving weighted events (3 types), event grain, 14-day buckets | F7 |
| `E3` | same, key grain | F7 |
| `E4` | min/max `timestamp` per type | F7 |
| script A | `r0-scope.mjs` — verbatim resolver/map/lookup, scoped and unscoped, per type and per board | F2 |

**`X1b` (full text):**

```sql
with resolved as (
  select e.board_id as ev_board, exists (select 1 from weave_embeddings w where w.board_id = e.board_id) as in_scope,
         unnest(case when e.event_type like 'connection%'
           then array[split_part(target_id,':',2)||':'||split_part(target_id,':',3),
                      split_part(target_id,':',2)||':'||split_part(target_id,':',4)]
           else array[substring(target_id from 6)] end) as ckey
  from weave_events e
  where event_type in ('connection_label_clicked','connection_description_closed','item_added','lightbox_opened','lightbox_closed','node_selected')
    and target_id is not null)
select ev_board, in_scope, count(*) as resolved,
       count(*) filter (where live.node_id is not null) as hit,
       count(*) filter (where live.node_id is null and anyr.node_id is not null) as archived_miss,
       count(*) filter (where anyr.node_id is null) as absent_miss
from resolved r
left join weave_embeddings live on live.board_id||':'||live.node_id = r.ckey and live.archived_at is null
left join weave_embeddings anyr on anyr.board_id||':'||anyr.node_id = r.ckey
group by 1,2 order by 3 desc;
```

## File/line map

| what | where |
|---|---|
| board input: body `board_ids` else derived from all `weave_embeddings` rows | [generate-profile-snapshot.ts:305-335](../../netlify/functions/generate-profile-snapshot.ts) |
| service-role client construction | [:291-301](../../netlify/functions/generate-profile-snapshot.ts) |
| `lightboxClosedWeight` + constants | [:76-89](../../netlify/functions/generate-profile-snapshot.ts) |
| `ENGAGEMENT_RULES`; two byte-identical inline `connection:` resolvers | [:111-150](../../netlify/functions/generate-profile-snapshot.ts); [:114-121](../../netlify/functions/generate-profile-snapshot.ts), [:125-132](../../netlify/functions/generate-profile-snapshot.ts) |
| `resolveNodeTarget` | [:152-158](../../netlify/functions/generate-profile-snapshot.ts) |
| `parseEmbedding` | [:181-202](../../netlify/functions/generate-profile-snapshot.ts) |
| map population (`.in(board)`, `.is('archived_at', null)`) | [:346-350](../../netlify/functions/generate-profile-snapshot.ts) |
| map key construction | [:370](../../netlify/functions/generate-profile-snapshot.ts) |
| events read — the one live board predicate, no range | [:386-389](../../netlify/functions/generate-profile-snapshot.ts) |
| weightMap init, weight loop, gate, silent miss, comment | [:404-440](../../netlify/functions/generate-profile-snapshot.ts); comment [:434](../../netlify/functions/generate-profile-snapshot.ts) |
| normalization | [:442-448](../../netlify/functions/generate-profile-snapshot.ts) |
| clustering over `nodes` | [:457](../../netlify/functions/generate-profile-snapshot.ts) |
| anchor selection (per cluster, top-3) | [:476-488](../../netlify/functions/generate-profile-snapshot.ts) |
| `generation_metadata` construction | [:511-526](../../netlify/functions/generate-profile-snapshot.ts) |
| snapshot row + insert (no `user_id`) | [:528-543](../../netlify/functions/generate-profile-snapshot.ts) |
| route config | [:589-591](../../netlify/functions/generate-profile-snapshot.ts) |
| only caller: `npm run snapshot:test` | [package.json:15](../../package.json) |
| themes: service-role client; embeddings read with `archived_at` filter | [extract-snapshot-themes.ts:156-165](../../netlify/functions/extract-snapshot-themes.ts), [:222-228](../../netlify/functions/extract-snapshot-themes.ts) |
| browser snapshot reader (authenticated, `select_own`) | [profileSnapshots.ts:36-46](../../src/persistence/profileSnapshots.ts) |
| `real_voice_session_deposits` view (`session_kind = 'real'`) | [036_voice_session_kind.sql:54-60](../../supabase/migrations/036_voice_session_kind.sql) |
| view consumer; soft `anchor_edge_id` join | [depositRetrieval.ts:138-140](../../src/services/voice/depositRetrieval.ts), [:180-190](../../src/services/voice/depositRetrieval.ts) |
| deposits backfill iterates all sessions, no kind filter | [summarizeVoiceSession.mjs:348](../../scripts/summarizeVoiceSession.mjs) |
| `timestamp default now()` | [001_create_weave_events.sql:10](../../supabase/migrations/001_create_weave_events.sql) |
| `trackEvent` timestamp override only when passed | [eventTracker.ts:45](../../src/services/eventTracker.ts) |

## Appendix A — `r0-scope.mjs` (throwaway; not in the repo)

```js
// Throwaway R0 reproduction of generate-profile-snapshot.ts steps 1–4, run twice:
//   scoped   = code as written: events .in('board_id', boardIds) at :386-389, weight gate at :426
//   unscoped = identical except the board predicate on the events read is removed
// Rule/resolver/map code copied VERBATIM from netlify/functions/generate-profile-snapshot.ts @ e5cd3fd
// (lines 76-89, 111-158, 181-202, 326-334, 346-377, 404-435). No insert step exists here.
import { readFileSync } from 'node:fs'
const S = process.argv[2]
const events = JSON.parse(readFileSync(`${S}/events.json`, 'utf8'))
const embeddingRows = JSON.parse(readFileSync(`${S}/embeddings.json`, 'utf8'))

// ---- verbatim :76-89
const LIGHTBOX_DWELL_CAP_S = 45
const LIGHTBOX_DWELL_LOG_DIVISOR = Math.log2(LIGHTBOX_DWELL_CAP_S + 1)
const LIGHTBOX_CLOSED_BASE_WEIGHT = 1.5
function lightboxClosedWeight(event) {
  const ms = event.duration_ms
  if (!ms || ms <= 0) return 0
  const seconds = ms / 1000
  const scale = Math.min(Math.log2(seconds + 1) / LIGHTBOX_DWELL_LOG_DIVISOR, 1.0)
  return LIGHTBOX_CLOSED_BASE_WEIGHT * scale
}
// ---- verbatim :111-158
const ENGAGEMENT_RULES = {
  connection_label_clicked: { weight: 1.0, resolve: (e) => {
      if (!e.target_id) return []
      const parts = e.target_id.split(':')
      if (parts.length !== 4 || parts[0] !== 'connection') return []
      const [, boardId, fromId, toId] = parts
      return [`${boardId}:${fromId}`, `${boardId}:${toId}`] } },
  connection_description_closed: { weight: 0.3, resolve: (e) => {
      if (!e.target_id) return []
      const parts = e.target_id.split(':')
      if (parts.length !== 4 || parts[0] !== 'connection') return []
      const [, boardId, fromId, toId] = parts
      return [`${boardId}:${fromId}`, `${boardId}:${toId}`] } },
  item_added: { weight: 0.2, resolve: resolveNodeTarget },
  lightbox_opened: { weight: 0.1, resolve: resolveNodeTarget },
  lightbox_closed: { weight: lightboxClosedWeight, resolve: resolveNodeTarget },
  node_selected: { weight: 0.1, resolve: resolveNodeTarget },
}
function resolveNodeTarget(event) {
  if (!event.target_id) return []
  if (!event.target_id.startsWith('node:')) return []
  return [event.target_id.slice('node:'.length)]
}
// ---- verbatim :181-202 (warnings suppressed)
function parseEmbedding(raw) {
  if (typeof raw === 'string') { try { const p = JSON.parse(raw); if (Array.isArray(p)) return p } catch {} ; return null }
  if (Array.isArray(raw)) return raw
  return null
}
// ---- Step 1 (:326-334): boardIds = distinct board_id over ALL weave_embeddings rows
const boardIds = [...new Set(embeddingRows.map((r) => r.board_id))]
// ---- Step 2 (:346-377): .in('board_id', boardIds).is('archived_at', null), parse
const nodes = []
let nodesExcludedNoEmbedding = 0
for (const row of embeddingRows.filter((r) => boardIds.includes(r.board_id) && r.archived_at === null)) {
  const embedding = parseEmbedding(row.embedding)
  if (!embedding) { nodesExcludedNoEmbedding++; continue }
  nodes.push({ compositeKey: `${row.board_id}:${row.node_id}` })
}
// archived / absent classification helpers (D7 B4/B5 definitions, composite key)
const anyRow = new Map(embeddingRows.map((r) => [`${r.board_id}:${r.node_id}`, r]))

// ---- Step 4 (:404-435), instrumentation only around `key in weightMap`
function run(scopeEvents) {
  const weightMap = {}
  for (const node of nodes) weightMap[node.compositeKey] = 0
  const tally = () => ({ resolved: 0, hit: 0, archived_miss: 0, absent_miss: 0 })
  const total = tally(); const byType = {}; const byBoard = {}
  let zeroWeightGated = 0, eventsRead = scopeEvents.length, eventsUnmatched = 0
  for (const event of scopeEvents) {
    const rule = ENGAGEMENT_RULES[event.event_type]
    if (!rule) { eventsUnmatched++; continue }
    const attributedKeys = rule.resolve(event)
    if (attributedKeys.length === 0) continue
    const perEventWeight = typeof rule.weight === 'function' ? rule.weight(event) : rule.weight
    if (perEventWeight <= 0) { zeroWeightGated += attributedKeys.length; continue }
    const t = (byType[event.event_type] ??= tally()); const b = (byBoard[event.board_id] ??= tally())
    for (const key of attributedKeys) {
      let bucket
      if (key in weightMap) { weightMap[key] += perEventWeight; bucket = 'hit' }
      else { const r = anyRow.get(key); bucket = r ? 'archived_miss' : 'absent_miss' }
      for (const o of [total, t, b]) { o.resolved++; o[bucket]++ }
    }
  }
  const maxRaw = Math.max(...Object.values(weightMap), 0)
  const nonZero = Object.values(weightMap).filter((v) => v > 0).length
  return { eventsRead, eventsUnmatched, zeroWeightGated, total, byType, byBoard, maxRawWeight: maxRaw, nodesWithWeight: nonZero, weightMap }
}
const scopedEvents = events.filter((e) => boardIds.includes(e.board_id))   // :389 .in('board_id', boardIds)
const scoped = run(scopedEvents)
const unscoped = run(events)
const gate = (o) => o.resolved === o.hit + o.archived_miss + o.absent_miss
const fmt = (o) => `${o.resolved} = ${o.hit} + ${o.archived_miss} + ${o.absent_miss} ${gate(o) ? 'OK' : 'FAIL'}`
console.log(`boards_in_scope=${boardIds.length} map_size=${nodes.length} nodesExcludedNoEmbedding=${nodesExcludedNoEmbedding} events_total=${events.length}`)
for (const [name, r] of [['scoped', scoped], ['unscoped', unscoped]]) {
  console.log(`\n== ${name}: events_read=${r.eventsRead} unmatched_type=${r.eventsUnmatched} zero_weight_gated_keys=${r.zeroWeightGated} nodes_with_weight=${r.nodesWithWeight}/${nodes.length} max_raw_weight=${r.maxRawWeight.toFixed(4)}`)
  console.log(`   total  resolved = hit + archived + absent : ${fmt(r.total)}`)
  for (const t of Object.keys(r.byType).sort()) console.log(`   ${t.padEnd(30)} ${fmt(r.byType[t])}`)
  if (name === 'unscoped') {
    console.log('   by board_id:')
    for (const b of Object.keys(r.byBoard).sort((a, c) => r.byBoard[c].resolved - r.byBoard[a].resolved)) console.log(`   ${b} inList=${boardIds.includes(b)} ${fmt(r.byBoard[b])}`)
  }
}
console.log(`\nHIT DIFFERENCE (unscoped − scoped) = ${unscoped.total.hit - scoped.total.hit}`)
console.log(`RESOLVED DIFFERENCE = ${unscoped.total.resolved - scoped.total.resolved}; weightMap identical across runs: ${JSON.stringify(scoped.weightMap) === JSON.stringify(unscoped.weightMap)}`)
```
