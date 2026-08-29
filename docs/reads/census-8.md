# Signal Census — Issue #8 (thesis-7 verification layer)

> **This is a point-in-time inventory, as of 2026-08-28.**
>
> **Base commit:** `ff0b4f8c41411fcef7cee57b5797372f11c1f230` (`main`, verified
> equal to `origin/main` after `git fetch origin`; working tree clean).
> **Prod DB snapshot time:** `2026-08-28 22:56:15 UTC` (`select now()` at
> connection open). **Server:** PostgreSQL 17.6 on aarch64-linux.
>
> **Prod claims in this document were true at the snapshot time and are verified
> by re-running the stated query, never by citing this document.** Every prod
> finding carries its query inline, tagged `C1`–`C16`. If you need to know
> whether a count still holds, run the query.
>
> **The durable layer is the query inventory and the file/line map; the findings
> layer (counts, current values) decays.**
>
> Follows the `docs/reads/` document class established by
> [`preflight-read-8.md`](docs/reads/preflight-read-8.md). Read reports describe what
> **is**, and therefore go stale; session records describe what **happened**,
> and do not.

**Scope.** Census only. No fixes, no migrations, no threshold opinions, no
roster recommendations. Defects are catalogued, not repaired. **Zero writes of
any kind** were issued to prod — including the OQ14 empirical insert test, which
remains deferred (§T5.4).

**Connection.** Read-only prod via `WEAVE_PROD_RO_DATABASE_URL` exclusively
(`--db-url`, role `weave_readonly`). No Management API, no access tokens, no
service-role credentials, no CLI auth flow. No auth failures occurred.

---

## 0. Preconditions (verified first — every claim below depends on them)

**0.1 Checkout currency.** `git fetch origin` ran before any file was read.
`main` and `origin/main` both resolve to `ff0b4f8c...`; `git status -sb` reports
no divergence and no local modifications. Every file/line citation in this
document is a citation *at that SHA*.

**0.2 Read visibility (the absence-claim precondition).** `weave_readonly` is
neither superuser nor `BYPASSRLS`, and RLS is enabled on all 12 relevant public
tables. Visibility comes entirely from an explicit `readonly_audit_select`
policy (`to weave_readonly`, `using (true)`) present on **all 12** — verified,
not assumed. Counts below are therefore whole-table, not RLS-filtered. Had that
policy been missing on any table, its counts would have been silently zero or
partial and this document would have been wrong without saying so.

```sql
-- C1: role privileges
select rolname, rolbypassrls, rolsuper from pg_roles where rolname = current_user;
-- → weave_readonly | f | f

-- C2: RLS posture + the readonly policy, per table
select c.relname,
       c.relrowsecurity as rls_enabled,
       bool_or(p.polname = 'readonly_audit_select'
               and pg_get_expr(p.polqual, p.polrelid) = 'true') as ro_sees_all
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
left join pg_policy p on p.polrelid = c.oid
where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity
group by c.relname order by 1;
-- → 12/12 rows: rls_enabled = t, ro_sees_all = t
```

**0.3 What this search space does *not* cover.** Absence claims in this
document are scoped to: the working tree at `ff0b4f8`, excluding
`node_modules/`, `.git/`, `.netlify/` (build output — a stale mirror of
`netlify/functions/`), and `dist/`; and to the 12 RLS-covered `public` tables
above. Client-side board state lives in browser `localStorage` and is **not
observable from here** — the pipeline itself documents this
([generate-profile-snapshot.ts:1-9](netlify/functions/generate-profile-snapshot.ts:1)).
Nothing in this document asserts anything about localStorage contents.

**0.4 Tooling.** `psql` 18.4 and `supabase` CLI 2.84.2 were already present. No
tool was installed.

---

## T1 — Rules table verbatim

**Verdict: the code contains six rules. The count in the preflight read is
correct. The planning chat's "April spec" reconstruction is wrong on three of
the six entries and names a seventh rule that does not exist.**

### T1.1 The table, verbatim

[`netlify/functions/generate-profile-snapshot.ts:111-158`](netlify/functions/generate-profile-snapshot.ts:111):

```ts
const ENGAGEMENT_RULES: Record<string, EngagementRule> = {
  connection_label_clicked: {
    weight: 1.0,
    resolve: (e) => {
      if (!e.target_id) return []
      // Format: "connection:{board_id}:{from}:{to}"
      const parts = e.target_id.split(':')
      if (parts.length !== 4 || parts[0] !== 'connection') return []
      const [, boardId, fromId, toId] = parts
      return [`${boardId}:${fromId}`, `${boardId}:${toId}`]
    },
  },
  connection_description_closed: {
    weight: 0.3,
    resolve: (e) => {
      if (!e.target_id) return []
      // Format: "connection:{board_id}:{from}:{to}"
      const parts = e.target_id.split(':')
      if (parts.length !== 4 || parts[0] !== 'connection') return []
      const [, boardId, fromId, toId] = parts
      return [`${boardId}:${fromId}`, `${boardId}:${toId}`]
    },
  },
  item_added: {
    weight: 0.2,
    resolve: resolveNodeTarget,
  },
  lightbox_opened: {
    weight: 0.1,
    resolve: resolveNodeTarget,
  },
  lightbox_closed: {
    weight: lightboxClosedWeight,
    resolve: resolveNodeTarget,
  },
  node_selected: {
    weight: 0.1,
    resolve: resolveNodeTarget,
  },
}

function resolveNodeTarget(event: WeaveEvent): string[] {
  if (!event.target_id) return []
  // Format: "node:{board_id}:{node_id}"
  // Only accept the prefixed form; reject connection and legacy formats.
  if (!event.target_id.startsWith('node:')) return []
  return [event.target_id.slice('node:'.length)]
}
```

The one weight function,
[`:74-89`](netlify/functions/generate-profile-snapshot.ts:74):

```ts
const LIGHTBOX_DWELL_CAP_S = 45
const LIGHTBOX_DWELL_LOG_DIVISOR = Math.log2(LIGHTBOX_DWELL_CAP_S + 1)
const LIGHTBOX_CLOSED_BASE_WEIGHT = 1.5

function lightboxClosedWeight(event: WeaveEvent): number {
  const ms = event.duration_ms
  if (!ms || ms <= 0) return 0
  const seconds = ms / 1000
  const scale = Math.min(
    Math.log2(seconds + 1) / LIGHTBOX_DWELL_LOG_DIVISOR,
    1.0,
  )
  return LIGHTBOX_CLOSED_BASE_WEIGHT * scale
}
```

### T1.2 Per-rule breakdown

