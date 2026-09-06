# Revival R2 — Verify on prod: OQ14, unweighted pair, determinism, Q18

> **This is a point-in-time verification record, as of 2026-09-05 (local).**
>
> **Read opened:** `PENDING — select now() at first RO connection (P2)`.
> **Repo SHA (baseline read):** `2cda5920f37692c2b9f165dea6d7beb27586106d` (`origin/main` = PR #45 merged).
> **Repo SHA (runs):** `PENDING — origin/main after PR #46 (Part A) merges; the deployed function must carry it`.
> **Database:** Weave prod (`wndfikmpifyqkgivmnwv`).
> **Role:** `weave_readonly` via `WEAVE_PROD_RO_DATABASE_URL` / `--db-url` only. Claude Code holds no
> write credential and no JWT; every generation is executed by Daniel from his own terminal.
> **Dashboard PostgREST max-rows:** `PENDING — supplied by Daniel`.
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
rows_expected = 16`; `anchors.edges_found = 16`, `nodes_found = 32`; `attribution.by_type.voice_session
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

(B1–B6 verification sections follow once the runs exist.)
