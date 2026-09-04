# D7 Diagnosis — weightMap miss classification + click/close orphan pairing

> **This is a point-in-time diagnostic, as of 2026-09-04.**
>
> **Read opened:** `2026-09-04 21:30:03 UTC` (`select now()` at first connection).
> **Repo SHA:** `1b2cfffc50942213e6c4d01efab80943d3350d71` (`origin/main` after
> `git fetch origin`; branch `reads/d7-diagnosis` cut from it; working tree clean).
> **Database:** Weave prod (`wndfikmpifyqkgivmnwv`), PostgreSQL 17.6 on aarch64-linux.
> **Role:** `weave_readonly` via `WEAVE_PROD_RO_DATABASE_URL` / `--db-url` only.
> No Management API, no service role, no CLI auth flow. No auth friction occurred.
>
> **Findings in this document decay; the query map does not.** Every count is
> verified by re-running the query directly above it, never by citing this file.
>
> Follows the `docs/reads/` document class established by
> [`preflight-read-8.md`](docs/reads/preflight-read-8.md) and
> [`census-8.md`](docs/reads/census-8.md). Census figures referenced here were
> read at `ff0b4f8` on 2026-08-28.

**Scope.** Two questions, read-only. Q1: why do resolved engagement keys miss the
snapshot pipeline's `weightMap`? Q2: are orphan `connection_label_clicked` rows
re-click switching or lost closes? No fixes, no schema, no code changes, no
`generation_metadata` opinions, no pipeline invocation. Zero writes to prod.

---

## 0. Preflight (all passed; recorded verbatim)

**P1 — checkout currency and code delta.** `git fetch origin` ran first. Local
`main` was at `ff0b4f8` (two PRs behind); branch cut from `origin/main` =
`1b2cfff`. `git status --short` empty.

```bash
git log --oneline ff0b4f8..HEAD -- netlify/functions/generate-profile-snapshot.ts netlify/functions/ src/api/ src/utils/ supabase/migrations/
# → (no output)
git diff --stat ff0b4f8..1b2cfff
# → docs/reads/census-8.md (+1039), Claude.md (+1)
```