| # | event_type | weight | resolver behavior | file:line |
|---|---|---|---|---|
| 1 | `connection_label_clicked` | `1.0` flat | **both endpoints** — inline; requires exactly 4 colon-segments and literal prefix `connection`, else `[]` | [`:112-122`](netlify/functions/generate-profile-snapshot.ts:112) |
| 2 | `connection_description_closed` | `0.3` flat | **both endpoints** — byte-identical inline resolver to #1 (duplicated, not shared) | [`:123-133`](netlify/functions/generate-profile-snapshot.ts:123) |
| 3 | `item_added` | `0.2` flat | **single node** via `resolveNodeTarget` | [`:134-137`](netlify/functions/generate-profile-snapshot.ts:134) |
| 4 | `lightbox_opened` | `0.1` flat | **single node** via `resolveNodeTarget` | [`:138-141`](netlify/functions/generate-profile-snapshot.ts:138) |
| 5 | `lightbox_closed` | **function** `lightboxClosedWeight` — `1.5 × min(log₂(s+1)/log₂(46), 1.0)`, returns `0` on null/≤0 duration | **single node** via `resolveNodeTarget` | [`:142-145`](netlify/functions/generate-profile-snapshot.ts:142) |
| 6 | `node_selected` | `0.1` flat | **single node** via `resolveNodeTarget` | [`:146-149`](netlify/functions/generate-profile-snapshot.ts:146) |

`resolveNodeTarget` strips the literal `node:` prefix and returns the remainder
*whole* — it does **not** validate segment count. A malformed 4-segment
`node:`-prefixed id would yield a composite key that simply fails the
`key in weightMap` test downstream ([`:430`](netlify/functions/generate-profile-snapshot.ts:430))
and be dropped silently. No such rows exist in prod today (§T2.2), so this is
latent, not active.

### T1.3 Drift from the "April spec" as stated in the dispatch

| April spec (per dispatch) | Code at `ff0b4f8` | Verdict |
|---|---|---|
| `connection_label_clicked` 1.0 | `1.0` | ✅ matches |
| `connection_description_closed` 0.3 | `0.3` | ✅ matches |
| `item_added` 0.2 | `0.2` | ✅ matches |
| `weave_triggered` tiered 0.5/0.8/1.0, ×1.5 mode multiplier | **absent — no `weave_triggered` key exists in `ENGAGEMENT_RULES`** | 🚩 **spec names a rule the code does not have** |
| *(not in spec)* | `lightbox_opened` 0.1 | 🚩 code has a rule the spec does not name |
| *(not in spec)* | `lightbox_closed`, duration-scaled | 🚩 code has a rule the spec does not name |
| *(not in spec)* | `node_selected` 0.1 | 🚩 code has a rule the spec does not name |

**Reconciling "six rules."** The count is a coincidence of arithmetic, not
agreement: the April spec as reconstructed in the planning chat names four
rules, of which three survive verbatim in code and one (`weave_triggered`) is
absent entirely; the code adds three the spec does not mention. 3 shared + 3
code-only = 6. There is no tiering and no mode multiplier anywhere in the
pipeline — `grep -rn "1\.5\|tier" netlify/functions/generate-profile-snapshot.ts`
returns only `LIGHTBOX_CLOSED_BASE_WEIGHT = 1.5`, which is a lightbox-dwell
base, unrelated to weave modes.

`weave_triggered` *is* emitted in prod (84 rows, §T2.1) and *does* carry
`metadata.mode` on all 84 rows (§T2.4), so the ingredients the spec assumed
exist — but nothing consumes them. It is write-only.

### T1.4 Normalization (context for any weight discussion)

Raw weights are summed per composite key, then divided by the single global
maximum so the top node is exactly `1.0`
([`:442-448`](netlify/functions/generate-profile-snapshot.ts:442)). The
normalization is **global across the whole snapshot**, not per-board and not
per-cluster. Absolute weight values are therefore meaningless outside a single
snapshot run.

---

## T2 — Event-type inventory

**Verdict: 15 distinct event types, 2,682 rows. Six are consumed; nine are
write-only. There is exactly one reader of `weave_events` in the entire
codebase, so "consumed-by" is binary — a type is in `ENGAGEMENT_RULES` or it is
write-only. No third category exists.**

### T2.1 The inventory

```sql
-- C3: event-type inventory
select event_type, count(*) as rows,
       count(target_id) as with_target,
       count(duration_ms) as with_duration,
       min(timestamp)::date as first_seen,
       max(timestamp)::date as last_seen
from weave_events group by event_type order by rows desc;
```

**Cardinality check:** expected 15 groups summing to `select count(*) from
weave_events` = **2,682**; processed 15 groups summing to
499+450+410+345+138+132+128+125+110+101+84+75+36+34+15 = **2,682**. ✅ Match.

| event_type | rows | grain | duration-bearing | consumed-by | surface-alive |
|---|---:|---|---|---|---|
| `connection_label_clicked` | 499 | **edge** (`connection:{b}:{from}:{to}`) → attributed to 2 nodes | no (0/499) | weighting table, `1.0` | alive — [App.tsx:339](src/App.tsx:339) |
| `connection_description_closed` | 450 | **edge** → 2 nodes | **yes, 450/450** | weighting table, `0.3` | alive — [App.tsx:305](src/App.tsx:305) |
| `board_switched` | 410 | **board** (`board:{id}`) | no | **write-only** | alive — [App.tsx:358](src/App.tsx:358) |
| `session_started` | 345 | **session** (`target_id` null; `board_id`+`session_id` only) | no | **write-only** | alive — [App.tsx:219](src/App.tsx:219) |
| `node_selected` | 138 | **node** | no | weighting table, `0.1` | alive — [App.tsx:140](src/App.tsx:140) |
| `lightbox_opened` | 132 | **node** | no | weighting table, `0.1` | alive — [ImageCardNode.tsx:105](src/components/ImageCardNode.tsx:105), [LinkCardNode.tsx:633](src/components/LinkCardNode.tsx:633), [PdfCardNode.tsx:190](src/components/PdfCardNode.tsx:190) |
| `lightbox_closed` | 128 | **node** | **yes, 128/128** | weighting table, duration-scaled | alive — [ImageCardNode.tsx:118](src/components/ImageCardNode.tsx:118), [LinkCardNode.tsx:617](src/components/LinkCardNode.tsx:617), [PdfCardNode.tsx:203](src/components/PdfCardNode.tsx:203) |
| `item_added` | 125 | **node** | no | weighting table, `0.2` | alive — [App.tsx:407](src/App.tsx:407), [:459](src/App.tsx:459), [:532](src/App.tsx:532), [AddNodeButton.tsx:78](src/components/AddNodeButton.tsx:78), [:104](src/components/AddNodeButton.tsx:104), [:158](src/components/AddNodeButton.tsx:158), [:217](src/components/AddNodeButton.tsx:217) |
| `voice.session.started` | 110 | **session** (voice) — null `target_id` | no | **write-only** | alive — [vadController.ts:367](src/services/voice/vadController.ts:367) via [voiceSessionLogger.ts:48](src/services/voice/voiceSessionLogger.ts:48) |
| `voice.session.ended` | 101 | **session** (voice) — null `target_id` | no | **write-only** | alive — [vadController.ts:470](src/services/voice/vadController.ts:470) |
| `weave_triggered` | 84 | **board** (null `target_id`; `board_id` only) | **partly, 54/84** | **write-only** | alive — [WeaveButton.tsx:447](src/components/WeaveButton.tsx:447) |
| `session_ended` | 75 | **session** | no | **write-only** | alive — [App.tsx:222](src/App.tsx:222) |
| `item_deleted` | 36 | **node** | no | **write-only** | alive — [App.tsx:268](src/App.tsx:268); last emitted 2026-07-25 |
| `voice_insight_played` | 34 | **edge** (`connection:{b}:{from}:{to}`) | **yes, 34/34** | **write-only** | code alive, **traffic dead since 2026-05-31** — see §T2.3 |
| `board_created` | 15 | **board** | no | **write-only** | alive — [App.tsx:366](src/App.tsx:366) |

