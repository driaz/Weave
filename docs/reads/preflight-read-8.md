# Preflight Read — Issue #8 (snapshot revival + engagement weighting)

> **This is a point-in-time inventory, as of 2026-08-15.**
>
> **Prod claims in this document were true on the as-of date and are verified by
> re-running the stated queries, never by citing this document.** Every prod
> finding below carries the query that produced it (tagged `Q1`–`Q49`, reproduced
> inline). If you need to know whether a count still holds, run the query. Do not
> quote this file as evidence of present-tense prod state.
>
> **The durable layer is the query inventory and the file/line map; the findings
> layer (counts, current values) decays.** The queries and the code map are
> written to survive; the numbers are a photograph.
>
> `docs/reads/` is a new document class. Read reports describe what **is**, and
> therefore go stale. They are distinct from session records, which describe what
> **happened** and do not.
>
> **Base commit:** `1a61fc2` (main, incl. PR #38). **Re-verified 2026-08-16:** all
> 23 load-bearing prod counts re-ran with **zero drift**, and 15 spot-checked
> file/line citations resolve unchanged. See §0 for what that re-run corrected.

**Scope.** Inventory only. No design, no grain proposal, no threshold
recalibration, no fixes. Defects surfaced here are catalogued, not repaired —
that is deliberate. Connection: read-only prod via `WEAVE_PROD_RO_DATABASE_URL`
(`weave_readonly`, PostgreSQL 17.6). Zero writes to prod, dev, or code.

**Read-visibility precondition (verified first, because every count depends on
it).** `weave_readonly` is neither superuser nor `BYPASSRLS` (`Q8`:
`rolsuper=f, rolbypassrls=f`), and RLS is enabled on all eight tables read here.
Visibility comes from an explicit `readonly_audit_select` policy
(`to weave_readonly`, `qual = true`) present on every table this report counts
(`Q10`, `Q11`). Counts below are therefore whole-table, not RLS-filtered. Had
that policy been absent, every count in this document would have been silently
zero-or-partial.

```sql
-- Q8
select current_user, rolsuper, rolbypassrls from pg_roles where rolname = current_user;
-- Q10/Q11
select tablename, policyname, roles::text, cmd, qual from pg_policies
where schemaname='public' order by tablename, policyname;
```

---

## 0. Correction — the 2026-08-16 re-run

The 2026-08-15 draft was cut from a **stale local `main`**, five commits behind
`origin/main`. Those five commits are PR #38, and one of them
(`ac6dc67`) adds `docs/session-record-2026-08-13.md`. The draft asserted that
file **did not exist**. That assertion was wrong: it existed on `origin/main`
and was merely absent from the stale working tree the read was performed in.
The claim is retracted; §5.7 now cites the record.

Nothing else changed. The five missing commits touch only `MIGRATIONS.md` and
that session record — **no code** (`git diff --name-only deda67a..origin/main`).
Every file/line citation, every prod count, and all five inventories are
unaffected; the re-run against `1a61fc2` reproduced 23/23 counts with zero drift
and 15/15 spot-checked citations unchanged.

The discipline entry this earns, stated plainly because the document class exists
to carry exactly this kind of thing: **"the file is not in my working tree" is not
"the file does not exist."** A read that reports on repository state must
establish that its checkout is current before drawing conclusions from absence —
`git fetch && git status` is the precondition, in the same way §Read-visibility
above is the precondition for trusting a row count. Absence of evidence was
reported as evidence of absence, and a `git fetch` would have caught it.

---

## 1. Snapshot pipeline, end-to-end, as it runs today

### 1.1 What triggers it: nothing

There is no automatic trigger. Grepping `src/` for the three function paths
returns zero call sites — no component, hook, or service invokes
`/api/generate-profile-snapshot`, `/api/extract-snapshot-themes`, or
`/api/generate-snapshot-narrative`. `netlify.toml` declares no scheduled
function (it sets only a 300s timeout for `extract-snapshot-themes`). The only
invocation surface in the repo is manual:

- `package.json:15` — `npm run snapshot:test`, a `curl` to
  `http://localhost:8888/api/generate-profile-snapshot`
- `scripts/test-themes.sh`, `scripts/test-narrative.sh` — curl the latest
  snapshot id into stages 2 and 3
- `scripts/run-themes.mjs`, `scripts/run-narrative.mjs` — standalone
  re-implementations of stages 2 and 3

Prod confirms dormancy. `weave_profile_snapshots` holds exactly **one** row: a
`trigger_reason = 'fixture'` row created 2026-04-17, `node_count = 37`,
`event_count = 0`, **zero clusters**, no bridges, but with a narrative and a
backfilled title (migration `026`). Its `generation_metadata` carries none of
the keys stage 1 stamps (`cluster_threshold_used`, `rules_applied`,
`singletons_dropped` are all null).

```sql
-- Q5
select id, created_at, node_count, event_count, trigger_reason,
       jsonb_array_length(coalesce(clusters,'[]'::jsonb)) as n_clusters,
       (bridges is not null) as has_bridges,
       (narrative is not null and btrim(narrative) <> '') as has_narrative,
       generation_metadata->>'cluster_threshold_used' as threshold_used,
       generation_metadata->'rules_applied' as rules_applied
from weave_profile_snapshots order by created_at desc;
```

**The pipeline has never run in production.** The only snapshot artifact that
exists is a hand-seeded fixture with no clusters. Everything the Reflect view
and the voice opening turn render today comes from that fixture.

### 1.2 Stage 1 — `netlify/functions/generate-profile-snapshot.ts`

| Step | Lines | What it does |
| --- | --- | --- |
| 1 | `:326-334` | Board discovery: `select board_id from weave_embeddings` (distinct in JS) when `board_ids` not supplied |
| 2 | `:346-350` | Embedding fetch: `.in('board_id', …).is('archived_at', null)` |
| 3 | `:386-389` | Event fetch: `select * from weave_events .in('board_id', …)` — **no time window, no event_type filter** |
| 4 | `:404-448` | Per-node engagement weights (below) |
| 5 | `:457-504` | Agglomerative clustering + cluster object construction |
| 6 | `:528-543` | Insert into `weave_profile_snapshots` |

**Engagement rules** (`:111-150`) — the table that already exists:

| event_type | weight | attribution |
| --- | --- | --- |
| `connection_label_clicked` | `1.0` | both endpoint nodes (`:114-122`) |
| `connection_description_closed` | `0.3` | both endpoint nodes (`:124-132`) |
| `item_added` | `0.2` | single node |
| `lightbox_opened` | `0.1` | single node |
| `lightbox_closed` | `lightboxClosedWeight` (`:80-89`) | single node |
| `node_selected` | `0.1` | single node |

`lightboxClosedWeight` is the only duration-scaled rule: `1.5 × min(log2(s+1)/log2(46), 1.0)`,
saturating at 45s (`:74-78`). `resolveNodeTarget` (`:152-158`) accepts only the
`node:{board_id}:{node_id}` prefixed form and rejects legacy formats. Weights are
normalized so the max node weight is `1.0` (`:443-448`).

**Clustering.** `agglomerativeClustering` (`:214-267`), average linkage, O(n³),
gated by `CLUSTER_SIMILARITY_THRESHOLD = 0.72` (`:72`). Singletons are dropped
(`:460`); clusters sort by size descending for stable `c1…cN` ids (`:464`).

**Where engagement lands in the cluster object** (`:467-504`): members sort by
weight descending; `anchor_node_ids` = **top 3 by weight** (`:480-481`);
`engagement_weight` = **mean of those top 3** (`:484-488`), rounded to 4dp. The
threshold value is stamped into `generation_metadata.cluster_threshold_used`
(`:519`), so any produced snapshot self-documents which threshold made it.

### 1.3 Stage 2 — `netlify/functions/extract-snapshot-themes.ts`

Reads `clusters` from the snapshot row (`:184-188`), collects all member
composite keys, splits them into `board_id` / `node_id` (`:213-216`), then
fetches summaries:

```ts
// extract-snapshot-themes.ts:222-228
.from('weave_embeddings')
.select('board_id, node_id, node_type, content_summary')
.in('board_id', boardIds)
.is('archived_at', null)   // ← the client-side archived filter
```

**This is the client-side filter the revival must relocate.** Its exact twin
lives at `generate-profile-snapshot.ts:350`. See §5.2 for the landing-spot fact.

Engagement re-enters here as prompt structure, not math: `buildUserPrompt`
(`:102-133`) prefixes anchor members with `★` (`:116`), and `SYSTEM_PROMPT:30`
instructs the model — *"The anchor nodes (marked with ★) are the pieces this
person engages with most … Weight them accordingly."* Members whose summary is
missing or blank render as `(visual content — no text description available)`
(`:123`). One Claude call per cluster, sequential (`:255-284`); results and
timing metadata are written back to the same row (`:300-306`).

### 1.4 Stage 3 — `netlify/functions/generate-snapshot-narrative.ts`

Filters to clusters with non-blank themes and sorts by size descending
(`:98-100`, with the comment that input order is a structural cue to the model).
`buildUserPrompt` emits engagement numerically into the prompt:

```
Thread (${cluster.size} pieces, ${boardsTouched} boards, engagement: ${weight}):
```

and `SYSTEM_PROMPT:42` instructs — *"Weight larger clusters and
higher-engagement clusters more heavily in the narrative."* Writes `narrative`
plus a `title` (separate `TITLE_MODEL` call) into `generation_metadata`
(`:295-306`).

Model pins: `CLAUDE_MODEL = 'claude-opus-4-7'` (themes `:12`, narrative `:13`),
`TITLE_MODEL = 'claude-sonnet-4-6'` (narrative `:14`).

### 1.5 Where the output lands and who consumes it

Output is three columns on one row: `clusters` (jsonb), `narrative` (text),
`generation_metadata` (jsonb). Consumers:

- **Reflect view** — `ReflectView.tsx:92` via `useProfileSnapshot` →
  `profileSnapshotStore`. Renders narrative paragraphs (`:57`), theme
  descriptions from clusters (`:63-69`), piece count (`:69`), title (`:71`).
- **Voice opening turn** — `vadController.ts:533` calls
  `getLatestProfileSnapshot` directly (not through the store), and passes
  `snapshot?.narrative` as `recentThinking` into `buildSystemPrompt`
  (`vadController.ts:547`). Opening turn only; best-effort, degrades to the
  empty path on failure.

**Gating fact:** `getLatestProfileSnapshot` (`persistence/profileSnapshots.ts:36-65`)
returns `null` when `narrative` is null or whitespace (`:54-55`). A snapshot that
has completed stages 1 and 2 but not stage 3 is **invisible to both consumers** —
clusters and themes included.

### 1.6 The cache (`feat/snapshot-cache` lineage)

`src/services/profileSnapshot/profileSnapshotStore.ts`. localStorage key
`weave.snapshot.latest`, `SCHEMA_VERSION = 1` (`:39-40`). State is read
synchronously at module load (`:84`) so React renders the cached snapshot on
first paint. Version mismatch or unparseable JSON yields `null` (`:53-56`).

Invalidation surface, in full:

- `refresh(client)` — fired **once per component lifetime** after auth resolves
  (`useProfileSnapshotBootstrap.ts:17-24`, guarded by `didBootstrapRef`)
- `clearForSignout()` — removes the key (`:124-127`)

There is no TTL, no revalidation on focus, no invalidation on board mutation. In
practice the cache refreshes once per page load.

**Catalogued defect — stale-snapshot resurrection.** `refresh()` writes the
cache only when the fetch returns a snapshot (`:110-112`). On a `null` result it
sets in-memory state to `null` but leaves localStorage **untouched** (`:113-115`).
The next page load calls `readCache()` at module init and resurrects the stale
snapshot. Reaching `null` requires the row to disappear or its narrative to go
blank — narrow today (one fixture row), but it means "snapshot removed server-side"
does not propagate to a client that has cached it. Not fixed here.

### 1.7 Catalogued defects in the pipeline (findings only — no fixes)

1. **Stale scope comment.** `generate-profile-snapshot.ts:1-9` asserts *"Boards
   live in localStorage on the client; there is no server-side `weave_nodes`
   table."* Literally true (nothing is named `weave_nodes`), substantively false:
   prod has `boards` (8 rows), `nodes` (71), `edges` (293) — `Q36`, `Q37`. The
   stated justification for treating `weave_embeddings` as the canonical node
   list no longer holds, and the comment's own trigger condition ("when the
   persistence layer moves off localStorage") has already fired.
2. **Dead table.** `weave_profile_cluster_embeddings` (migration `003`) has 0
   rows (`Q6`) and no writer anywhere in the codebase.
3. **Duration ignored on a rule that has it.** `connection_description_closed`
   carries `duration_ms` on all 447 prod rows (`Q2`) but is weighted flat at
   `0.3` (`:124-133`), while `lightbox_closed` scales by duration. Asymmetry is
   undocumented.
4. **Unbounded event scan.** Stage 1 step 3 fetches every event for every
   in-scope board with no time window (`:386-389`), so engagement weight is
   lifetime-cumulative with no recency term.

```sql
-- Q6
select count(*) as rows, count(distinct snapshot_id) as snapshots
from weave_profile_cluster_embeddings;
-- Q36 / Q37
select table_name from information_schema.tables
where table_schema='public' and table_type='BASE TABLE' order by 1;
select 'boards' t, count(*) from boards union all
select 'nodes', count(*) from nodes union all select 'edges', count(*) from edges;
```

---

## 2. Engagement signals that exist today

### 2.1 The only store is `weave_events`

Schema: migration `001` (base), `025` (`voice_session_id`, no FK, partial index),
plus `user_id` added through `009`/`011`/`014`. Live columns (`Q1`): `id`,
`event_type`, `target_id`, `board_id`, `session_id`, `timestamp`, `duration_ms`,
`metadata`, `user_id`, `voice_session_id`.

Writer: `src/services/eventTracker.ts:30-55`. Fire-and-forget — failures
`console.warn` and never throw (`:50-54`). `session_id` is a
`crypto.randomUUID()` generated once per page load (`:4`) and is a *browser*
session, unrelated to `voice_sessions.id` (which is what `voice_session_id`
holds). 24 call sites across `App.tsx`, `AddNodeButton`, `LinkCardNode`,
`PdfCardNode`, `ImageCardNode`, `WeaveButton`, `EdgeDetailPopup`, and
`voiceSessionLogger.ts:88`.

Prod totals (`Q4`): **2,645 rows**, 339 distinct browser sessions, 36 distinct
`board_id` values, **1 distinct user**, spanning 2026-04-23 → 2026-08-14.

### 2.2 Every signal, and whether anything reads it back

`Q2` + `Q3` cross-referenced against `ENGAGEMENT_RULES`:

| event_type | rows | target grain | duration | **consumed?** |
| --- | ---: | --- | ---: | --- |
| `connection_label_clicked` | 495 | `connection:` 4-part | 0 | ✅ w=1.0 → both endpoints |
| `connection_description_closed` | 447 | `connection:` 4-part | 447 | ✅ w=0.3 → both endpoints |
| `board_switched` | 398 | `board:` | 0 | ❌ write-only |
| `session_started` | 339 | *(null)* | 0 | ❌ write-only |
| `node_selected` | 137 | `node:` 3-part | 0 | ✅ w=0.1 |
| `lightbox_opened` | 129 | `node:` 3-part | 0 | ✅ w=0.1 |
| `lightbox_closed` | 125 | `node:` 3-part | 125 | ✅ duration-scaled |
| `item_added` | 124 | `node:` 3-part | 0 | ✅ w=0.2 |
| `voice.session.started` | 109 | *(null)* | 0 | ❌ (86 carry `voice_session_id`) |
| `voice.session.ended` | 100 | *(null)* | 0 | ❌ (77 carry `voice_session_id`) |
| `weave_triggered` | 83 | *(null)* | 53 | ❌ write-only |
| `session_ended` | 74 | *(null)* | 0 | ❌ write-only |
| `item_deleted` | 36 | `node:` 3-part | 0 | ❌ node-attributable, unweighted |
| `voice_insight_played` | 34 | `connection:` 4-part | 34 | ❌ **edge-shaped, attributable, unused** |
| `board_created` | 15 | `board:` | 0 | ❌ write-only |

**Consumed: 6 types / 1,457 rows (55.1%). Write-only: 9 types / 1,188 rows (44.9%).**

Target-id shapes are clean — `Q3` shows every `node:` event is exactly 3
colon-parts and every `connection:` event exactly 4, with zero malformed rows, so
`resolveNodeTarget`'s strict prefix check drops nothing in the current corpus.

**Free signal, already captured:** `voice_insight_played` (34 rows) has the same
4-part `connection:` target shape as the two consumed edge events and carries
`duration_ms` on all 34. It is directly attributable under the existing resolver
with no new instrumentation.

```sql
-- Q2
select event_type, count(*) n, count(target_id) with_target, count(duration_ms) with_duration,
       count(metadata) with_metadata, count(voice_session_id) with_voice_session,
       min(timestamp)::date first_seen, max(timestamp)::date last_seen
from weave_events group by event_type order by n desc;
-- Q3
select event_type,
       case when target_id is null then '(null)' else split_part(target_id, ':', 1) end as target_prefix,
       count(*) n,
       count(*) filter (where target_id is not null and array_length(string_to_array(target_id,':'),1)=3) parts3,
       count(*) filter (where target_id is not null and array_length(string_to_array(target_id,':'),1)=4) parts4
from weave_events group by 1,2 order by 1,2;
-- Q4
select count(*) total_events, count(distinct session_id) distinct_browser_sessions,
       count(distinct board_id) distinct_boards, count(distinct user_id) distinct_users,
       min(timestamp) earliest, max(timestamp) latest from weave_events;
```

### 2.3 Grain of what exists today

Attribution is **node-grain, and only node-grain.** Edge events resolve to their
two endpoint nodes (`generate-profile-snapshot.ts:114-132`) — the edge identity
is discarded at attribution time and never persisted. Cluster-grain
`engagement_weight` is *derived* (mean of top-3 node weights), not stored
independently. There is no persisted edge-grain, region-grain, or session-grain
weight anywhere in the system.

**Retention:** none configured. No TTL, no pruning job, no archival. All 2,645
rows since 2026-04-23 are retained.

### 2.4 JSONB-resident signals and #11 exposure — per signal

**No engagement signal is JSONB-resident.** `Q40` and `Q41` enumerate every
top-level key in `nodes.data` (71 rows) and `edges.data` (293 rows). Neither
carries any interaction, view-count, dwell, or recency field. **The #11 clobber
therefore has zero direct exposure to any engagement signal today** — because
every engagement signal lives in `weave_events`, which is append-only, written by
a dedicated `insert` (`eventTracker.ts:47-49`), and never touched by either board
write path.

That is the good news. The exposure is one level down, in the identity key:

| JSONB-resident item | rows | write path | #11 exposure |
| --- | ---: | --- | --- |
| `nodes.data->>'_clientNodeId'` | 71/71 | **debounced full-board save** — `syncBoard.ts:117` → `replace_board_contents` (`syncBoard.ts:226`) | **Exposed.** This is the join key on which *all* engagement attribution and the `037` archive trigger depend. |
| `nodes.data->>'contentDescription'` | 25 | targeted patch — `patch_node_data` (`linkEnrichment.ts:153,245`; `sweep-corpus-embeddings.mjs:403`) | **Exposed** (server patch vs. client full save — the known #11 race) |
| `nodes.data->>'transcript'` | 32 | targeted patch (`linkEnrichment.ts:128,227`) | **Exposed** |
| `nodes.data->>'processing_log'` | 43 | `append_processing_log` RPC | **Exposed** |
| `nodes.data->>'media_analysis'` | 12 | server-side write | **Exposed** |
| `edges.data` (`mode`,`type`,`explanation`,`surprise`,`from`,`to`,`strength`) | 293 | full-board save | Exposed, but carries no engagement signal |

The design sitting's constraint, stated as a fact: **weighting cannot be
attributed to a node at all without `_clientNodeId`, and `_clientNodeId` rides
the full-board-save path that #11 shows races with server-side JSONB patches.**
The signals themselves are trustworthy; the pointer from signal to node is the
part on the exposed write path. Loss rate is unquantified — quantifying it is #11's
job, not this read's.

Scale of that exposure, from the record rather than from inference:
`docs/session-record-2026-08-13.md:82-85` files #11 as a **watch item at n=0,
"not built for"** — a stale full-board save can prune a node the client later
restores; the `037` trigger archives correctly on the prune, but revival "lives on
embed writers only," so the card stays dark until its next embed event. So the
observed incidence today is zero, and the exposure is structural rather than
demonstrated. Both halves belong in the design argument; neither is a reason to
treat the signals as untrustworthy.

**Stray artifact:** one node carries a `test_patch` key in `nodes.data` (`Q40`) —
a leftover from RPC testing, still in prod.

```sql
-- Q40 / Q41
select k as data_key, count(*) n from nodes, lateral jsonb_object_keys(coalesce(data,'{}'::jsonb)) k
group by k order by n desc;
select k as data_key, count(*) n from edges, lateral jsonb_object_keys(coalesce(data,'{}'::jsonb)) k
group by k order by n desc;
```

### 2.5 Voice-side signals derivable with no new capture

`Q24` — all derivable from existing rows by join alone:

| session_kind | ended sessions | avg duration | avg utterances | avg deposits |
| --- | ---: | ---: | ---: | ---: |
| `qa` | 60 | 91.6 s | 1.67 | 1.00 |
| `real` | 24 | 785.8 s | 21.88 | 2.29 |

```sql
-- Q24
select session_kind, count(*) sessions,
       round(avg(extract(epoch from (ended_at - started_at)))::numeric,1) avg_duration_s,
       round(avg(u.n)::numeric,2) avg_utterances, round(avg(d.n)::numeric,2) avg_deposits
from voice_sessions s
left join lateral (select count(*) n from voice_utterances x where x.session_id=s.id) u on true
left join lateral (select count(*) n from voice_session_deposits y where y.session_id=s.id and y.type='deposit') d on true
where s.ended_at is not null group by session_kind order by 1;
```

The `real`/`qa` separation is stark (8.6× duration, 13× utterances). Any
session-grain weighting would need `session_kind` as a first-class filter, which
migration `036` already normalized onto the table and the
`real_voice_session_deposits` view already applies (§3.4).

---

## 3. Voice event surface

### 3.1 `voice_sessions` — 86 rows

`Q15`: `session_kind` splits **`qa` = 62, `real` = 24** (`NOT NULL DEFAULT 'real'`,
migration `036`). `anchor_edge_id` set on 53 (38 qa + 15 real). `ended_at` on 84.
`board_snapshot` non-empty on all 86. **`summary` is NULL on all 86** — deposits
superseded that column; it remains in the schema unused.

### 3.2 `board_snapshot` — the only voice→board reference, and it is ambiguous

`Q23`/`Q25`/`Q26`. Top-level keys: `nodes`, `edges`, `captured_at` — and
**no `board_id`** (0/86). Element shapes:

- node elements: `{id, type, position, preview_text}` (923 occurrences each)
- edge elements: `{id, source, target}` (3,548 occurrences each)

Those `id`/`source`/`target` values are **client** node ids. So the voice side's
one pointer into board content is generation-ambiguous under the #5 rule *and*
carries no `board_id` to scope it — meaning it cannot even be disambiguated by
board without joining back through `voice_sessions` → some other surface.

### 3.3 `voice_utterances` — 628 rows

`Q16`: 278 `user` / 350 other, across 75 sessions with at least one utterance.
**2 vector-less rows — matches pre-registered anomaly** (carried under #1); no
action, no investigation.

### 3.4 `voice_session_deposits` — 179 rows

`Q18`:

| generation | type | n | live | superseded | sessions | prompt_versions |
| ---: | --- | ---: | ---: | ---: | ---: | ---: |
| 1 | `deposit` | 117 | 115 | 2 | 65 | 1 |
| 1 | `open_edge` | 60 | 59 | 1 | 60 | 1 |
| 2 | `deposit` | 1 | 1 | 0 | 1 | 1 |
| 2 | `open_edge` | 1 | 1 | 0 | 1 | 1 |

The one-`open_edge`-per-session terminal-row contract holds: 60 `open_edge` rows
across 60 distinct sessions at generation 1. Regeneration is exercised but barely
— exactly one session has reached generation 2. Uniqueness is enforced by
`unique(session_id, generation, ordinal)` (`Q29`).

Views present in prod (`Q34`, `Q35`): `active_voice_session_deposits`
(`superseded_at is null`) and `real_voice_session_deposits` (same, plus
`join voice_sessions on session_kind = 'real'`).

### 3.5 `provenance` is empty — the #5 exposure check comes back vacuous

`Q21`: of 179 deposits, **`provenance` is NULL on all 179** (0 not-null, 0 empty
objects). Deposits carry **no pointer to board content of any kind** — not a node
id, not an edge id, not a board id. The `provenance jsonb` column exists and is
entirely unpopulated.

Consequence for the design argument: the #5-rule exposure for deposits is not
"unsafe," it is **absent**. There is nothing to join. Any deposit-keyed weighting
would be building the reference, not inheriting one. The voice side's only extant
board references are `voice_sessions.board_snapshot` (client ids, §3.2) and
`voice_sessions.anchor_edge_id` (an `edges.id` server uuid — generation-stable,
and the single stable voice→board link in the system).

### 3.6 Anomaly reconciliation

| Pre-registered | Observed | Verdict |
| --- | --- | --- |
| 2 vector-less utterance rows | **2** (`Q16`) | ✅ matches — non-event |
| 8 zero-utterance sessions | **11** (`Q17`) | ⚠️ **DIVERGENCE** |
| Zero-deposit-unrepresentable edge, n=1 | 10 sessions have utterances but no deposits (`Q22`) | ⚠️ **exceeds pre-registered n=1** |

**Divergence, reported verbatim, not investigated.** Per the pre-registration
protocol: no cause is hypothesized and no follow-up query was run beyond the
kind-split below, which is part of the same count.

```sql
-- Q17 → 11
select count(*) as zero_utterance_sessions from voice_sessions s
where not exists (select 1 from voice_utterances u where u.session_id = s.id);

-- Q20 → all 11 are session_kind='qa'
select s.session_kind, count(*) as zero_utterance_sessions from voice_sessions s
where not exists (select 1 from voice_utterances u where u.session_id = s.id)
group by s.session_kind order by 1;

-- Q22 → 10
select count(*) as sessions_with_utt_no_deposits from voice_sessions s
where exists (select 1 from voice_utterances u where u.session_id=s.id)
  and not exists (select 1 from voice_session_deposits d where d.session_id=s.id);
```

Observed: zero-utterance sessions = **11**, all `session_kind = 'qa'`
(`Q20`); pre-registered figure was 8. Sessions with utterances but zero deposits
= **10**; the pre-registered zero-deposit edge case was n=1 (`6efc2ba3`). Both
figures are stated as measured. No causal story is offered — that is deliberate,
per the handoff and per the 2026-08-14 precedent.

---

## 4. Schema surfaces weighting would touch

Read-only description of what exists. **Not a proposed schema.**

### 4.1 `match_retrieval_context` — prod signature is post-038 and already has an engagement slot

`Q27` — exactly one overload, matching migration `038`:

```
match_retrieval_context(extensions.halfvec, text, double precision, integer, text[], text[])
  → TABLE(source text, ref_id text, content text, speaker text,
          node_type text, similarity double precision, score double precision)
  volatility = stable, security = invoker
```

Arguments: `query_embedding halfvec(3072)`, `p_board_id text`,
`p_match_threshold double precision`, `p_total_cap int`,
`p_excluded_node_ids text[]`, `p_live_node_ids text[]`.

Corpus predicate (038 body): `board_id = p_board_id`, `embedding is not null`,
**`archived_at is null`**, `content_summary is not null`,
`char_length(btrim(content_summary)) >= 20`, self-exclusion via
`p_excluded_node_ids`, orphan-drop via `p_live_node_ids` (null disables).

**The engagement hook already exists and is hard-wired off.** The `score` column is:

```sql
(el.similarity * 1.0)::double precision as score   -- engagement = 1.0 (Phase-11 hook)
```

So the serving RPC carries a designated **multiplicative, node-grain** engagement
slot keyed on `node_id`, currently pinned to `1.0`. Ordering is
`order by score desc, ref_id` — a `ref_id` tiebreak that keeps output stable, and
which would stop being the tiebreak the moment engagement stops being constant.

### 4.2 The snapshot query path takes and returns

Not an RPC. Stage 1 issues plain PostgREST selects:

- in: `board_ids text[]`; out: `(board_id, node_id, node_type, embedding, content_summary)`
  filtered on `archived_at is null` (`generate-profile-snapshot.ts:346-350`)
- in: `board_ids text[]`; out: `weave_events.*` (`:386-389`)

Engagement enters entirely in TypeScript (`:404-448`). **There is no SQL surface
in the snapshot path where engagement is computed today.**

### 4.3 Identity keys — stable vs. ambiguous

`Q29` (unique/PK indexes) and `Q39` (core columns).

**Generation-STABLE (server-assigned, safe to join):**

| key | table |
| --- | --- |
| `id` (uuid PK) | `weave_embeddings`, `weave_edge_embeddings`, `weave_events`, `weave_profile_snapshots`, `voice_sessions`, `voice_utterances`, `voice_session_deposits`, `nodes`, `edges`, `boards` |
| `unique(board_id, node_id)` | `weave_embeddings` — stable *as a row identity*, but `node_id` is a client id |
| `unique(board_id, mode, node_lo, node_hi)` | `weave_edge_embeddings` — same caveat |
| `unique(session_id, utterance_index)` | `voice_utterances` |
| `unique(session_id, generation, ordinal)` | `voice_session_deposits` |
| `voice_sessions.anchor_edge_id` → `edges.id` | the one stable voice→board link |

**Generation-AMBIGUOUS (client-supplied, reused across card generations — #5):**

`weave_embeddings.node_id` · `weave_edge_embeddings.node_lo`/`node_hi` ·
`nodes.data->>'_clientNodeId'` · the `board_id`/`node_id` payload inside
`weave_events.target_id` · `voice_sessions.board_snapshot` node/edge ids ·
`match_retrieval_context.ref_id` and its `p_excluded_node_ids` /
`p_live_node_ids` arrays.

**The constraint, stated as fact:** every identity that engagement attribution
touches today is on the ambiguous side. `weave_events.target_id` is bare `text`
with no foreign key. The only route from an event to a generation-stable key is
`(board_id, client node id)` → `nodes.data->>'_clientNodeId'` → `nodes.id`, which
is precisely the join the #5 rule declares unsafe — and which is also the join
migration `037`'s trigger makes, knowingly (its header at
`037:26-31` calls the ambiguity out and defers the fix to #5).

The #5 rule's exact formulation, from the sitting that hardened it
(`docs/session-record-2026-08-13.md:79-81`): `(board_id, client_node_id)` is
**safe for deletion-path joins, unsafe joined to live nodes** — prod evidence,
n=1. That asymmetry is the operative constraint here. Engagement attribution
joins to *live* nodes, which is the unsafe direction; the `037` trigger joins on
the *deletion* path, which is the safe one. A weighting scheme cannot borrow the
trigger's precedent as license for the same join.

### 4.4 Lexicographic edge-identity footgun — confirmed live, and concrete

Pre-registered as a footgun; here is its measured size. `node_lo`/`node_hi` are
`text` (`Q1`). In prod, **100/100 node ids are pure numeric**, with lengths 1–2
digits and 51 of them ≥2 digits (`Q47`). Prod confirms the hazard directly:

```sql
-- Q47
select least('4','10') as lexicographic_least, greatest('4','10') as lexicographic_greatest;
--  lexicographic_least | lexicographic_greatest
--  10                  | 4
```

`Q49`: of 326 `weave_edge_embeddings` rows, **326 have both ids numeric, and 149
(45.7%) have `node_lo`/`node_hi` of differing digit length** — exactly the
population where lexicographic and numeric ordering disagree.

Migration `031` avoids the trap by materializing `least`/`greatest` at write time
in TypeScript (`connectionIdentity.ts`) so the unique index is self-consistent.
No SQL in the repo currently recomputes the ordering server-side, so nothing is
broken today. **Any hand-written SQL lookup or join that recomputes
`least(node_lo, node_hi)` over these ids will disagree with the stored tuple on
roughly 46% of rows** — silently, with no error.

```sql
-- Q29
select c.relname tbl, i.relname index_name, idx.indisunique, idx.indisprimary,
       pg_get_indexdef(idx.indexrelid)
from pg_index idx join pg_class c on c.oid=idx.indrelid join pg_class i on i.oid=idx.indexrelid
join pg_namespace n on n.oid=c.relnamespace
where n.nspname='public' and idx.indisunique order by c.relname;
-- Q49
select count(*) rows,
       count(*) filter (where node_lo ~ '^[0-9]+$' and node_hi ~ '^[0-9]+$') both_numeric,
       count(*) filter (where node_lo ~ '^[0-9]+$' and node_hi ~ '^[0-9]+$'
                          and length(node_lo) <> length(node_hi)) differing_digit_lengths
from weave_edge_embeddings;
```

---

## 5. The revival delta

What changed under snapshot theming's feet while it was dormant, answered
empirically.

### 5.1 The substrate it clusters on

`Q13`: 100 `weave_embeddings` rows across 12 board ids — **70 live, 30 archived**.
By type (`Q12`):

| node_type | total | live | archived | live with vector | live passing thin-summary guard |
| --- | ---: | ---: | ---: | ---: | ---: |
| `linkCard` | 93 | 68 | 25 | 68 | 68 |
| `textCard` | 4 | 0 | 4 | 0 | 0 |
| `imageCard` | 3 | 2 | 1 | 2 | **1** |

Two facts the design sitting will care about: **every live `textCard` is
archived** (0 live), and **one of the two live `imageCard` rows fails the
20-char thin-summary guard** — so the retrieval-visible corpus is effectively
69 rows, 68 of them link cards. This is the post-#2-sweep composition
(youtube `contentDescription` + tweet transcripts folded into the embed input per
PR-1 / #34 / #35); node-to-node cosine now measures content difference rather
than boilerplate.

**`CLUSTER_SIMILARITY_THRESHOLD = 0.72`** (`generate-profile-snapshot.ts:72`) was
calibrated against the pre-sweep substrate and is void. It is still the literal
in the code, and it is stamped into `generation_metadata.cluster_threshold_used`
(`:519`) on every run. This read does not recalibrate it — recalibration is a
revival-time, eyes-on activity.

### 5.2 The archived-row serving filter — where it actually lands

Migration `038` put `archived_at is null` into `match_retrieval_context` at the
system layer. The snapshot pipeline carries the same semantics as **two
TypeScript predicates** on plain PostgREST selects:
`generate-profile-snapshot.ts:350` and `extract-snapshot-themes.ts:228`.

**The landing-spot fact the design sitting asked for: the snapshot pipeline does
not call `match_retrieval_context`, or any RPC at all.** `Q28` enumerates the
entire public function surface — `append_processing_log`,
`archive_embedding_on_node_delete`, `match_retrieval_context`, `patch_node_data`,
`replace_board_contents`, `update_updated_at_column`. None of them serve the
snapshot path. So there is **no existing system-layer query for the filter to move
into**; relocating it means creating one. That is a fact about today, not a
recommendation about tomorrow.

Migration `038`'s own header anticipated this, noting the client-side filter cost
"zero live cost (that pipeline is dormant)" and existed to keep the dormant
pipeline from waking with divergent semantics. §1.1 confirms the dormancy
assumption still holds. The promotion sitting recorded the same intent
independently — `docs/session-record-2026-08-13.md:25-28` logs the
`extract-snapshot-themes.ts` filter as "client-side TS only — flagged for
system-layer relocation at **#8 revival**." This read's contribution is not the
flag but its landing spot: there is no RPC to relocate it into.

### 5.3 Schema drift in the tables it reads

| table | drift since the pipeline was written |
| --- | --- |
| `weave_embeddings` | `archived_at` (`007`); `user_id` NOT NULL, default `auth.uid()` (`009`/`011`/`014`); `embedding` is `halfvec(3072)` (`Q32`); partial index `idx_weave_embeddings_active` on `board_id WHERE archived_at IS NULL` (`Q48`) |
| `weave_events` | `user_id` NOT NULL default `auth.uid()` (`009`/`011`/`014`); `voice_session_id` + partial index (`025`) |
| `weave_profile_snapshots` | `user_id` **nullable**, default `auth.uid()` (`Q1`) |
| core schema | `boards`/`nodes`/`edges` now exist server-side (`Q36`), contradicting the pipeline's scope comment (§1.7) |

### 5.4 Do the queries still run as written? Yes.

EXPLAIN (costs off), read-only, against today's prod schema:

| stage | plan | `Q` |
| --- | --- | --- |
| board discovery | `Index Only Scan using idx_weave_embeddings_board` | `Q43` |
| embedding fetch (`archived_at is null`) | `Index Scan using idx_weave_embeddings_active` | `Q44` |
| event fetch | `Index Scan using idx_weave_events_board` | `Q45` |
| themes summary fetch | `Index Scan using idx_weave_embeddings_active` | `Q46` |

All four parse and plan cleanly, and the archived filter is index-supported by
the partial index `idx_weave_embeddings_active` (`Q48`) — which post-dates the
pipeline and happens to serve it well.

```sql
-- Q44 (representative)
explain (costs off)
select board_id, node_id, node_type, embedding, content_summary
from weave_embeddings where board_id = any (array['x']) and archived_at is null;
```

**Not verified:** the stage-1 `insert` and the stage-2/3 `update` statements. The
RO role holds no write privilege, and EXPLAIN on a write statement is out of
scope for a read session. Their viability is inferred from column presence
(`Q1`), not measured.

### 5.5 An unverified write-visibility delta

Stated as a mechanism, with the outcome explicitly unmeasured:

- `generate-profile-snapshot.ts:528-543` inserts a snapshot row and **does not set
  `user_id`**.
- `weave_profile_snapshots.user_id` is nullable with default `auth.uid()` (`Q1`).
- The functions authenticate with `SUPABASE_SERVICE_ROLE_KEY` (`:292`), and
  `service_role` has `rolbypassrls = t` (`Q33`) — so the insert itself will succeed.
- The client read is RLS-scoped `auth.uid() = user_id`
  (`weave_profile_snapshots_select_own`, `Q10`).

All 1 existing snapshot row, all 100 embedding rows, and all 2,645 event rows have
`user_id` populated with the single user `92fcfcc8-…` (`Q30`, `Q31`) — but that
row was backfilled by `009`/`011`, **not written by the pipeline**. So prod
contains no evidence either way about what a service-role pipeline insert
produces. Whether a fresh run yields a client-visible snapshot is therefore
**open, and verifiable only by running it**. Listed in §6.

### 5.6 Restart or rebuild?

Empirically: **the code still runs, but there is no prior run to restart from.**

- The queries plan (§5.4) and every column they name still exists (§5.3).
- The clustering math and the engagement rules are intact and need no schema work.
- What is void is the *tuning* (`0.72` against a substrate that has since been
  swept), the *filter's architectural home* (§5.2), and possibly the *write
  visibility* (§5.5).
- And the pipeline has **never produced a real snapshot in prod** (§1.1). The
  single fixture row has zero clusters, so no stage-2 or stage-3 output has ever
  been generated against real data. There is no baseline artifact to diff a
  revival run against.

The `0.72` threshold has never been validated against production output at all —
only against whatever produced the fixture. "Recalibration" at revival is
therefore closer to first calibration.

### 5.7 Known-hot identity — paper trail checked

`Q42` returns exactly one archived embedding row whose node is still live:

```
board_id = 8a8d45a9-5327-4355-ae3c-c1fff734b327, node_id = 33,
node_type = linkCard, archived_at = 2026-08-14 01:13:57+00
```

This is the pre-registered, `039`-adjudicated Galloway ghost, manually re-archived
by PK during the promotion sitting. **Expected state; resolves at #17.** No causal
sentence is constructed here.

**Paper trail read, and it corroborates exactly.**
`docs/session-record-2026-08-13.md:46-66` names the row's primary key as
`86b0bed0-dee8-405a-83b9-9e0a9b265f03` with `archived_at` stamped
2026-08-14 01:13:57 UTC. The 2026-08-16 re-run of `Q42` returns that PK and that
timestamp byte-for-byte. The record also supplies the fact that mechanics alone
cannot: **the 037 trigger was not the writer** — the row carries a
post-promotion timestamp because of a manual by-PK `UPDATE` during the sitting.
The record explicitly warns that this exact confusion occurred on 2026-08-14
(`:64-66`), which is why this read pre-registered the row rather than inferring
from it.

The record adds one corpus fact bearing on §5.1: **the live card at that identity
(Daniel Ahmad's) has no embedding row on prod at all** — the only card in the
corpus with zero retrieval presence, dark until #17 (`:70-74`). So the
archived-ghost-beside-live-node state is expected by construction, not an
invariant violation.

```sql
-- Q42
select e.board_id, e.node_id, e.node_type, e.archived_at
from weave_embeddings e
where e.archived_at is not null
  and exists (select 1 from nodes n
              where n.board_id::text = e.board_id
                and n.data->>'_clientNodeId' = e.node_id);
```

---

## 6. Open questions the design sitting must answer

*Questions only. No proposed answers.*

**On purpose and grain**

1. What is the weighting for — steering what the narrative emphasizes, steering
   what retrieval surfaces during voice, or steering which nodes cluster at all?
   The existing implementation does the first, the `score` hook in
   `match_retrieval_context` is positioned for the second, and nothing does the third.
2. Given that node-grain weighting already ships (§1.2), is #8 a change of grain,
   a change of inputs, or a change of consumer?
3. Edge events are currently dissolved into their two endpoints (§2.3). Is the
   loss of edge identity at attribution time a defect to repair or a modelling
   choice to keep?
4. Should `engagement_weight` remain derived (mean of top-3 member weights) or
   become a stored quantity with its own identity?

**On what counts as a signal**

5. Should any of the 1,188 write-only event rows (§2.2) become weighted — and
   specifically, is `voice_insight_played` (34 rows, edge-shaped, duration-bearing,
   attributable today at zero instrumentation cost) in or out?
6. Should `item_deleted` (36 rows, node-attributable) carry negative weight,
   zero weight, or be excluded by definition?
7. Why does `connection_description_closed` carry `duration_ms` on all 447 rows
   but weight flat, while `lightbox_closed` scales by duration (§1.7.3)?
8. Engagement is currently lifetime-cumulative with no time window (§1.7.4).
   Should it decay, and against what clock?
9. Should the `qa`/`real` `session_kind` split (§2.5 — 8.6× duration difference)
   gate which voice sessions contribute engagement at all?

**On identity and trust**

10. Every identity engagement touches is generation-ambiguous (§4.3), and the
    single stable voice→board link is `voice_sessions.anchor_edge_id`. Can any
    weighting scheme #8 wants be expressed without the unsafe
    `(board_id, client_node_id)` join, or does #8 block on #5?
11. `return_flag` needs cross-session identity. Given `provenance` is empty on all
    179 deposits (§3.5), what surface would a return signal key on?
12. `_clientNodeId` — the pointer every attribution depends on — rides the
    full-board-save path (§2.4). Does #8 proceed on an unquantified loss rate, or
    does it block on #11?
13. Should `provenance` be populated going forward, and if so with a stable key or
    the ambiguous one?

**On revival mechanics**

14. Does a service-role pipeline insert produce a client-visible snapshot, or does
    the omitted `user_id` (§5.5) make it invisible under RLS?
15. Where should the archived-row filter live, given the snapshot path calls no RPC
    and none of the six existing functions serve it (§5.2)?
16. Should the snapshot path move to `match_retrieval_context` (inheriting the
    `038` filter, the thin-summary guard, and the `score` hook), or stay on direct
    selects with its own predicates?
17. Given the pipeline has never run in prod (§1.1) and `0.72` has never been
    validated against real output (§5.6), what does "generate one real output and
    look at it" mean concretely — which boards, which threshold sweep, judged how?
18. With the retrieval-visible corpus at ~69 rows, 68 of them `linkCard` (§5.1),
    is there enough substrate for agglomerative clustering to produce more than one
    non-singleton cluster?
19. Does stage 3 (`narrative`) have to run for a revival to be observable, given
    `getLatestProfileSnapshot` returns `null` on a blank narrative (§1.5)?
20. Does the stale-snapshot resurrection path (§1.6) need closing before revival
    changes what snapshots exist?

**On the divergences**

21. Zero-utterance sessions measured 11, not the pre-registered 8, all
    `session_kind='qa'` (§3.6). Sessions with utterances but no deposits measured
    10 against a pre-registered n=1. Do these belong to #1's carried anomalies at
    revised counts, or are they a separate finding?

---

## Appendix — query index

`Q1` table columns · `Q2` events by type · `Q3` target_id shapes · `Q4` event
totals · `Q5` snapshot rows · `Q6` cluster-embeddings count · `Q8` RO role RLS
posture · `Q10`/`Q11` RLS policies · `Q12`/`Q13` embeddings live vs archived ·
`Q14` edge embeddings · `Q15` voice_sessions by kind · `Q16` utterances · `Q17`
zero-utterance sessions · `Q18` deposits by generation · `Q20` zero-utterance by
kind · `Q21` provenance population · `Q22` sessions w/ utterances, no deposits ·
`Q23`/`Q25`/`Q26` board_snapshot keys · `Q24` derivable session signals · `Q27`
RPC signature · `Q28` public function surface · `Q29` unique/PK indexes ·
`Q30`/`Q31` user_id population · `Q32` vector types · `Q33` RLS-bypass roles ·
`Q34`/`Q35` deposit views · `Q36`/`Q37` base tables + core counts · `Q39` core
columns · `Q40`/`Q41` JSONB keys · `Q42` archived-with-live-node · `Q43`–`Q46`
EXPLAIN plans · `Q47` node id shape · `Q48` embeddings indexes · `Q49` edge id
digit lengths.

Full statements are reproduced inline in the sections that cite them.
