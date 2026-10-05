# Voice launch attribution — the six edge-less real sessions in the t2 window

> **This is a point-in-time read, as of 2026-10-05 UTC. Findings only. No fix is proposed.**
>
> **Read opened:** `2026-10-05 11:44:28 UTC` (`select now()` at first RO connection).
> **Repo SHA:** `deae198` (`origin/main`, freshly fetched; local `main` fast-forwarded from `3fe031c` before the read). Branch cut from `origin/main`.
> **Database:** Weave prod (`wndfikmpifyqkgivmnwv`). **Role:** `weave_readonly` via `WEAVE_PROD_RO_DATABASE_URL` / `--db-url` only. No writes and no code changes.
> **Dispatch:** #61 (follow-up to preflight read #8 / `docs/reads/t2-preflight.md` §C.2, which left the launch surface of the 6 unanchored sessions "not characterised").
>
> **Findings in this document decay; the query map does not.** To verify a count, re-run the query shown with it. Don't cite this document as the source.

---

## 0. Preconditions

| precondition | state | how established |
|---|---|---|
| Checkout currency | `git fetch` then `pull --ff-only`: local `main` = `origin/main` = `deae198` | `git fetch origin && git pull --ff-only origin main` |
| RO identity | `weave_readonly`, `rolbypassrls = f`, `rolsuper = f` | `select now(), current_user; select rolname, rolbypassrls, rolsuper from pg_roles where rolname = current_user;` |
| RLS visibility | `readonly_audit_select`, `qual = true` for `{weave_readonly}` on all 7 tables touched (`boards, edges, nodes, voice_sessions, voice_utterances, weave_events, weave_profile_snapshots`). Counts are whole-table. | `select tablename, roles::text, qual from pg_policies where policyname = 'readonly_audit_select';` |
| Migration state | Not re-derived from files. Every column used was observed in `information_schema.columns` on prod during this read. `replace_board_contents` was read live with `pg_get_functiondef` (§D.2). | — |
| Deployed code | **Inference, not observation.** Netlify deploys `main`, and no deploy log was read. The launch path files (§C/§D) last changed on 2026-08-13 (`2d60746`), before the window opened. So every session in the window ran this code unless a non-`main` deploy was live. | `git log --since=2026-05-01 -- src/components/EdgeDetailPopup.tsx src/persistence/syncBoard.ts src/services/voice/voiceSession{Manager,Controller}.ts src/persistence/hydration.ts src/hooks/useBoardStorage.ts` |

**The window.** t1 `generated_at` = `2026-09-07T02:37:59.815Z` (row `efa6d6e1…`), exclusive. Upper bound: t2 unpinned `generated_at` = `2026-10-04T18:46:05.731Z` (row `adffc023…`), inclusive. Using the pinned t2 (`ce322885…`, `18:15:51.251Z`) instead changes nothing: 0 sessions start between the two. No sessions have started since t2.

```sql
select session_kind, (anchor_edge_id is null) edge_null, (ended_at is null) open, count(*)
from voice_sessions where started_at > '2026-09-07T02:37:59.815Z' and started_at <= '2026-10-04T18:46:05.731Z'
group by 1,2,3 order by 1,2,3;
-- → qa/f/f 2 | real/f/f 3 | real/t/f 6
select count(*) from voice_sessions where started_at > '2026-10-04T18:15:51.251Z' and started_at <= '2026-10-04T18:46:05.731Z';  -- → 0
select count(*) from voice_sessions where started_at > '2026-10-04T18:46:05.731Z';                                               -- → 0
```

**Cardinality.** Expected: 9 real ended sessions (6 null + 3 anchored), consistent with preflight §C.2. Processed in §A, §B, §E: 9 rows each. ✅

---

## A. The six sessions, and the three for contrast

All 9 rows have every column populated except `summary`, which is null on all 9. `board_snapshot` is an object with keys `{nodes, edges, captured_at}` on all 9. Its edge `id`s are synthesized (`weave-{source}-{target}-{i}`, [boardSnapshot.ts:145](src/services/voice/boardSnapshot.ts:145)), not `edges.id`. A check on 3 sessions found 0 uuid-shaped edge ids out of 232. So the snapshot cannot stand in for a missing anchor. `end_reason = user_closed` on all 9.