### T2.2 Target-id shape (resolver compatibility)

```sql
-- C4: segment counts per type
select event_type, array_length(string_to_array(target_id, ':'), 1) as segments, count(*)
from weave_events where target_id is not null group by 1, 2 order by 1, 2;
```

**Cardinality check:** expected 10 groups (10 of 15 types carry a `target_id`)
summing to 2,262; processed 10 groups summing to 2,262. ✅ Match.

Every populated `target_id` is shape-correct for its resolver: both
`connection:` types are 4-segment (499 + 450), all five `node:` types are
3-segment (125 + 36 + 128 + 132 + 138), both `board:` types are 2-segment
(15 + 410), and `voice_insight_played` is 4-segment `connection:`. **Zero
malformed rows.** The 2026-04 cleanup migration
[`005_cleanup_target_id_format.sql`](supabase/migrations/005_cleanup_target_id_format.sql)
did its job and nothing has regressed since.

### T2.3 The "Listen to insight" button — confirmed emitting path

**Confirmed: the button emits `voice_insight_played`, and it is edge-grain and
duration-bearing.** The full path at `ff0b4f8`:

1. Label `'Listen to insight'` —
   [`EdgeDetailPopup.tsx:375`](src/components/EdgeDetailPopup.tsx:375), inside
   `VoiceInsightButton`'s `labelByState` map (`idle` state).
2. Button rendered —
   [`EdgeDetailPopup.tsx:685-691`](src/components/EdgeDetailPopup.tsx:685),
   `onClick={triggerVoice}`.
3. `triggerVoice` comes from `useVoiceInsight({ buildRequest, onPlayed:
   handlePlayed })` —
   [`EdgeDetailPopup.tsx:514-517`](src/components/EdgeDetailPopup.tsx:514).
4. `handlePlayed` emits —
   [`EdgeDetailPopup.tsx:489-512`](src/components/EdgeDetailPopup.tsx:489):

```ts
trackEvent('voice_insight_played', {
  boardId,
  targetId: `connection:${boardId}:${fromId}:${toId}`,
  durationMs: Math.round(metrics.durationListened * 1000),
  metadata: {
    connectionLabel: connection.label,
    nodeIds: [fromId, toId],
    durationListened: metrics.durationListened,
    completed: metrics.completed,
    insightLength: metrics.insightLength,
    totalLatency: metrics.totalLatency,
    mode,
  },
})
```

5. `EdgeDetailPopup` is mounted at [`App.tsx:704`](src/App.tsx:704).

**Surface-alive verdict: the surface is alive in code — the component renders,
the button is not feature-flagged, and there is no deprecation marker anywhere
in the file (`grep -n "deprecat" src/components/EdgeDetailPopup.tsx` → no
matches).** The dispatch's "deprecation-pending" is a plan, not a code fact; it
is not observable from the repository at this SHA.

What *is* observable is that traffic stopped: last `voice_insight_played` row is
**2026-05-31**, ~13 weeks before the snapshot time, while `voice.session.*`
events continue through 2026-08-28. The one-way TTS playback characterization
is consistent with the payload — `completed`, `durationListened`,
`insightLength` describe a playback, with no response channel. The row is
**edge-grain and carries listened-duration on 100% of rows**, which makes it the
single richest depth signal in the table that nothing reads.

### T2.4 `weave_triggered` payload shape

Emitted at [`WeaveButton.tsx:447-467`](src/components/WeaveButton.tsx:447) with
no `targetId` (board-grain), `durationMs` = wall-clock weave latency, and a
13-key metadata object.

```sql
-- C5: metadata key coverage
select k, count(*) from weave_events, jsonb_object_keys(metadata) k
where event_type = 'weave_triggered' and metadata is not null group by 1 order by 2 desc;

-- C6: duration coverage over time
select date_trunc('month', timestamp)::date as mon, count(*) as rows, count(duration_ms) as w_duration
from weave_events where event_type = 'weave_triggered' group by 1 order by 1;
```

`mode` is present on **84/84** rows. The other twelve keys (`nodeCount`,
`connectionsReturned`, `apiLatencyMs`, `promptTokens`, `completionTokens`,
`model`, `stopReason`, `skipped`, `error`, `contextConnectionsSent`,
`connectionsAfterDedup`, `duplicatesFiltered`) are present on **54/84** — the
Phase-5 enrichment landed mid-May 2026, and the 24 April rows plus 6 early-May
rows predate it. Duration coverage follows the same boundary exactly: 0/24 in
April, 25/31 in May, 21/21, 4/4, 4/4 thereafter.

**Consequence for the spec drift in §T1.3:** a `weave_triggered` rule keyed on
`nodeCount` tiers with a `mode` multiplier could be evaluated on only 54 of 84
existing rows; `mode` alone covers all 84.

### T2.5 There is exactly one reader

```
grep -rn "weave_events" src netlify supabase   (excluding docs/, node_modules/, .netlify/, dist/)
```

Reads: **one** —
[`generate-profile-snapshot.ts:387`](netlify/functions/generate-profile-snapshot.ts:387),
`.from('weave_events').select('*').in('board_id', boardIds)`.
Writes: **one** — [`eventTracker.ts:48`](src/services/eventTracker.ts:48).
Everything else is DDL/DML in `supabase/migrations/` or a generated type in
[`database.ts:460`](src/types/database.ts:460).

**Precondition for this absence claim:** the search covers the working tree at
`ff0b4f8` excluding `node_modules/`, `.git/`, `.netlify/` (build artifacts
mirroring `netlify/functions/`), `dist/`, and `docs/`. It would **not** catch a
consumer that reaches `weave_events` through a Postgres view, RPC, or trigger
rather than by name in application code. Checked (`C18`) and none exist. `public` holds
exactly two views — `active_voice_session_deposits` and
`real_voice_session_deposits` — and `position('weave_events' in
pg_get_viewdef(oid))` is `0` for both, so neither references the table. There
are no materialized views. `pg_trigger` on `weave_events` holds only two
internal RI constraint triggers (`tgisinternal = t`), i.e. the FK enforcement
for `user_id`, and no user-defined trigger.

The practical upshot: **"consumed-by" for `weave_events` is binary.** There is
no "other consumer" column to fill — a type is in `ENGAGEMENT_RULES` or it is
write-only.

---

## T3 — Write-only breakdown

**Verdict: 1,210 of 2,682 rows (45.12%) are write-only, across nine types. The
preflight read's 44.9% has drifted +0.22pp on ~2 weeks of new data. One type is
write-only *and* traffic-dead; zero types are write-only and code-dead.**

```sql
-- C7: write-only breakdown by type
select case when event_type in ('connection_label_clicked','connection_description_closed',
                                'item_added','lightbox_opened','lightbox_closed','node_selected')
            then 'weighted' else 'write_only' end as class,
       event_type, count(*) as rows,
       round(100.0 * count(*) / sum(count(*)) over (), 2) as pct_of_all
from weave_events group by 1, 2 order by 1, 3 desc;

-- C8: totals
select count(*) filter (where event_type in ('connection_label_clicked','connection_description_closed',
         'item_added','lightbox_opened','lightbox_closed','node_selected')) as weighted_rows,
       count(*) - count(*) filter (where event_type in ('connection_label_clicked','connection_description_closed',
         'item_added','lightbox_opened','lightbox_closed','node_selected')) as write_only_rows,
       count(*) as total
from weave_events;
```

