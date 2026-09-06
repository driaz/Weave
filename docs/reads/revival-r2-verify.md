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
does not.

**Daniel ran (b) from his terminal, 2026-09-05 (local). Response, verbatim:**

```json
[{"id":"253c9a8c-5170-4461-86e0-e9c9fece9cbd","created_at":"2026-09-06T03:13:55.653969+00:00","trigger_reason":"r2_unweighted"},
 {"id":"204af847-fa26-4e61-a699-c059fc5cd9e4","created_at":"2026-04-17T22:52:00+00:00","trigger_reason":"fixture"}]
```

**Two rows, run 1 first ⇒ `weave_profile_snapshots_select_own` admits the pipeline-written row
to Daniel's authenticated session.** The §0 question — "does a pipeline-written snapshot become
visible to the user under RLS?" — is answered **yes**. The R1 fix path (service-role insert
carrying the verified caller's `user_id`) works as designed; the census-8 D1 hazard
(`user_id NULL` ⇒ invisible) is closed for v2 rows.

**Two verdicts, kept separate:**

| question | verdict | basis |
|---|---|---|
| OQ14 as worded in §0 (visible under RLS) | **visible** | direct authenticated read, two rows |
| OQ14 as observed in §3 B1 (visible in Reflect UI) | **not visible** | Reflect discards narrative-less rows (`profileSnapshots.ts:53-57`); a stage-1 row cannot render |

The §5 stop condition is worded on the UI observation. It was honoured: B3 was not run in this
sitting. Whether the RLS verdict clears B3 is recorded as the planning layer's decision, made by
Daniel as its hand; if cleared, the runbook command for run 2 is unchanged.
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

## B3 — Run 2 (pinned to run 1, page size 50)

**Clearance.** After the direct authenticated read established the RLS fact (B1), Daniel — as the
planning layer's hand — cleared B3 and ran it. The §5 stop had been honoured until that point.

Executed by Daniel at `2026-09-06 04:01:16 UTC` (47.4 min after run 1), body
`{"trigger_reason":"r2_unweighted","uniform_weights":true,"page_size":50,"pin_node_set_from_snapshot_id":"253c9a8c-5170-4461-86e0-e9c9fece9cbd"}`.
Response: `snapshot_id e7adade7-68ec-4090-8514-923d407dbf91`; summary, attribution and `events_read`
identical to run 1's except `breadth_from`/`depth_from` (shifted by the gap).

```sql
select count(*) from weave_profile_snapshots;                                    -- → 3
select id, created_at, trigger_reason, (user_id = '92fcfcc8-fac9-466f-be22-afdfa71b9102') as user_is_daniel, node_count, event_count,
       jsonb_array_length(clusters) as n_clusters, generation_metadata->>'generated_at', generation_metadata->'node_set'->>'source',
       (generation_metadata->'node_set'->>'count')::int, (generation_metadata->'parameters'->>'page_size')::int, generation_metadata->'timing_ms'
from weave_profile_snapshots where id = 'e7adade7-68ec-4090-8514-923d407dbf91';
-- → e7adade7… | 2026-09-06 04:01:20.533736+00 | r2_unweighted | t | 71 | 207 | 7 | 2026-09-06T04:01:16.521Z
--   | pinned:253c9a8c-5170-4461-86e0-e9c9fece9cbd | 71 | 50 | {"generate":151,"fetch_voice":731,"fetch_events":688,"fetch_embeddings":1665}
select (a.generation_metadata->'node_set'->'keys' = b.generation_metadata->'node_set'->'keys') as keys_identical_in_order,
       (select count(*) from jsonb_array_elements_text(a.generation_metadata->'node_set'->'keys') k
         where k not in (select jsonb_array_elements_text(b.generation_metadata->'node_set'->'keys'))) as run2_keys_not_in_run1
from weave_profile_snapshots a, weave_profile_snapshots b where a.id='e7adade7-…' and b.id='253c9a8c-…';
-- → t | 0
```

