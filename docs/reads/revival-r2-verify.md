# Revival R2 — Verify on prod: OQ14, unweighted pair, determinism, Q18

> **This is a point-in-time verification record, as of 2026-09-05 (local).**
>
> **Read opened:** `2026-09-06 02:24:10 UTC` (`select now()` at first RO connection, P2).
> **Repo SHA (baseline read):** `2cda5920f37692c2b9f165dea6d7beb27586106d` (`origin/main` = PR #45 merged).
> **Repo SHA (runs):** `02078ae0d2524691affb9011a310ac6474c96d15` (`origin/main` after PR #46 merged; Netlify deploys `main`, so this is the code the runs execute).
> **Database:** Weave prod (`wndfikmpifyqkgivmnwv`).
> **Role:** `weave_readonly` via `WEAVE_PROD_RO_DATABASE_URL` / `--db-url` only. Claude Code holds no
> write credential and no JWT; every generation is executed by Daniel from his own terminal.
> **Dashboard PostgREST max-rows:** **1000** (read by Daniel from the project dashboard, 2026-09-05). This closes R0/F3: the v1 read (2,642 rows, no range) was capped at 1,000; the v2 read is range-paged and count-gated, so the cap cannot truncate it silently.
>
> **Findings in this document decay; the query map does not.** Every count is
> verified by re-running the query directly above it, never by citing this file.
>
> Fifth occupant of the `docs/reads/` class. Depends on
> [`revival-preflight.md`](revival-preflight.md) (R0) and PR #45 (R1).

**Scope.** Four questions: OQ14 visibility, run-1 metadata gates against independent RO counts,
determinism across two runs over one node set, Q18 facts. No prompt, weight or decay changes;
no editing or deleting of snapshot rows.

(Header created before any query ran; body filled as B0–B6 proceed.)

---

## 0. Preflight (RO; recorded verbatim)

**P1 — checkout currency.** `git fetch origin`; `main` reset to `origin/main` = `2cda592` (PR #45
merged 2026-09-06 02:17 UTC). Branch `reads/revival-r2-verify` cut from it. Working tree clean.
Part A (PR #46, `feat/r2-run-params`) adds `uniform_weights` / `page_size`; it must be merged and
deployed before B1, and the runs' SHA is recorded in the header when Daniel confirms.

**P2 — role identity.**

```sql
select now(), current_user, current_setting('is_superuser');
-- → 2026-09-06 02:24:10.15711+00 | weave_readonly | off
select rolname, rolbypassrls, rolsuper from pg_roles where rolname = current_user;
-- → weave_readonly | f | f
```

**P3 — RO visibility.** `readonly_audit_select` with `qual = true` on **13/13** public base tables
(query as R0 P3).

**P4 — `weave_events` QA marker: none** (restated). `voice_session_id → session_kind`: null 2,540 |
qa 115 | real 50 (= 2,705 ✅). One `user_id` on the table: `92fcfcc8-fac9-466f-be22-afdfa71b9102`
— this is Daniel's auth uid, and the uid the OQ14 check compares against.

**P5 — grants.** `SELECT` only, every relation.

---

## B0 — Baseline (RO, before any write)

Read at `T0 = 2026-09-06 02:24:31 UTC`. **Every 70-day figure below moves with the clock**; the
gates in B2/B3 are compared against the same queries re-run with each run's recorded
`generated_at`, not against these literals. The queries are the deliverable; the numbers are the
state at T0.

**B0a — snapshot table.**

```sql
select count(*) from weave_profile_snapshots;                                    -- → 1
select id, created_at, trigger_reason, user_id, node_count, event_count,
       generation_metadata->>'pipeline_version' as pv
from weave_profile_snapshots order by created_at desc limit 5;
-- → 204af847-fa26-4e61-a699-c059fc5cd9e4 | 2026-04-17 22:52:00+00 | fixture | 92fcfcc8-… | 37 | 0 | (null)
```

One row, the hand-seeded fixture. Expected after B1: 2 rows; after B3: 3.

**B0b — the events read and attribution, independently.** Exports (RO), then the **real R1
modules** (`netlify/lib/snapshot/{engagement,reads,constants}.ts`, imported, not copied) run over
them at `generated_at = T0` with `uniform_weights = true` (Appendix A, `r2-expected.ts`):

```bash
psql "$WEAVE_PROD_RO_DATABASE_URL" -X -At -c "select json_agg(row_to_json(e)) from (select id, event_type, target_id, board_id, session_id, timestamp, duration_ms, metadata, user_id, voice_session_id from weave_events where event_type in ('lightbox_closed','connection_description_closed','item_added','connection_label_clicked','lightbox_opened') order by timestamp, id) e" > $S/r2-events.json      # 1,349 rows (all time; the script applies the horizon)
psql "$WEAVE_PROD_RO_DATABASE_URL" -X -At -c "select json_agg(row_to_json(w)) from (select board_id, node_id, node_type, embedding::text as embedding, content_summary, archived_at, created_at from weave_embeddings order by created_at) w" > $S/r2-embeddings.json   # 101
psql "$WEAVE_PROD_RO_DATABASE_URL" -X -At -c "<B0d voice query below>" > $S/r2-voice.json          # 16
node $S/r2-expected.mjs $S "<generated_at>" true
```

| expected at T0 | value |
|---|---:|
| `events_read.rows_expected` (5 types, `timestamp >= T0 − 70 d`) | **191** |
| by type: `connection_label_clicked` / `connection_description_closed` / `item_added` / `lightbox_opened` / `lightbox_closed` | 65 / 58 / 10 / 30 / 28 |
| `attribution.resolved` | **186** |
| `attribution.hit` | **178** |
| `attribution.dropped.archived` / `.absent` | **8** / **0** |
| by type — `connection_description_closed` (resolved/hit/archived/absent) | 116 / 113 / 3 / 0 |
| by type — `item_added` | 10 / 8 / 2 / 0 |
| by type — `lightbox_closed` | 28 / 25 / 3 / 0 |
| by type — `voice_session` | 32 / 32 / 0 / 0 |
| `zero_weight_events` | 0 |
| `events_unmatched_by_type` | `connection_label_clicked` 65, `lightbox_opened` 30 |
| `node_set.count` (live embeddings) | **71** (of 101) |
| `max_raw_weight_before_normalization` | 8.6268 (key `a428492a…:35`) |

Cardinality: 178 + 8 + 0 = 186 ✅; per type 113+3, 8+2, 25+3, 32+0 ✅. Under the 70-day horizon
the absent bucket is **0** — the 29 all-time absent keys (R0/F2) are all April–May 2026 and fall
outside the window; the pre-registered 16 → 29 figure is therefore not observable at this horizon,
as the dispatch anticipated.

**SQL cross-check of the same predicate** (composite join; weight gate on `lightbox_closed`):

```sql
with resolved as (
  select e.event_type,
         unnest(case when e.event_type like 'connection%'
           then array[split_part(target_id,':',2)||':'||split_part(target_id,':',3),
                      split_part(target_id,':',2)||':'||split_part(target_id,':',4)]
           else array[substring(target_id from 6)] end) as ckey
  from weave_events e
  where event_type in ('lightbox_closed','connection_description_closed','item_added')
    and timestamp >= now() - interval '70 days'
    and target_id is not null
    and not (event_type = 'lightbox_closed' and (duration_ms is null or duration_ms <= 0)))
select event_type, count(*) as resolved,
       count(*) filter (where live.node_id is not null) as hit,
       count(*) filter (where live.node_id is null and anyr.node_id is not null) as archived,
       count(*) filter (where anyr.node_id is null) as absent
from resolved r
left join weave_embeddings live on live.board_id||':'||live.node_id = r.ckey and live.archived_at is null
left join weave_embeddings anyr on anyr.board_id||':'||anyr.node_id = r.ckey
group by 1 order by 1;
-- → connection_description_closed 116 | 113 | 3 | 0
--   item_added                     10 |   8 | 2 | 0
--   lightbox_closed                28 |  25 | 3 | 0            (= script, cell for cell ✅)

select event_type, count(*) from weave_events
where event_type in ('lightbox_closed','connection_description_closed','item_added','connection_label_clicked','lightbox_opened')
  and timestamp >= now() - interval '70 days' group by 1 order by 1;
-- → 58 | 65 | 10 | 28 | 30   (sum 191 ✅)
```

**B0c — pair asymmetry by set-difference per `(session_id, target_id)`, 70 d.**

```sql
with g as (
  select case when event_type in ('connection_label_clicked','connection_description_closed') then 'connection' else 'lightbox' end as pair,
         session_id, target_id,
         count(*) filter (where event_type in ('connection_label_clicked','lightbox_opened')) as opens,
         count(*) filter (where event_type in ('connection_description_closed','lightbox_closed')) as closes
  from weave_events
  where event_type in ('connection_label_clicked','connection_description_closed','lightbox_opened','lightbox_closed')
    and timestamp >= now() - interval '70 days'
  group by 1,2,3)
select pair, sum(opens) as opens, sum(closes) as closes, sum(least(opens,closes)) as paired,
       sum(greatest(0, opens-closes)) as orphan_opens, sum(greatest(0, closes-opens)) as unmatched_closes
from g group by 1 order by 1;
```

| pair | opens | closes | paired | orphan_opens | unmatched_closes |
|---|---:|---:|---:|---:|---:|
| connection | 65 | 58 | 58 | 7 | 0 |
| lightbox | 30 | 28 | 28 | 2 | 0 |

Script output identical ✅. Gates: 58 + 7 = 65; 28 + 2 = 30 ✅.

**B0d — voice population and the anchor hop.**

```sql
select s.id as session_id, s.anchor_edge_id, s.ended_at,
       (select count(*) from voice_utterances u where u.session_id = s.id and u.speaker = 'user') as user_turns,
       e.board_id,
       'connection:' || e.board_id || ':' || coalesce(nf.data->>'_clientNodeId', nf.id::text) || ':' || coalesce(nt.data->>'_clientNodeId', nt.id::text) as anchor_target,
       (e.id is not null) as edge_found, (nf.id is not null and nt.id is not null) as nodes_found,
       (nf.data->>'_clientNodeId' is not null) as from_has_client_id, (nt.data->>'_clientNodeId' is not null) as to_has_client_id
from voice_sessions s
left join edges e on e.id = s.anchor_edge_id
left join nodes nf on nf.id = e.source_node_id
left join nodes nt on nt.id = e.target_node_id
where s.session_kind = 'real' and s.ended_at is not null and s.anchor_edge_id is not null
order by s.ended_at, s.id;
-- → 16 rows; within 210 d: 16; edge_found 16/16; nodes_found 16/16; both _clientNodeId 16/16
```

| session | ended | user_turns | anchor (`board…:from:to`) | endpoint state |
|---|---|---:|---|---|
| `a2d72d70` | 05-18 | 2 | `8a8d45a9…:21:6` | live / live |
| `248f8460` | 05-18 | 9 | `8a8d45a9…:21:3` | live / live |
| `0dac35fb` | 05-18 | 3 | `a428492a…:8:3` | live / live |
| `87af5c92` | 05-18 | 21 | `b3c1473b…:16:3` | live / live |
| `c12efded` | 05-19 | 6 | `b3c1473b…:4:8` | live / live |
| `41cc85a8` | 05-19 | 2 | `b3c1473b…:7:8` | live / live |
| `751f9335` | 05-30 | 2 | `b3c1473b…:16:7` | live / live |
| `8bde239f` | 05-30 | 6 | `b3c1473b…:18:7` | live / live |
| `f61f63eb` | 06-07 | 4 | `b3c1473b…:8:9` | live / live |
| `9152ad23` | 06-07 | 22 | `8a8d45a9…:25:7` | live / live |
| `9b74ca61` | 06-09 | 12 | `b3c1473b…:4:9` | live / live |
| `2c18bad5` | 06-20 | 16 | `b3c1473b…:20:10` | live / live |
| `4b7a9c05` | 07-12 | 23 | `b3c1473b…:22:4` | live / live |
| `f90a49c2` | 08-09 | 6 | `a428492a…:35:33` | live / live |
| `1264631b` | 08-09 | 10 | `8a8d45a9…:39:37` | live / live |
| `dd5f619b` | 08-28 | 14 | `a428492a…:39:35` | live / live |

**Expected voice at any run in the next weeks:** `events_read.voice_sessions.rows_returned =
rows_expected = 16`; `anchors.edges_found = 16`, `nodes_found = 22` (distinct endpoint uuids; anchors share nodes); `attribution.by_type.voice_session
= 32 / 32 / 0 / 0` (every anchor endpoint is a live embedding, so **no** voice key lands in
`attribution.dropped` today — the dispatch's "unresolved anchors appear in dropped" clause has
nothing to count; a failed `_clientNodeId` hop would surface as an `absent` miss under
`voice_session`, and a missing edge or node row would throw).

**B0e — live embeddings.** `select count(*) filter (where archived_at is null), count(*) from weave_embeddings;` → **71** / 101.

---

## Runbook (Daniel executes every write; Claude Code verifies RO)

Preconditions: PR #46 merged; Netlify has deployed `main`; the dashboard **API max-rows** value is
sent to Claude Code for the header. `WEAVE_PROD_URL` = the production site origin;
`WEAVE_SNAPSHOT_JWT` = Daniel's own Supabase access token for the prod project (the
`access_token` inside the `sb-<ref>-auth-token` localStorage entry of a signed-in prod tab; it
expires, so run 2 follows run 1 within minutes). **Neither value is ever pasted to Claude Code.**

**B1 — run 1** (live set, default page size, uniform weights):

```bash
curl -s -X POST "$WEAVE_PROD_URL/api/generate-profile-snapshot" \
  -H "Authorization: Bearer $WEAVE_SNAPSHOT_JWT" -H 'Content-Type: application/json' \
  -d '{"trigger_reason":"r2_unweighted","uniform_weights":true}'
```

Report back: the JSON response (it carries `snapshot_id`, `summary`, `attribution`,
`events_read`; no secrets). Then open **Reflect** in the prod app and report, verbatim, whether
the new snapshot is visible. If the function returns an error, report the message verbatim — a
thrown gate is the pipeline working.

**B3 — run 2** (pinned to run 1, page size 50), only after Claude Code reports B2 green:

```bash
curl -s -X POST "$WEAVE_PROD_URL/api/generate-profile-snapshot" \
  -H "Authorization: Bearer $WEAVE_SNAPSHOT_JWT" -H 'Content-Type: application/json' \
  -d '{"trigger_reason":"r2_unweighted","uniform_weights":true,"page_size":50,"pin_node_set_from_snapshot_id":"<RUN1_SNAPSHOT_ID>"}'
```


---

## B1 — Run 1 (OQ14)

Executed by Daniel from his terminal at `2026-09-06 03:13:50 UTC` against the deployed function
(`main` = `02078ae`), body `{"trigger_reason":"r2_unweighted","uniform_weights":true}`. Function
response (pasted by Daniel; no secrets): `snapshot_id 253c9a8c-5170-4461-86e0-e9c9fece9cbd`,
`summary {cluster_count 7, avg_cluster_size 5, cross_board_cluster_count 7, max_cluster_size 14,
singletons_dropped 36, nodes_excluded 0}`, attribution and `events_read` identical to the RO
figures below.

```sql
select count(*) as snapshot_rows, count(*) filter (where created_at > '2026-09-06 02:24:10+00') as new_rows
from weave_profile_snapshots;
-- → 2 | 1                                                          (exactly one new row ✅)
select id, created_at, trigger_reason, user_id, (user_id = '92fcfcc8-fac9-466f-be22-afdfa71b9102') as user_is_daniel,
       node_count, event_count, jsonb_array_length(clusters) as n_clusters, generation_metadata->>'pipeline_version' as pv,
       generation_metadata->>'generated_at' as generated_at
from weave_profile_snapshots where id = '253c9a8c-5170-4461-86e0-e9c9fece9cbd';
-- → 253c9a8c… | 2026-09-06 03:13:55.653969+00 | r2_unweighted | 92fcfcc8-… | t | 71 | 207 | 7 | v2 | 2026-09-06T03:13:50.574Z
select jsonb_pretty(generation_metadata->'parameters') from weave_profile_snapshots where id = '253c9a8c-…';
```

```json
{
  "k": 5,
  "page_size": 500,
  "voice_base": 0.6460148371100897,
  "breadth_max": 1.5,
  "dwell_cap_s": 45,
  "anchor_count": 3,
  "h_depth_days": 42,
  "h_breadth_days": 14,
  "min_real_turns": 4,
  "uniform_weights": true,
  "cluster_threshold": 0.72,
  "item_added_weight": 0.2
}
```

`user_id` is **non-null and equals Daniel's auth uid** ✅. `uniform_weights: true`,
`h_breadth_days 14`, `h_depth_days 42`, `k 5`, `anchor_count 3`, `voice_base 0.6460` ✅.
`timing_ms`: fetch_embeddings 2,663 / fetch_events 494 / fetch_voice 1,547 / generate 158.

**OQ14 verdict — Reflect visibility, Daniel's observation verbatim (2026-09-05 local):** *"There is no
visibility"*. **Not visible.** Per §5 this is a stop condition: **run 2 (B3) is not executed**; B4 is
not attempted. B2, B5 and B6 below are RO reads of run 1 and stand as recorded.

**What the UI observation can and cannot decide (code, not inference).** Reflect renders through
[`getLatestProfileSnapshot`](../../src/persistence/profileSnapshots.ts) →
[`profileSnapshotStore.refresh`](../../src/services/profileSnapshot/profileSnapshotStore.ts) →
[`ReflectView`](../../src/components/ReflectView.tsx):

```ts
// src/persistence/profileSnapshots.ts:39-57
    .from('weave_profile_snapshots')
    .select('id, created_at, node_count, clusters, narrative, generation_metadata')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  ...
  // The contract is "a usable snapshot or nothing" — a row whose
  // narrative is null or blank is indistinguishable from no row from
  // the caller's perspective, so collapse both cases here.
  const narrative = data.narrative?.trim()
  if (!narrative) return null
```

```ts
// src/services/profileSnapshot/profileSnapshotStore.ts:109-114
        const result = await getLatestProfileSnapshot(client)
        if (result) { ... setState({ snapshot: result, ... }) }
        else { setState({ snapshot: null, loading: false, error: null }) }
// src/components/ReflectView.tsx:103-107 — snapshot null ⇒ contentMode 'empty'
```

Run 1 is a stage-1 row: `narrative` is `null` by construction (filled by
`generate-snapshot-narrative`, stage 3, not run here). **A stage-1 snapshot cannot appear in
Reflect under any RLS outcome**; the client collapses it to "no snapshot". The dispatch's §1
("Their Reflect appearance is expected and accepted") assumed otherwise — see §8.

The observation therefore splits OQ14 into two readable states, decided by *what Reflect shows
instead*, because `limit(1)` returns only the newest row the policy admits:

| RLS admits run 1 to Daniel's session? | newest admitted row | client result | Reflect shows |
|---|---|---|---|
| **yes** | run 1 (`narrative` null) | collapsed to `null` | **empty state** — the April fixture *"Clarity as cost, not reward"* disappears |
| **no** | fixture `204af847…` (has narrative) | fixture | **the April fixture, unchanged** |

```sql
-- RO view of the same ordering, policy-free
select id, created_at, trigger_reason, user_id, (narrative is not null and btrim(narrative) <> '') as has_narrative,
       jsonb_array_length(coalesce(clusters,'[]'::jsonb)) as n_clusters, generation_metadata->>'title' as title
from weave_profile_snapshots order by created_at desc limit 5;
-- → 253c9a8c… | 2026-09-06 03:13:55 | r2_unweighted | 92fcfcc8-… | f | 7 | (null)
--   204af847… | 2026-04-17 22:52:00 | fixture       | 92fcfcc8-… | t | 0 | Clarity as cost, not reward
select polname, pg_get_expr(polqual, polrelid) from pg_policy where polrelid='public.weave_profile_snapshots'::regclass and polcmd='r';
-- → readonly_audit_select true | weave_profile_snapshots_select_own (auth.uid() = user_id)
```

**Pending Daniel's second observation** (either resolves OQ14 as an RLS question without any
write): (a) whether Reflect now shows the April fixture or the empty state; or (b) the direct
authenticated read below, run from his terminal with his own token and the prod **anon** key
(both public to the browser; never pasted here) — it exercises exactly `select_own`:

```bash
curl -s "$WEAVE_SUPABASE_URL/rest/v1/weave_profile_snapshots?select=id,created_at,trigger_reason&order=created_at.desc" \
  -H "apikey: $WEAVE_SUPABASE_ANON_KEY" -H "Authorization: Bearer $WEAVE_SNAPSHOT_JWT"
```

Two rows (`253c9a8c…` first) ⇒ RLS admits the pipeline-written row; one row (the fixture) ⇒ it
does not. The verdict recorded above stays "not visible" as the UI fact; whether B3 proceeds is
the planning layer's call on the RLS fact once (a) or (b) is reported.
(`weave_readonly` cannot emulate `auth.uid()`; the RLS-side facts are: policy
`weave_profile_snapshots_select_own` is `auth.uid() = user_id`, and the row's `user_id` is
Daniel's uid, so the policy predicate is satisfiable for his session.)

---

## B2 — Run 1 gates (RO, against B0 re-derived at run 1's `generated_at`)

Expected side: the **real R1 modules at the deployed SHA** (`netlify/lib/snapshot/*` @ `02078ae`)
imported by `r2-expected.ts` (Appendix A) over the RO exports of B0, with
`generated_at = 2026-09-06T03:13:50.574Z` and `uniform = true`. Observed side: the row's
`generation_metadata`. Comparison is key-order-insensitive (`r2-gates.mjs`, Appendix B).

| gate | expected | observed | match |
|---|---|---|---|
| events_read.breadth_from | "2026-06-28T03:13:50.574Z" | "2026-06-28T03:13:50.574Z" | MATCH |
| events_read.depth_from | "2026-02-08T03:13:50.574Z" | "2026-02-08T03:13:50.574Z" | MATCH |
| events_read.rows_returned = rows_expected | 191 | 191 | MATCH |
| events_read.rows_expected = RO count(*) same predicate | 191 | 191 | MATCH |
| events_read.by_type | {"connection_description_closed":58,"connection_label_clicked":65,"item_added":10,"lightbox_closed":28,"lightbox_opened":30} | {"connection_description_closed":58,"connection_label_clicked":65,"item_added":10,"lightbox_closed":28,"lightbox_opened":30} | MATCH |
| attribution.resolved = hit + archived + absent | 186 | 186 | MATCH |
| attribution.resolved | 186 | 186 | MATCH |
| attribution.hit | 178 | 178 | MATCH |
| attribution.dropped | {"absent":0,"archived":8} | {"absent":0,"archived":8} | MATCH |
| attribution.by_type | {"connection_description_closed":{"absent":0,"archived":3,"hit":113,"resolved":116},"item_added":{"absent":0,"archived":2,"hit":8,"resolved":10},"lightbox_closed":{"absent":0,"archived":3,"hit":25,"resolved":28},"voice_session":{"absent":0,"archived":0,"hit":32,"resolved":32}} | {"connection_description_closed":{"absent":0,"archived":3,"hit":113,"resolved":116},"item_added":{"absent":0,"archived":2,"hit":8,"resolved":10},"lightbox_closed":{"absent":0,"archived":3,"hit":25,"resolved":28},"voice_session":{"absent":0,"archived":0,"hit":32,"resolved":32}} | MATCH |
| attribution.zero_weight_events | 0 | 0 | MATCH |
| pair_asymmetry.connection | {"closes":58,"opens":65,"orphan_opens":7,"paired":58,"unmatched_closes":0} | {"closes":58,"opens":65,"orphan_opens":7,"paired":58,"unmatched_closes":0} | MATCH |
| pair_asymmetry.lightbox | {"closes":28,"opens":30,"orphan_opens":2,"paired":28,"unmatched_closes":0} | {"closes":28,"opens":30,"orphan_opens":2,"paired":28,"unmatched_closes":0} | MATCH |
| voice rows_returned = rows_expected | 16 | 16 | MATCH |
| voice rows_expected = RO count | 16 | 16 | MATCH |
| voice anchors edges_found = qualifying | 16 | 16 | MATCH |
| voice unresolved anchors (qualifying − edges_found) = voice archived+absent | 0 | 0 | MATCH |
| node_set.source | "live" | "live" | MATCH |
| node_set.count = RO live embeddings | 71 | 71 | MATCH |
| node_set.keys.length = node_set.count | 71 | 71 | MATCH |
| embeddings rows_returned = rows_expected = RO count | [101,101] | [101,101] | MATCH |
| events_unmatched_by_type | {"connection_label_clicked":65,"lightbox_opened":30} | {"connection_label_clicked":65,"lightbox_opened":30} | MATCH |
| max_raw_weight_before_normalization (1e-9) | 6384770239 | 6384770239 | MATCH |
| parameters.uniform_weights | true | true | MATCH |
| parameters.page_size | 500 | 500 | MATCH |
| parameters.{h_breadth_days,h_depth_days,k,anchor_count} | [14,42,5,3] | [14,42,5,3] | MATCH |
| parameters.voice_base (4dp) | 0.646 | 0.646 | MATCH |

**27/27 match.** In particular: `rows_returned = rows_expected = 191` (= RO `count(*)` on the
identical 5-type/70-day predicate); `resolved 186 = hit 178 + archived 8 + absent 0`, and every
per-type cell equals the independent SQL join (B0b); both pair counters equal the SQL
set-difference (B0c); voice `16 = 16 = 16`, zero unresolved anchors, `voice_session 32/32/0/0`;
`node_set` live, 71 keys = 71 live embeddings; `max_raw_weight` agrees to 1e-9.

**Method incident, recorded because it is the R0 rule in action.** The first pass of the expected
calculator was bundled from a working tree at `2cda592` — the reads branch had been cut before
PR #46 merged — so `resolveEvents` ignored the `uniformWeights` option and the expected
weights came out on the weighted curve (`max_raw_weight` 8.616 vs observed 6.385) while every
*count* matched. Rebasing the branch onto `origin/main` (`02078ae`, the deployed SHA) and
rebuilding made the weights agree to 1e-9. Checkout currency is a precondition for an
expected value, not just for an absence claim.

---

## B5 — Q18 reading (run 1, facts only)

From `253c9a8c…` `clusters` and `generation_metadata`:

| fact | value |
|---|---:|
| node count (live set) | **71** |
| clusters (non-singleton) | **7** |
| cluster sizes | 2, 2, 2, 2, 3, 10, 14 |
| size min / median / max | 2 / **2** / 14 |
| nodes in clusters | 35 |
| singletons dropped | **36** (share **50.7%**) |
| largest cluster share of node set | 14/71 = **19.7%** |
| clusters spanning > 1 board | **7 of 7** (boards touched: 4, 3, 2, 2, 2, 2, 2) |
| anchors recorded | 17 (3 + 3 + 3 + 2 + 2 + 2 + 2) |
| anchors with `w_total = 0` | 5 of 17 |
| `max_raw_weight` | 6.3848, held by `a428492a…:35`, which is a **singleton** (not in any cluster, so not an anchor) |

Per cluster (`cluster_id`, size, boards, `engagement_weight`): c1 14 / 4 / 0.2353; c2 10 / 3 /
0.1422; c3 3 / 2 / 0.1581; c4 2 / 2 / 0.0620; c5 2 / 2 / 0.0142; c6 2 / 2 / 0; c7 2 / 2 / 0.1174.

Top three anchors by `w_total` (uniform weights, decayed):

| anchor | `board_id` | cluster | `w_total` | `w_normalized` | breadth | depth | recency |
|---|---|---|---:|---:|---:|---:|---:|
| `a428492a…:39` | `a428492a-08f5-4d66-8da6-a307bcdaea62` | c3 | 2.8679 | 0.4492 | 1.3301 | 0.8730 | 0.6648 |
| `b3c1473b…:20` | `b3c1473b-85bd-405b-90d0-917754d3da5f` | c1 | 1.9028 | 0.2980 | 1.6267 | 0.2760 | 0 |
| `a428492a…:23` | `a428492a-08f5-4d66-8da6-a307bcdaea62` | c1 | 1.5363 | 0.2406 | 1.5363 | 0 | 0 |

No interpretation offered; the viability call is the planning layer's.

---

## B6 — Provenance spot-check (run 1)

`r2-provenance.mjs` (Appendix C): for each of the 17 anchors' `top_events` (36 entries), locate
the source row and recompute `w_eff`.

- **weave_events entries (32):** `top_events` carry no row id (neither R1's shape nor the
  dispatch's §2.5 shape includes one), so each was located by `(event_type, target_id,
  timestamp)` where `target_id` = `edge_id` for edge-grain entries or `node:<anchor key>` for
  node-grain, and `timestamp = generated_at − age_days × 86 400 000 ms` matched within 2 ms
  against the RO export. **32/32 located.**
- **voice entries (4):** located by `voice_session_id`; `edge_id` equals the synthesized anchor
  target and `ended_at` matches within 2 ms. **4/4 located.** `user_turns` recomputed from
  `voice_utterances` (`speaker = 'user'`, B0d): **4/4 equal.**
- **`w_eff = w_rule × 2^(−age_days / H)`** with H by class: **36/36 within 1e-6** (all `w_rule = 1`
  under uniform weights).

```json
{ "anchors": 17, "top_events": 36, "source_row_found": 36, "w_eff_recomputed_within_1e6": 36,
  "voice_entries": 4, "user_turns_match": 4, "misses": [] }
```

---

## B3 / B4 — not executed

Stopped at the OQ14 stop condition (B1). Run 2 was not requested; no determinism diff exists.
The runbook command for B3 remains above for use if the planning layer clears it.

---

## 8. Contradicts the dispatch

- **"Their Reflect appearance is expected and accepted."** A stage-1 row cannot appear in Reflect:
  the client discards any snapshot with a null/blank `narrative`
  (`profileSnapshots.ts:53-57`), and stage 1 writes `narrative: null`. The UI observation the
  dispatch designates as the OQ14 verdict therefore reads "not visible" for every stage-1 run,
  whatever RLS does. The RLS question is still decidable from the UI, but by the *fixture's*
  presence or absence, or by the direct authenticated read above.
- **B6 "confirm each event exists … by id."** `top_events` entries for `weave_events` carry no row
  id (neither R1's shape nor §2.5's includes one); located instead by `(event_type, target_id,
  timestamp = generated_at − age_days)` within 2 ms — 32/32 found. Voice entries do carry
  `voice_session_id` — 4/4 found. A row id in provenance would make B6 exact; not added here.
- **"Anchors that fail the `_clientNodeId` hop must appear in `attribution.dropped`."** All 16
  anchors resolve to live endpoints today, so the clause has nothing to count; the mechanism
  (a failed hop ⇒ `absent` under `voice_session`) is in place but unexercised.
- **Pre-registered `absent` 16 → 29.** Not observable at the 70-day horizon (`absent` = 0); the
  dispatch anticipated the difference and asked for independence instead, which holds 27/27.
- **`nodes_found` expectation.** B0d first predicted 32 endpoint nodes; the read requests
  *distinct* uuids and anchors share endpoints, so the figure is 22. Corrected in B0d.

## 9. Query map

| id | measures | where |
|---|---|---|
| `P2`–`P5` | role, RLS visibility, QA marker, grants (as R0) | §0 |
| `B0a` | snapshot inventory | B0, B1 |
| `B0b` | 70-day attribution by type (SQL composite join); 5-type row count | B0 |
| `B0c` | pair set-difference per `(session_id, target_id)`, 70 d | B0 |
| `B0d` | qualifying voice sessions with anchor hop (`edges` → `nodes.data._clientNodeId`) | B0, B6 |
| `B0e` | live / total embeddings | B0 |
| `B1` | new-row check; `user_id` = uid; `parameters`; `node_set` vs live count | B1 |
| `R-view` | Reflect's ordering, policy-free; SELECT policies | B1 |
| script A | `r2-expected.ts` — real R1 modules over RO exports at a given `generated_at` | B0, B2 |
| script B | `r2-gates.mjs` — order-insensitive expected/observed table | B2 |
| script C | `r2-provenance.mjs` — locate every `top_events` row; recompute `w_eff`, `user_turns` | B6 |

## Appendix A — `r2-expected.ts` (throwaway; imports the real modules, not copies)

```ts
import { readFileSync } from 'node:fs'
import { BREADTH_HORIZON_DAYS, DEPTH_HORIZON_DAYS, MS_PER_DAY } from '<repo>/netlify/lib/snapshot/constants'
import { attribute, buildWeightMap, compositeKey, fromVoiceSession, fromWeaveEvent, pairAsymmetry, resolveEvents } from '<repo>/netlify/lib/snapshot/engagement'
import { EVENT_TYPES_READ } from '<repo>/netlify/lib/snapshot/reads'
const [S, atIso, uniformArg] = process.argv.slice(2)
const generatedAt = new Date(atIso); const uniform = uniformArg === 'true'
const events = JSON.parse(readFileSync(`${S}/r2-events.json`, 'utf8'))
const embeddings = JSON.parse(readFileSync(`${S}/r2-embeddings.json`, 'utf8'))
const voice = JSON.parse(readFileSync(`${S}/r2-voice.json`, 'utf8'))
const breadthFrom = new Date(generatedAt.getTime() - BREADTH_HORIZON_DAYS * MS_PER_DAY)
const depthFrom = new Date(generatedAt.getTime() - DEPTH_HORIZON_DAYS * MS_PER_DAY)
const windowEvents = events.filter((e) => EVENT_TYPES_READ.includes(e.event_type) && new Date(e.timestamp) >= breadthFrom)
const byType = {}; for (const e of windowEvents) byType[e.event_type] = (byType[e.event_type] ?? 0) + 1
const windowVoice = voice.filter((v) => new Date(v.ended_at) >= depthFrom)
const liveKeys = embeddings.filter((r) => r.archived_at === null).map(compositeKey)
const map = buildWeightMap(embeddings, liveKeys)
const engagementEvents = [...windowEvents.map(fromWeaveEvent), ...windowVoice.map((v) => fromVoiceSession({
  session_id: v.session_id, anchor_edge_id: v.anchor_edge_id, ended_at: v.ended_at,
  user_turns: Number(v.user_turns), anchor_target: v.anchor_target, board_id: v.board_id }))]
const { resolved, unmatchedByType, unresolvedByType } = resolveEvents(engagementEvents, { uniformWeights: uniform })
const out = attribute(resolved, map, generatedAt)
console.log(JSON.stringify({ generated_at: generatedAt.toISOString(), uniform_weights: uniform,
  breadth_from: breadthFrom.toISOString(), depth_from: depthFrom.toISOString(),
  events_read: { rows_expected: windowEvents.length, by_type: byType },
  voice_sessions: { rows_expected: windowVoice.length, user_turns: windowVoice.map((v) => [v.session_id.slice(0, 8), Number(v.user_turns)]) },
  node_set_count_live: liveKeys.length, embeddings_total: embeddings.length,
  attribution: out.attribution, pair_asymmetry: pairAsymmetry(windowEvents),
  events_unmatched_by_type: unmatchedByType, events_unresolved_by_type: unresolvedByType,
  max_raw_weight: Math.max(...Object.values(out.weights), 0) }, null, 1))
```

Bundled with `esbuild --bundle --platform=node --format=esm --alias:@supabase/supabase-js=<repo>/node_modules/@supabase/supabase-js`
from a checkout at the **deployed SHA** (see the B2 method incident).

## Appendix B — `r2-gates.mjs` and Appendix C — `r2-provenance.mjs`

Reproduced in the session record for this sitting; both are short joins over `run1-meta.json`,
the RO exports, and `r2-expected-run1.json`, with key-order-insensitive JSON comparison.