| class | event_type | rows | % of all events | surface status |
|---|---|---:|---:|---|
| weighted | `connection_label_clicked` | 499 | 18.61% | alive |
| weighted | `connection_description_closed` | 450 | 16.78% | alive |
| weighted | `node_selected` | 138 | 5.15% | alive |
| weighted | `lightbox_opened` | 132 | 4.92% | alive |
| weighted | `lightbox_closed` | 128 | 4.77% | alive |
| weighted | `item_added` | 125 | 4.66% | alive |
| **write-only** | `board_switched` | 410 | 15.29% | alive, emitting through 2026-08-28 |
| **write-only** | `session_started` | 345 | 12.86% | alive, emitting through 2026-08-28 |
| **write-only** | `voice.session.started` | 110 | 4.10% | alive, emitting through 2026-08-28 |
| **write-only** | `voice.session.ended` | 101 | 3.77% | alive, emitting through 2026-08-28 |
| **write-only** | `weave_triggered` | 84 | 3.13% | alive, emitting through 2026-08-28 |
| **write-only** | `session_ended` | 75 | 2.80% | alive, but last emitted **2026-08-27** vs. `session_started` 2026-08-28 — 345 starts to 75 ends is a 4.6× asymmetry, see 🚩D3 |
| **write-only** | `item_deleted` | 36 | 1.34% | alive, last emitted **2026-07-25** |
| **write-only** | `voice_insight_played` | 34 | 1.27% | 🚩 **code alive, traffic dead since 2026-05-31** |
| **write-only** | `board_created` | 15 | 0.56% | alive, last emitted 2026-08-13 |

**Totals: weighted 1,472 (54.88%) / write-only 1,210 (45.12%) / 2,682.**

**Cardinality check:** 15 rows expected and processed; 1,472 + 1,210 = 2,682 =
`count(*)`. ✅ Match.

### T3.1 Write-only **and** surface-dead

**Exactly zero types are surface-dead in the strict sense** (emitter removed
from code). Every one of the nine write-only types has a live `trackEvent` call
site at `ff0b4f8` — see the file:line column in §T2.1, all of which resolve.

If "surface-dead" is relaxed to *traffic-dead* (emitter present, no rows for
≥60 days before the snapshot time), there is **one** candidate:

- **`voice_insight_played`** — 34 rows, last 2026-05-31, 89 days silent. This
  is the only write-only type that is also edge-grain and 100% duration-bearing.
  Excluding it from a roster on "surface-dead" grounds would be excluding the
  richest depth signal in the table on the basis of a *plan* to deprecate that
  is not present in the code (§T2.3). Flagged, not recommended either way.

`item_deleted` (36 rows, last 2026-07-25, 34 days silent) does not meet the
60-day bar and its emitter is live.

**Precondition:** "traffic-dead" is measured against `max(timestamp)` per type
at the snapshot time. It is a claim about *this prod database*, not about
whether the surface can still be reached in the running app.

---

## T4 — Anchor/cluster mechanics verification

**Verdict: the planning chat's reconstruction is wrong in its central
mechanism. There is no anchor-seeded similarity search and no cap of 3 on
cluster count. Clustering is agglomerative average-linkage over all nodes;
"anchors" are a per-cluster top-3 *label*, computed after clustering, used only
to mark ★ in a downstream prompt. The ≥4-thread discrepancy therefore
dissolves — it was never a discrepancy.**

### T4.1 What the code actually does

Clustering — [`:214-267`](netlify/functions/generate-profile-snapshot.ts:214),
called at [`:457`](netlify/functions/generate-profile-snapshot.ts:457):

```ts
function agglomerativeClustering(nodes: NodeEntry[], threshold: number): number[][] {
  // ... precompute full pairwise cosine similarity matrix ...
  const clusters: number[][] = nodes.map((_, i) => [i])   // every node its own cluster
  while (clusters.length > 1) {
    // scan all cluster pairs, pick highest AVERAGE-LINKAGE similarity
    // ...
    if (bestSim < threshold) break     // <-- the only stopping condition
    clusters[bestI] = clusters[bestI].concat(clusters[bestJ])
    clusters.splice(bestJ, 1)
  }
  return clusters
}
```

**Anchor selection** — [`:476-488`](netlify/functions/generate-profile-snapshot.ts:476),
*inside* the per-cluster `.map()` that runs **after** clustering completes:

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

### T4.2 Point-by-point against the dispatch's questions

| Question asked | Answer from code |
|---|---|
| "Anchor selection: top-3 nodes by weight?" | **Confirmed as to the rule, refuted as to the role.** It *is* top-3 by normalized engagement weight ([`:479-481`](netlify/functions/generate-profile-snapshot.ts:479)) — but **per cluster, after clustering**, and `Math.min(3, memberWeights.length)`, so a 2-member cluster has 2 anchors. Anchors are not seeds; they seed nothing. Their only downstream use is prefixing `★ ` in the theme prompt ([`extract-snapshot-themes.ts:106`](netlify/functions/extract-snapshot-themes.ts:106), [`:116`](netlify/functions/extract-snapshot-themes.ts:116)), plus `engagement_weight` = mean of those top-3 weights. |
| "Similarity search around each anchor's embedding at 0.72?" | **Refuted.** No similarity search exists. `CLUSTER_SIMILARITY_THRESHOLD = 0.72` ([`:72`](netlify/functions/generate-profile-snapshot.ts:72)) is a **stopping threshold on average linkage between clusters** ([`:259`](netlify/functions/generate-profile-snapshot.ts:259)), not a radius around a point. Membership rule: two clusters merge iff their *mean* pairwise cosine similarity is the highest among all remaining pairs **and** ≥ 0.72; the loop halts the first time the best available pair falls below 0.72. |
| "Two anchors within threshold of each other: merge / overlap / duplicates?" | **The question does not apply, and the underlying concern is structurally impossible.** Anchors do not define clusters, so two anchors cannot collide. Partitional guarantee: every node starts in exactly one cluster ([`:232`](netlify/functions/generate-profile-snapshot.ts:232)) and merging concatenates then splices ([`:262-263`](netlify/functions/generate-profile-snapshot.ts:262)), so a node is in exactly one cluster always. **Overlapping clusters and duplicate clusters cannot occur.** Two *anchors of different clusters* being highly similar is possible and is not handled — but it is also not a defect, because clusters were already separated by average linkage over all members, not by their anchors. |
| "Singleton handling: dropped where, how?" | [`:459-461`](netlify/functions/generate-profile-snapshot.ts:459) — `rawClusters.filter(c => c.length > 1)` immediately after clustering, before cluster objects are built. The count is preserved as `singletons_dropped` in `generation_metadata` ([`:520`](netlify/functions/generate-profile-snapshot.ts:520)) and in the HTTP response ([`:576`](netlify/functions/generate-profile-snapshot.ts:576)). **The node ids are not preserved** — a dropped singleton is unrecoverable from the snapshot row (🚩D2). |