**The attribution code has not changed since the census SHA.** The two commits
between `ff0b4f8` and `1b2cfff` are docs-only (PR #41 census, PR #42 Claude.md).
Every file/line citation in [census-8.md](docs/reads/census-8.md) resolves
unchanged at this SHA. Census figures are therefore expected to reproduce up to
**data growth since 2026-08-28** only.

**P2 — role identity.**

```sql
select now(), current_user, current_setting('is_superuser');
-- → 2026-09-04 21:30:03.51525+00 | weave_readonly | off
select rolname, rolbypassrls, rolsuper from pg_roles where rolname = current_user;
-- → weave_readonly | f | f
```

**P3 — RO visibility on every table counted.** `weave_readonly` is neither
superuser nor `BYPASSRLS`; visibility rests entirely on the
`readonly_audit_select` policy (`using (true)`). Verified present on **13/13**
public base tables, including every table this read touches (`weave_events`,
`weave_embeddings`, `nodes`, `edges`, `voice_sessions`, `voice_utterances`,
`weave_profile_snapshots`). Counts below are whole-table, not RLS-filtered.

```sql
select c.relname, c.relrowsecurity as rls_enabled,
       bool_or(p.polname = 'readonly_audit_select'
               and pg_get_expr(p.polqual, p.polrelid) = 'true') as ro_sees_all
from pg_class c join pg_namespace n on n.oid = c.relnamespace
left join pg_policy p on p.polrelid = c.oid
where n.nspname = 'public' and c.relkind = 'r'
group by c.relname, c.relrowsecurity order by 1;
-- → 13 rows, ro_sees_all = t on all 13. rls_enabled = t on 12;
--   edges_dedup_backup_028 has rls_enabled = f (not used by this read).
```

**P4 — QA/test marker on `weave_events`.** Verbatim answer: **`weave_events`
carries no QA column of its own.** The only path to `session_kind` is
`weave_events.voice_session_id → voice_sessions.id` (nullable, no FK, migration
025). Every `weave_events` row belongs to a single `user_id`
(`92fcfcc8-fac9-466f-be22-afdfa71b9102`), which is also the sole `user_id` on
both real and QA `voice_sessions` — so `user_id` cannot separate QA from real.
`voice_sessions` has no `board_id` column, so board membership cannot be
derived from QA sessions directly either.

```sql
select coalesce(vs.session_kind,
         case when e.voice_session_id is null then '(null voice_session_id)' else '(dangling)' end) as kind,
       count(*)
from weave_events e left join voice_sessions vs on vs.id = e.voice_session_id
group by 1 order by 2 desc;
-- → (null voice_session_id) 2540 | qa 115 | real 50

select 'weave_events' as src, user_id::text, count(*) from weave_events group by 1,2
union all
select 'voice_sessions:'||session_kind, user_id::text, count(*) from voice_sessions group by 1,2;
-- → weave_events 92fcfcc8-… 2705 | voice_sessions:qa 92fcfcc8-… 62 | voice_sessions:real 92fcfcc8-… 25
```

Consequence for this read: a row of any of the six weighted event types is
QA-attributable **only if** its `voice_session_id` is non-null and joins to a
`session_kind = 'qa'` row. §1.3 (B3) and §2.5 test exactly that predicate and
report whether it is ever satisfiable for these types.

**P5 — no write grants.**

```sql
select table_name, string_agg(privilege_type, ',') from information_schema.role_table_grants
where grantee = current_user group by 1 order by 1;
-- → 15 rows, every row = SELECT only (13 tables + 2 views).
```

**Tooling.** `psql` 18.4, `node` v20, `supabase` CLI already present. Nothing
installed. No Postgres driver exists in `node_modules` (`pg`, `postgres` absent),
so the reproduction script (§1.2) consumes `psql` CSV exports rather than
connecting itself.

---

## 1. Question 1 — D7: why resolved keys miss `weightMap`

### 1.1 Code of record (read before any SQL)

`weave_events` has exactly one reader outside migrations:
[generate-profile-snapshot.ts:387](netlify/functions/generate-profile-snapshot.ts:387).
The census's sole-reader precondition (`C18`: no view or user trigger) was not
re-run; the file/line map is unchanged (P1).

**Resolution side — node grain** ([:152-158](netlify/functions/generate-profile-snapshot.ts:152)):

```ts
function resolveNodeTarget(event: WeaveEvent): string[] {
  if (!event.target_id) return []
  // Format: "node:{board_id}:{node_id}"
  // Only accept the prefixed form; reject connection and legacy formats.
  if (!event.target_id.startsWith('node:')) return []
  return [event.target_id.slice('node:'.length)]
}
```

**Resolution side — edge grain → both endpoints** ([:114-121](netlify/functions/generate-profile-snapshot.ts:114),
identical body at [:125-132](netlify/functions/generate-profile-snapshot.ts:125)):

```ts
resolve: (e) => {
  if (!e.target_id) return []
  // Format: "connection:{board_id}:{from}:{to}"
  const parts = e.target_id.split(':')
  if (parts.length !== 4 || parts[0] !== 'connection') return []
  const [, boardId, fromId, toId] = parts
  return [`${boardId}:${fromId}`, `${boardId}:${toId}`]
},
```

**Map side — key construction** ([:370](netlify/functions/generate-profile-snapshot.ts:370)):

```ts
compositeKey: `${row.board_id}:${row.node_id}`,
```

**Map side — row selection** ([:326-334](netlify/functions/generate-profile-snapshot.ts:326)
and [:346-350](netlify/functions/generate-profile-snapshot.ts:346)):

```ts
// Step 1: boardIds = every distinct board_id in weave_embeddings — NO archived filter
const { data: boardRows } = await supabase.from('weave_embeddings').select('board_id')
boardIds = [...new Set((boardRows ?? []).map((r) => r.board_id))]
// Step 2: the map population
const { data: embeddingRows } = await supabase
  .from('weave_embeddings')
  .select('board_id, node_id, node_type, embedding, content_summary')
  .in('board_id', boardIds)
  .is('archived_at', null)
```

followed by `parseEmbedding` ([:181-202](netlify/functions/generate-profile-snapshot.ts:181)):
a row whose `embedding` is not a JSON-parseable array string is excluded and
counted in `nodes_excluded_no_embedding`. So the map filters are exactly:
**(a) `archived_at is null`, (b) embedding parseable**. There is no user
scope (service role), and the board scope is a no-op for the map (the board
list is derived from the same table). The table of record for "nodes that
exist" is `weave_embeddings`, by the file's own header
([:1-9](netlify/functions/generate-profile-snapshot.ts:1)); the `nodes` table
(uuid ids, no `archived_at` column) is not read by the pipeline at all.

**The lookup and the miss** ([:429-435](netlify/functions/generate-profile-snapshot.ts:429)):

```ts
for (const key of attributedKeys) {
  if (key in weightMap) {
    weightMap[key] += perEventWeight
    contributed = true
  }
  // If key not in weightMap, the node had no embedding — already excluded
}
```

Confirmed: no `console.*`, no counter, no `generation_metadata` field on the
miss path. The comment's claim ("the node had no embedding") is tested in §1.3.

**Gate before the lookup** ([:424-426](netlify/functions/generate-profile-snapshot.ts:424)):
`if (perEventWeight <= 0) continue` — a `lightbox_closed` with null/zero
`duration_ms` never reaches the lookup. Measured: zero such rows today (`X4`).

**Window/limit on the events read** ([:386-389](netlify/functions/generate-profile-snapshot.ts:386)):

```ts
.from('weave_events').select('*').in('board_id', boardIds)
```

Two consequences. (1) **Board scope:** events on boards with no
`weave_embeddings` row at all are never read. (2) **hypothesis, untestable
from the database:** there is no `.range()`/`.limit()`; supabase-js inherits
the project's PostgREST `max-rows`, whose default is 1,000. In-scope events
number 2,642 (§1.2). If prod's `max-rows` is at default, the pipeline reads
only the first 1,000 events, unordered. That setting is project API
configuration, not a database object — nothing `weave_readonly` can see
answers it. Recorded as a hypothesis for revival, not a finding.

**Key expressions compared.** Both sides produce `<board_id>:<node_id>` with a
single `:` separator, same ordering, no casing or type coercion on either side
(`board_id` and `node_id` are `text` columns; `target_id` is `text`). No
structural drift; B1/B2 are expected to be zero and are still tested.

**Population shapes (the facts the tests above rely on):**

```sql
-- T1: every weighted-type target_id is well-formed today
select event_type, split_part(target_id,':',1) as prefix, array_length(string_to_array(target_id,':'),1) as segs, count(*)
from weave_events where event_type in ('connection_label_clicked','connection_description_closed','item_added','lightbox_opened','lightbox_closed','node_selected')
group by 1,2,3 order by 1;
-- → connection_* : prefix 'connection', 4 segments (454, 504); the four node types: prefix 'node', 3 segments (125, 131, 135, 139). No other shape, no nulls.

-- T3: the map-side population
select (archived_at is null) as live, (embedding is null) as emb_null, count(*) from weave_embeddings group by 1,2;
-- → live=f emb_null=f 30 | live=t emb_null=f 71        (no null embeddings; map size = 71)
select count(*) as rows, count(distinct board_id||':'||node_id) as distinct_keys, count(distinct board_id) as boards from weave_embeddings;
-- → 101 | 101 | 12                                        (no duplicate composites)
select left(embedding::text,1), count(*) from weave_embeddings where embedding is not null group by 1;
-- → '[' 101                                                 (all JSON-array strings; parseEmbedding accepts all)

-- X4: the weight gate never fires today
select count(*) filter (where duration_ms is null or duration_ms <= 0) as zero_weight, count(*) from weave_events where event_type='lightbox_closed';
-- → 0 | 131
```

**Entanglement (constraint 2).** Nothing in the module is exported except the
default handler and `config`. `ENGAGEMENT_RULES`, `resolveNodeTarget`, the map
build and the lookup are closures inside the same function body as the
`weave_profile_snapshots` insert ([:539-543](netlify/functions/generate-profile-snapshot.ts:539)).
They cannot be invoked without the insert. **The real functions were not
called.** §1.2 uses a scratch script (Appendix A) carrying those lines
verbatim, fed by `psql` exports of the two tables the pipeline reads, with
instrumentation only around the `key in weightMap` test. The verbatim copy is
the assumption every §1 count rests on.

### 1.2 Reproduced totals

Two scopes are reported, because the census (`C17`) counted every event in the
table while the code path reads only board-scoped events:

| scope | definition |
|---|---|
| **census** | all `weave_events` rows of the six rule types; no weight gate (matches `C17`) |
| **pipeline** | rows with `board_id` in the embeddings board list; weight gate applied before lookup (the code path at `:386-435`) |

```bash
# exports (read-only), then the verbatim-copy script — Appendix A
psql "$WEAVE_PROD_RO_DATABASE_URL" -X -At -c "select json_agg(row_to_json(e)) from (select id, event_type, target_id, board_id, session_id, timestamp, duration_ms, metadata, voice_session_id from weave_events order by timestamp, id) e" > $S/events.json
psql "$WEAVE_PROD_RO_DATABASE_URL" -X -At -c "select json_agg(row_to_json(w)) from (select board_id, node_id, node_type, embedding::text as embedding, content_summary, archived_at, created_at from weave_embeddings order by created_at) w" > $S/embeddings.json
node $S/d7-reproduce.mjs $S
```

```json
{ "boards_in_scope": 12, "map_size": 71, "nodesExcludedNoEmbedding": 0,
  "events_total": 2705, "events_in_board_scope": 2642, "events_never_read": 63,
  "census_scope":   { "resolved": 2446, "hits": 2058, "misses": 388 },
  "pipeline_scope": { "resolved": 2433, "hits": 2058, "misses": 375, "zero_weight_keys_gated_before_lookup": 0 } }
```

**Expected count, derived independently** (`T0` row counts × keys per event):

```sql
select event_type, count(*) from weave_events group by 1 order by 2 desc;
-- connection_label_clicked 504 | connection_description_closed 454 | node_selected 139
-- lightbox_opened 135 | lightbox_closed 131 | item_added 125   (other types omitted)
```

2·(504 + 454) + (139 + 135 + 131 + 125) = 1,916 + 530 = **2,446** ✅ = script
census-scope `resolved`. Pipeline scope: 2,446 − 13 keys on never-read boards
(`F8`: 4 `item_added` + 9 `node_selected`) = **2,433** ✅.

```sql
-- F8: weighted-type events on boards with no weave_embeddings row (never read by the pipeline)
select event_type, count(*) from weave_events e
where event_type in ('connection_label_clicked','connection_description_closed','item_added','lightbox_opened','lightbox_closed','node_selected')
  and not exists (select 1 from weave_embeddings w where w.board_id = e.board_id) group by 1;
-- → item_added 4 | node_selected 9
```

**Versus census (2026-08-28, `ff0b4f8`):**

| | census | now (census scope) | delta | now (pipeline scope) |
|---|---:|---:|---:|---:|
| resolved keys | 2,421 | **2,446** | +25 | 2,433 |
| hits (live embedding) | 2,033 | **2,058** | +25 | 2,058 |
| misses | 388 | **388** | 0 | **375** |
| miss rate | 16.0% | 15.9% | | 15.4% |

The +25 is exactly the event growth since the census: +5 clicks, +4 closes,
+3 `lightbox_opened`, +3 `lightbox_closed`, +1 `node_selected` → 2·9 + 7 = 25.
Every new key hit a live embedding; the miss population is unchanged. Code
delta is nil (P1). **The census figures reproduce.** The 13-key difference
between scopes is the board-scope filter at `:389`, which the census did not
apply — those 13 keys are never looked up, so they are not D7 drops; they are
listed for reconciliation and classified in §1.3 alongside the primary
population.

**M (primary, pipeline scope) = 375.** Census-scope M = 388 is partitioned in
parallel so the census's 359/29 split has a direct successor.

### 1.3 Partition (ordered, first-match, exhaustive)

Two facts constrain the bucket definitions and are established before the
tests run:

```sql
-- X2: node_id is a per-board counter, not a global id
select count(*) as rows, count(distinct node_id) as distinct_node_ids,
       count(distinct board_id||':'||node_id) as distinct_composites, min(node_id::int), max(node_id::int)
from weave_embeddings;
-- → 101 | 31 | 101 | 2 | 39
```

`node_id` values are small integers reused on every board (31 distinct values
across 101 rows, 12 boards). A node is therefore identified **only** by the
composite `(board_id, node_id)`; a bare `node_id` match against another board
is coincidence, not the same node. B4/B5 below test the composite. The
dispatch's B6 ("node present in map under a different board") is reported under
both readings — composite (0 by construction, because B5 fires first) and
literal (coincidental id reuse) — so the "#5 asymmetry" hypothesis is visible
rather than defined away.

```sql
-- F1: map-side key component shapes (regex source for B1)
select length(board_id) as blen, board_id ~ '^[0-9a-f-]{36}$' as b_uuid, length(node_id) as nlen, count(*)
from weave_embeddings group by 1,2,3;
-- → 36 | t | 2 | 52 ;  36 | t | 1 | 49     (all node_id digits — verified in the script: allMapNodeIdsDigits=true)
```

B1 pattern: `^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:\d+$`.

```bash
node $S/d7-partition.mjs $S pipeline    # Appendix B
node $S/d7-partition.mjs $S census
```

```text
== pipeline: M=375, allMapNodeIdsDigits=true, distinct node_id in map=31 over 101 rows
buckets {"B4":359,"B5":16} sum 375
bucket x event_type {"B4|item_added":41,"B4|connection_label_clicked":131,"B4|connection_description_closed":116,"B4|node_selected":43,"B4|lightbox_opened":14,"B4|lightbox_closed":14,"B5|node_selected":3,"B5|connection_label_clicked":7,"B5|connection_description_closed":6}
bucket x detail {"B4|event_before_archive":359,"B5|board_known_node_unknown|nodeid_exists_elsewhere":16}
B4 x node_type(emb) {"linkCard":303,"textCard":36,"not-B4":16,"imageCard":20}
misses by event_type (independent recount) {"item_added":41,"connection_label_clicked":138,"connection_description_closed":122,"node_selected":46,"lightbox_opened":14,"lightbox_closed":14}
distinct missed keys 35 distinct B5 keys 5
B8/B1/B2/B3/B7 rows: []

== census: M=388, allMapNodeIdsDigits=true, distinct node_id in map=31 over 101 rows
buckets {"B4":359,"B5":29} sum 388
bucket x event_type {"B4|item_added":41,"B4|connection_label_clicked":131,"B4|connection_description_closed":116,"B4|node_selected":43,"B4|lightbox_opened":14,"B4|lightbox_closed":14,"B5|item_added":4,"B5|node_selected":12,"B5|connection_label_clicked":7,"B5|connection_description_closed":6}
bucket x detail {"B4|event_before_archive":359,"B5|board_unknown|nodeid_exists_elsewhere":13,"B5|board_known_node_unknown|nodeid_exists_elsewhere":16}
misses by event_type (independent recount) {"item_added":45,"connection_label_clicked":138,"connection_description_closed":122,"node_selected":55,"lightbox_opened":14,"lightbox_closed":14}
distinct missed keys 39 distinct B5 keys 9
B8/B1/B2/B3/B7 rows: []
```

| # | bucket | test applied | pipeline M=375 | census M=388 |
|---|---|---|---:|---:|
| B1 | key-format drift | key fails the B1 regex | **0** | 0 |
| B2 | grain mismatch | well-formed but ≠ 2 segments | **0** | 0 |
| B3 | QA/test leakage | source event `voice_session_id` joins to `session_kind='qa'` | **0 — untestable, not absent** (see below) | 0 |
| B4 | target archived | composite exists in `weave_embeddings`, `archived_at is not null` | **359** (95.7%) | 359 (92.5%) |
| B5 | target not found | composite matches no `weave_embeddings` row | **16** (4.3%) | 29 (7.5%) |
| B6 | cross-board composite miss | composite absent, bare `node_id` live under another board (composite reading) | **0** by construction | 0 |
| B7 | excluded by other map filter | composite exists, not archived, but not in map (embedding null/unparseable) | **0** | 0 |
| B8 | unclassified | remainder | **0** | 0 |
| | **sum** | | **375** ✅ | **388** ✅ |

**B3 is untestable, not absent.** P4 established the only QA marker
(`voice_session_id → session_kind`). None of the six weighted types ever
carries it:

```sql
-- F3
select event_type, count(*) filter (where voice_session_id is not null) as with_vsid, count(*) as total
from weave_events where event_type in ('connection_label_clicked','connection_description_closed','item_added','lightbox_opened','lightbox_closed','node_selected') group by 1;
-- → with_vsid = 0 on all six (504, 454, 125, 135, 131, 139)
```

`user_id` is uniform across the table (P4), so no identity-based marker exists
either. QA leakage into weighting cannot be measured from `weave_events` today.

**B6 under the literal reading.** Every one of the 16 (pipeline) / 29 (census)
B5 keys has its bare `node_id` present under some other board
(`nodeid_exists_elsewhere` on all rows in the script output). With 31 distinct
ids over 12 boards this is expected by pigeonhole and carries no information
about the node. The "#5 asymmetry" — same node reachable under two board keys —
has **no instance** in this population: no missed composite corresponds to a
live row that differs by board only *and* denotes the same node, because
`node_id` does not denote a node without its board.

**Independent SQL cross-check** (composite join, per source type, census scope):

```sql
-- X1
with resolved as (
  select event_type, board_id as ev_board,
         unnest(case when event_type like 'connection%'
      then array[split_part(target_id,':',2)||':'||split_part(target_id,':',3),
                 split_part(target_id,':',2)||':'||split_part(target_id,':',4)]
      else array[substring(target_id from 6)] end) as ckey
  from weave_events
  where event_type in ('connection_label_clicked','connection_description_closed',
                       'item_added','lightbox_opened','lightbox_closed','node_selected')
    and target_id is not null)
select event_type, count(*) as resolved,
       count(*) filter (where live.node_id is not null) as hit_live,
       count(*) filter (where live.node_id is null and anyr.node_id is not null) as b4_archived,
       count(*) filter (where anyr.node_id is null) as b5_absent,
       count(*) filter (where anyr.node_id is null and not exists
         (select 1 from weave_embeddings w where w.board_id = r.ev_board)) as b5_board_unknown
from resolved r
left join weave_embeddings live on live.board_id||':'||live.node_id = r.ckey and live.archived_at is null
left join weave_embeddings anyr on anyr.board_id||':'||anyr.node_id = r.ckey
group by 1 order by 1;
```

| event_type | resolved | hit_live | B4 archived | B5 absent | of which board unknown |
|---|---:|---:|---:|---:|---:|
| `connection_description_closed` | 908 | 786 | **116** | **6** | 0 |
| `connection_label_clicked` | 1,008 | 870 | **131** | **7** | 0 |
| `item_added` | 125 | 80 | **41** | **4** | 4 |
| `lightbox_closed` | 131 | 117 | **14** | **0** | 0 |
| `lightbox_opened` | 135 | 121 | **14** | **0** | 0 |
| `node_selected` | 139 | 84 | **43** | **12** | 9 |
| **sum** | **2,446** | **2,058** | **359** | **29** | **13** |

Second cardinality gate: script per-type miss recount (census scope)
`item_added 45, connection_label_clicked 138, connection_description_closed 122, node_selected 55, lightbox_opened 14, lightbox_closed 14` = 388 ✅;
each equals the SQL row's B4 + B5 (41+4, 131+7, 116+6, 43+12, 14+0, 14+0) ✅.
Pipeline scope removes exactly the 13 board-unknown B5 keys
(`item_added` 45→41, `node_selected` 55→46) ✅.

**B4 by source event type (pipeline scope, the roster-bleed view):**

| source `event_type` | B4 keys | in v2 roster? |
|---|---:|---|
| `connection_label_clicked` | 131 | no (still emitted) |
| `connection_description_closed` | 116 | **yes** (edge grain → both endpoints) |
| `node_selected` | 43 | no |
| `item_added` | 41 | **yes** |
| `lightbox_opened` | 14 | no |
| `lightbox_closed` | 14 | **yes** |

B4 by the archived row's `node_type`: linkCard 303, textCard 36, imageCard 20
(= 359 ✅). B4 by timing — **every one of the 359 events precedes the row's
`archived_at`**:

```sql
-- X3
with resolved as (
  select e.id, e.event_type, e.timestamp as ts,
         unnest(case when event_type like 'connection%'
      then array[split_part(target_id,':',2)||':'||split_part(target_id,':',3),
                 split_part(target_id,':',2)||':'||split_part(target_id,':',4)]
      else array[substring(target_id from 6)] end) as ckey
  from weave_events e
  where event_type in ('connection_label_clicked','connection_description_closed','item_added','lightbox_opened','lightbox_closed','node_selected'))
select (r.ts > w.archived_at) as event_after_archive, count(*)
from resolved r join weave_embeddings w on w.board_id||':'||w.node_id = r.ckey and w.archived_at is not null
group by 1;
-- → f | 359          (no row with t)
select min(archived_at), max(archived_at), count(*) from weave_embeddings where archived_at is not null;
-- → 2026-04-25 18:25:37 | 2026-08-14 01:13:57 | 30
```

All 30 archived embedding rows carry engagement (35 distinct missed keys in
pipeline scope = 30 archived + 5 B5). Nothing engages an already-archived node.

**B5 by source event type:** pipeline scope — `connection_label_clicked` 7,
`connection_description_closed` 6, `node_selected` 3 (= 16 ✅), all on one
board; census scope adds `item_added` 4 + `node_selected` 9 on a second board
with no embeddings at all (= 29 ✅). Nine distinct keys in total:

```sql
-- Y1/Y2/Y4/Y9 condensed: the two B5 boards
select node_id, node_type, created_at, archived_at from weave_embeddings
 where board_id='64bc0982-479c-4b8e-9a1e-9df59a14c866' order by node_id::int;
-- → 10 rows, node_id 10..23, first created 2026-04-30 23:42, all archived 2026-06-15 01:28
select min(created_at) from weave_embeddings;                     -- → 2026-04-25 18:12:09 (pipeline birth)
select (select count(*) from boards where id::text='aa4183ba-b741-436f-8c5d-e744c8d0b39e') as in_boards,
       (select count(*) from boards where id::text='64bc0982-479c-4b8e-9a1e-9df59a14c866') as b64_in_boards;
-- → 0 | 0   (neither board exists in the newer boards/nodes persistence either)
```

| B5 key (`board:node`) | first event | last event | `item_added` row | `item_deleted` row |
|---|---|---|---:|---:|
| `64bc0982…:2` | 2026-05-16 | 2026-05-16 | 0 | 0 |
| `64bc0982…:3` | 2026-05-06 | 2026-05-06 | 0 | **1** |
| `64bc0982…:4` | 2026-05-06 | 2026-05-06 | 0 | **1** |
| `64bc0982…:6` | 2026-05-16 | 2026-05-16 | 0 | 0 |
| `64bc0982…:8` | 2026-05-06 | 2026-05-16 | 0 | 0 |
| `aa4183ba…:10` | 2026-04-26 | 2026-04-26 | 1 | 0 |
| `aa4183ba…:11` | 2026-04-26 | 2026-04-26 | 1 | **1** |
| `aa4183ba…:13` | 2026-04-26 | 2026-04-26 | 1 | **1** |
| `aa4183ba…:15` | 2026-04-26 | 2026-04-26 | 1 | **1** |

(Query in the map: `Y9b`.) All nine are April–May 2026 nodes on two boards
whose embedding coverage starts at `node_id` 10 on 2026-04-30 (board
`64bc0982`) or never (board `aa4183ba`). Five of nine have an `item_deleted`
row from the pre-037 hard-delete era. Whether the other four were never
embedded or hard-deleted without a tracked delete is **not distinguishable from
prod state** — flag-never-delete (037) arrived 2026-08-14, after every event
here. No B5 key dates from after 037.

### 1.4 Findings

**F-D7.1 — B4 = 359 (95.7% of 375): keys whose composite exists in
`weave_embeddings` with `archived_at not null`; the map builder filters
`.is('archived_at', null)` at [:350](netlify/functions/generate-profile-snapshot.ts:350).**
Sources: 131 `connection_label_clicked`, 116 `connection_description_closed`,
43 `node_selected`, 41 `item_added`, 14 `lightbox_opened`, 14 `lightbox_closed`.
Every event predates its node's archival. This is **legitimate exclusion**
(engagement with a node the user later archived), not signal loss — but the
code's own comment at `:434` ("the node had no embedding") misdescribes it: all
359 have an embedding row; they are archived, not absent.

**F-D7.2 — B5 = 16 (4.3%): keys with no `weave_embeddings` row under any
archival state.** Sources: 7 clicks, 6 closes, 3 `node_selected`, five keys on
one board, April–May 2026, pre-037. Legitimate exclusion in the sense that
nothing exists to attribute to; the cause (never embedded vs. hard-deleted
before flag-never-delete) is unrecoverable. The 13 further census-scope B5 keys
are on a board with no embeddings at all and are never read by the pipeline
(board-scope filter at `:389`), so they are not D7 drops.

**F-D7.3 — B1, B2, B6, B7, B8 = 0 (measured, not assumed).** No key-format
drift, no grain confusion, no cross-board asymmetry, no embedding-parse
exclusion. The two key expressions are identical in form and the population
confirms it. B3 = 0 is **untestable**: the six weighted types never carry
`voice_session_id`, and `user_id` is uniform.

**F-D7.4 — the miss is one cause with one long tail.** A D7 drop counter
keyed on `archived` vs `absent` would account for 375/375 today. Anything finer
(format, grain, cross-board) would read zero against current prod.

---

## 2. Question 2 — orphan `connection_label_clicked` rows

### 2.1 Population

```sql
select event_type, count(*) filter (where session_id is null) as null_sess,
       count(*) filter (where target_id is null) as null_target, count(*)
from weave_events where event_type in ('connection_label_clicked','connection_description_closed','lightbox_opened','lightbox_closed') group by 1;
-- → connection_description_closed 0 | 0 | 454
--   connection_label_clicked      0 | 0 | 504
--   lightbox_closed               0 | 0 | 131
--   lightbox_opened               0 | 0 | 135
```

| | census (08-28) | now | delta |
|---|---:|---:|---:|
| \|C\| `connection_label_clicked` | 499 | **504** | +5 |
| \|X\| `connection_description_closed` | 450 | **454** | +4 |
| net gap \|C\| − \|X\| | 49 | **50** | +1 |

`session_id` and `target_id` are both `not null`/never null here, so O1 = 0 by
schema (`session_id` is `NOT NULL`; `target_id` nullable but never null for
these types). Ordering: `(timestamp, id)`; no two C/X rows share a
`(session_id, timestamp)` (`F4` → 0 ties), so the tiebreak is never exercised.

**Timestamp semantics matter for §2.6:** `weave_events.timestamp` is
`default now()` ([001_create_weave_events.sql:10](supabase/migrations/001_create_weave_events.sql:10))
and `trackEvent` only overrides it for `weave_triggered`
([eventTracker.ts:45](src/services/eventTracker.ts:45)). Every C/X/lightbox row
is stamped at **insert arrival**, by fire-and-forget async inserts. Order in
the table is arrival order, not emission order.

### 2.2 Pairing rule

Stated verbatim: *within a session, order all C and X rows by `(timestamp,
id)`. Each click pairs with the first subsequent `connection_description_closed`
in the same session with the same `target_id` that has not already been
consumed by an earlier click* (FIFO within `(session_id, target_id)`).

Implementation (`Q2`, parameterised by `:open`/`:close`; full text in the query
map): per `(session_id, target_id)` group, `d = closes_so_far − clicks_so_far`
(inclusive); `unmatched_closes_so_far = greatest(0, running max of d)`; a close
is matched iff that running value did not increase at its row; the k-th click
of the group is paired iff `k ≤ matched closes in the group`. Session-level
neighbours (`next_type`, `next_target`) come from `lead()` over the C/X stream
of the session regardless of target.

### 2.3 Classification of unpaired clicks

```sql
-- Q2 with :open='connection_label_clicked', :close='connection_description_closed'
with q as (…Q2…) select side, bucket, count(*) from q group by 1,2 order by 1,2;
```

| side | bucket | count | test |
|---|---|---:|---|
| click | **paired** | **452** | |
| click | O1 unpairable | **0** | null session/target |
| click | O2 re-click switching | **0** | next C/X is a click on a different target, no close for this target ever follows |
| click | O3 re-click same target | **1** | next C/X is a click on the same target |
| click | O4 session-terminal | **49** | no later C/X in session |
| click | O5 lost close, mid-session | **2** | later C/X exists, none of O2–O4 |
| click | O6 unclassified | **0** | |
| close | matched | **452** | |
| close | **unmatched** | **2** | no preceding unconsumed click |

**Click side:** 452 + 0 + 0 + 1 + 49 + 2 + 0 = **504** = |C| ✅.
**Close side:** 452 + 2 = **454** = |X| ✅.
**Orphans = 52** (10.3% of clicks); unmatched closes = 2; net 50 = |C| − |X| ✅.

**Independent check without the pairing machinery** — for every click, the
kind of the next C/X row in its session:

```sql
-- Z3
select case when n.event_type is null then '(none)'
            when n.event_type='connection_label_clicked' and n.target_id=c.target_id then 'click same target'
            when n.event_type='connection_label_clicked' then 'click different target'
            when n.target_id=c.target_id then 'close same target'
            else 'close different target' end as next_cx, count(*)
from (select id, session_id, target_id, timestamp from weave_events where event_type='connection_label_clicked') c
left join lateral (select event_type, target_id from weave_events e where e.session_id=c.session_id
   and e.event_type in ('connection_label_clicked','connection_description_closed')
   and (e.timestamp,e.id)>(c.timestamp,c.id) order by e.timestamp, e.id limit 1) n on true
group by 1 order by 2 desc;
-- → close same target 449 | (none) 49 | click different target 2 | click same target 2 | close different target 2
```

449 + 49 + 2 + 2 + 2 = 504 ✅. The 49 with no successor are O4 exactly. The six
non-standard successors are listed key-by-key (`Z6`):

| session | click | target (`board:from:to`) | next C/X | Δ | disposition |
|---|---|---|---|---:|---|
| `95101656` | 05-22 06:24:40.45 | `b3c1473b…:4:9` | click `…:4:8` | 0.78 s | **switch**; close for `4:9` arrives 1.13 s later → paired |
| `95101656` | 05-22 06:24:41.23 | `b3c1473b…:4:8` | close `…:4:9` | 1.13 s | paired (its own close follows) |
| `205137bc` | 05-31 04:43:15.459 | `26a0a954…:4:7` | click `…:4:7` | 2.11 s | **O3** — see §2.6 |
| `a273f49b` | 05-31 20:56:45.149176 | `26a0a954…:4:7` | click `…:4:7` | **14 µs** | paired; the 14 µs twin is a double emission |
| `bf715018` | 07-11 07:02:55.36 | `b3c1473b…:22:3` | click `…:22:6` | 19.9 s | **switch**; close for `22:3` arrives 27 µs after the new click → paired |
| `bf715018` | 07-11 07:03:15.273516 | `b3c1473b…:22:6` | close `…:22:3` | **27 µs** | **O5** — terminal after a switch |

**O2 = 0 is structural, not incidental.** `EdgeDetailPopup` renders a
full-viewport overlay whose click handler *is* `onClose`
([EdgeDetailPopup.tsx:580](src/components/EdgeDetailPopup.tsx:580)), and `onClose`
is `closeEdgeDetail`, which emits the close ([App.tsx:305](src/App.tsx:305)). A
click anywhere while the popup is open — including on another label — closes
the current popup with an emitted event first. Both observed switches
(`95101656`, `bf715018`) confirm it: the first edge's close was emitted. The
"re-click switching loses the first close" hypothesis in the dispatch is
**refuted** on both code and data.

**O4 = 49 — what follows each terminal click** (`Z4`, `Z5`, `Z7`):

```sql
-- Z5 / Z7 (orphans CTE = clicks with no later C/X in session)
select count(*) as o4,
  count(*) filter (where not exists (select 1 from weave_events e where e.session_id=o.session_id and (e.timestamp,e.id)>(o.timestamp,o.id))) as last_event_of_session,
  count(*) filter (where exists (select 1 from weave_events e where e.session_id=o.session_id and e.event_type like 'voice%' and (e.timestamp,e.id)>(o.timestamp,o.id))) as voice_event_follows,
  count(*) filter (where exists (select 1 from weave_events e where e.session_id=o.session_id and e.event_type='session_ended' and (e.timestamp,e.id)>(o.timestamp,o.id))) as session_ended_follows,
  count(*) filter (where exists (select 1 from weave_events e where e.session_id=o.session_id and e.event_type in ('board_switched','weave_triggered','item_deleted','board_created') and (e.timestamp,e.id)>(o.timestamp,o.id))) as programmatic_close_path_follows
from orphans o;
-- → 49 | 16 | 31 | 5 | 0
```

| after the terminal click, in-session | count |
|---|---:|
| a voice event follows (`voice.session.started` 27, `voice_insight_played` 4), then no further C/X | **31** |
| nothing at all — the click is the session's last row | **16** |
| `session_ended` directly | 2 (5 in total have a `session_ended` somewhere after) |
| `board_switched` / `weave_triggered` / `item_deleted` / `board_created` | **0** |

The last row rules out the three **non-emitting** programmatic close paths in
code — board switch ([App.tsx:198](src/App.tsx:198)), weave result/clear
([App.tsx:647](src/App.tsx:647), [:697](src/App.tsx:697)) — for all 49: none is
followed by the event those paths would leave. The popup survives a voice
session (session `a273f49b` shows click → voice start → voice end → close 1 s
later), so the 31 voice-followed cases are the popup left open after listening.
What remains is unmount without close: tab close or navigation, with
`session_ended` firing on only 5/49 (consistent with D3's 22% clean-unmount
rate). **From events alone, tab-close and a dropped close are
indistinguishable** — stated per the dispatch. What *is* established: no
switching, no programmatic close, and the popup's own three emitting paths
(overlay, Escape, button) were not taken.

**O5 = 2**, key-by-key: `a273f49b` click `4:7` at 20:57:08.70 (an
ordering artefact — §2.6) and `bf715018` click `22:6` at 07:03:15.273516 (the
terminal click of a switch — the session's last C/X row after it is the close
for the *previous* edge, 27 µs later). **O3 = 1**: `205137bc`, also an
ordering artefact (§2.6).

**Unmatched closes = 2**, key-by-key (`Z2`, `Z8`):

| session | close ts | target | nearest same-target click | where |
|---|---|---|---|---|
| `205137bc` | 05-31 04:43:15.274 | `26a0a954…:4:7` | **185 ms after** the close, same session | first C/X of the session |
| `a273f49b` | 05-31 20:56:45.135 | `26a0a954…:4:7` | **14 ms after** the close, same session | first C/X of the session |

Both are closes that landed in the table *before* the click that opened them.
Not cross-session: the nearest preceding click on that target in any session is
2.5 h / 14 h earlier.

### 2.4 Control — `lightbox_opened` / `lightbox_closed`

```sql
-- Q2 with :open='lightbox_opened', :close='lightbox_closed'
```

| side | bucket | count |
|---|---|---:|
| open | paired | **129** |
| open | O4 session-terminal | 5 |
| open | O5 | 1 |
| close | matched | 129 |
| close | unmatched | **2** |

129 + 5 + 1 = **135** = |opens| ✅; 129 + 2 = **131** = |closes| ✅.
Orphan rate **6/135 = 4.4%** vs. C/X **52/504 = 10.3%**; net gap 4 (3.0%) vs.
50 (9.9%) — the "~3%" baseline the census read the 10% against is the *net*
figure; the like-for-like orphan rates are 4.4% vs 10.3%. The lightbox O5 and
both unmatched closes are ordering artefacts of the same kind as §2.3's
(`b89442b5`: close 130 µs before its open; `9ca47de5`: close 389 µs before its
open at the session's end).

### 2.5 QA partition

**Q2 counts are un-partitioned by session kind, by construction.** No
`connection_label_clicked`, `connection_description_closed`, `lightbox_opened`
or `lightbox_closed` row carries `voice_session_id` (`F3`: 0 of 504 / 454 / 135
/ 131), and `user_id` is uniform (P4). A row-level real/QA split does not exist.

A **session co-occurrence** view is possible and is reported as such — it
says a browser session also contained a voice session of that kind, not that
the click was QA:

```sql
-- Z7b (clicks) / Z7 (O4 orphans): browser sessions containing a qa / real voice session
select count(*) as clicks,
  count(*) filter (where exists (select 1 from weave_events e join voice_sessions vs on vs.id=e.voice_session_id where e.session_id=c.session_id and vs.session_kind='qa')) as session_has_qa_voice,
  count(*) filter (where exists (select 1 from weave_events e join voice_sessions vs on vs.id=e.voice_session_id where e.session_id=c.session_id and vs.session_kind='real')) as session_has_real_voice,
  count(*) filter (where not exists (select 1 from weave_events e where e.session_id=c.session_id and e.voice_session_id is not null)) as session_has_no_voice
from weave_events c where c.event_type='connection_label_clicked';
```

| population | in a session with a QA voice session | with a real voice session | with no voice session |
|---|---:|---:|---:|
| all 504 clicks | 103 | 64 | 350 (13 clicks sit in sessions containing both kinds; columns overlap) |
| 49 O4 orphans | 14 | 6 | 30 (1 orphan sits in a session containing both; columns overlap) |

### 2.6 Ordering sensitivity (measurement hazard, not a finding about users)

All four unmatched closes across both pairs have a same-target open/click
landing **0.13 ms – 185 ms after** them in the same session (`Z8`):

```sql
select left(x.session_id,8) as sess, x.event_type, x.timestamp as close_ts, min(c.timestamp) - x.timestamp as next_same_target_open_after
from weave_events x join weave_events c on c.session_id=x.session_id and c.target_id=x.target_id and c.timestamp > x.timestamp
  and c.event_type = case x.event_type when 'connection_description_closed' then 'connection_label_clicked' else 'lightbox_opened' end
where x.id in ('ba30ea3a-8d49-47d4-9ed5-2369dd548d20','06c8241a-76d4-439d-ad1a-b97356453f86','d92b5a7e-a356-48b3-a839-2116050adca1','88dadfc2-5a28-497e-96a4-36a351001cf8')
group by 1,2,3 order by 3;
-- → 9ca47de5 lightbox_closed 389 µs | b89442b5 lightbox_closed 130 µs | 205137bc close 185 ms | a273f49b close 14 ms
```

In code a close cannot be emitted before its open (`closeEdgeDetail` requires
`popupEdge && edgeOpenedAtRef.current`, [App.tsx:300](src/App.tsx:300);
`closeLightbox` requires `lightboxOpenedAtRef.current !== null`,
[LinkCardNode.tsx:616](src/components/LinkCardNode.tsx:616)). These four rows
are therefore **insert-arrival reversals** of open/close bursts emitted within
the same tick (§2.1: `default now()`, async inserts). Each reversal manufactures
one unmatched close and one phantom orphan (O3 in `205137bc`, O5 in `a273f49b`,
O5 in `b89442b5`, one O4 in `9ca47de5`).

Re-pairing in emission order (each unmatched close re-attached to the click it
precedes by < 200 ms) gives, for C/X: paired 454, orphans 50 (49 O4 + the
`bf715018` switch-terminal), unmatched 0 — 454 + 50 = 504 ✅, 454 + 0 = 454 ✅;
for lightbox: paired 131, orphans 4, unmatched 0. This is reported as
sensitivity, not as the partition of record; the partition of record is §2.3
under the dispatch's stated ordering. Sub-second adjacency is common: 71 of 801
adjacent same-session C/X pairs are < 1 s apart, 2 are < 10 ms (`Z8b`).

### 2.7 Findings

**F-Q2.1 — The orphans are not re-click switching. O2 = 0 of 504, and the
overlay design makes switching emit the previous close.** Two switches were
observed; both closed the first edge.

**F-Q2.2 — 49 of 52 orphans are session-terminal: the popup was open when the
browser session ended, with no emitting or non-emitting close path taken.** In
31 the user had started voice from the popup first. Tab-close versus a dropped
insert is indistinguishable from events; the absence of `session_ended` in
44/49 is consistent with unmount-without-flush (D3), not with a lost insert
specifically.

**F-Q2.3 — The remaining 3 orphans and all 4 unmatched closes (both pairs)
are insert-order reversals of same-tick bursts, not user behaviour.** Any
pair-asymmetry counter that orders by `timestamp` will see them.

**F-Q2.4 — Like-for-like, the C/X orphan rate is 10.3% against a lightbox
control of 4.4%; the "3%" baseline was the lightbox net gap.** The excess is
entirely O4, and O4's dominant successor is a voice session (31/49), a path the
lightbox does not have.

---

## 3. Contradicts the dispatch / could not test

- **"Nodes table" with an archived flag.** The dispatch's B4/B5 wording assumes
  a nodes table carrying `archived_at`. In this codebase the map's table of
  record is `weave_embeddings` (per the pipeline's own header); the `nodes`
  table has uuid ids, no `archived_at`, and none of the nine B5 keys' boards
  exist in it. B4/B5 were evaluated against `weave_embeddings`.
- **"Node id" is not an identifier.** `node_id` is a per-board counter (31
  distinct values, 101 rows). B4/B5/B6 as literally worded ("key's node id
  exists…") would misclassify by coincidental reuse; the composite reading was
  applied and the literal reading reported alongside (§1.3).
- **Re-click switching is refuted, not merely small.** O2 = 0, and the
  overlay-as-close design excludes the mechanism.
- **The 388 reproduces exactly, but "resolved keys" moved to 2,446.** The
  census's 2,421 is the 08-28 population; +25 keys since then all hit. The
  pipeline-faithful population is 2,433 / 375 because of the board-scope
  filter the census did not apply.
- **The real resolver and map-builder could not be called** (not exported,
  co-resident with the insert). Verbatim copies were used; the SQL cross-check
  (`X1`) agrees cell-for-cell.
- **Session record format.** The dispatch says to match "the census session
  record from PR #41"; PR #41 contains only `docs/reads/census-8.md` and no
  session record (`git diff --stat ff0b4f8..468dda3`). The session record for
  this sitting follows `docs/session-record-2026-08-15.md` instead.
- **Untestable here:** B3 (no QA marker on weighted types); PostgREST
  `max-rows` on the events read (project config, not a database object);
  never-embedded vs. hard-deleted for the four B5 keys without an
  `item_deleted` row.

---

## 4. Query map (deduplicated; re-run at revival)

Reconnect: `psql "$WEAVE_PROD_RO_DATABASE_URL" -X`. `$S` is any scratch
directory outside the repo.

| id | measures | where used |
|---|---|---|
| `P2` | `now()`, `current_user`, `is_superuser`; `pg_roles` bypassrls/super | §0 |
| `P3` | `readonly_audit_select` present with `qual = true` on every public base table | §0 |
| `P4` | `weave_events` columns; `voice_session_id → session_kind` join counts; distinct `user_id` per table | §0 |
| `P5` | `role_table_grants` for `current_user` — SELECT only | §0 |
| `T0` | `weave_events` total and per-type counts (the expected-count source) | §1.2, §2.1 |
| `T1` | `target_id` prefix and segment count per weighted type | §1.1 |
| `T3` | `weave_embeddings` live/archived × embedding-null; distinct composites; duplicate composites (0) | §1.1 |
| `F1` | map-side key component shapes (B1 regex source) | §1.3 |
| `F3` | `voice_session_id` presence on the six weighted types (B3 testability, §2.5) | §1.3, §2.5 |
| `F4` | `(session_id, timestamp)` ties among C/X and among lightbox rows | §2.1 |
| `F8` | weighted-type events on boards absent from `weave_embeddings` (never read) | §1.2 |
| `F9` | null `session_id` / `target_id` on the four Q2 types | §2.1 |
| `X1` | composite-join coverage per type: hit / archived / absent / board-unknown (SQL cross-check of the partition) | §1.3 |
| `X2` | `node_id` cardinality vs composite cardinality | §1.3 |
| `X3` | events on archived keys, before vs after `archived_at`; archived row span | §1.3 |
| `X4` | `lightbox_closed` rows with null/zero `duration_ms` (weight gate) | §1.1 |
| `Y1` | embedding inventory of board `64bc0982…` | §1.3 |
| `Y4` | B5 boards' presence in `boards`/`nodes` | §1.3 |
| `Y9` | first `weave_embeddings.created_at` overall and per B5 board | §1.3 |
| `Y9b` | per B5 key: first/last event, `item_added`/`item_deleted` rows (text below) | §1.3 |
| `Q2` | FIFO pairing + orphan classification, parameterised (text below) | §2.3, §2.4 |
| `Z2` | for each unmatched close, nearest preceding same-target click in any session | §2.3 |
| `Z3` | next C/X kind after every click (pairing-free check) | §2.3 |
| `Z4` | per O4 orphan: next any-events, gap, same-target close in another session within 2 h | §2.3 |
| `Z5`/`Z7` | O4 aftermath counts: last-of-session, voice follows, `session_ended` follows, programmatic-close paths follow; session voice kind | §2.3, §2.5 |
| `Z6` | the six clicks whose next C/X is not "close same target" | §2.3 |
| `Z7b` | session voice kind for all clicks | §2.5 |
| `Z8` | unmatched closes: distance to the next same-target open | §2.6 |
| `Z8b` | adjacent same-session C/X gaps < 1 s / < 10 ms | §2.6 |
| script A | `d7-reproduce.mjs` — verbatim resolver/map/lookup over the two exports | §1.2 |
| script B | `d7-partition.mjs` — B1–B8 first-match partition, per-type and per-detail tallies | §1.3 |

**`Q2` (full text):**

```sql
-- psql -v open='connection_label_clicked' -v close='connection_description_closed'   (or lightbox_opened / lightbox_closed)
with ev as (
  select id, session_id, target_id, timestamp as ts, event_type,
         (event_type = :'open')::int as is_c, (event_type = :'close')::int as is_x
  from weave_events where event_type in (:'open', :'close')
), g as (
  select ev.*,
    sum(is_x) over w - sum(is_c) over w as d,
    row_number() over (partition by session_id, target_id, is_c order by ts, id) as ord_within_kind
  from ev window w as (partition by session_id, target_id order by ts, id rows unbounded preceding)
), g2 as (
  select g.*, greatest(0, max(d) over (partition by session_id, target_id order by ts, id rows unbounded preceding)) as unmatched_cum
  from g
), closes as (
  select g2.*, (unmatched_cum = coalesce(lag(unmatched_cum) over (partition by session_id, target_id order by ts, id), 0)) as matched
  from g2 where is_x = 1
), grp as (
  select session_id, target_id, count(*) filter (where matched) as matched_total from closes group by 1,2
), sess as (
  select id,
    lead(event_type) over (partition by session_id order by ts, id) as next_type,
    lead(target_id)  over (partition by session_id order by ts, id) as next_target
  from ev
), clicks as (
  select g2.id, g2.session_id, g2.target_id, g2.ts, g2.ord_within_kind,
         (g2.ord_within_kind <= coalesce(grp.matched_total, 0)) as paired,
         s.next_type, s.next_target,
         exists (select 1 from ev x where x.session_id = g2.session_id and x.target_id = g2.target_id
                   and x.is_x = 1 and (x.ts, x.id) > (g2.ts, g2.id)) as close_follows_for_target,
         (select e2.event_type from weave_events e2 where e2.session_id = g2.session_id and (e2.timestamp, e2.id) > (g2.ts, g2.id) order by e2.timestamp, e2.id limit 1) as next_any_event
  from g2 left join grp using (session_id, target_id) left join sess s on s.id = g2.id
  where g2.is_c = 1
), classified as (
  select c.*,
    case when paired then 'paired'
         when session_id is null or target_id is null then 'O1'
         when next_type = :'open' and next_target <> target_id and not close_follows_for_target then 'O2'
         when next_type = :'open' and next_target = target_id then 'O3'
         when next_type is null then 'O4'
         when next_type is not null then 'O5'
         else 'O6' end as bucket
  from clicks c
)
select 'click' as side, id, session_id, target_id, ts, bucket, next_type, next_target, close_follows_for_target, next_any_event from classified
union all
select 'close', id, session_id, target_id, ts, case when matched then 'matched' else 'unmatched' end, null, null, null, null from closes;
-- summaries: wrap as  with q as (…) select side, bucket, count(*) from q group by 1,2;
```

**`Y9b`:**

```sql
with b5 as (select unnest(array['64bc0982-479c-4b8e-9a1e-9df59a14c866:2','64bc0982-479c-4b8e-9a1e-9df59a14c866:3','64bc0982-479c-4b8e-9a1e-9df59a14c866:4','64bc0982-479c-4b8e-9a1e-9df59a14c866:6','64bc0982-479c-4b8e-9a1e-9df59a14c866:8','aa4183ba-b741-436f-8c5d-e744c8d0b39e:10','aa4183ba-b741-436f-8c5d-e744c8d0b39e:11','aa4183ba-b741-436f-8c5d-e744c8d0b39e:13','aa4183ba-b741-436f-8c5d-e744c8d0b39e:15']) as ckey)
select b5.ckey,
  (select min(timestamp) from weave_events e where e.target_id = 'node:'||b5.ckey or e.target_id like 'connection:'||split_part(b5.ckey,':',1)||':%' and (split_part(e.target_id,':',3)=split_part(b5.ckey,':',2) or split_part(e.target_id,':',4)=split_part(b5.ckey,':',2))) as first_event,
  (select max(timestamp) from weave_events e where e.target_id = 'node:'||b5.ckey or e.target_id like 'connection:'||split_part(b5.ckey,':',1)||':%' and (split_part(e.target_id,':',3)=split_part(b5.ckey,':',2) or split_part(e.target_id,':',4)=split_part(b5.ckey,':',2))) as last_event,
  (select count(*) from weave_events e where e.event_type='item_deleted' and e.target_id='node:'||b5.ckey) as item_deleted_rows,
  (select count(*) from weave_events e where e.event_type='item_added' and e.target_id='node:'||b5.ckey) as item_added_rows
from b5 order by 1;
```

## File/line map

| what | where |
|---|---|
| `ENGAGEMENT_RULES` (edge-grain resolvers) | [generate-profile-snapshot.ts:111-150](netlify/functions/generate-profile-snapshot.ts:111) |
| `resolveNodeTarget` | [:152-158](netlify/functions/generate-profile-snapshot.ts:152) |
| board list (no archived filter) | [:326-334](netlify/functions/generate-profile-snapshot.ts:326) |
| map population + `archived_at is null` | [:346-350](netlify/functions/generate-profile-snapshot.ts:346) |
| `parseEmbedding` exclusion | [:181-202](netlify/functions/generate-profile-snapshot.ts:181), [:362-368](netlify/functions/generate-profile-snapshot.ts:362) |
| map key construction | [:370](netlify/functions/generate-profile-snapshot.ts:370) |
| events read, board-scoped, no limit | [:386-389](netlify/functions/generate-profile-snapshot.ts:386) |
| weight gate before lookup | [:424-426](netlify/functions/generate-profile-snapshot.ts:424) |
| the silent miss | [:429-435](netlify/functions/generate-profile-snapshot.ts:429) |
| snapshot insert (never invoked here) | [:539-543](netlify/functions/generate-profile-snapshot.ts:539) |
| `timestamp default now()` | [001_create_weave_events.sql:10](supabase/migrations/001_create_weave_events.sql:10) |
| `trackEvent` (timestamp override only when passed) | [eventTracker.ts:36-49](src/services/eventTracker.ts:36) |
| `connection_description_closed` emit (requires open popup) | [App.tsx:299-317](src/App.tsx:299) |
| `connection_label_clicked` emit | [App.tsx:319-350](src/App.tsx:319) |
| non-emitting popup closes: `clearHighlight`, board switch | [App.tsx:157-160](src/App.tsx:157), [:196-199](src/App.tsx:196) |
| `clearHighlight` callers | [App.tsx:634](src/App.tsx:634), [:647](src/App.tsx:647), [:697](src/App.tsx:697) |
| popup overlay = `onClose` | [EdgeDetailPopup.tsx:580](src/components/EdgeDetailPopup.tsx:580) |
| Escape / close button → `onClose` | [EdgeDetailPopup.tsx:566-572](src/components/EdgeDetailPopup.tsx:566), [:621](src/components/EdgeDetailPopup.tsx:621) |
| lightbox open/close emits (linkCard) | [LinkCardNode.tsx:612-640](src/components/LinkCardNode.tsx:612) |

## Appendix A — `d7-reproduce.mjs` (throwaway; not in the repo)

```js
// Throwaway reproduction of generate-profile-snapshot.ts steps 1–4 (read + resolve + map + lookup).
// Rule/resolver/map code is copied VERBATIM from netlify/functions/generate-profile-snapshot.ts @ 1b2cfff
// (lines 80-89, 111-158, 326-334, 346-377, 404-435). No insert step exists here.
import { readFileSync, writeFileSync } from 'node:fs'
const S = process.argv[2]
const events = JSON.parse(readFileSync(`${S}/events.json`, 'utf8'))
const embeddingRows = JSON.parse(readFileSync(`${S}/embeddings.json`, 'utf8'))

// ---- verbatim: lightboxClosedWeight (:76-89)
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
// ---- verbatim: ENGAGEMENT_RULES + resolveNodeTarget (:111-158)
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
// ---- verbatim: parseEmbedding (:181-202), warnings suppressed
function parseEmbedding(raw) {
  if (typeof raw === 'string') { try { const p = JSON.parse(raw); if (Array.isArray(p)) return p } catch {} ; return null }
  if (Array.isArray(raw)) return raw
  return null
}
// ---- Step 1 (:326-334): boardIds = distinct board_id over ALL weave_embeddings rows (no archived filter)
const boardIds = [...new Set(embeddingRows.map((r) => r.board_id))]
// ---- Step 2 (:346-377): .in('board_id', boardIds).is('archived_at', null), then parse
const nodes = []
let nodesExcludedNoEmbedding = 0
for (const row of embeddingRows.filter((r) => boardIds.includes(r.board_id) && r.archived_at === null)) {
  const embedding = parseEmbedding(row.embedding)
  if (!embedding) { nodesExcludedNoEmbedding++; continue }
  nodes.push({ compositeKey: `${row.board_id}:${row.node_id}`, boardId: row.board_id, nodeId: row.node_id })
}
// ---- Step 4 (:404-435) with instrumentation added ONLY around the `key in weightMap` test
function run(scopeEvents, applyWeightGate) {
  const weightMap = {}
  for (const node of nodes) weightMap[node.compositeKey] = 0
  const out = { resolved: 0, hits: 0, misses: [], zeroWeightSkipped: 0, unmatched: 0 }
  for (const event of scopeEvents) {
    const rule = ENGAGEMENT_RULES[event.event_type]
    if (!rule) { out.unmatched++; continue }
    const attributedKeys = rule.resolve(event)
    if (attributedKeys.length === 0) continue
    const perEventWeight = typeof rule.weight === 'function' ? rule.weight(event) : rule.weight
    if (applyWeightGate && perEventWeight <= 0) { out.zeroWeightSkipped += attributedKeys.length; continue }
    for (const key of attributedKeys) {
      out.resolved++
      if (key in weightMap) out.hits++
      else out.misses.push({ key, event_id: event.id, event_type: event.event_type, target_id: event.target_id, board_id: event.board_id, ts: event.timestamp, duration_ms: event.duration_ms, metadata: event.metadata, voice_session_id: event.voice_session_id })
    }
  }
  return out
}
const pipelineEvents = events.filter((e) => boardIds.includes(e.board_id))   // Step 3 (:386-389) .in('board_id', boardIds)
const census = run(events, false)          // census C17 definition: all events, no weight gate
const pipeline = run(pipelineEvents, true) // code path as written: board scope + weight gate before lookup
const summary = {
  boards_in_scope: boardIds.length, map_size: nodes.length, nodesExcludedNoEmbedding,
  events_total: events.length, events_in_board_scope: pipelineEvents.length, events_never_read: events.length - pipelineEvents.length,
  census_scope: { resolved: census.resolved, hits: census.hits, misses: census.misses.length },
  pipeline_scope: { resolved: pipeline.resolved, hits: pipeline.hits, misses: pipeline.misses.length, zero_weight_keys_gated_before_lookup: pipeline.zeroWeightSkipped },
}
console.log(JSON.stringify(summary, null, 2))
writeFileSync(`${S}/misses-census.json`, JSON.stringify(census.misses, null, 1))
writeFileSync(`${S}/misses-pipeline.json`, JSON.stringify(pipeline.misses, null, 1))
writeFileSync(`${S}/map-keys.json`, JSON.stringify(nodes.map(n => n.compositeKey)))
// per-type miss counts, both scopes
for (const [name, r] of [['census', census], ['pipeline', pipeline]]) {
  const byType = {}; for (const m of r.misses) byType[m.event_type] = (byType[m.event_type] ?? 0) + 1
  console.log(name, 'misses by event_type', JSON.stringify(byType))
}
```

## Appendix B — `d7-partition.mjs` (throwaway; not in the repo)

```js
// Partition the missed keys (B1..B8, ordered, first-match) against weave_embeddings facts.
import { readFileSync, writeFileSync } from 'node:fs'
const S = process.argv[2]; const which = process.argv[3] // 'pipeline' | 'census'
const misses = JSON.parse(readFileSync(`${S}/misses-${which}.json`, 'utf8'))
const emb = JSON.parse(readFileSync(`${S}/embeddings.json`, 'utf8'))
const mapKeys = new Set(JSON.parse(readFileSync(`${S}/map-keys.json`, 'utf8')))
const byComposite = new Map(); const byNodeId = new Map(); const boards = new Set()
for (const r of emb) { byComposite.set(`${r.board_id}:${r.node_id}`, r); boards.add(r.board_id); (byNodeId.get(r.node_id) ?? byNodeId.set(r.node_id, []).get(r.node_id)).push(r) }
// B1 pattern derived from the map side: board_id = uuid (36 chars, all 101 rows), node_id = digits (verified below)
const nodeIdPat = /^\d+$/
const allMapNodeIdsDigits = emb.every(r => nodeIdPat.test(r.node_id))
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const keyPat = new RegExp(`^${UUID}:\\d+$`)
const buckets = {}; const rows = []
for (const m of misses) {
  let b, detail = ''
  const segs = m.key.split(':')
  const [boardId, nodeId] = segs
  const comp = byComposite.get(m.key)
  if (!keyPat.test(m.key)) { b = 'B1'; detail = `segs=${segs.length}` }
  else if (segs.length !== 2) { b = 'B2' }
  else if (m.voice_session_id) { b = 'B3' } // never true: F3 shows 0 with voice_session_id (P4)
  else if (comp && comp.archived_at !== null) { b = 'B4'; detail = (m.ts > comp.archived_at) ? 'event_after_archive' : 'event_before_archive' }
  else if (!comp) {
    b = 'B5'
    detail = boards.has(boardId) ? 'board_known_node_unknown' : 'board_unknown'
    // literal-reading B6 note: does node_id exist under a different board?
    if ((byNodeId.get(nodeId) ?? []).some(r => r.board_id !== boardId)) detail += '|nodeid_exists_elsewhere'
  }
  else if (comp && comp.archived_at === null && !mapKeys.has(m.key)) { b = 'B7'; detail = comp.embedding == null ? 'embedding_null' : 'unparseable_or_other' }
  else { b = 'B8' }
  buckets[b] = (buckets[b] ?? 0) + 1
  rows.push({ ...m, bucket: b, detail, node_type_meta: m.metadata?.node_type ?? null })
}
const tally = (f) => { const t = {}; for (const r of rows) { const k = f(r); t[k] = (t[k] ?? 0) + 1 }; return t }
console.log(`== ${which}: M=${misses.length}, allMapNodeIdsDigits=${allMapNodeIdsDigits}, distinct node_id in map=${byNodeId.size} over ${emb.length} rows`)
console.log('buckets', JSON.stringify(buckets), 'sum', Object.values(buckets).reduce((a,b)=>a+b,0))
console.log('bucket x event_type', JSON.stringify(tally(r => `${r.bucket}|${r.event_type}`), null, 0))
console.log('bucket x detail', JSON.stringify(tally(r => `${r.bucket}|${r.detail}`), null, 0))
console.log('B5 x node_type_meta', JSON.stringify(tally(r => r.bucket==='B5' ? `${r.event_type}|${r.node_type_meta}` : 'not-B5'), null, 0))
console.log('B4 x node_type(emb)', JSON.stringify(tally(r => r.bucket==='B4' ? `${byComposite.get(r.key).node_type}` : 'not-B4'), null, 0))
console.log('misses by event_type (independent recount)', JSON.stringify(tally(r => r.event_type)))
console.log('distinct missed keys', new Set(rows.map(r=>r.key)).size, 'distinct B5 keys', new Set(rows.filter(r=>r.bucket==='B5').map(r=>r.key)).size)
console.log('B5 keys:', JSON.stringify([...new Set(rows.filter(r=>r.bucket==='B5').map(r=>`${r.key} (${r.detail})`))]))
console.log('B8/B1/B2/B3/B7 rows:', JSON.stringify(rows.filter(r=>!['B4','B5'].includes(r.bucket))))
writeFileSync(`${S}/partition-${which}.json`, JSON.stringify(rows, null, 1))
```