**Gates** (expected re-derived at run 2's `generated_at`, same method as B2):

| gate | expected | observed | match |
|---|---|---|---|
| events_read.breadth_from | "2026-06-28T04:01:16.521Z" | "2026-06-28T04:01:16.521Z" | MATCH |
| events_read.depth_from | "2026-02-08T04:01:16.521Z" | "2026-02-08T04:01:16.521Z" | MATCH |
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
| node_set.source | "pinned:253c9a8c-5170-4461-86e0-e9c9fece9cbd" | "pinned:253c9a8c-5170-4461-86e0-e9c9fece9cbd" | MATCH |
| node_set.count = RO live embeddings | 71 | 71 | MATCH |
| node_set.keys.length = node_set.count | 71 | 71 | MATCH |
| embeddings rows_returned = rows_expected = RO count | [101,101] | [101,101] | MATCH |
| events_unmatched_by_type | {"connection_label_clicked":65,"lightbox_opened":30} | {"connection_label_clicked":65,"lightbox_opened":30} | MATCH |
| max_raw_weight_before_normalization (1e-9) | 6375999008 | 6375999008 | MATCH |
| parameters.uniform_weights | true | true | MATCH |
| parameters.page_size | 50 | 50 | MATCH |
| parameters.{h_breadth_days,h_depth_days,k,anchor_count} | [14,42,5,3] | [14,42,5,3] | MATCH |
| parameters.voice_base (4dp) | 0.646 | 0.646 | MATCH |

**27/27 match.** Pinned-run additions: `node_set.source = pinned:253c9a8c…` ✅; `node_set.keys`
identical to run 1's, in order ✅; `parameters.page_size = 50` ✅.

**Pagination proof.** With `page_size = 50`, the 191-row events read was walked in **4 pages**
(50, 50, 50, 41), the 101-row embeddings read in 3 pages, and every `rows_returned` still equals
its `rows_expected` count(*) (191 = 191, 101 = 101, 16 = 16). The R1 pager terminates on a short
page and the count gate would have thrown on any truncation; neither the default page (run 1)
nor the small page (run 2) lost a row. Together with max-rows = 1000 (header), R0/F3 is closed.

**B6 for run 2:** 36/36 `top_events` located, `w_eff` recomputed within 1e-6 for 36/36,
`user_turns` 4/4 (same script as run 1).

---

## B4 — Determinism diff (run 1 vs run 2, identical node set)

```text
clusters run1 7 run2 7 | sizes run1 14,10,3,2,2,2,2 run2 14,10,3,2,2,2,2
set-of-sets identical: true | only in run1: 0 only in run2: 0
nodes clustered run1 35 run2 35 | same membership 35 | differing 0
cluster_id → members identical in order: true
anchor (cluster,key) sequences identical: true | run1 17 run2 17
anchor_node_ids per cluster identical: true
generated_at gap (min) 47.43 | max |Δw_total| over anchors 0.003725 max rel 0.001630 | expected breadth decay over gap 0.001630
w_total=0 anchors run1 ["c3:9","c4:2","c5:10","c6:4","c6:13"] run2 (identical)
engagement_weight per cluster run1 0.2353,0.1422,0.1581,0.062,0.0142,0,0.1174 run2 0.2352,0.1422,0.1581,0.062,0.0142,0,0.1173
```

| check | verdict |
|---|---|
| number of clusters | 7 = 7 ✅ |
| cluster assignments as set-of-sets | **identical** (0 clusters unique to either run) ✅ |
| per-node membership up to relabelling | 35/35 identical ✅ |
| `cluster_id` labelling and member order | identical (not required; observed) |
| anchors: keys and order per cluster | **identical**, 17 = 17 ✅ |
| `w_total` drift | max 0.0037 abs, 0.163% rel, exactly `1 − 2^(−47.4 min / 14 d)` = the breadth-clock decay over the gap; expected, not a determinism failure |
| anchor-boundary ties | **none possible**: the five `w_total = 0` anchors sit in clusters where every member is an anchor (c3 size 3 with 3 anchors; c4–c7 size 2 with 2 anchors), so no non-anchor member competes at a tie. c1 (14) and c2 (10) have positive-weight anchors with clear margins. |

**Verdict: deterministic.** Two back-to-back runs over the same 71-key node set produced
identical cluster assignments and identical anchors; only `w_eff` moved, by the amount decay
predicts. Census-8 D4 (index-order tie-breaks over an unordered select) did not manifest on this
data; the pinned read is ordered `(created_at, board_id, node_id)` in v2.

---

## 8. Contradicts the dispatch

- **B3 proceeded after the §5 UI stop.** The stop was honoured until the RLS fact was established by
  Daniel's direct authenticated read; Daniel then cleared B3 as the planning layer's hand. Both
  verdicts and the sequence are recorded in B1; nothing was routed around.
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

## Appendix D — Run 1 `generation_metadata` (`253c9a8c-5170-4461-86e0-e9c9fece9cbd`), in full

```json
{
 "anchors": [
  {
   "key": "b3c1473b-85bd-405b-90d0-917754d3da5f:20",
   "w_total": 1.9027694086422189,
   "board_id": "b3c1473b-85bd-405b-90d0-917754d3da5f",
   "by_class": {
    "depth": 0.27601967596775395,
    "breadth": 1.6267497326744649,
    "recency": 0
   },
   "cluster_id": "c1",
   "top_events": [
    {
     "class": "breadth",
     "w_eff": 0.903965006313307,
     "w_rule": 1,
     "edge_id": "connection:b3c1473b-85bd-405b-90d0-917754d3da5f:20:12",
     "age_days": 2.039256377314815,
     "event_type": "connection_description_closed"
    },
    {
     "class": "depth",
     "w_eff": 0.27601967596775395,
     "w_rule": 1,
     "edge_id": "connection:b3c1473b-85bd-405b-90d0-917754d3da5f:20:10",
     "age_days": 78.00059325231481,
     "event_type": "voice_session",
     "user_turns": 16,
     "voice_session_id": "2c18bad5-7a1d-45a6-bb4b-92891fe5c5be"
    },
    {
     "class": "breadth",
     "w_eff": 0.10326314410688918,
     "w_rule": 1,
     "edge_id": "connection:b3c1473b-85bd-405b-90d0-917754d3da5f:20:9",
     "age_days": 45.85843730324074,
     "event_type": "connection_description_closed"
    },
    {
     "class": "breadth",
     "w_eff": 0.10325564842695406,
     "w_rule": 1,
     "edge_id": "connection:b3c1473b-85bd-405b-90d0-917754d3da5f:20:12",
     "age_days": 45.85990347222222,
     "event_type": "connection_description_closed"
    },
    {
     "class": "breadth",
     "w_eff": 0.10325501939849227,
     "w_rule": 1,
     "edge_id": "connection:b3c1473b-85bd-405b-90d0-917754d3da5f:24:20",
     "age_days": 45.8600265162037,
     "event_type": "connection_description_closed"
    }
   ],
   "w_normalized": 0.2980168960582455
  },
  {
   "key": "a428492a-08f5-4d66-8da6-a307bcdaea62:23",
   "w_total": 1.5362630518555807,
   "board_id": "a428492a-08f5-4d66-8da6-a307bcdaea62",
   "by_class": {
    "depth": 0,
    "breadth": 1.5362630518555807,
    "recency": 0
   },
   "cluster_id": "c1",
   "top_events": [
    {
     "class": "breadth",
     "w_eff": 0.7380534450274224,
     "w_rule": 1,
     "edge_id": "connection:a428492a-08f5-4d66-8da6-a307bcdaea62:23:12",
     "age_days": 6.134839259259259,
     "event_type": "connection_description_closed"
    },
    {
     "class": "breadth",
     "w_eff": 0.631264158664676,
     "w_rule": 1,
     "age_days": 9.29157954861111,
     "event_type": "lightbox_closed"
    },
    {
     "class": "breadth",
     "w_eff": 0.055648770921093056,
     "w_rule": 1,
     "edge_id": "connection:a428492a-08f5-4d66-8da6-a307bcdaea62:25:23",
     "age_days": 58.34508912037037,
     "event_type": "connection_description_closed"
    },
    {
     "class": "breadth",
     "w_eff": 0.05564838280289387,
     "w_rule": 1,
     "edge_id": "connection:a428492a-08f5-4d66-8da6-a307bcdaea62:25:23",
     "age_days": 58.34522998842593,
     "event_type": "connection_description_closed"
    },
    {
     "class": "breadth",
     "w_eff": 0.05564829443949517,
     "w_rule": 1,
     "edge_id": "connection:a428492a-08f5-4d66-8da6-a307bcdaea62:25:23",
     "age_days": 58.345262060185185,
     "event_type": "connection_description_closed"
    }
   ],
   "w_normalized": 0.24061367823317503
  },
  {
   "key": "b3c1473b-85bd-405b-90d0-917754d3da5f:14",
   "w_total": 1.067172882473563,
   "board_id": "b3c1473b-85bd-405b-90d0-917754d3da5f",
   "by_class": {
    "depth": 0,
    "breadth": 1.067172882473563,
    "recency": 0
   },
   "cluster_id": "c1",
   "top_events": [
    {
     "class": "breadth",
     "w_eff": 0.9039622670985036,
     "w_rule": 1,
     "edge_id": "connection:b3c1473b-85bd-405b-90d0-917754d3da5f:24:14",
     "age_days": 2.0393175810185187,
     "event_type": "connection_description_closed"
    },
    {
     "class": "breadth",
     "w_eff": 0.10325968001584462,
     "w_rule": 1,
     "edge_id": "connection:b3c1473b-85bd-405b-90d0-917754d3da5f:24:14",
     "age_days": 45.85911487268518,
     "event_type": "connection_description_closed"
    },
    {
     "class": "breadth",
     "w_eff": 0.05995093535921463,
     "w_rule": 1,
     "edge_id": "connection:b3c1473b-85bd-405b-90d0-917754d3da5f:22:14",
     "age_days": 56.84103497685185,
     "event_type": "connection_description_closed"
    }
   ],
   "w_normalized": 0.16714350595916208
  },
  {
   "key": "a428492a-08f5-4d66-8da6-a307bcdaea62:37",
   "w_total": 1.1607764824938218,
   "board_id": "a428492a-08f5-4d66-8da6-a307bcdaea62",
   "by_class": {
    "depth": 0,
    "breadth": 0.8706232347494571,
    "recency": 0.2901532477443647
   },
   "cluster_id": "c2",
   "top_events": [
    {
     "class": "breadth",
     "w_eff": 0.29021049246957425,
     "w_rule": 1,
     "edge_id": "connection:a428492a-08f5-4d66-8da6-a307bcdaea62:37:33",
     "age_days": 24.987597800925926,
     "event_type": "connection_description_closed"
    },
    {
     "class": "breadth",
     "w_eff": 0.2902092189336442,
     "w_rule": 1,
     "edge_id": "connection:a428492a-08f5-4d66-8da6-a307bcdaea62:37:33",
     "age_days": 24.987686435185186,
     "event_type": "connection_description_closed"
    },
    {
     "class": "breadth",
     "w_eff": 0.29020352334623856,
     "w_rule": 1,
     "age_days": 24.988082835648147,
     "event_type": "lightbox_closed"
    },
    {
     "class": "recency",
     "w_eff": 0.2901532477443647,
     "w_rule": 1,
     "age_days": 24.99158224537037,
     "event_type": "item_added"
    }
   ],
   "w_normalized": 0.18180395520288878
  },
  {
   "key": "a428492a-08f5-4d66-8da6-a307bcdaea62:12",
   "w_total": 0.8248385558981086,
   "board_id": "a428492a-08f5-4d66-8da6-a307bcdaea62",
   "by_class": {
    "depth": 0,
    "breadth": 0.8248385558981086,
    "recency": 0
   },
   "cluster_id": "c2",
   "top_events": [
    {
     "class": "breadth",
     "w_eff": 0.7380534450274224,
     "w_rule": 1,
     "edge_id": "connection:a428492a-08f5-4d66-8da6-a307bcdaea62:23:12",
     "age_days": 6.134839259259259,
     "event_type": "connection_description_closed"
    },
    {
     "class": "breadth",
     "w_eff": 0.08678511087068624,
     "w_rule": 1,
     "edge_id": "connection:a428492a-08f5-4d66-8da6-a307bcdaea62:33:12",
     "age_days": 49.36972094907407,
     "event_type": "connection_description_closed"
    }
   ],
   "w_normalized": 0.1291884476707714
  },
  {
   "key": "a428492a-08f5-4d66-8da6-a307bcdaea62:27",
   "w_total": 0.7380558181078725,
   "board_id": "a428492a-08f5-4d66-8da6-a307bcdaea62",
   "by_class": {
    "depth": 0,
    "breadth": 0.7380558181078725,
    "recency": 0
   },
   "cluster_id": "c2",
   "top_events": [
    {
     "class": "breadth",
     "w_eff": 0.7380558181078725,
     "w_rule": 1,
     "edge_id": "connection:a428492a-08f5-4d66-8da6-a307bcdaea62:27:7",
     "age_days": 6.134774317129629,
     "event_type": "connection_description_closed"
    }
   ],
   "w_normalized": 0.11559630033530528
  },
  {
   "key": "a428492a-08f5-4d66-8da6-a307bcdaea62:39",
   "w_total": 2.8678517321653523,
   "board_id": "a428492a-08f5-4d66-8da6-a307bcdaea62",
   "by_class": {
    "depth": 0.8729712180763387,
    "breadth": 1.3301163605470734,
    "recency": 0.6647641535419401
   },
   "cluster_id": "c3",
   "top_events": [
    {
     "class": "depth",
     "w_eff": 0.8729712180763387,
     "w_rule": 1,
     "edge_id": "connection:a428492a-08f5-4d66-8da6-a307bcdaea62:39:35",
     "age_days": 8.231748252314814,
     "event_type": "voice_session",
     "user_turns": 14,
     "voice_session_id": "dd5f619b-0886-4efb-bc10-b222eced972e"
    },
    {
     "class": "breadth",
     "w_eff": 0.6652735837757848,
     "w_rule": 1,
     "edge_id": "connection:a428492a-08f5-4d66-8da6-a307bcdaea62:39:35",
     "age_days": 8.231724837962963,
     "event_type": "connection_description_closed"
    },
    {
     "class": "breadth",
     "w_eff": 0.6648427767712887,
     "w_rule": 1,
     "edge_id": "connection:a428492a-08f5-4d66-8da6-a307bcdaea62:39:35",
     "age_days": 8.244808391203703,
     "event_type": "connection_description_closed"
    },
    {
     "class": "recency",
     "w_eff": 0.6647641535419401,
     "w_rule": 1,
     "age_days": 8.247197083333333,
     "event_type": "item_added"
    }
   ],
   "w_normalized": 0.4491707022896992
  },
  {
   "key": "8a8d45a9-5327-4355-ae3c-c1fff734b327:6",
   "w_total": 0.15978576982649262,
   "board_id": "8a8d45a9-5327-4355-ae3c-c1fff734b327",
   "by_class": {
    "depth": 0.15978576982649262,
    "breadth": 0,
    "recency": 0
   },
   "cluster_id": "c3",
   "top_events": [
    {
     "class": "depth",
     "w_eff": 0.15978576982649262,
     "w_rule": 1,
     "edge_id": "connection:8a8d45a9-5327-4355-ae3c-c1fff734b327:21:6",
     "age_days": 111.12314489583333,
     "event_type": "voice_session",
     "user_turns": 2,
     "voice_session_id": "a2d72d70-789b-4836-b9f2-79831beb0a9f"
    }
   ],
   "w_normalized": 0.025026079850604982
  },
  {
   "key": "8a8d45a9-5327-4355-ae3c-c1fff734b327:9",
   "w_total": 0,
   "board_id": "8a8d45a9-5327-4355-ae3c-c1fff734b327",
   "by_class": {
    "depth": 0,
    "breadth": 0,
    "recency": 0
   },
   "cluster_id": "c3",
   "top_events": [],
   "w_normalized": 0
  },
  {
   "key": "a428492a-08f5-4d66-8da6-a307bcdaea62:8",
   "w_total": 0.7912503861514284,
   "board_id": "a428492a-08f5-4d66-8da6-a307bcdaea62",
   "by_class": {
    "depth": 0.159979039338744,
    "breadth": 0.6312713468126844,
    "recency": 0
   },
   "cluster_id": "c4",
   "top_events": [
    {
     "class": "breadth",
     "w_eff": 0.6312713468126844,
     "w_rule": 1,
     "age_days": 9.291349560185186,
     "event_type": "lightbox_closed"
    },
    {
     "class": "depth",
     "w_eff": 0.159979039338744,
     "w_rule": 1,
     "edge_id": "connection:a428492a-08f5-4d66-8da6-a307bcdaea62:8:3",
     "age_days": 111.04989844907408,
     "event_type": "voice_session",
     "user_turns": 3,
     "voice_session_id": "0dac35fb-3117-440f-914a-0b9d67622b1c"
    }
   ],
   "w_normalized": 0.12392777759339932
  },
  {
   "key": "fef6c2a3-7f77-436c-bf8f-8446fc65048b:2",
   "w_total": 0,
   "board_id": "fef6c2a3-7f77-436c-bf8f-8446fc65048b",
   "by_class": {
    "depth": 0,
    "breadth": 0,
    "recency": 0
   },
   "cluster_id": "c4",
   "top_events": [],
   "w_normalized": 0
  },
  {
   "key": "8a8d45a9-5327-4355-ae3c-c1fff734b327:15",
   "w_total": 0.18149630240497172,
   "board_id": "8a8d45a9-5327-4355-ae3c-c1fff734b327",
   "by_class": {
    "depth": 0,
    "breadth": 0.18149630240497172,
    "recency": 0
   },
   "cluster_id": "c5",
   "top_events": [
    {
     "class": "breadth",
     "w_eff": 0.18149630240497172,
     "w_rule": 1,
     "age_days": 34.46783113425926,
     "event_type": "lightbox_closed"
    }
   ],
   "w_normalized": 0.028426442238933848
  },
  {
   "key": "a428492a-08f5-4d66-8da6-a307bcdaea62:10",
   "w_total": 0,
   "board_id": "a428492a-08f5-4d66-8da6-a307bcdaea62",
   "by_class": {
    "depth": 0,
    "breadth": 0,
    "recency": 0
   },
   "cluster_id": "c5",
   "top_events": [],
   "w_normalized": 0
  },
  {
   "key": "fef6c2a3-7f77-436c-bf8f-8446fc65048b:4",
   "w_total": 0,
   "board_id": "fef6c2a3-7f77-436c-bf8f-8446fc65048b",
   "by_class": {
    "depth": 0,
    "breadth": 0,
    "recency": 0
   },
   "cluster_id": "c6",
   "top_events": [],
   "w_normalized": 0
  },
  {
   "key": "8a8d45a9-5327-4355-ae3c-c1fff734b327:13",
   "w_total": 0,
   "board_id": "8a8d45a9-5327-4355-ae3c-c1fff734b327",
   "by_class": {
    "depth": 0,
    "breadth": 0,
    "recency": 0
   },
   "cluster_id": "c6",
   "top_events": [],
   "w_normalized": 0
  },
  {
   "key": "2810ae3a-3701-4ebb-9c21-a5dd27027232:4",
   "w_total": 0.9545198611706353,
   "board_id": "2810ae3a-3701-4ebb-9c21-a5dd27027232",
   "by_class": {
    "depth": 0,
    "breadth": 0.9545198611706353,
    "recency": 0
   },
   "cluster_id": "c7",
   "top_events": [
    {
     "class": "breadth",
     "w_eff": 0.08678016305610063,
     "w_rule": 1,
     "edge_id": "connection:2810ae3a-3701-4ebb-9c21-a5dd27027232:2:4",
     "age_days": 49.3708725,
     "event_type": "connection_description_closed"
    },
    {
     "class": "breadth",
     "w_eff": 0.08677782868905222,
     "w_rule": 1,
     "edge_id": "connection:2810ae3a-3701-4ebb-9c21-a5dd27027232:2:4",
     "age_days": 49.37141582175926,
     "event_type": "connection_description_closed"
    },
    {
     "class": "breadth",
     "w_eff": 0.08677767567913665,
     "w_rule": 1,
     "edge_id": "connection:2810ae3a-3701-4ebb-9c21-a5dd27027232:2:4",
     "age_days": 49.371451435185186,
     "event_type": "connection_description_closed"
    },
    {
     "class": "breadth",
     "w_eff": 0.0867773399235174,
     "w_rule": 1,
     "edge_id": "connection:2810ae3a-3701-4ebb-9c21-a5dd27027232:2:4",
     "age_days": 49.371529583333334,
     "event_type": "connection_description_closed"
    },
    {
     "class": "breadth",
     "w_eff": 0.086774765011507,
     "w_rule": 1,
     "age_days": 49.372128912037034,
     "event_type": "lightbox_closed"
    }
   ],
   "w_normalized": 0.1494994847825558
  },
  {
   "key": "a428492a-08f5-4d66-8da6-a307bcdaea62:31",
   "w_total": 0.5443245032217409,
   "board_id": "a428492a-08f5-4d66-8da6-a307bcdaea62",
   "by_class": {
    "depth": 0,
    "breadth": 0.5443245032217409,
    "recency": 0
   },
   "cluster_id": "c7",
   "top_events": [
    {
     "class": "breadth",
     "w_eff": 0.18145026406739043,
     "w_rule": 1,
     "edge_id": "connection:a428492a-08f5-4d66-8da6-a307bcdaea62:35:31",
     "age_days": 34.47295513888889,
     "event_type": "connection_description_closed"
    },
    {
     "class": "breadth",
     "w_eff": 0.18144827757936177,
     "w_rule": 1,
     "age_days": 34.473176261574075,
     "event_type": "lightbox_closed"
    },
    {
     "class": "breadth",
     "w_eff": 0.1814259615749887,
     "w_rule": 1,
     "edge_id": "connection:a428492a-08f5-4d66-8da6-a307bcdaea62:35:31",
     "age_days": 34.47566049768518,
     "event_type": "connection_description_closed"
    }
   ],
   "w_normalized": 0.0852535773183075
  }
 ],
 "node_set": {
  "keys": [
   "a428492a-08f5-4d66-8da6-a307bcdaea62:2",
   "a428492a-08f5-4d66-8da6-a307bcdaea62:3",
   "a428492a-08f5-4d66-8da6-a307bcdaea62:4",
   "a428492a-08f5-4d66-8da6-a307bcdaea62:5",
   "a428492a-08f5-4d66-8da6-a307bcdaea62:6",
   "a428492a-08f5-4d66-8da6-a307bcdaea62:7",
   "a428492a-08f5-4d66-8da6-a307bcdaea62:8",
   "a428492a-08f5-4d66-8da6-a307bcdaea62:10",
   "8a8d45a9-5327-4355-ae3c-c1fff734b327:2",
   "8a8d45a9-5327-4355-ae3c-c1fff734b327:3",
   "8a8d45a9-5327-4355-ae3c-c1fff734b327:4",
   "8a8d45a9-5327-4355-ae3c-c1fff734b327:5",
   "8a8d45a9-5327-4355-ae3c-c1fff734b327:6",
   "8a8d45a9-5327-4355-ae3c-c1fff734b327:7",
   "8a8d45a9-5327-4355-ae3c-c1fff734b327:8",
   "8a8d45a9-5327-4355-ae3c-c1fff734b327:9",
   "b3c1473b-85bd-405b-90d0-917754d3da5f:3",
   "b3c1473b-85bd-405b-90d0-917754d3da5f:4",
   "b3c1473b-85bd-405b-90d0-917754d3da5f:6",
   "b3c1473b-85bd-405b-90d0-917754d3da5f:7",
   "b3c1473b-85bd-405b-90d0-917754d3da5f:8",
   "b3c1473b-85bd-405b-90d0-917754d3da5f:9",
   "b3c1473b-85bd-405b-90d0-917754d3da5f:10",
   "fef6c2a3-7f77-436c-bf8f-8446fc65048b:2",
   "fef6c2a3-7f77-436c-bf8f-8446fc65048b:3",
   "fef6c2a3-7f77-436c-bf8f-8446fc65048b:4",
   "fef6c2a3-7f77-436c-bf8f-8446fc65048b:6",
   "8a8d45a9-5327-4355-ae3c-c1fff734b327:11",
   "a428492a-08f5-4d66-8da6-a307bcdaea62:12",
   "a428492a-08f5-4d66-8da6-a307bcdaea62:14",
   "b3c1473b-85bd-405b-90d0-917754d3da5f:12",
   "8a8d45a9-5327-4355-ae3c-c1fff734b327:13",
   "a428492a-08f5-4d66-8da6-a307bcdaea62:16",
   "a428492a-08f5-4d66-8da6-a307bcdaea62:21",
   "a428492a-08f5-4d66-8da6-a307bcdaea62:23",
   "a428492a-08f5-4d66-8da6-a307bcdaea62:25",
   "a428492a-08f5-4d66-8da6-a307bcdaea62:27",
   "8a8d45a9-5327-4355-ae3c-c1fff734b327:15",
   "fef6c2a3-7f77-436c-bf8f-8446fc65048b:8",
   "04555951-8428-447f-8ac4-c19cab9af5bf:2",
   "2810ae3a-3701-4ebb-9c21-a5dd27027232:2",
   "fef6c2a3-7f77-436c-bf8f-8446fc65048b:10",
   "fef6c2a3-7f77-436c-bf8f-8446fc65048b:12",
   "a428492a-08f5-4d66-8da6-a307bcdaea62:29",
   "b3c1473b-85bd-405b-90d0-917754d3da5f:14",
   "8a8d45a9-5327-4355-ae3c-c1fff734b327:17",
   "2810ae3a-3701-4ebb-9c21-a5dd27027232:4",
   "a428492a-08f5-4d66-8da6-a307bcdaea62:31",
   "2810ae3a-3701-4ebb-9c21-a5dd27027232:6",
   "8a8d45a9-5327-4355-ae3c-c1fff734b327:19",
   "b3c1473b-85bd-405b-90d0-917754d3da5f:16",
   "8a8d45a9-5327-4355-ae3c-c1fff734b327:21",
   "8a8d45a9-5327-4355-ae3c-c1fff734b327:23",
   "a358f35c-dc41-4df2-a942-1f35f527f2d9:2",
   "a358f35c-dc41-4df2-a942-1f35f527f2d9:3",
   "8a8d45a9-5327-4355-ae3c-c1fff734b327:25",
   "a358f35c-dc41-4df2-a942-1f35f527f2d9:5",
   "b3c1473b-85bd-405b-90d0-917754d3da5f:18",
   "8a8d45a9-5327-4355-ae3c-c1fff734b327:27",
   "8a8d45a9-5327-4355-ae3c-c1fff734b327:29",
   "8a8d45a9-5327-4355-ae3c-c1fff734b327:31",
   "a428492a-08f5-4d66-8da6-a307bcdaea62:33",
   "b3c1473b-85bd-405b-90d0-917754d3da5f:20",
   "b3c1473b-85bd-405b-90d0-917754d3da5f:22",
   "b3c1473b-85bd-405b-90d0-917754d3da5f:24",
   "8a8d45a9-5327-4355-ae3c-c1fff734b327:37",
   "a428492a-08f5-4d66-8da6-a307bcdaea62:35",
   "8a8d45a9-5327-4355-ae3c-c1fff734b327:39",
   "a428492a-08f5-4d66-8da6-a307bcdaea62:37",
   "04c9c895-82cd-4e08-ad20-a5fc6eea12b6:2",
   "a428492a-08f5-4d66-8da6-a307bcdaea62:39"
  ],
  "count": 71,
  "source": "live"
 },
 "timing_ms": {
  "generate": 158,
  "fetch_voice": 1547,
  "fetch_events": 494,
  "fetch_embeddings": 2663
 },
 "parameters": {
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
 },
 "attribution": {
  "hit": 178,
  "by_type": {
   "item_added": {
    "hit": 8,
    "absent": 0,
    "archived": 2,
    "resolved": 10
   },
   "voice_session": {
    "hit": 32,
    "absent": 0,
    "archived": 0,
    "resolved": 32
   },
   "lightbox_closed": {
    "hit": 25,
    "absent": 0,
    "archived": 3,
    "resolved": 28
   },
   "connection_description_closed": {
    "hit": 113,
    "absent": 0,
    "archived": 3,
    "resolved": 116
   }
  },
  "dropped": {
   "absent": 0,
   "archived": 8
  },
  "resolved": 186,
  "zero_weight_events": 0
 },
 "events_read": {
  "by_type": {
   "item_added": 10,
   "lightbox_closed": 28,
   "lightbox_opened": 30,
   "connection_label_clicked": 65,
   "connection_description_closed": 58
  },
  "depth_from": "2026-02-08T03:13:50.574Z",
  "embeddings": {
   "rows_expected": 101,
   "rows_returned": 101
  },
  "breadth_from": "2026-06-28T03:13:50.574Z",
  "rows_expected": 191,
  "rows_returned": 191,
  "voice_sessions": {
   "anchors": {
    "edges_found": 16,
    "nodes_found": 22,
    "edges_requested": 16,
    "nodes_requested": 22
   },
   "rows_expected": 16,
   "rows_returned": 16
  }
 },
 "generated_at": "2026-09-06T03:13:50.574Z",
 "pair_asymmetry": {
  "lightbox": {
   "opens": 30,
   "closes": 28,
   "paired": 28,
   "orphan_opens": 2,
   "unmatched_closes": 0
  },
  "connection": {
   "opens": 65,
   "closes": 58,
   "paired": 58,
   "orphan_opens": 7,
   "unmatched_closes": 0
  }
 },
 "total_clusters": 7,
 "pipeline_version": "v2",
 "singletons_dropped": 36,
 "events_unmatched_by_type": {
  "lightbox_opened": 30,
  "connection_label_clicked": 65
 },
 "events_unresolved_by_type": {},
 "nodes_excluded_no_embedding": 0,
 "max_raw_weight_before_normalization": 6.3847702389005985
}
```

## Appendix E — Run 1 `clusters`, in full

```json
[
 {
  "size": 14,
  "cluster_id": "c1",
  "boards_touched": [
   "8a8d45a9-5327-4355-ae3c-c1fff734b327",
   "b3c1473b-85bd-405b-90d0-917754d3da5f",
   "fef6c2a3-7f77-436c-bf8f-8446fc65048b",
   "a428492a-08f5-4d66-8da6-a307bcdaea62"
  ],
  "anchor_node_ids": [
   "b3c1473b-85bd-405b-90d0-917754d3da5f:20",
   "a428492a-08f5-4d66-8da6-a307bcdaea62:23",
   "b3c1473b-85bd-405b-90d0-917754d3da5f:14"
  ],
  "member_node_ids": [
   "8a8d45a9-5327-4355-ae3c-c1fff734b327:3",
   "8a8d45a9-5327-4355-ae3c-c1fff734b327:4",
   "b3c1473b-85bd-405b-90d0-917754d3da5f:7",
   "b3c1473b-85bd-405b-90d0-917754d3da5f:3",
   "b3c1473b-85bd-405b-90d0-917754d3da5f:6",
   "b3c1473b-85bd-405b-90d0-917754d3da5f:10",
   "b3c1473b-85bd-405b-90d0-917754d3da5f:14",
   "fef6c2a3-7f77-436c-bf8f-8446fc65048b:3",
   "fef6c2a3-7f77-436c-bf8f-8446fc65048b:6",
   "b3c1473b-85bd-405b-90d0-917754d3da5f:12",
   "a428492a-08f5-4d66-8da6-a307bcdaea62:23",
   "b3c1473b-85bd-405b-90d0-917754d3da5f:16",
   "b3c1473b-85bd-405b-90d0-917754d3da5f:20",
   "b3c1473b-85bd-405b-90d0-917754d3da5f:22"
  ],
  "engagement_weight": 0.2353,
  "theme_description": ""
 },
 {
  "size": 10,
  "cluster_id": "c2",
  "boards_touched": [
   "a428492a-08f5-4d66-8da6-a307bcdaea62",
   "8a8d45a9-5327-4355-ae3c-c1fff734b327",
   "2810ae3a-3701-4ebb-9c21-a5dd27027232"
  ],
  "anchor_node_ids": [
   "a428492a-08f5-4d66-8da6-a307bcdaea62:37",
   "a428492a-08f5-4d66-8da6-a307bcdaea62:12",
   "a428492a-08f5-4d66-8da6-a307bcdaea62:27"
  ],
  "member_node_ids": [
   "a428492a-08f5-4d66-8da6-a307bcdaea62:4",
   "a428492a-08f5-4d66-8da6-a307bcdaea62:29",
   "8a8d45a9-5327-4355-ae3c-c1fff734b327:19",
   "2810ae3a-3701-4ebb-9c21-a5dd27027232:6",
   "a428492a-08f5-4d66-8da6-a307bcdaea62:5",
   "a428492a-08f5-4d66-8da6-a307bcdaea62:27",
   "a428492a-08f5-4d66-8da6-a307bcdaea62:37",
   "8a8d45a9-5327-4355-ae3c-c1fff734b327:27",
   "8a8d45a9-5327-4355-ae3c-c1fff734b327:29",
   "a428492a-08f5-4d66-8da6-a307bcdaea62:12"
  ],
  "engagement_weight": 0.1422,
  "theme_description": ""
 },
 {
  "size": 3,
  "cluster_id": "c3",
  "boards_touched": [
   "8a8d45a9-5327-4355-ae3c-c1fff734b327",
   "a428492a-08f5-4d66-8da6-a307bcdaea62"
  ],
  "anchor_node_ids": [
   "a428492a-08f5-4d66-8da6-a307bcdaea62:39",
   "8a8d45a9-5327-4355-ae3c-c1fff734b327:6",
   "8a8d45a9-5327-4355-ae3c-c1fff734b327:9"
  ],
  "member_node_ids": [
   "8a8d45a9-5327-4355-ae3c-c1fff734b327:6",
   "8a8d45a9-5327-4355-ae3c-c1fff734b327:9",
   "a428492a-08f5-4d66-8da6-a307bcdaea62:39"
  ],
  "engagement_weight": 0.1581,
  "theme_description": ""
 },
 {
  "size": 2,
  "cluster_id": "c4",
  "boards_touched": [
   "a428492a-08f5-4d66-8da6-a307bcdaea62",
   "fef6c2a3-7f77-436c-bf8f-8446fc65048b"
  ],
  "anchor_node_ids": [
   "a428492a-08f5-4d66-8da6-a307bcdaea62:8",
   "fef6c2a3-7f77-436c-bf8f-8446fc65048b:2"
  ],
  "member_node_ids": [
   "a428492a-08f5-4d66-8da6-a307bcdaea62:8",
   "fef6c2a3-7f77-436c-bf8f-8446fc65048b:2"
  ],
  "engagement_weight": 0.062,
  "theme_description": ""
 },
 {
  "size": 2,
  "cluster_id": "c5",
  "boards_touched": [
   "a428492a-08f5-4d66-8da6-a307bcdaea62",
   "8a8d45a9-5327-4355-ae3c-c1fff734b327"
  ],
  "anchor_node_ids": [
   "8a8d45a9-5327-4355-ae3c-c1fff734b327:15",
   "a428492a-08f5-4d66-8da6-a307bcdaea62:10"
  ],
  "member_node_ids": [
   "a428492a-08f5-4d66-8da6-a307bcdaea62:10",
   "8a8d45a9-5327-4355-ae3c-c1fff734b327:15"
  ],
  "engagement_weight": 0.0142,
  "theme_description": ""
 },
 {
  "size": 2,
  "cluster_id": "c6",
  "boards_touched": [
   "fef6c2a3-7f77-436c-bf8f-8446fc65048b",
   "8a8d45a9-5327-4355-ae3c-c1fff734b327"
  ],
  "anchor_node_ids": [
   "fef6c2a3-7f77-436c-bf8f-8446fc65048b:4",
   "8a8d45a9-5327-4355-ae3c-c1fff734b327:13"
  ],
  "member_node_ids": [
   "fef6c2a3-7f77-436c-bf8f-8446fc65048b:4",
   "8a8d45a9-5327-4355-ae3c-c1fff734b327:13"
  ],
  "engagement_weight": 0,
  "theme_description": ""
 },
 {
  "size": 2,
  "cluster_id": "c7",
  "boards_touched": [
   "2810ae3a-3701-4ebb-9c21-a5dd27027232",
   "a428492a-08f5-4d66-8da6-a307bcdaea62"
  ],
  "anchor_node_ids": [
   "2810ae3a-3701-4ebb-9c21-a5dd27027232:4",
   "a428492a-08f5-4d66-8da6-a307bcdaea62:31"
  ],
  "member_node_ids": [
   "2810ae3a-3701-4ebb-9c21-a5dd27027232:4",
   "a428492a-08f5-4d66-8da6-a307bcdaea62:31"
  ],
  "engagement_weight": 0.1174,
  "theme_description": ""
 }
]
```

## Appendix F — Run 2 `generation_metadata` (`e7adade7-68ec-4090-8514-923d407dbf91`), in full

```json
{
 "anchors": [
  {
   "key": "b3c1473b-85bd-405b-90d0-917754d3da5f:20",
   "w_total": 1.8999686005850889,
   "board_id": "b3c1473b-85bd-405b-90d0-917754d3da5f",
   "by_class": {
    "depth": 0.27586966906666843,
    "breadth": 1.6240989315184204,
    "recency": 0
   },
   "cluster_id": "c1",
   "top_events": [
    {
     "class": "breadth",
     "w_eff": 0.9024919884079532,
     "w_rule": 1,
     "edge_id": "connection:b3c1473b-85bd-405b-90d0-917754d3da5f:20:12",
     "age_days": 2.072195578703704,
     "event_type": "connection_description_closed"
    },
    {
     "class": "depth",
     "w_eff": 0.27586966906666843,
     "w_rule": 1,
     "edge_id": "connection:b3c1473b-85bd-405b-90d0-917754d3da5f:20:10",
     "age_days": 78.0335324537037,
     "event_type": "voice_session",
     "user_turns": 16,
     "voice_session_id": "2c18bad5-7a1d-45a6-bb4b-92891fe5c5be"
    },
    {
     "class": "breadth",
     "w_eff": 0.10309487602220643,
     "w_rule": 1,
     "edge_id": "connection:b3c1473b-85bd-405b-90d0-917754d3da5f:20:9",
     "age_days": 45.891376504629626,
     "event_type": "connection_description_closed"
    },
    {
     "class": "breadth",
     "w_eff": 0.10308739255653919,
     "w_rule": 1,
     "edge_id": "connection:b3c1473b-85bd-405b-90d0-917754d3da5f:20:12",
     "age_days": 45.89284267361111,
     "event_type": "connection_description_closed"
    },
    {
     "class": "breadth",
     "w_eff": 0.1030867645530841,
     "w_rule": 1,
     "edge_id": "connection:b3c1473b-85bd-405b-90d0-917754d3da5f:24:20",
     "age_days": 45.892965717592595,
     "event_type": "connection_description_closed"
    }
   ],
   "w_normalized": 0.2979875935264109
  },
  {
   "key": "a428492a-08f5-4d66-8da6-a307bcdaea62:23",
   "w_total": 1.5337596994393783,
   "board_id": "a428492a-08f5-4d66-8da6-a307bcdaea62",
   "by_class": {
    "depth": 0,
    "breadth": 1.5337596994393783,
    "recency": 0
   },
   "cluster_id": "c1",
   "top_events": [
    {
     "class": "breadth",
     "w_eff": 0.7368507812826528,
     "w_rule": 1,
     "edge_id": "connection:a428492a-08f5-4d66-8da6-a307bcdaea62:23:12",
     "age_days": 6.167778460648148,
     "event_type": "connection_description_closed"
    },
    {
     "class": "breadth",
     "w_eff": 0.6302355088804178,
     "w_rule": 1,
     "age_days": 9.32451875,
     "event_type": "lightbox_closed"
    },
    {
     "class": "breadth",
     "w_eff": 0.055558090822410894,
     "w_rule": 1,
     "edge_id": "connection:a428492a-08f5-4d66-8da6-a307bcdaea62:25:23",
     "age_days": 58.37802832175926,
     "event_type": "connection_description_closed"
    },
    {
     "class": "breadth",
     "w_eff": 0.055557703336653295,
     "w_rule": 1,
     "edge_id": "connection:a428492a-08f5-4d66-8da6-a307bcdaea62:25:23",
     "age_days": 58.37816918981481,
     "event_type": "connection_description_closed"
    },
    {
     "class": "breadth",
     "w_eff": 0.05555761511724343,
     "w_rule": 1,
     "edge_id": "connection:a428492a-08f5-4d66-8da6-a307bcdaea62:25:23",
     "age_days": 58.37820126157408,
     "event_type": "connection_description_closed"
    }
   ],
   "w_normalized": 0.24055206056720477
  },
  {
   "key": "b3c1473b-85bd-405b-90d0-917754d3da5f:14",
   "w_total": 1.0654339160832569,
   "board_id": "b3c1473b-85bd-405b-90d0-917754d3da5f",
   "by_class": {
    "depth": 0,
    "breadth": 1.0654339160832569,
    "recency": 0
   },
   "cluster_id": "c1",
   "top_events": [
    {
     "class": "breadth",
     "w_eff": 0.9024892536567213,
     "w_rule": 1,
     "edge_id": "connection:b3c1473b-85bd-405b-90d0-917754d3da5f:24:14",
     "age_days": 2.0722567824074076,
     "event_type": "connection_description_closed"
    },
    {
     "class": "breadth",
     "w_eff": 0.10309141757592474,
     "w_rule": 1,
     "edge_id": "connection:b3c1473b-85bd-405b-90d0-917754d3da5f:24:14",
     "age_days": 45.892054074074075,
     "event_type": "connection_description_closed"
    },
    {
     "class": "breadth",
     "w_eff": 0.05985324485061076,
     "w_rule": 1,
     "edge_id": "connection:b3c1473b-85bd-405b-90d0-917754d3da5f:22:14",
     "age_days": 56.87397417824074,
     "event_type": "connection_description_closed"
    }
   ],
   "w_normalized": 0.1671007029365122
  },
  {
   "key": "a428492a-08f5-4d66-8da6-a307bcdaea62:37",
   "w_total": 1.1588849883199484,
   "board_id": "a428492a-08f5-4d66-8da6-a307bcdaea62",
   "by_class": {
    "depth": 0,
    "breadth": 0.8692045475163823,
    "recency": 0.2896804408035661
   },
   "cluster_id": "c2",
   "top_events": [
    {
     "class": "breadth",
     "w_eff": 0.28973759224805723,
     "w_rule": 1,
     "edge_id": "connection:a428492a-08f5-4d66-8da6-a307bcdaea62:37:33",
     "age_days": 25.020537002314814,
     "event_type": "connection_description_closed"
    },
    {
     "class": "breadth",
     "w_eff": 0.28973632078736367,
     "w_rule": 1,
     "edge_id": "connection:a428492a-08f5-4d66-8da6-a307bcdaea62:37:33",
     "age_days": 25.020625636574074,
     "event_type": "connection_description_closed"
    },
    {
     "class": "breadth",
     "w_eff": 0.28973063448096137,
     "w_rule": 1,
     "age_days": 25.02102203703704,
     "event_type": "lightbox_closed"
    },
    {
     "class": "recency",
     "w_eff": 0.2896804408035661,
     "w_rule": 1,
     "age_days": 25.02452144675926,
     "event_type": "item_added"
    }
   ],
   "w_normalized": 0.18175739785225922
  },
  {
   "key": "a428492a-08f5-4d66-8da6-a307bcdaea62:12",
   "w_total": 0.8234944751500947,
   "board_id": "a428492a-08f5-4d66-8da6-a307bcdaea62",
   "by_class": {
    "depth": 0,
    "breadth": 0.8234944751500947,
    "recency": 0
   },
   "cluster_id": "c2",
   "top_events": [
    {
     "class": "breadth",
     "w_eff": 0.7368507812826528,
     "w_rule": 1,
     "edge_id": "connection:a428492a-08f5-4d66-8da6-a307bcdaea62:23:12",
     "age_days": 6.167778460648148,
     "event_type": "connection_description_closed"
    },
    {
     "class": "breadth",
     "w_eff": 0.08664369386744183,
     "w_rule": 1,
     "edge_id": "connection:a428492a-08f5-4d66-8da6-a307bcdaea62:33:12",
     "age_days": 49.402660150462964,
     "event_type": "connection_description_closed"
    }
   ],
   "w_normalized": 0.12915536438691888
  },
  {
   "key": "a428492a-08f5-4d66-8da6-a307bcdaea62:27",
   "w_total": 0.7368531504961501,
   "board_id": "a428492a-08f5-4d66-8da6-a307bcdaea62",
   "by_class": {
    "depth": 0,
    "breadth": 0.7368531504961501,
    "recency": 0
   },
   "cluster_id": "c2",
   "top_events": [
    {
     "class": "breadth",
     "w_eff": 0.7368531504961501,
     "w_rule": 1,
     "edge_id": "connection:a428492a-08f5-4d66-8da6-a307bcdaea62:27:7",
     "age_days": 6.167713518518519,
     "event_type": "connection_description_closed"
    }
   ],
   "w_normalized": 0.11556669780284014
  },
  {
   "key": "a428492a-08f5-4d66-8da6-a307bcdaea62:39",
   "w_total": 2.864126630194618,
   "board_id": "a428492a-08f5-4d66-8da6-a307bcdaea62",
   "by_class": {
    "depth": 0.8724967891911466,
    "breadth": 1.3279489257441703,
    "recency": 0.6636809152593011
   },
   "cluster_id": "c3",
   "top_events": [
    {
     "class": "depth",
     "w_eff": 0.8724967891911466,
     "w_rule": 1,
     "edge_id": "connection:a428492a-08f5-4d66-8da6-a307bcdaea62:39:35",
     "age_days": 8.264687453703704,
     "event_type": "voice_session",
     "user_turns": 14,
     "voice_session_id": "dd5f619b-0886-4efb-bc10-b222eced972e"
    },
    {
     "class": "breadth",
     "w_eff": 0.6641895153726757,
     "w_rule": 1,
     "edge_id": "connection:a428492a-08f5-4d66-8da6-a307bcdaea62:39:35",
     "age_days": 8.264664039351851,
     "event_type": "connection_description_closed"
    },
    {
     "class": "breadth",
     "w_eff": 0.6637594103714948,
     "w_rule": 1,
     "edge_id": "connection:a428492a-08f5-4d66-8da6-a307bcdaea62:39:35",
     "age_days": 8.277747592592593,
     "event_type": "connection_description_closed"
    },
    {
     "class": "recency",
     "w_eff": 0.6636809152593011,
     "w_rule": 1,
     "age_days": 8.280136284722222,
     "event_type": "item_added"
    }
   ],
   "w_normalized": 0.4492043720216104
  },
  {
   "key": "8a8d45a9-5327-4355-ae3c-c1fff734b327:6",
   "w_total": 0.1596989319295739,
   "board_id": "8a8d45a9-5327-4355-ae3c-c1fff734b327",
   "by_class": {
    "depth": 0.1596989319295739,
    "breadth": 0,
    "recency": 0
   },
   "cluster_id": "c3",
   "top_events": [
    {
     "class": "depth",
     "w_eff": 0.1596989319295739,
     "w_rule": 1,
     "edge_id": "connection:8a8d45a9-5327-4355-ae3c-c1fff734b327:21:6",
     "age_days": 111.15608409722222,
     "event_type": "voice_session",
     "user_turns": 2,
     "voice_session_id": "a2d72d70-789b-4836-b9f2-79831beb0a9f"
    }
   ],
   "w_normalized": 0.025046887827397345
  },
  {
   "key": "8a8d45a9-5327-4355-ae3c-c1fff734b327:9",
   "w_total": 0,
   "board_id": "8a8d45a9-5327-4355-ae3c-c1fff734b327",
   "by_class": {
    "depth": 0,
    "breadth": 0,
    "recency": 0
   },
   "cluster_id": "c3",
   "top_events": [],
   "w_normalized": 0
  },
  {
   "key": "a428492a-08f5-4d66-8da6-a307bcdaea62:8",
   "w_total": 0.7901347817219861,
   "board_id": "a428492a-08f5-4d66-8da6-a307bcdaea62",
   "by_class": {
    "depth": 0.15989209640670232,
    "breadth": 0.6302426853152838,
    "recency": 0
   },
   "cluster_id": "c4",
   "top_events": [
    {
     "class": "breadth",
     "w_eff": 0.6302426853152838,
     "w_rule": 1,
     "age_days": 9.324288761574074,
     "event_type": "lightbox_closed"
    },
    {
     "class": "depth",
     "w_eff": 0.15989209640670232,
     "w_rule": 1,
     "edge_id": "connection:a428492a-08f5-4d66-8da6-a307bcdaea62:8:3",
     "age_days": 111.08283765046296,
     "event_type": "voice_session",
     "user_turns": 3,
     "voice_session_id": "0dac35fb-3117-440f-914a-0b9d67622b1c"
    }
   ],
   "w_normalized": 0.12392329120299381
  },
  {
   "key": "fef6c2a3-7f77-436c-bf8f-8446fc65048b:2",
   "w_total": 0,
   "board_id": "fef6c2a3-7f77-436c-bf8f-8446fc65048b",
   "by_class": {
    "depth": 0,
    "breadth": 0,
    "recency": 0
   },
   "cluster_id": "c4",
   "top_events": [],
   "w_normalized": 0
  },
  {
   "key": "8a8d45a9-5327-4355-ae3c-c1fff734b327:15",
   "w_total": 0.1812005527892998,
   "board_id": "8a8d45a9-5327-4355-ae3c-c1fff734b327",
   "by_class": {
    "depth": 0,
    "breadth": 0.1812005527892998,
    "recency": 0
   },
   "cluster_id": "c5",
   "top_events": [
    {
     "class": "breadth",
     "w_eff": 0.1812005527892998,
     "w_rule": 1,
     "age_days": 34.50077033564815,
     "event_type": "lightbox_closed"
    }
   ],
   "w_normalized": 0.028419162640219996
  },
  {
   "key": "a428492a-08f5-4d66-8da6-a307bcdaea62:10",
   "w_total": 0,
   "board_id": "a428492a-08f5-4d66-8da6-a307bcdaea62",
   "by_class": {
    "depth": 0,
    "breadth": 0,
    "recency": 0
   },
   "cluster_id": "c5",
   "top_events": [],
   "w_normalized": 0
  },
  {
   "key": "fef6c2a3-7f77-436c-bf8f-8446fc65048b:4",
   "w_total": 0,
   "board_id": "fef6c2a3-7f77-436c-bf8f-8446fc65048b",
   "by_class": {
    "depth": 0,
    "breadth": 0,
    "recency": 0
   },
   "cluster_id": "c6",
   "top_events": [],
   "w_normalized": 0
  },
  {
   "key": "8a8d45a9-5327-4355-ae3c-c1fff734b327:13",
   "w_total": 0,
   "board_id": "8a8d45a9-5327-4355-ae3c-c1fff734b327",
   "by_class": {
    "depth": 0,
    "breadth": 0,
    "recency": 0
   },
   "cluster_id": "c6",
   "top_events": [],
   "w_normalized": 0
  },
  {
   "key": "2810ae3a-3701-4ebb-9c21-a5dd27027232:4",
   "w_total": 0.9529644637418624,
   "board_id": "2810ae3a-3701-4ebb-9c21-a5dd27027232",
   "by_class": {
    "depth": 0,
    "breadth": 0.9529644637418624,
    "recency": 0
   },
   "cluster_id": "c7",
   "top_events": [
    {
     "class": "breadth",
     "w_eff": 0.086638754115358,
     "w_rule": 1,
     "edge_id": "connection:2810ae3a-3701-4ebb-9c21-a5dd27027232:2:4",
     "age_days": 49.40381170138889,
     "event_type": "connection_description_closed"
    },
    {
     "class": "breadth",
     "w_eff": 0.08663642355217857,
     "w_rule": 1,
     "edge_id": "connection:2810ae3a-3701-4ebb-9c21-a5dd27027232:2:4",
     "age_days": 49.40435502314815,
     "event_type": "connection_description_closed"
    },
    {
     "class": "breadth",
     "w_eff": 0.08663627079159386,
     "w_rule": 1,
     "edge_id": "connection:2810ae3a-3701-4ebb-9c21-a5dd27027232:2:4",
     "age_days": 49.40439063657407,
     "event_type": "connection_description_closed"
    },
    {
     "class": "breadth",
     "w_eff": 0.08663593558309096,
     "w_rule": 1,
     "edge_id": "connection:2810ae3a-3701-4ebb-9c21-a5dd27027232:2:4",
     "age_days": 49.40446878472222,
     "event_type": "connection_description_closed"
    },
    {
     "class": "breadth",
     "w_eff": 0.08663336486691939,
     "w_rule": 1,
     "age_days": 49.405068113425926,
     "event_type": "lightbox_closed"
    }
   ],
   "w_normalized": 0.14946120013729497
  },
  {
   "key": "a428492a-08f5-4d66-8da6-a307bcdaea62:31",
   "w_total": 0.543437522272292,
   "board_id": "a428492a-08f5-4d66-8da6-a307bcdaea62",
   "by_class": {
    "depth": 0,
    "breadth": 0.543437522272292,
    "recency": 0
   },
   "cluster_id": "c7",
   "top_events": [
    {
     "class": "breadth",
     "w_eff": 0.18115458947154245,
     "w_rule": 1,
     "edge_id": "connection:a428492a-08f5-4d66-8da6-a307bcdaea62:35:31",
     "age_days": 34.50589434027778,
     "event_type": "connection_description_closed"
    },
    {
     "class": "breadth",
     "w_eff": 0.18115260622051124,
     "w_rule": 1,
     "age_days": 34.50611546296296,
     "event_type": "lightbox_closed"
    },
    {
     "class": "breadth",
     "w_eff": 0.18113032658023828,
     "w_rule": 1,
     "edge_id": "connection:a428492a-08f5-4d66-8da6-a307bcdaea62:35:31",
     "age_days": 34.508599699074075,
     "event_type": "connection_description_closed"
    }
   ],
   "w_normalized": 0.08523174511621269
  }
 ],
 "node_set": {
  "keys": [
   "a428492a-08f5-4d66-8da6-a307bcdaea62:2",
   "a428492a-08f5-4d66-8da6-a307bcdaea62:3",
   "a428492a-08f5-4d66-8da6-a307bcdaea62:4",
   "a428492a-08f5-4d66-8da6-a307bcdaea62:5",
   "a428492a-08f5-4d66-8da6-a307bcdaea62:6",
   "a428492a-08f5-4d66-8da6-a307bcdaea62:7",
   "a428492a-08f5-4d66-8da6-a307bcdaea62:8",
   "a428492a-08f5-4d66-8da6-a307bcdaea62:10",
   "8a8d45a9-5327-4355-ae3c-c1fff734b327:2",
   "8a8d45a9-5327-4355-ae3c-c1fff734b327:3",
   "8a8d45a9-5327-4355-ae3c-c1fff734b327:4",
   "8a8d45a9-5327-4355-ae3c-c1fff734b327:5",
   "8a8d45a9-5327-4355-ae3c-c1fff734b327:6",
   "8a8d45a9-5327-4355-ae3c-c1fff734b327:7",
   "8a8d45a9-5327-4355-ae3c-c1fff734b327:8",
   "8a8d45a9-5327-4355-ae3c-c1fff734b327:9",
   "b3c1473b-85bd-405b-90d0-917754d3da5f:3",
   "b3c1473b-85bd-405b-90d0-917754d3da5f:4",
   "b3c1473b-85bd-405b-90d0-917754d3da5f:6",
   "b3c1473b-85bd-405b-90d0-917754d3da5f:7",
   "b3c1473b-85bd-405b-90d0-917754d3da5f:8",
   "b3c1473b-85bd-405b-90d0-917754d3da5f:9",
   "b3c1473b-85bd-405b-90d0-917754d3da5f:10",
   "fef6c2a3-7f77-436c-bf8f-8446fc65048b:2",
   "fef6c2a3-7f77-436c-bf8f-8446fc65048b:3",
   "fef6c2a3-7f77-436c-bf8f-8446fc65048b:4",
   "fef6c2a3-7f77-436c-bf8f-8446fc65048b:6",
   "8a8d45a9-5327-4355-ae3c-c1fff734b327:11",
   "a428492a-08f5-4d66-8da6-a307bcdaea62:12",
   "a428492a-08f5-4d66-8da6-a307bcdaea62:14",
   "b3c1473b-85bd-405b-90d0-917754d3da5f:12",
   "8a8d45a9-5327-4355-ae3c-c1fff734b327:13",
   "a428492a-08f5-4d66-8da6-a307bcdaea62:16",
   "a428492a-08f5-4d66-8da6-a307bcdaea62:21",
   "a428492a-08f5-4d66-8da6-a307bcdaea62:23",
   "a428492a-08f5-4d66-8da6-a307bcdaea62:25",
   "a428492a-08f5-4d66-8da6-a307bcdaea62:27",
   "8a8d45a9-5327-4355-ae3c-c1fff734b327:15",
   "fef6c2a3-7f77-436c-bf8f-8446fc65048b:8",
   "04555951-8428-447f-8ac4-c19cab9af5bf:2",
   "2810ae3a-3701-4ebb-9c21-a5dd27027232:2",
   "fef6c2a3-7f77-436c-bf8f-8446fc65048b:10",
   "fef6c2a3-7f77-436c-bf8f-8446fc65048b:12",
   "a428492a-08f5-4d66-8da6-a307bcdaea62:29",
   "b3c1473b-85bd-405b-90d0-917754d3da5f:14",
   "8a8d45a9-5327-4355-ae3c-c1fff734b327:17",
   "2810ae3a-3701-4ebb-9c21-a5dd27027232:4",
   "a428492a-08f5-4d66-8da6-a307bcdaea62:31",
   "2810ae3a-3701-4ebb-9c21-a5dd27027232:6",
   "8a8d45a9-5327-4355-ae3c-c1fff734b327:19",
   "b3c1473b-85bd-405b-90d0-917754d3da5f:16",
   "8a8d45a9-5327-4355-ae3c-c1fff734b327:21",
   "8a8d45a9-5327-4355-ae3c-c1fff734b327:23",
   "a358f35c-dc41-4df2-a942-1f35f527f2d9:2",
   "a358f35c-dc41-4df2-a942-1f35f527f2d9:3",
   "8a8d45a9-5327-4355-ae3c-c1fff734b327:25",
   "a358f35c-dc41-4df2-a942-1f35f527f2d9:5",
   "b3c1473b-85bd-405b-90d0-917754d3da5f:18",
   "8a8d45a9-5327-4355-ae3c-c1fff734b327:27",
   "8a8d45a9-5327-4355-ae3c-c1fff734b327:29",
   "8a8d45a9-5327-4355-ae3c-c1fff734b327:31",
   "a428492a-08f5-4d66-8da6-a307bcdaea62:33",
   "b3c1473b-85bd-405b-90d0-917754d3da5f:20",
   "b3c1473b-85bd-405b-90d0-917754d3da5f:22",
   "b3c1473b-85bd-405b-90d0-917754d3da5f:24",
   "8a8d45a9-5327-4355-ae3c-c1fff734b327:37",
   "a428492a-08f5-4d66-8da6-a307bcdaea62:35",
   "8a8d45a9-5327-4355-ae3c-c1fff734b327:39",
   "a428492a-08f5-4d66-8da6-a307bcdaea62:37",
   "04c9c895-82cd-4e08-ad20-a5fc6eea12b6:2",
   "a428492a-08f5-4d66-8da6-a307bcdaea62:39"
  ],
  "count": 71,
  "source": "pinned:253c9a8c-5170-4461-86e0-e9c9fece9cbd"
 },
 "timing_ms": {
  "generate": 151,
  "fetch_voice": 731,
  "fetch_events": 688,
  "fetch_embeddings": 1665
 },
 "parameters": {
  "k": 5,
  "page_size": 50,
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
 },
 "attribution": {
  "hit": 178,
  "by_type": {
   "item_added": {
    "hit": 8,
    "absent": 0,
    "archived": 2,
    "resolved": 10
   },
   "voice_session": {
    "hit": 32,
    "absent": 0,
    "archived": 0,
    "resolved": 32
   },
   "lightbox_closed": {
    "hit": 25,
    "absent": 0,
    "archived": 3,
    "resolved": 28
   },
   "connection_description_closed": {
    "hit": 113,
    "absent": 0,
    "archived": 3,
    "resolved": 116
   }
  },
  "dropped": {
   "absent": 0,
   "archived": 8
  },
  "resolved": 186,
  "zero_weight_events": 0
 },
 "events_read": {
  "by_type": {
   "item_added": 10,
   "lightbox_closed": 28,
   "lightbox_opened": 30,
   "connection_label_clicked": 65,
   "connection_description_closed": 58
  },
  "depth_from": "2026-02-08T04:01:16.521Z",
  "embeddings": {
   "rows_expected": 101,
   "rows_returned": 101
  },
  "breadth_from": "2026-06-28T04:01:16.521Z",
  "rows_expected": 191,
  "rows_returned": 191,
  "voice_sessions": {
   "anchors": {
    "edges_found": 16,
    "nodes_found": 22,
    "edges_requested": 16,
    "nodes_requested": 22
   },
   "rows_expected": 16,
   "rows_returned": 16
  }
 },
 "generated_at": "2026-09-06T04:01:16.521Z",
 "pair_asymmetry": {
  "lightbox": {
   "opens": 30,
   "closes": 28,
   "paired": 28,
   "orphan_opens": 2,
   "unmatched_closes": 0
  },
  "connection": {
   "opens": 65,
   "closes": 58,
   "paired": 58,
   "orphan_opens": 7,
   "unmatched_closes": 0
  }
 },
 "total_clusters": 7,
 "pipeline_version": "v2",
 "singletons_dropped": 36,
 "events_unmatched_by_type": {
  "lightbox_opened": 30,
  "connection_label_clicked": 65
 },
 "events_unresolved_by_type": {},
 "nodes_excluded_no_embedding": 0,
 "max_raw_weight_before_normalization": 6.3759990075449
}
```

## Appendix G — Run 2 `clusters`, in full

```json
[
 {
  "size": 14,
  "cluster_id": "c1",
  "boards_touched": [
   "8a8d45a9-5327-4355-ae3c-c1fff734b327",
   "b3c1473b-85bd-405b-90d0-917754d3da5f",
   "fef6c2a3-7f77-436c-bf8f-8446fc65048b",
   "a428492a-08f5-4d66-8da6-a307bcdaea62"
  ],
  "anchor_node_ids": [
   "b3c1473b-85bd-405b-90d0-917754d3da5f:20",
   "a428492a-08f5-4d66-8da6-a307bcdaea62:23",
   "b3c1473b-85bd-405b-90d0-917754d3da5f:14"
  ],
  "member_node_ids": [
   "8a8d45a9-5327-4355-ae3c-c1fff734b327:3",
   "8a8d45a9-5327-4355-ae3c-c1fff734b327:4",
   "b3c1473b-85bd-405b-90d0-917754d3da5f:7",
   "b3c1473b-85bd-405b-90d0-917754d3da5f:3",
   "b3c1473b-85bd-405b-90d0-917754d3da5f:6",
   "b3c1473b-85bd-405b-90d0-917754d3da5f:10",
   "b3c1473b-85bd-405b-90d0-917754d3da5f:14",
   "fef6c2a3-7f77-436c-bf8f-8446fc65048b:3",
   "fef6c2a3-7f77-436c-bf8f-8446fc65048b:6",
   "b3c1473b-85bd-405b-90d0-917754d3da5f:12",
   "a428492a-08f5-4d66-8da6-a307bcdaea62:23",
   "b3c1473b-85bd-405b-90d0-917754d3da5f:16",
   "b3c1473b-85bd-405b-90d0-917754d3da5f:20",
   "b3c1473b-85bd-405b-90d0-917754d3da5f:22"
  ],
  "engagement_weight": 0.2352,
  "theme_description": ""
 },
 {
  "size": 10,
  "cluster_id": "c2",
  "boards_touched": [
   "a428492a-08f5-4d66-8da6-a307bcdaea62",
   "8a8d45a9-5327-4355-ae3c-c1fff734b327",
   "2810ae3a-3701-4ebb-9c21-a5dd27027232"
  ],
  "anchor_node_ids": [
   "a428492a-08f5-4d66-8da6-a307bcdaea62:37",
   "a428492a-08f5-4d66-8da6-a307bcdaea62:12",
   "a428492a-08f5-4d66-8da6-a307bcdaea62:27"
  ],
  "member_node_ids": [
   "a428492a-08f5-4d66-8da6-a307bcdaea62:4",
   "a428492a-08f5-4d66-8da6-a307bcdaea62:29",
   "8a8d45a9-5327-4355-ae3c-c1fff734b327:19",
   "2810ae3a-3701-4ebb-9c21-a5dd27027232:6",
   "a428492a-08f5-4d66-8da6-a307bcdaea62:5",
   "a428492a-08f5-4d66-8da6-a307bcdaea62:27",
   "a428492a-08f5-4d66-8da6-a307bcdaea62:37",
   "8a8d45a9-5327-4355-ae3c-c1fff734b327:27",
   "8a8d45a9-5327-4355-ae3c-c1fff734b327:29",
   "a428492a-08f5-4d66-8da6-a307bcdaea62:12"
  ],
  "engagement_weight": 0.1422,
  "theme_description": ""
 },
 {
  "size": 3,
  "cluster_id": "c3",
  "boards_touched": [
   "8a8d45a9-5327-4355-ae3c-c1fff734b327",
   "a428492a-08f5-4d66-8da6-a307bcdaea62"
  ],
  "anchor_node_ids": [
   "a428492a-08f5-4d66-8da6-a307bcdaea62:39",
   "8a8d45a9-5327-4355-ae3c-c1fff734b327:6",
   "8a8d45a9-5327-4355-ae3c-c1fff734b327:9"
  ],
  "member_node_ids": [
   "8a8d45a9-5327-4355-ae3c-c1fff734b327:6",
   "8a8d45a9-5327-4355-ae3c-c1fff734b327:9",
   "a428492a-08f5-4d66-8da6-a307bcdaea62:39"
  ],
  "engagement_weight": 0.1581,
  "theme_description": ""
 },
 {
  "size": 2,
  "cluster_id": "c4",
  "boards_touched": [
   "a428492a-08f5-4d66-8da6-a307bcdaea62",
   "fef6c2a3-7f77-436c-bf8f-8446fc65048b"
  ],
  "anchor_node_ids": [
   "a428492a-08f5-4d66-8da6-a307bcdaea62:8",
   "fef6c2a3-7f77-436c-bf8f-8446fc65048b:2"
  ],
  "member_node_ids": [
   "a428492a-08f5-4d66-8da6-a307bcdaea62:8",
   "fef6c2a3-7f77-436c-bf8f-8446fc65048b:2"
  ],
  "engagement_weight": 0.062,
  "theme_description": ""
 },
 {
  "size": 2,
  "cluster_id": "c5",
  "boards_touched": [
   "a428492a-08f5-4d66-8da6-a307bcdaea62",
   "8a8d45a9-5327-4355-ae3c-c1fff734b327"
  ],
  "anchor_node_ids": [
   "8a8d45a9-5327-4355-ae3c-c1fff734b327:15",
   "a428492a-08f5-4d66-8da6-a307bcdaea62:10"
  ],
  "member_node_ids": [
   "a428492a-08f5-4d66-8da6-a307bcdaea62:10",
   "8a8d45a9-5327-4355-ae3c-c1fff734b327:15"
  ],
  "engagement_weight": 0.0142,
  "theme_description": ""
 },
 {
  "size": 2,
  "cluster_id": "c6",
  "boards_touched": [
   "fef6c2a3-7f77-436c-bf8f-8446fc65048b",
   "8a8d45a9-5327-4355-ae3c-c1fff734b327"
  ],
  "anchor_node_ids": [
   "fef6c2a3-7f77-436c-bf8f-8446fc65048b:4",
   "8a8d45a9-5327-4355-ae3c-c1fff734b327:13"
  ],
  "member_node_ids": [
   "fef6c2a3-7f77-436c-bf8f-8446fc65048b:4",
   "8a8d45a9-5327-4355-ae3c-c1fff734b327:13"
  ],
  "engagement_weight": 0,
  "theme_description": ""
 },
 {
  "size": 2,
  "cluster_id": "c7",
  "boards_touched": [
   "2810ae3a-3701-4ebb-9c21-a5dd27027232",
   "a428492a-08f5-4d66-8da6-a307bcdaea62"
  ],
  "anchor_node_ids": [
   "2810ae3a-3701-4ebb-9c21-a5dd27027232:4",
   "a428492a-08f5-4d66-8da6-a307bcdaea62:31"
  ],
  "member_node_ids": [
   "2810ae3a-3701-4ebb-9c21-a5dd27027232:4",
   "a428492a-08f5-4d66-8da6-a307bcdaea62:31"
  ],
  "engagement_weight": 0.1173,
  "theme_description": ""
 }
]
```