### T4.3 The "≥4 threads" discrepancy — resolved, with evidence

The dispatch asks how ≥4 threads emerged if "the design caps clusters at anchor
count (3)." **The premise is false twice over, and the fixture row proves the
second half.**

1. **There is no cap.** Cluster count is `nonSingletonClusters.length`
   ([`:460`](netlify/functions/generate-profile-snapshot.ts:460)), bounded above
   only by ⌊n/2⌋. `cluster_id` is assigned `c${idx + 1}` over however many
   survive ([`:496`](netlify/functions/generate-profile-snapshot.ts:496)); no
   slice, no top-N, anywhere. Downstream,
   [`extract-snapshot-themes.ts:255`](netlify/functions/extract-snapshot-themes.ts:255)
   iterates `for (const cluster of clusters)` with no limit. A run producing 4,
   9, or 20 clusters is ordinary behavior. **≥4 threads needs no explanation.**

2. **The "sole reference snapshot" is not a pipeline output.** Its `clusters`
   column is **NULL** and its `event_count` is **0** (§T5.3). It was never
   clustered by this code. Its `generation_metadata` says so in as many words:

   ```
   "note": "Underlying nodes lost in localStorage→Supabase migration, narrative
            preserved as exemplary baseline. Original snapshot generated April 17 2026."
   ```

   The threads counted in it were counted by reading its 3,657-character
   `narrative` prose. **There is no stored cluster structure to compare against
   any cap**, so no observation about that document constrains the pipeline's
   cluster count at all.

**Of the three explanations the dispatch offered — differing anchor count,
narrative subdivision, or a different mechanism — the evidence supports the
third, and refutes the framing that made the first two necessary.** The
mechanism differs from the reconstruction: anchors are labels, not seeds, and
nothing caps cluster count.

### T4.4 Order-dependence note (catalogued, not a fix)

`agglomerativeClustering` breaks ties with strict `>`
([`:250`](netlify/functions/generate-profile-snapshot.ts:250)), so on exactly
equal average linkage the *first* pair in index order wins. Node order comes
from an unordered Supabase `select` ([`:346-350`](netlify/functions/generate-profile-snapshot.ts:346))
with no `order by`. Exact float ties are vanishingly unlikely on 1536-dim
embeddings, so this is theoretical — but snapshot reproducibility across runs is
not guaranteed by construction. 🚩D4.

---

## T5 — Snapshot table facts

**Verdict: the table of record is `weave_profile_snapshots`. It has a
`generation_metadata jsonb` column in the live schema. It holds exactly one row,
which is a hand-authored fixture, not a pipeline product. `weave_profile_cluster_embeddings`
is confirmed empty and confirmed not the target.**

### T5.1 The table of record

[`generate-profile-snapshot.ts:539-543`](netlify/functions/generate-profile-snapshot.ts:539):

```ts
    const { data: inserted, error: insertErr } = await supabase
      .from('weave_profile_snapshots')
      .insert(snapshotRow)
      .select('id')
      .single()
```

`weave_profile_cluster_embeddings` appears nowhere in
`netlify/functions/generate-profile-snapshot.ts` and holds **0 rows** (`C9`),
consistent with the known-dead status. It is not written by this pipeline.

### T5.2 Live schema — `generation_metadata` exists

```sql
-- C10
select ordinal_position, column_name, data_type, is_nullable, column_default
from information_schema.columns
where table_schema = 'public' and table_name = 'weave_profile_snapshots'
order by ordinal_position;
```

| # | column | type | nullable | default |
|---|---|---|---|---|
| 1 | `id` | uuid | NO | `gen_random_uuid()` |
| 2 | `created_at` | timestamptz | NO | `now()` |
| 3 | `board_ids` | ARRAY | NO | — |
| 4 | `node_count` | integer | NO | — |
| 5 | `event_count` | integer | NO | — |
| 6 | `clusters` | jsonb | YES | — |
| 7 | `bridges` | jsonb | YES | — |
| 8 | `narrative` | text | YES | — |
| 9 | `trigger_reason` | text | NO | `'unknown'::text` |
| 10 | **`generation_metadata`** | **jsonb** | YES | — |
| 11 | `user_id` | uuid | **YES** | **`auth.uid()`** |

**`generation_metadata` exists in the live prod schema, not merely in spec.**
✅ Confirmed as an OQ14 setup fact.

**`user_id` default is `auth.uid()`** — confirmed as believed. Note it is
**nullable**, which matters for OQ14: a service-role insert (RLS-bypassing, no
`auth.uid()`) would write `user_id = NULL` rather than failing a NOT NULL
constraint. That row would then be invisible to every `authenticated` policy in
§T5.4, since `auth.uid() = NULL` is never true. Catalogued as 🚩D1; **not
tested**, per the non-goals.

The shape the pipeline writes into `generation_metadata`
([`:511-526`](netlify/functions/generate-profile-snapshot.ts:511)):
`timing_ms{fetch_nodes, fetch_embeddings, fetch_events, compute_weights,
cluster}`, `cluster_threshold_used`, `singletons_dropped`,
`nodes_excluded_no_embedding`, `max_raw_weight_before_normalization`,
`total_clusters`, `rules_applied`, `events_unmatched_by_type`.

### T5.3 The one row, quoted

```sql
-- C11
select id, created_at, board_ids, node_count, event_count, trigger_reason, user_id,
       clusters is null as clusters_null, bridges is null as bridges_null,
       length(narrative) as narrative_chars, jsonb_pretty(generation_metadata)
from weave_profile_snapshots;
```

**Cardinality check:** expected 1 row (`select count(*)` = 1, `C9`); processed 1.
✅ Match.

```
id              | 204af847-fa26-4e61-a699-c059fc5cd9e4
created_at      | 2026-04-17 22:52:00+00
board_ids       | {}            -- empty array
node_count      | 37
event_count     | 0
clusters        | NULL
bridges         | NULL
narrative       | (3657 chars, non-null)
trigger_reason  | fixture
user_id         | 92fcfcc8-fac9-466f-be22-afdfa71b9102
generation_metadata:
{
    "note": "Underlying nodes lost in localStorage→Supabase migration, narrative preserved as exemplary baseline. Original snapshot generated April 17 2026.",
    "title": "Clarity as cost, not reward",
    "fixture": true
}
```

This is the load-bearing evidence for §T4.3. It is a preserved narrative with
`fixture: true`, `trigger_reason = 'fixture'`, no boards, no events, and **no
clusters**. None of the pipeline's own `generation_metadata` keys
(`timing_ms`, `cluster_threshold_used`, `rules_applied`, …) are present —
further confirmation that
[`generate-profile-snapshot.ts`](netlify/functions/generate-profile-snapshot.ts)
did not produce it.

**Corroborating the preflight read's finding that the pipeline has never run in
prod:** every row this pipeline inserts would carry `timing_ms` and
`cluster_threshold_used`. Zero rows in `weave_profile_snapshots` carry either.
**Precondition:** this is a claim about rows *currently present* in prod at the
snapshot time under whole-table visibility (§0.2). It does not exclude a run
whose rows were later deleted; nothing in the schema records deletions.

### T5.4 RLS policies, verbatim