| session | started (UTC) | ended (UTC) | user turns | utts | `anchor_edge_id` | snapshot nodes / edges | `processing_log` entries |
|---|---|---|---:|---:|---|---|---:|
| `2048d084…` | 09-09 05:03:45.384 | 05:18:07.285 | 10 | 21 | **null** | 23 / 110 | 636 |
| `02144349…` | 09-17 23:04:34.753 | 23:09:45.290 | 5 | 11 | **null** | 24 / 117 | 266 |
| `1defbdf7…` | 09-24 07:58:22.699 | 08:13:35.604 | 13 | 27 | **null** | 15 / 73 | 714 |
| `3ffe9e77…` | 09-26 10:25:49.529 | 10:51:01.748 | 20 | 41 | **null** | 16 / 81 | 1104 |
| `477db21d…` | 10-01 01:43:23.221 | 01:54:00.842 | 8 | 17 | **null** | 4 / 12 | 545 |
| `71cb3d68…` | 10-03 07:17:32.106 | 07:34:16.159 | 17 | 35 | **null** | 26 / 129 | 831 |
| *contrast* | | | | | | | |
| `ae2ca271…` | 09-17 06:54:37.309 | 07:13:00.150 | 14 | 29 | `0d9c97e7…` | 23 / 110 | 806 |
| `d289fffc…` | 09-27 08:47:07.446 | 08:59:45.442 | 11 | 23 | `bbe0f77c…` | 16 / 81 | 529 |
| `4949baac…` | 09-28 05:08:31.029 | 05:10:34.538 | 1 | 3 | `2ffeebeb…` | 16 / 81 | 110 |

First two utterances (speaker, first 80 chars). In every session, the first is the assistant's opening:

| session | #0 (assistant) | #1 (user) |
|---|---|---|
| `2048d084` | The Hubinger admission is stranger than it looks because it's not a whistleblowe | Yeah, I don't know. I mean, I think it is kind of an act of courage. I mean, I g |
| `02144349` | Notice what the two pieces do with specificity, because they move in opposite di | Almost wiser. I mean, this is a hard question because I initially wanted to say |
| `1defbdf7` | The professor's argument ends where it gets interesting: intensive investment pr | I don't think Holmes knew. I've seen tweets where she feels she felt cheated or |
| `3ffe9e77` | Both of these pieces are doing something structurally identical and slightly sne | it's sophisticated i think you're right there but i think there's something also |
| `477db21d` | The convergence here is less interesting than the timing of it, and the timing i | yeah it's a good question i mean to me this feels maybe maybe a little bit disin |
| `71cb3d68` | Both of these are fan edits, which means someone sat down with editing software | I mean, music's pretty powerful, I'm not going to lie, I think probably there is |
| `ae2ca271` | The thing that makes this pairing work isn't that the prediction came true — it' | I think it's dread as a hobby, man. It's not really useful because there are no |
| `d289fffc` | Chamath is making a causal claim about origins — trauma installs the engine — an | That's a good question. I do find it interesting that essentially the exit cause |
| `4949baac` | Both of these are stories about a scoring machine that only works as long as nob | It's resorting |

The six edge-less openings have the same shape as the three anchored ones: two pieces, one relationship. That is what the edge-scoped opening produces ([EdgeDetailPopup.tsx:539-540](src/components/EdgeDetailPopup.tsx:539) passes `connectionContext` + `nodeContent` for exactly two nodes). The `voice.session.started` entry in `processing_log` carries only `{boardId}` for both kinds (e.g. `2048d084` and `ae2ca271`), so the log does not distinguish them either.

```sql
select vs.id, vs.started_at, vs.ended_at, vs.end_reason, vs.anchor_edge_id, vs.session_kind,
 (select count(*) from voice_utterances u where u.session_id=vs.id and u.speaker='user') user_turns,
 (select count(*) from voice_utterances u where u.session_id=vs.id) all_utts,
 vs.summary is not null has_summary, jsonb_typeof(vs.board_snapshot) bs_type,
 jsonb_array_length(vs.board_snapshot->'nodes') n_nodes, jsonb_array_length(vs.board_snapshot->'edges') n_edges,
 jsonb_array_length(vs.processing_log) plog_n
from voice_sessions vs
where vs.session_kind='real' and vs.ended_at is not null
 and vs.started_at > '2026-09-07T02:37:59.815Z' and vs.started_at <= '2026-10-04T18:46:05.731Z'
order by vs.anchor_edge_id is not null, vs.started_at;   -- → 9 rows

select u.session_id, u.utterance_index, u.speaker, left(replace(u.text, E'\n',' '),80)
from voice_utterances u join voice_sessions vs on vs.id=u.session_id
where vs.session_kind='real' and vs.ended_at is not null
 and vs.started_at > '2026-09-07T02:37:59.815Z' and vs.started_at <= '2026-10-04T18:46:05.731Z'
 and u.utterance_index in (select utterance_index from voice_utterances u2 where u2.session_id=u.session_id order by utterance_index limit 2)
order by vs.anchor_edge_id is not null, vs.started_at, u.utterance_index;   -- → 18 rows

select count(*) filter (where e->>'id' ~ '^[0-9a-f]{8}-'), count(*) from voice_sessions vs, jsonb_array_elements(board_snapshot->'edges') e
where id in ('2048d084-6395-4fac-be21-b18f85c56bf3','477db21d-352f-4be3-a117-847d09766786','ae2ca271-ccce-496d-af3b-3365ad60a6b4');  -- → 0 | 232
```