```sql
-- C12
select polname,
       case polcmd when 'r' then 'SELECT' when 'a' then 'INSERT'
                   when 'w' then 'UPDATE' when 'd' then 'DELETE' else 'ALL' end as cmd,
       polpermissive as permissive,
       (select array_agg(pg_get_userbyid(r)) from unnest(polroles) r) as roles,
       pg_get_expr(polqual, polrelid) as using_expr,
       pg_get_expr(polwithcheck, polrelid) as with_check_expr
from pg_policy where polrelid = 'public.weave_profile_snapshots'::regclass
order by polname;
```

| polname | cmd | permissive | roles | USING | WITH CHECK |
|---|---|---|---|---|---|
| `readonly_audit_select` | SELECT | t | `{weave_readonly}` | `true` | — |
| `weave_profile_snapshots_delete_own` | DELETE | t | `{authenticated}` | `(auth.uid() = user_id)` | — |
| `weave_profile_snapshots_insert_own` | INSERT | t | `{authenticated}` | — | `(auth.uid() = user_id)` |
| `weave_profile_snapshots_select_own` | SELECT | t | `{authenticated}` | `(auth.uid() = user_id)` | — |
| `weave_profile_snapshots_update_own` | UPDATE | t | `{authenticated}` | `(auth.uid() = user_id)` | `(auth.uid() = user_id)` |

Five policies, all permissive, `rowsecurity = t`, `forcerowsecurity = f`
(`C2`). The table owner is `postgres`, and `FORCE` is off, so the owner and the
service role are unaffected by these policies — the pipeline's service-role
insert bypasses all of them.

**These are the OQ14 setup facts. The empirical insert test was NOT run.** No
`INSERT`, `UPDATE`, `DELETE`, or DDL was issued against prod in the course of
this census; the connection was made as `weave_readonly`, which holds no write
grant on any table.

---

## T6 — Voice-session signal shape (edge-grain evidence base)

**Verdict: `happened`, `duration`, and `turn_count` are all derivable today
from existing columns. Return-evidence is derivable *in principle* but the real
corpus contains none: when QA sessions are excluded, all 16 anchored real
sessions sit on 16 distinct edges. There is no `return_flag` column and no
repeat visit to observe. 🚩 This is the loudest contradiction of the planning
chat's reconstruction in the whole census.**

### T6.1 `voice_sessions` schema

```sql
-- C13
select ordinal_position, column_name, data_type, is_nullable, column_default
from information_schema.columns
where table_schema = 'public' and table_name = 'voice_sessions' order by ordinal_position;
```

| # | column | type | nullable | default |
|---|---|---|---|---|
| 1 | `id` | uuid | NO | `gen_random_uuid()` |
| 2 | `user_id` | uuid | NO | — |
| 3 | `anchor_edge_id` | uuid | **YES** | — |
| 4 | `board_snapshot` | jsonb | NO | `'{}'::jsonb` |
| 5 | `started_at` | timestamptz | NO | `now()` |
| 6 | `ended_at` | timestamptz | YES | — |
| 7 | `end_reason` | text | YES | — |
| 8 | `processing_log` | jsonb | NO | `'[]'::jsonb` |
| 9 | `summary` | text | YES | — |
| 10 | `session_kind` | text | NO | `'real'::text` |

**There is no `duration` column, no `turn_count` column, and no `return_flag`
column.** Foreign keys: `anchor_edge_id → edges(id) ON DELETE SET NULL`;
`voice_utterances.session_id → voice_sessions(id) ON DELETE CASCADE` (`C14`).

Note the two silent-loss paths those FKs create: deleting an edge nulls
`anchor_edge_id` (the session survives, its anchor evidence does not), and
deleting a session cascades away its utterances (the derived turn count
disappears with it). Both matter for any signal built on this table. 🚩D5.

### T6.2 Population, pooled

```sql
-- C15
select count(*) as total_sessions,
       count(anchor_edge_id) as with_anchor_edge,
       count(*) filter (where ended_at is not null) as with_ended_at,
       count(*) filter (where summary is not null) as with_summary,
       count(distinct user_id) as users
from voice_sessions;
```

| metric | value |
|---|---|
| total sessions | **87** |
| with non-null `anchor_edge_id` | **54** (62.1%) |
| with `ended_at` | 85 (2 never closed) |
| with `summary` | **0** |
| distinct users | 1 |

By kind and end reason (`C15b`, `select session_kind, end_reason, count(*),
count(anchor_edge_id) from voice_sessions group by 1,2`):

| session_kind | end_reason | sessions | with anchor |
|---|---|---:|---:|
| `qa` | `user_closed` | 53 | 31 |
| `real` | `user_closed` | 25 | 16 |
| `qa` | `error` | 7 | 7 |
| `qa` | *(null)* | 2 | 0 |

**Cardinality check:** 53+25+7+2 = **87** = total. ✅ Match. Anchors:
31+16+7+0 = **54** = `with_anchor_edge`. ✅ Match.

**62 of 87 sessions (71%) are `session_kind = 'qa'`.** Any metric computed on
the pooled table is majority test traffic. Every figure below is therefore given
both pooled and real-only.

### T6.3 Duration and turn-count distributions

```sql
-- C16a: duration, derived
select count(*) as n, round(min(extract(epoch from ended_at - started_at))::numeric, 1) as min_s,
       round(percentile_cont(0.5) within group (order by extract(epoch from ended_at - started_at))::numeric, 1) as p50_s,
       round(percentile_cont(0.9) within group (order by extract(epoch from ended_at - started_at))::numeric, 1) as p90_s,
       round(max(extract(epoch from ended_at - started_at))::numeric, 1) as max_s
from voice_sessions where ended_at is not null;   -- add: and session_kind = 'real'

-- C16b: turns, derived from voice_utterances
select count(*) as sessions, min(n), percentile_cont(0.5) within group (order by n) as p50, max(n)
from (select vs.id, count(vu.*) n from voice_sessions vs
      join voice_utterances vu on vu.session_id = vs.id
      group by 1) s;   -- add a where on vs.session_kind = 'real'
```

| metric | pooled (87) | real only (25) |
|---|---|---|
| sessions with derivable duration | 85 | **25 / 25 (100%)** |
| duration min / p50 / p90 / max (s) | 1.9 / 101.7 / 922.8 / 1848.3 | — / **634.5** / — / 1848.3 |
| sessions with ≥1 utterance | 76 | **25 / 25 (100%)** |
| turns min / p50 / max | 1 / 3.0 / 47 | **4 / 23.0 / 47** |

The real corpus is dramatically deeper than the pooled figure suggests: median
real session is **10.6 minutes and 23 turns**, against a pooled median of
1.7 minutes and 3 turns. The pooled numbers are dominated by short QA probes.
**Any depth calibration done on the pooled table would be calibrated on test
traffic.** 🚩D6.

### T6.4 Return evidence — the contradiction

```sql
-- C16c: sessions per anchor edge
select sessions_on_anchor, count(*) as n_anchor_edges
from (select anchor_edge_id, count(*) as sessions_on_anchor
      from voice_sessions
      where anchor_edge_id is not null   -- add: and session_kind = 'real'
      group by 1) t
group by 1 order by 1;
```

**Pooled (all 54 anchored sessions):**

| sessions on one anchor edge | # of anchor edges |
|---:|---:|
| 1 | 14 |
| 2 | 6 |
| 3 | 4 |
| 4 | 2 |
| 8 | 1 |

**Cardinality check:** 14·1 + 6·2 + 4·3 + 2·4 + 1·8 = 14+12+12+8+8 = **54** =
`with_anchor_edge` (§T6.2). ✅ Match. 27 distinct anchor edges; 13 of them
carry ≥2 sessions.

**Real only (the 16 anchored `session_kind = 'real'` sessions):**

| sessions on one anchor edge | # of anchor edges |
|---:|---:|
| 1 | **16** |

**Cardinality check:** 16·1 = **16** = anchored real sessions (§T6.2). ✅ Match.

🚩 **Every one of the 13 repeat-visited anchor edges is repeat-visited by QA
sessions only. In the real corpus, no edge has ever been revisited.** The
maximum, 8 sessions on one edge, is a QA fixture.

### T6.5 Derivable today vs. requiring new instrumentation

| signal | derivable today? | how / why not |
|---|---|---|
| **happened** | ✅ **yes** | row existence + `anchor_edge_id is not null`. Edge-grain, 16 real sessions on 16 edges. |
| **duration** | ✅ **yes, derived** | `ended_at - started_at`. 100% coverage on real sessions; 2/87 pooled rows never closed. No stored column — every consumer must recompute, and a never-closed session yields NULL rather than 0. |
| **turn_count** | ✅ **yes, derived** | `count(*) from voice_utterances group by session_id`. 100% coverage on real sessions. No stored column; the `ON DELETE CASCADE` means it is not reconstructible after a session delete. |
| **return-evidence** | ⚠️ **schema-derivable, data-absent** | `count(*) group by anchor_edge_id` needs no new column. But the real corpus has **zero** repeat visits, so the signal is presently unmeasurable — not for want of instrumentation, for want of the behavior. Additionally, `anchor_edge_id → edges ON DELETE SET NULL` means a deleted edge erases return-evidence retroactively. |

**Sizing the Phase-11 depth roster against reality:** three of the four
candidate signals need no new instrumentation at all. The fourth needs no
instrumentation either — it needs users to come back to an edge, which has not
happened once outside QA. **A roster that treats return-evidence as an
available signal today would be building on 16 observations of exactly one
visit each.**

---

## Defect catalogue

Catalogued, not repaired, per the dispatch's non-goals.

| id | severity | finding |
|---|---|---|
| **D1** | setup fact for OQ14 | `weave_profile_snapshots.user_id` is **nullable** with default `auth.uid()`. A service-role insert (which is how the pipeline writes, [`:301`](netlify/functions/generate-profile-snapshot.ts:301)) has no `auth.uid()`, so it would write `user_id = NULL` — silently, no constraint violation — and the row would then be invisible to all four `authenticated` policies (§T5.4). **Not empirically tested** (OQ14 deferred). |
| **D2** | observability | Dropped singleton **node ids are not preserved** — only the count ([`:459-461`](netlify/functions/generate-profile-snapshot.ts:459), [`:520`](netlify/functions/generate-profile-snapshot.ts:520)). Which nodes fell out of a snapshot is unrecoverable after the fact. |
| **D3** | data integrity | `session_started` 345 rows vs. `session_ended` 75 — a **4.6× asymmetry** (§T3). 270 sessions have a start with no recorded end. Consistent with `session_ended` firing only on clean unmount ([App.tsx:222](src/App.tsx:222)) and being lost on tab close/navigation. Any session-grain duration signal built on this pair would be defined for 22% of sessions. |
| **D4** | reproducibility | Cluster merges break exact ties by index order ([`:250`](netlify/functions/generate-profile-snapshot.ts:250)) over an **unordered** `select` ([`:346-350`](netlify/functions/generate-profile-snapshot.ts:346)) — no `order by`. Snapshot output is not reproducible by construction. Practically negligible on 1536-dim floats. |
| **D5** | data integrity | `voice_sessions.anchor_edge_id → edges ON DELETE SET NULL` silently erases edge-grain attribution when an edge is deleted; `voice_utterances ON DELETE CASCADE` erases derived turn counts with the session (§T6.1). |
| **D6** | measurement hazard | 71% of `voice_sessions` are `session_kind = 'qa'`. Pooled medians (1.7 min / 3 turns) differ from real medians (10.6 min / 23 turns) by roughly 6× and 8×. Any calibration on the pooled table calibrates on test traffic (§T6.3). |
| **D7** | observability | **New in this census.** Engagement attribution silently drops resolved keys that miss `weightMap` — the `if (key in weightMap)` guard at [`:430`](netlify/functions/generate-profile-snapshot.ts:430) has **no counter**. `generation_metadata` records `nodes_excluded_no_embedding` (nodes with no parseable embedding) and `events_unmatched_by_type` (events with no rule), but **not** events that matched a rule, resolved cleanly, and hit nothing. Measured below: that is 14.9% of all resolved keys. |

### D7, measured

```sql
-- C17: attribution coverage of the six weighted rules
with resolved as (
  select unnest(case when event_type like 'connection%'
      then array[split_part(target_id,':',2)||':'||split_part(target_id,':',3),
                 split_part(target_id,':',2)||':'||split_part(target_id,':',4)]
      else array[substring(target_id from 6)] end) as ckey
  from weave_events
  where event_type in ('connection_label_clicked','connection_description_closed',
                       'item_added','lightbox_opened','lightbox_closed','node_selected')
    and target_id is not null)
select case when live.node_id is not null then 'live_embedding'
            when anyr.node_id is not null then 'archived_embedding'
            else 'no_embedding_row' end as bucket, count(*)
from resolved r
left join weave_embeddings live on live.board_id||':'||live.node_id = r.ckey and live.archived_at is null
left join weave_embeddings anyr on anyr.board_id||':'||anyr.node_id = r.ckey
group by 1 order by 2 desc;
```

| bucket | resolved keys | share |
|---|---:|---:|
| hits a live embedding (weight lands) | **2,033** | 85.1% |
| hits an **archived** embedding (dropped — `is('archived_at', null)` at [`:350`](netlify/functions/generate-profile-snapshot.ts:350)) | **359** | 15.0% |
| no embedding row at all (dropped) | **29** | 1.2% |

**Cardinality check:** 2,033 + 359 + 29 = **2,421** resolved keys; independently
derived as 2·(499+450) + (125+132+128+138) = 1,898 + 523 = **2,421**. ✅ Match.

Per-type hit rates (`C17b`, same CTE grouped by `event_type`): `lightbox_opened`
89.4%, `lightbox_closed` 89.1%, `connection_description_closed` 86.4%,
`connection_label_clicked` 86.2%, `item_added` **64.0%**, `node_selected`
**60.1%**.

This is expected behavior — archived nodes *should* not accrue weight — but it
is **invisible**: a snapshot run today would discard 388 of 2,421 attributions
and report nothing about it in `generation_metadata`. The two lowest-coverage
types are the two whose events are most likely to reference since-deleted nodes.