---

## B. Browser-session reconstruction

Attribution method (F1): `weave_events` rows with `voice_session_id = voice_sessions.id` and `event_type = 'voice.session.started'` give the browser `session_id`. Exactly 1 such row exists per session (9/9, 0 duplicates). Every `weave_events` row in that browser `session_id` in [`started_at − 5 min`, `started_at + 5 s`] was read: 91 rows. The full listing is the first query below.

**A `connection_label_clicked` precedes every one of the 9 sessions.** It is the last C/X row before `voice.session.started` in each case, with no close between click and voice start. The same holds for the contrast sessions.

| session | launch click (UTC) | click → `started_at` | launch edge (`target_id`) | other context in the 5 min |
|---|---|---:|---|---|
| `2048d084` | 05:03:44.070 | 1.3 s | `connection:8a8d45a9…:41:11` (Abusrdity) | same edge clicked and closed 8.5 s earlier (re-open) |
| `02144349` | 23:04:18.750 | 16.0 s | `connection:8a8d45a9…:43:11` | 8 connection clicks on node 43's edges, 5 lightboxes |
| `1defbdf7` | 07:58:20.954 | 1.7 s | `connection:b3c1473b…:26:8` (Tech and Business) | same edge clicked and closed 16 s earlier (re-open) |
| `3ffe9e77` | 10:25:36.439 | 13.1 s | `connection:b3c1473b…:28:8` | page load −235 s, node 28 added, **`weave_triggered` −177 s**, then 7 clicks on node 28's new edges |
| `477db21d` | 01:43:22.287 | 0.9 s | `connection:a358f35c…:5:7` (Geopolitics) | **`session_started` 6.3 s before voice start** (page load), nothing else |
| `71cb3d68` | 07:17:26.499 | 5.6 s | `connection:8a8d45a9…:47:17` | 2 prior clicks on node 47 / node 33 edges |
| *contrast* | | | | |
| `ae2ca271` | 06:54:35.646 | 1.7 s | `connection:8a8d45a9…:3:4` (= anchor `0d9c97e7`) | page load −77 s, board switch, re-open of the same edge |
| `d289fffc` | 08:46:38.989 | 28.5 s | `connection:b3c1473b…:28:4` (= anchor `bbe0f77c`) | page load −59 s |
| `4949baac` | 05:08:29.734 | 1.3 s | `connection:b3c1473b…:20:18` (= anchor `2ffeebeb`) | page load −13.8 s |

**Answer to "was there a launch edge in the UI even though the row has none": yes, for 6 of 6.** In each case, a connection popup was opened on a specific edge and voice started from it within 0.9–16 s.

```sql
-- B.1 full 5-minute listing (91 rows)
with v as (
  select vs.id vsid, vs.started_at, vs.anchor_edge_id, e.session_id bsid
  from voice_sessions vs join weave_events e on e.voice_session_id=vs.id and e.event_type='voice.session.started'
  where vs.session_kind='real' and vs.ended_at is not null and vs.started_at > '2026-09-07T02:37:59.815Z' and vs.started_at <= '2026-10-04T18:46:05.731Z')
select v.vsid, v.anchor_edge_id is not null anch, w.event_type, w.target_id, w.duration_ms,
  round(extract(epoch from (w.timestamp - v.started_at))::numeric,3) dt_s, w.timestamp
from v join weave_events w on w.session_id=v.bsid
where w.timestamp >= v.started_at - interval '5 minutes' and w.timestamp <= v.started_at + interval '5 seconds'
order by v.anchor_edge_id is not null, v.started_at, w.timestamp;   -- → 91 rows

-- B.2 one voice.session.started per session
select vs.id, count(*) from voice_sessions vs join weave_events e on e.voice_session_id=vs.id and e.event_type='voice.session.started'
where vs.session_kind='real' and vs.ended_at is not null group by 1 having count(*) > 1;   -- → 0 rows
```

### B.3 Was the launch edge in the database at click time, and when was it born?

The `target_id` was resolved to `edges` rows through `nodes.data->>'_clientNodeId'` on the board, in either direction. The edge's `created_at` was compared with the browser session's first event, which is its `session_started` (page load) in all 9.