```sql
-- C18: sole-reader precondition — nothing reaches weave_events via a view or trigger
select c.relname, c.relkind, position('weave_events' in pg_get_viewdef(c.oid)) as mentions
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind in ('v','m');
-- → active_voice_session_deposits | v | 0 ;  real_voice_session_deposits | v | 0

select tgname, tgisinternal from pg_trigger where tgrelid = 'public.weave_events'::regclass;
-- → 2 rows, both tgisinternal = t (RI constraint triggers)
```

---

## Contradictions of the planning chat's reconstruction

Flagged loudly, in descending order of consequence.

1. 🚩 **The clustering mechanism is not anchor-seeded similarity search.** It is
   agglomerative average-linkage over all nodes, with 0.72 as a *stopping*
   threshold on inter-cluster mean similarity, not a radius. Anchors are a
   per-cluster top-3 label computed **after** clustering, whose only downstream
   effect is a `★` marker in a prompt. (§T4.1, §T4.2)

2. 🚩 **There is no cap of 3 on cluster count.** Cluster count is unbounded
   above by anything but ⌊n/2⌋. The "≥4 threads" discrepancy was never a
   discrepancy; the question it was raised to answer does not arise. (§T4.3)

3. 🚩 **The sole reference snapshot is not a pipeline output.** `clusters` is
   NULL, `event_count` is 0, `board_ids` is `{}`, `trigger_reason` is
   `'fixture'`, and its own metadata says the underlying nodes were lost in the
   localStorage→Supabase migration. No mechanical claim can be tested against
   it. (§T5.3)

4. 🚩 **`weave_triggered` has no engagement rule.** The April spec's tiered
   0.5/0.8/1.0 with ×1.5 mode multiplier does not exist in code, in any form.
   Its 84 rows are write-only, and only 54 carry the `nodeCount` such a rule
   would need. (§T1.3, §T2.4)

5. 🚩 **Return-evidence for voice sessions is data-absent, not
   instrumentation-absent.** Restricted to real sessions, all 16 anchored
   sessions sit on 16 distinct edges — zero repeat visits, ever. The 13
   repeat-visited edges visible in the pooled data are entirely QA. (§T6.4)

6. 🚩 **71% of `voice_sessions` is QA traffic**, and pooled depth medians
   understate real ones by ~6–8×. (§T6.3)

7. ⚠️ **"Listen to insight" is deprecation-*planned*, not deprecation-marked.**
   The dispatch's `voice_insight_played` identification is confirmed exactly
   ([EdgeDetailPopup.tsx:489-512](src/components/EdgeDetailPopup.tsx:489)), and
   the one-way-TTS characterization matches the payload. But no deprecation
   marker exists in the code, the button renders unconditionally, and it is the
   only edge-grain, 100%-duration-bearing signal in `weave_events`. What *is*
   true is that it has emitted nothing since 2026-05-31. (§T2.3, §T3.1)

8. ℹ️ **`connection_description_closed` is not the only duration-bearing type.**
   `lightbox_closed` (128/128) and `voice_insight_played` (34/34) are also fully
   duration-bearing; `weave_triggered` is partially so (54/84). (§T2.1)

---

## Query inventory

The durable layer. Every claim above is verify-by-requery.

| tag | § | what it establishes |
|---|---|---|
| `C1` | 0.2 | `weave_readonly` is not superuser, not `BYPASSRLS` |
| `C2` | 0.2 | RLS enabled + `readonly_audit_select` present on all 12 tables |
| `C3` | T2.1 | event-type inventory: rows, target/duration coverage, first/last seen |
| `C4` | T2.2 | `target_id` segment counts per type (resolver compatibility) |
| `C5` | T2.4 | `weave_triggered` metadata key coverage |
| `C6` | T2.4 | `weave_triggered` duration coverage by month |
| `C7` | T3 | weighted vs. write-only, per type, with % of all |
| `C8` | T3 | weighted / write-only / total row counts |
| `C9` | T5.1, T5.3 | table row counts incl. `weave_profile_cluster_embeddings` = 0 |
| `C10` | T5.2 | `weave_profile_snapshots` column schema |
| `C11` | T5.3 | the single fixture row + `generation_metadata` |
| `C12` | T5.4 | RLS policies on `weave_profile_snapshots`, verbatim |
| `C13` | T6.1 | `voice_sessions` column schema |
| `C14` | T6.1 | FK constraints on `voice_sessions` and `voice_utterances` |
| `C15` / `C15b` | T6.2 | voice-session population; split by kind and end reason |
| `C16a–c` | T6.3, T6.4 | duration, turn-count, and per-anchor session distributions |
| `C17` / `C17b` | D7 | attribution coverage: live / archived / absent, overall and per type |
| `C18` | T2.5 | no view or user-defined trigger over `weave_events` (the sole-reader precondition) |

Reconnect with:

```bash
psql "$WEAVE_PROD_RO_DATABASE_URL" -X
```

## File/line map

| what | where |
|---|---|
| `ENGAGEMENT_RULES` (6 entries) | [generate-profile-snapshot.ts:111-150](netlify/functions/generate-profile-snapshot.ts:111) |
| `resolveNodeTarget` | [:152-158](netlify/functions/generate-profile-snapshot.ts:152) |
| `lightboxClosedWeight` + constants | [:72-89](netlify/functions/generate-profile-snapshot.ts:72) |
| `CLUSTER_SIMILARITY_THRESHOLD = 0.72` | [:72](netlify/functions/generate-profile-snapshot.ts:72) |
| weight accumulation + silent drop (D7) | [:413-440](netlify/functions/generate-profile-snapshot.ts:413) |
| global normalization | [:442-448](netlify/functions/generate-profile-snapshot.ts:442) |
| `agglomerativeClustering` | [:214-267](netlify/functions/generate-profile-snapshot.ts:214) |
| threshold stop | [:259](netlify/functions/generate-profile-snapshot.ts:259) |
| singleton filter | [:459-461](netlify/functions/generate-profile-snapshot.ts:459) |
| anchor selection (top-3, post-clustering) | [:476-488](netlify/functions/generate-profile-snapshot.ts:476) |
| `generation_metadata` construction | [:511-526](netlify/functions/generate-profile-snapshot.ts:511) |
| snapshot insert (table of record) | [:539-543](netlify/functions/generate-profile-snapshot.ts:539) |
| archived-embedding exclusion | [:350](netlify/functions/generate-profile-snapshot.ts:350) |
| anchors → `★` in theme prompt | [extract-snapshot-themes.ts:106,116](netlify/functions/extract-snapshot-themes.ts:106) |
| unbounded per-cluster theme loop | [extract-snapshot-themes.ts:255](netlify/functions/extract-snapshot-themes.ts:255) |
| "Listen to insight" label | [EdgeDetailPopup.tsx:375](src/components/EdgeDetailPopup.tsx:375) |
| `voice_insight_played` emit | [EdgeDetailPopup.tsx:489-512](src/components/EdgeDetailPopup.tsx:489) |
| `VoiceInsightButton` render | [EdgeDetailPopup.tsx:685-691](src/components/EdgeDetailPopup.tsx:685) |
| `weave_triggered` emit | [WeaveButton.tsx:447-467](src/components/WeaveButton.tsx:447) |
| the only `weave_events` reader | [generate-profile-snapshot.ts:387](netlify/functions/generate-profile-snapshot.ts:387) |
| the only `weave_events` writer | [eventTracker.ts:48](src/services/eventTracker.ts:48) |