| session | anchored | launch edge `edges.id` | edge `created_at` | page load (browser session) | edge born **inside** this page load? | anchor = launch edge? |
|---|---|---|---|---|---|---|
| `2048d084` | no | `253a1b56…` | 09-09 04:46:39 | 09-09 04:45:26 | **yes** | — |
| `02144349` | no | `fe53dd86…` | 09-17 22:00:02 | 09-17 21:57:22 | **yes** | — |
| `1defbdf7` | no | `3ee03c47…` | 09-24 07:53:06 | 09-24 07:49:45 | **yes** | — |
| `3ffe9e77` | no | `696a0314…` | 09-26 10:23:37 | 09-26 10:21:54 | **yes** | — |
| `477db21d` | no | `fc618bf5…` | 09-30 23:45:31 | 10-01 01:43:16 | **no** (born in the *previous* page load `1044e958…`) | — |
| `71cb3d68` | no | `3cfc878e…` | 10-03 05:56:06 | 10-03 05:53:03 | **yes** | — |
| `ae2ca271` | yes | `0d9c97e7…` | 04-29 20:11:34 | 09-17 06:53:19 | no | ✅ |
| `d289fffc` | yes | `bbe0f77c…` | **09-26 10:23:37** | 09-27 08:46:08 | no | ✅ |
| `4949baac` | yes | `2ffeebeb…` | 06-19 15:17:03 | 09-28 05:08:17 | no | ✅ |

- In all 6 edge-less sessions, **the `edges` row existed before the launch click**: `created_at` precedes `click_ts` by 17 min to 1 d 2 h. The id was knowable server-side when the session row was inserted.
- In 5 of 6, the edge was created by a **weave run in the same page load**. A `weave_triggered` row precedes each edge's `created_at` by 44–81 s, which is the weave's `duration_ms` plus the save debounce. No `session_started` falls between the edge's birth and the launch (no reload). See B.4.
- In all 3 anchored sessions, the edge pre-dated the page load.
- **Natural control:** `bbe0f77c` (28 ⟷ 4) and `696a0314` (28 ⟷ 8) were written by the *same* weave at the *same* instant (`10:23:37.18009`). Launched in that page load (`3ffe9e77`), 28 ⟷ 8 wrote **null**. Launched after a reload the next day (`d289fffc`), 28 ⟷ 4 wrote its id.

```sql
-- B.3
with v as (
  select vs.id vsid, vs.started_at, vs.anchor_edge_id, e.session_id bsid
  from voice_sessions vs join weave_events e on e.voice_session_id=vs.id and e.event_type='voice.session.started'
  where vs.session_kind='real' and vs.ended_at is not null and vs.started_at > '2026-09-07T02:37:59.815Z' and vs.started_at <= '2026-10-04T18:46:05.731Z'),
launch as (
  select distinct on (v.vsid) v.*, w.target_id, w.timestamp click_ts
  from v join weave_events w on w.session_id=v.bsid and w.event_type='connection_label_clicked' and w.timestamp <= v.started_at
  order by v.vsid, w.timestamp desc),
bs as (select l.vsid, min(w.timestamp) bs_first, min(w.timestamp) filter (where w.event_type='session_started') bs_started
  from launch l join weave_events w on w.session_id=l.bsid group by 1),
parts as (select l.*, split_part(target_id,':',2)::uuid board, split_part(target_id,':',3) a, split_part(target_id,':',4) b from launch l)
select p.vsid, p.anchor_edge_id is not null anch, p.target_id, p.click_ts, bs.bs_first, bs.bs_started,
  ed.id edge_id, ed.created_at edge_created, ed.created_at > coalesce(bs.bs_started, bs.bs_first) edge_born_in_bsession,
  ed.created_at < p.click_ts edge_existed_at_click, ed.id = p.anchor_edge_id anchor_matches
from parts p join bs on bs.vsid=p.vsid
left join nodes na on na.board_id=p.board and na.data->>'_clientNodeId'=p.a
left join nodes nb on nb.board_id=p.board and nb.data->>'_clientNodeId'=p.b
left join edges ed on ed.board_id=p.board and ((ed.source_node_id=na.id and ed.target_node_id=nb.id) or (ed.source_node_id=nb.id and ed.target_node_id=na.id))
order by p.anchor_edge_id is not null, p.started_at;   -- → 9 rows (each pair resolves to exactly 1 edge in this window)
```

### B.4 The weave that produced each in-session edge

| session | `weave_triggered` (client-stamped start) | `duration_ms` | edge `created_at` − weave start | reloads between edge birth and launch |
|---|---|---:|---:|---:|
| `2048d084` | 09-09 04:45:46.817 | 48,935 | 52.2 s | 0 |
| `02144349` | 09-17 21:59:18.772 | 34,891 | 44.1 s | 0 |
| `1defbdf7` | 09-24 07:51:45.078 | 78,731 | 81.0 s | 0 |
| `3ffe9e77` | 09-26 10:22:52.530 | 40,116 | 44.7 s | 0 |
| `71cb3d68` | 10-03 05:55:03.233 | 58,202 | 63.7 s | 0 |

For `477db21d`, the edge's weave is `1044e958…` `weave_triggered` 09-30 23:45:15.337. That page load also clicked and closed 5 ⟷ 7 at 23:45:36. The next page load (`30c411f6…`) began 01:43:16.884, and 5 ⟷ 7 was clicked **5.4 s** after load.

```sql
-- B.4 (bsid / edge_created from B.3)
with x(vs, bsid, edge_created) as (values
 ('2048d084','3d113487-4710-44c9-8e15-826910b888aa','2026-09-09 04:46:39.066044+00'::timestamptz),
 ('02144349','de513492-105e-4eb3-8dc9-cbe64b0773eb','2026-09-17 22:00:02.858354+00'),
 ('1defbdf7','6901ef36-878c-478f-90e3-dc5c8a94594b','2026-09-24 07:53:06.032281+00'),
 ('3ffe9e77','d43a3654-0827-4b47-a45b-2c5b3553cbd5','2026-09-26 10:23:37.18009+00'),
 ('71cb3d68','b6b6e7b0-450b-4047-b640-62b441d26793','2026-10-03 05:56:06.955537+00'))
select x.vs, w.timestamp weave_ts, w.duration_ms, round(extract(epoch from x.edge_created - w.timestamp)::numeric,1),
  (select count(*) from weave_events s where s.session_id=x.bsid and s.event_type='session_started' and s.timestamp > x.edge_created) reloads_after_edge
from x left join lateral (select * from weave_events w where w.session_id=x.bsid and w.event_type='weave_triggered' and w.timestamp <= x.edge_created order by w.timestamp desc limit 1) w on true;
-- → 5 rows, reloads_after_edge 0 on all

-- B.4 477db21d neighbourhood
select session_id, event_type, target_id, timestamp from weave_events
where timestamp between '2026-09-30 23:30:00+00' and '2026-10-01 01:44:00+00' and event_type not like 'voice.%' order by timestamp;  -- → 10 rows
```

### B.5 All-time control (outside the window, to test the separation)

The same classification at session grain was run across **every** real ended voice session. All 34 are joinable to a browser session, and all 34 have a launch click. A pair can hold more than one `edges` row, one per mode (migration 029's unique key includes mode). So this is classified per session over all pair edges, not per edge row. An edge-grain first pass returned 42 rows against 34 sessions. The cause was that per-mode fan-out, re-derived below.

| anchored | launch pair's edge rows | sessions | anchor = a launch-pair edge |
|---|---|---:|---:|
| no | all born inside the launching page load | **13** | — |
| no | all pre-existing at page load | **1** (`477db21d`) | — |
| no | no edge row exists now (both nodes gone, `e1b8bf89…`, 2026-06-01) | 1 | — |
| yes | all pre-existing at page load | **19** | 19 / 19 |

13 + 1 + 1 + 19 = 34 = total real ended ✅. Nulls 15 = `count(*) where anchor_edge_id is null` ✅.

**No anchored session in history launched from an edge born in its own page load, and every such launch wrote null.**

```sql
with v as (
  select vs.id vsid, vs.started_at, vs.anchor_edge_id, e.session_id bsid
  from voice_sessions vs join weave_events e on e.voice_session_id=vs.id and e.event_type='voice.session.started'
  where vs.session_kind='real' and vs.ended_at is not null),
launch as (
  select distinct on (v.vsid) v.*, w.target_id, w.timestamp click_ts
  from v join weave_events w on w.session_id=v.bsid and w.event_type='connection_label_clicked' and w.timestamp <= v.started_at
  order by v.vsid, w.timestamp desc),
bs as (select l.vsid, min(w.timestamp) bs_first from launch l join weave_events w on w.session_id=l.bsid group by 1),
parts as (select l.*, split_part(target_id,':',2)::uuid board, split_part(target_id,':',3) a, split_part(target_id,':',4) b from launch l),
pe as (
  select p.vsid, p.started_at, p.anchor_edge_id, bs.bs_first, ed.id eid, ed.created_at
  from parts p join bs on bs.vsid=p.vsid
  left join nodes na on na.board_id=p.board and na.data->>'_clientNodeId'=p.a
  left join nodes nb on nb.board_id=p.board and nb.data->>'_clientNodeId'=p.b
  left join edges ed on ed.board_id=p.board and ((ed.source_node_id=na.id and ed.target_node_id=nb.id) or (ed.source_node_id=nb.id and ed.target_node_id=na.id))),
s as (
  select vsid, min(started_at) started_at, bool_or(anchor_edge_id is not null) anch, count(eid) n_pair_edges,
    bool_or(eid = anchor_edge_id) anchor_is_pair_edge,
    count(*) filter (where created_at > bs_first) n_born_in_bs, count(*) filter (where created_at <= bs_first) n_preexisting
  from pe group by vsid)
select anch, case when n_pair_edges=0 then 'pair has no edge row now'
  when n_born_in_bs>0 and n_preexisting=0 then 'all pair edges born in browser session'
  when n_born_in_bs=0 then 'all pair edges pre-existing at page load' else 'mixed' end edge_state,
  count(*) sessions, count(*) filter (where anchor_is_pair_edge) anchor_matches_pair
from s group by 1,2 order by 1,2;
-- → f/born 13 | f/pre-existing 1 | f/no row 1 | t/pre-existing 19 (19)

select count(*) total, count(*) filter (where anchor_edge_id is null) null_anchor
from voice_sessions where session_kind='real' and ended_at is not null;   -- → 34 | 15
```

---

## C. Every code path that creates a `voice_sessions` row

| # | site | what it passes for `anchor_edge_id` |
|---|---|---|
| 1 | [voiceSessions.ts:18-22](src/persistence/voiceSessions.ts:18) `createSession` | the only `.insert` on `voice_sessions` in `src/`, `netlify/`, `server/`; passes `input` through |
| 2 | [voiceSessionController.ts:224-231](src/services/voice/voiceSessionController.ts:224) `startSession` | the only caller of #1; `anchor_edge_id: anchorEdgeId` verbatim |
| 3 | [voiceSessionManager.ts:53-75](src/services/voice/voiceSessionManager.ts:53) `beginVoiceSession` | the only caller of #2; forwards `opts.anchorEdgeId` verbatim |
| 4 | [EdgeDetailPopup.tsx:524-541](src/components/EdgeDetailPopup.tsx:524) `handleSpeak` (button at [:698](src/components/EdgeDetailPopup.tsx:698)) | **the only caller of #3**: `connection.id && connection.id.length > 0 ? connection.id : null` ([:535-536](src/components/EdgeDetailPopup.tsx:535)) |

Established by `grep -rn "voice_sessions\|anchor_edge_id\|anchorEdgeId\|beginVoiceSession\|startSession(\|createSession" --include='*.ts' --include='*.tsx'` (excluding `__tests__` and `database.ts`).

- **Reflect opening:** it starts no session. [ReflectView.tsx](src/components/ReflectView.tsx) has no reference to voice, mic, Speak, or `beginVoiceSession`. No voice entry point in Reflect exists in this checkout.
- **Board-level or global mic:** none. `beginVoiceSession` has one call site.
- **Does the popup path ever send null?** Yes. It sends null whenever the `Connection` object it holds has no `id`. The code says so ([EdgeDetailPopup.tsx:528-534](src/components/EdgeDetailPopup.tsx:528)): "On freshly-Claude-derived connections that haven't survived a save → hydrate yet, connection.id is undefined; fall through to null." The `Connection.id` doc says the same ([claude.ts:169-178](src/api/claude.ts:169)). This was introduced deliberately in `1d003dc` (2026-05-16, "plumb edge db uuid through Connection to populate anchor_edge_id"). The `BeginVoiceSessionInput` doc comment ([voiceSessionManager.ts:43-46](src/services/voice/voiceSessionManager.ts:43)) still says the popup's `Connection` "doesn't carry a database uuid" at all. That predates `1d003dc` and is stale.
- **Re-entry after a session ends / second session in the same popup:** `handleSpeak` reads the same `connection` prop each time. A second session from the same popup writes whatever the first wrote, null or id. Nothing in [vadController.ts](src/services/voice/vadController.ts) calls `startSession`/`beginVoiceSession`, so reconnect or resume-after-error cannot create a second row. **No path creates a session that drops an id the popup held.**

---

## D. Where the edge id travels — and where it never arrives

### D.1 Popup click → insert

`onLabelClick` stores the **clicked `Connection` object** in `popupEdge` ([App.tsx:322](src/App.tsx:322)). The popup receives `popupEdge.connection` ([App.tsx:705](src/App.tsx:705)) and `handleSpeak` reads `connection.id` from it (§C #4 → #3 → #2 → #1). There is no lookup by pair, identity key, or database at any hop. **The id that reaches the insert is exactly `connection.id` on the object captured at click time.**

### D.2 How a `Connection` gets an `id`, and the only way it does

| step | code | `id` on the client `Connection`? |
|---|---|---|
| Weave run returns connections | [App.tsx:653-674](src/App.tsx:653): `result.connections` normalised and merged into `connections` state | **absent**. Claude-derived objects have no `id` |
| Debounced save | [syncBoard.ts:297-300](src/persistence/syncBoard.ts:297) → `replace_board_contents` RPC ([syncBoard.ts:218-232](src/persistence/syncBoard.ts:218)) | the RPC upserts `edges` and creates the row and its uuid, but **`returns void`** (live prod definition, read via `pg_get_functiondef`; the same in [030:48](supabase/migrations/030_replace_board_contents_directionless_edges.sql:48)). The client gets no ids back |
| Save success → store + cache | [useBoardStorage.ts:419-442](src/hooks/useBoardStorage.ts:419): the **same id-less `connections`** are written into the in-memory store and `putBoardCache` | **absent**, and now persisted to the local cache too |
| Board switch within the page load | [App.tsx:194](src/App.tsx:194) `setConnections(currentBoard.connections)` from the store | absent (the store holds the saved id-less array) |
| **Boot fetch from Supabase** | [useBoardStorage.ts:213-275](src/hooks/useBoardStorage.ts:213) → `connectionFromEdge` ([hydration.ts:164-183](src/persistence/hydration.ts:164)) sets `id: edge.id` | **present**. This is the only place an `id` is assigned. It runs once per page load (`didBootstrapRef`) |

So a connection created by a weave keeps `id === undefined` in client state for the rest of that page load: across saves, across board switches, and across popup re-opens. **Point of loss for the 5 in-session cases: the save round trip.** The edge row and its uuid are created server-side, but `replace_board_contents` returns nothing and the client never re-reads. `handleSpeak` then correctly forwards the `undefined` as `null`.

### D.3 The one pre-existing case (`477db21d`): a boot-time window

The edge pre-dated the page load, so the boot fetch would have supplied its id. Neither the DB nor `processing_log` records when the boot fetch lands, so the exact point is **inferred from code, not observed**:

1. The previous page load (`1044e958…`) saved board `a358f35c…` after the weave. Per D.2, that wrote the id-less 5 ⟷ 7 into the local cache.
2. With a warm cache, the canvas renders from the cache first and the boot fetch runs in the background ([useBoardStorage.ts:213-275](src/hooks/useBoardStorage.ts:213)). A cold cache would block on the fetch and render ids. The null outcome is consistent with the warm-cache path only.
3. The click came **5.4 s** after `session_started`. Revalidation re-seeds `connections` only when it lands and `storesEqual` is false ([useBoardStorage.ts:710-725](src/hooks/useBoardStorage.ts:710); it compares `updatedAt`, which differs between a client-stamped cache save and `boards.updated_at`, so a re-seed is expected). Even if the re-seed landed after the click, the open popup keeps the object captured at [App.tsx:322](src/App.tsx:322). `popupEdge` is reset only on board change ([App.tsx:196-199](src/App.tsx:196)).

Either ordering (fetch not yet landed at click, or landed while the popup held the stale object) ends at the same place: a cache-era `Connection` without `id`. Which ordering occurred is **undetermined** from prod data. For scale: the fastest anchored launch in history clicked 7 s after page load (B.5 `min_click_after_load_s`), and this one clicked at 5.4 s.

---

## E. Cross-check against D7's orphan clicks

**The six are not among D7's 49 O4 orphans, by time.** D7's Q2 population was the whole `weave_events` table as of its read (2026-09-04). The newest `connection_label_clicked` before this window is `2026-09-04 02:17:19`. All six launch clicks are 2026-09-09 or later.

**Applied to these launches, D7's orphan rule (launch click with no later same-target close in the browser session) does not track the missing edge id:**

| session | anchored | launch click closed? | close − voice end | `duration_ms` | non-voice events after voice end |
|---|---|---|---:|---:|---:|
| `2048d084` | no | yes | 1.2 s | 864,495 | 1 |
| `02144349` | no | yes | 1.1 s | 327,705 | 1 |
| `1defbdf7` | no | **no (orphan)** | — | — | 0 |
| `3ffe9e77` | no | yes | 1.3 s | 1,526,500 | 2 |
| `477db21d` | no | yes | 1.4 s | 641,053 | 1 |
| `71cb3d68` | no | **no (orphan)** | — | — | 0 |
| `ae2ca271` | yes | yes | 0.5 s | 1,104,735 | 1 |
| `d289fffc` | yes | **no (orphan)** | — | — | 0 |
| `4949baac` | yes | yes | 1.0 s | 125,904 | 1 |

- Edge-less: 4 closed, 2 orphan. Anchored: 2 closed, 1 orphan. Every orphan is the session-terminal shape D7 described: the voice session is the last activity in the browser session (0 non-voice events after voice end).
- The id is fixed at Speak time (§D.1), before any close could fire. The close path ([EdgeDetailPopup.tsx](src/components/EdgeDetailPopup.tsx) overlay / Escape / button) neither reads nor writes `anchor_edge_id`.

**This is not one defect with two symptoms.** These are two independent mechanisms that happen to share the popup:
(i) a missing close is unmount-without-flush at session end (D7 F-Q2.2) and occurs on anchored and edge-less launches alike;
(ii) a missing anchor is the id never reaching the client `Connection` (§D) and occurs whether or not the close is written.

```sql
with v as (
  select vs.id vsid, vs.started_at, vs.ended_at, vs.anchor_edge_id, e.session_id bsid
  from voice_sessions vs join weave_events e on e.voice_session_id=vs.id and e.event_type='voice.session.started'
  where vs.session_kind='real' and vs.ended_at is not null and vs.started_at > '2026-09-07T02:37:59.815Z' and vs.started_at <= '2026-10-04T18:46:05.731Z'),
launch as (
  select distinct on (v.vsid) v.*, w.target_id, w.timestamp click_ts
  from v join weave_events w on w.session_id=v.bsid and w.event_type='connection_label_clicked' and w.timestamp <= v.started_at
  order by v.vsid, w.timestamp desc)
select l.vsid, l.anchor_edge_id is not null anch, l.click_ts, c.timestamp close_ts, c.duration_ms,
  round(extract(epoch from c.timestamp - l.ended_at)::numeric,1) close_after_voice_end_s,
  (select count(*) from weave_events z where z.session_id=l.bsid and z.timestamp > l.ended_at and z.event_type not like 'voice.%') later_nonvoice
from launch l left join lateral (select * from weave_events c where c.session_id=l.bsid and c.target_id=l.target_id
  and c.event_type='connection_description_closed' and c.timestamp > l.click_ts order by c.timestamp limit 1) c on true
order by l.anchor_edge_id is not null, l.started_at;   -- → 9 rows, 3 with null close

select max(timestamp) from weave_events where event_type='connection_label_clicked' and timestamp < '2026-09-07T02:37:59.815Z';
-- → 2026-09-04 02:17:19.320118+00
```

---

## F. Close

### F.1 Launch path per session

| session | launch path | launch edge | edge row at click | point of loss |
|---|---|---|---|---|
| `2048d084` | **popup** (Speak in EdgeDetailPopup) | 41 ⟷ 11, `253a1b56…` | existed (17 min) | save round trip: edge born from an in-page-load weave, id never returned to the client (§D.2) |
| `02144349` | **popup** | 43 ⟷ 11, `fe53dd86…` | existed (1 h 4 min) | same |
| `1defbdf7` | **popup** | 26 ⟷ 8, `3ee03c47…` | existed (5 min) | same |
| `3ffe9e77` | **popup** | 28 ⟷ 8, `696a0314…` | existed (2 min) | same. Its sibling 28 ⟷ 4 from the same weave anchored correctly after a reload (`d289fffc`) |
| `477db21d` | **popup** | 5 ⟷ 7, `fc618bf5…` | existed (prior day) | boot-time window: cache-era `Connection` (id-less, written by the previous page load's save) held by the popup 5.4 s after load. Exact ordering vs. the boot fetch is **undetermined** (§D.3) |
| `71cb3d68` | **popup** | 47 ⟷ 17, `3cfc878e…` | existed (1 h 21 min) | save round trip, as for the first four |

Reflect opening: 0. Other: 0. Undetermined launch path: 0. There is exactly one launch path in code (§C), and every session's browser record shows a launch click on a specific edge (§B).

### F.2 Is the depth rule blind to these by construction or by defect?

**By defect.** For 6 of 6, an edge existed in the UI (the popup was open on it) and an `edges` row with a uuid existed before Speak (§B.3). The id was not written because the client-side `Connection` never received it. In 5 sessions that is because `replace_board_contents` returns `void` and nothing re-reads after a save (§D.2). In 1 it is because a cache-era object was used across the boot fetch (§D.3).

The pipeline's voice predicate (`anchor_edge_id is not null`, [reads.ts:165](netlify/lib/snapshot/reads.ts:165)) then excludes the 6. That drops 73 user turns from depth in the t2 window, against the 26 that were scored. The gap is documented in code comments ([EdgeDetailPopup.tsx:528-534](src/components/EdgeDetailPopup.tsx:528), [claude.ts:169-178](src/api/claude.ts:169)) as an accepted limitation of `1d003dc`, not a regression. Its prod rate was not previously measured: all-time it accounts for 13–14 of 15 null-anchor real sessions (§B.5).

A structural consequence the depth rule inherits (stated, not proposed against): launches from connections the user *just* wove (the freshest material) are systematically the ones that score zero depth.

> **Addendum (fix, branch `fix/voice-anchor-edge-id`, migrations 040–041):** accepted residual gap — Speak within ~500 ms (save debounce) + one RPC round trip of the weave that created the edge finds no `edges` row yet; `create_voice_session` inserts with `anchor_edge_id` null and logs `launch.anchor_edge_unresolved` with its inputs. No mitigation by design.
