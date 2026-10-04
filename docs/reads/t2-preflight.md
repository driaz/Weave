# t2 pre-registration read — the factual table the t2 predictions name

> **This is a point-in-time read, as of 2026-10-04 UTC. Findings only; no interpretation, no predictions.**
>
> **Read opened:** `2026-10-04 16:27:57 UTC` (`select now()` at first RO connection).
> **Repo SHA:** `bb23d8f` (`origin/main`, freshly fetched; local `main` fast-forwarded from `e54a031` before the read).
> **Database:** Weave prod (`wndfikmpifyqkgivmnwv`). **Role:** `weave_readonly` via `WEAVE_PROD_RO_DATABASE_URL` / `--db-url` only.
> No writes, no code changes, no snapshot generation.
> **Reference snapshot:** t1 = `efa6d6e1-6fc5-4063-8a1e-0de59409d2ad` (`docs/reads/t1.md`, PR #50), `generation_metadata.generated_at` = `2026-09-07T02:37:59.815Z`.
>
> **Findings in this document decay; the query map does not.** Every count below is verified by re-running the query shown with it, never by citing this document.

---

## 0. Preconditions (stated before any count or absence claim)

| precondition | state | how established |
|---|---|---|
| Checkout currency | `git fetch` then fast-forward: local `main` = `origin/main` = `bb23d8f`. Branch cut from `origin/main`. | `git fetch origin && git pull --ff-only` |
| RO identity | `weave_readonly`, `rolbypassrls = f`, `rolsuper = f` | `select now(), current_user; select rolname, rolbypassrls, rolsuper from pg_roles where rolname = current_user;` |
| RLS visibility | `readonly_audit_select` with `qual = true` for `{weave_readonly}` on all 8 tables this read touches (`boards, edges, nodes, voice_sessions, voice_utterances, weave_embeddings, weave_events, weave_profile_snapshots`); grants are `SELECT` only. Counts are whole-table, not RLS-filtered. | `select tablename, policyname, roles::text, qual from pg_policies where policyname = 'readonly_audit_select' …;` and `information_schema.role_table_grants where grantee = 'weave_readonly'` |
| Single tenant | `count(distinct user_id)` = 1 on `weave_events` and on `nodes` | `select count(distinct user_id) from weave_events;` (same for `nodes`) |
| Migration state | Not re-derived from files. Every table/column used here was observed in `information_schema.columns` on prod during this read. | — |
| Deployed code | **Inference, not observation**: Netlify deploys `main`; no deploy log was read. The snapshot code is byte-identical between t1's deployed SHA `bc22795` and `bb23d8f` (see §F.0), so the deploy question does not change any §F answer unless a non-`main` deploy is live. | `git diff --stat bc22795..bb23d8f -- netlify/ netlify.toml scripts/` |

**The window.** Every "since t1" figure uses **W = (`2026-09-07T02:37:59.815Z`, `2026-10-04 16:27:57+00`]** — t1's `generated_at` exclusive, the read-open instant inclusive. The upper bound is frozen so a re-run reproduces these counts even as new events arrive. Boundary check: rows in `weave_events` with `timestamp` in (`generated_at`, t1 `created_at` = `02:38:03.93`] → **0**, so no event sits ambiguously between t1's read and its insert.

```sql
select count(*) from weave_events
where timestamp > '2026-09-07T02:37:59.815Z' and timestamp <= '2026-09-07 02:38:03.934903+00';   -- → 0
```

**Snapshot inventory** (unchanged since t1; four rows, no t2 yet):

```sql
select id, created_at, trigger_reason from weave_profile_snapshots order by created_at;
-- 204af847… 2026-04-17 fixture | 253c9a8c… 2026-09-06 r2_unweighted | e7adade7… 2026-09-06 r2_unweighted | efa6d6e1… 2026-09-07 02:38:03 t1
```

---

## A. t1 anchor table

Source: the t1 row's own `generation_metadata.anchors[]` (12) and `unclustered_attended[]` (21). Title, type and board are joined live from `weave_embeddings` / `nodes` / `boards`; all 33 nodes still have a live `nodes` row and an unarchived `weave_embeddings` row. **Cardinality: expected 12 + 21 = 33 (t1 summary `anchor_count 12`, `unclustered_attended_count 21`); returned 33.**

- **title** = `nodes.title` (for tweets this is the author display name, not the tweet text — data shape noted in R3a).
- **type** = `nodes.link_type` (`tweet` / `youtube`), or `card_type` when there is no link type (`image`). All 33 have `weave_embeddings.node_type` = `linkCard` except A.2 #17 (`imageCard`).
- **dominant** = the largest `by_class` component, ties → breadth (the `attentionFor` rule, `netlify/lib/snapshot/attention.ts:15-21`). It coincides with t1's stored `attention` label on all 33 rows (dwelt ↔ breadth, discussed ↔ depth, added ↔ recency).
- `w_total` and `by_class` are t1's **decayed** values at t1's `generated_at`, copied from the row.

### A.1 Anchors (12)

| # | composite key | title | type | board | cluster | w_total | breadth | depth | recency | dominant | t1 attention |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | `b3c1473b-85bd-405b-90d0-917754d3da5f:20` | WIRED | tweet | Tech and Business | c1 | 1.9291 | 1.2119 | 0.7172 | 0.0000 | breadth | dwelt |
| 2 | `b3c1473b-85bd-405b-90d0-917754d3da5f:22` | Bloomberg | tweet | Tech and Business | c1 | 1.5417 | 0.3699 | 1.1603 | 0.0114 | depth | discussed (23) |
| 3 | `b3c1473b-85bd-405b-90d0-917754d3da5f:10` | arian ghashghai | tweet | Tech and Business | c1 | 0.9607 | 0.2435 | 0.7172 | 0.0000 | depth | discussed (16) |
| 4 | `a428492a-08f5-4d66-8da6-a307bcdaea62:37` | ​𝐥𝐲𝐫𝐚 | tweet | Philosophy and Art | c2 | 0.5459 | 0.4906 | 0.0000 | 0.0553 | breadth | dwelt |
| 5 | `a428492a-08f5-4d66-8da6-a307bcdaea62:12` | 🧬Maxpein🧬 | tweet | Philosophy and Art | c2 | 0.2087 | 0.2087 | 0.0000 | 0.0000 | breadth | dwelt |
| 6 | `a428492a-08f5-4d66-8da6-a307bcdaea62:27` | Sherry | tweet | Philosophy and Art | c2 | 0.1562 | 0.1562 | 0.0000 | 0.0000 | breadth | dwelt |
| 7 | `a428492a-08f5-4d66-8da6-a307bcdaea62:39` | Early Retirement Taught Me That We’ve All Been Sold A Lie? | youtube | Philosophy and Art | c3 | 3.4528 | 1.1580 | 2.1681 | 0.1267 | depth | discussed (14) |
| 8 | `8a8d45a9-5327-4355-ae3c-c1fff734b327:6` | The Silent Revolution And The Great Resignation | youtube | Abusrdity | c3 | 0.1610 | 0.0000 | 0.1610 | 0.0000 | depth | discussed (2) |
| 9 | `a428492a-08f5-4d66-8da6-a307bcdaea62:8` | Cinema Tweets | tweet | Philosophy and Art | c4 | 0.8756 | 0.6722 | 0.2034 | 0.0000 | breadth | dwelt |
| 10 | `8a8d45a9-5327-4355-ae3c-c1fff734b327:15` | (TRUE DETECTIVE) RUST COHLE - DEVASTATION | youtube | Abusrdity | c5 | 0.2594 | 0.2594 | 0.0000 | 0.0000 | breadth | dwelt |
| 11 | `2810ae3a-3701-4ebb-9c21-a5dd27027232:4` | James Lucas | tweet | Death | c7 | 0.6871 | 0.6871 | 0.0000 | 0.0000 | breadth | dwelt |
| 12 | `a428492a-08f5-4d66-8da6-a307bcdaea62:31` | James Lucas | tweet | Philosophy and Art | c7 | 0.6075 | 0.6075 | 0.0000 | 0.0000 | breadth | dwelt |

Dominant class: **breadth 8** (#1, 4, 5, 6, 9, 10, 11, 12), **depth 4** (#2, 3, 7, 8). Per cluster: c1 3, c2 3, c3 2, c4 1, c5 1, c6 0, c7 2.

### A.2 Unclustered attended (21, t1 rank order)

| # | composite key | title | type | board | w_total | breadth | depth | recency | dominant | t1 attention |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | `a428492a-08f5-4d66-8da6-a307bcdaea62:35` | Überkierk | tweet | Philosophy and Art | 8.3142 | 4.9863 | 3.2933 | 0.0346 | breadth | dwelt |
| 2 | `a428492a-08f5-4d66-8da6-a307bcdaea62:14` | 𝓐𝔂𝓸✯ | tweet | Philosophy and Art | 2.8757 | 2.8757 | 0.0000 | 0.0000 | breadth | dwelt |
| 3 | `b3c1473b-85bd-405b-90d0-917754d3da5f:4` | shouko | tweet | Tech and Business | 2.5353 | 0.5419 | 1.9934 | 0.0000 | depth | discussed (41) |
| 4 | `8a8d45a9-5327-4355-ae3c-c1fff734b327:37` | MeidasTouch | tweet | Abusrdity | 2.2577 | 0.8350 | 1.4000 | 0.0227 | depth | discussed (10) |
| 5 | `8a8d45a9-5327-4355-ae3c-c1fff734b327:39` | Documenting Saylor | tweet | Abusrdity | 2.0131 | 0.5639 | 1.4000 | 0.0491 | depth | discussed (10) |
| 6 | `b3c1473b-85bd-405b-90d0-917754d3da5f:24` | GigSlave Goes Public With $84 Billion Valuation \| Onion News Network | youtube | Tech and Business | 2.0128 | 1.9932 | 0.0000 | 0.0197 | breadth | dwelt |
| 7 | `a428492a-08f5-4d66-8da6-a307bcdaea62:33` | Tony Soprano - 'Is This All There Is' | youtube | Philosophy and Art | 1.9998 | 0.8746 | 1.1252 | 0.0000 | depth | discussed (6) |
| 8 | `b3c1473b-85bd-405b-90d0-917754d3da5f:9` | Naruto | tweet | Tech and Business | 1.1918 | 0.3199 | 0.8719 | 0.0000 | depth | discussed (16) |
| 9 | `a428492a-08f5-4d66-8da6-a307bcdaea62:16` | Columbus Trailer #1 (2017) \| Movieclips Indie | youtube | Philosophy and Art | 0.8954 | 0.8954 | 0.0000 | 0.0000 | breadth | dwelt |
| 10 | `b3c1473b-85bd-405b-90d0-917754d3da5f:8` | The Driven Man | tweet | Tech and Business | 0.7829 | 0.0000 | 0.7829 | 0.0000 | depth | discussed (12) |
| 11 | `8a8d45a9-5327-4355-ae3c-c1fff734b327:7` | RyanPatrick🇺🇸🦅 | tweet | Abusrdity | 0.6843 | 0.0428 | 0.6415 | 0.0000 | depth | discussed (22) |
| 12 | `8a8d45a9-5327-4355-ae3c-c1fff734b327:25` | New York Magazine | tweet | Abusrdity | 0.6832 | 0.0418 | 0.6415 | 0.0000 | depth | discussed (22) |
| 13 | `2810ae3a-3701-4ebb-9c21-a5dd27027232:2` | Alan Watts - Acceptance of Death | youtube | Death | 0.6652 | 0.6652 | 0.0000 | 0.0000 | breadth | dwelt |
| 14 | `a428492a-08f5-4d66-8da6-a307bcdaea62:21` | Big Brain Philosophy | tweet | Philosophy and Art | 0.5646 | 0.5646 | 0.0000 | 0.0000 | breadth | dwelt |
| 15 | `8a8d45a9-5327-4355-ae3c-c1fff734b327:21` | cinesthetic. | tweet | Abusrdity | 0.5343 | 0.0358 | 0.4985 | 0.0000 | depth | discussed (11) |
| 16 | `b3c1473b-85bd-405b-90d0-917754d3da5f:18` | 60 Minutes | tweet | Tech and Business | 0.4499 | 0.1019 | 0.3479 | 0.0000 | depth | discussed (6) |
| 17 | `a428492a-08f5-4d66-8da6-a307bcdaea62:3` | Hate_Room_08.03.2022_MidJourney | image | Philosophy and Art | 0.2034 | 0.0000 | 0.2034 | 0.0000 | depth | discussed (3) |
| 18 | `a428492a-08f5-4d66-8da6-a307bcdaea62:7` | gomi | tweet | Philosophy and Art | 0.1562 | 0.1562 | 0.0000 | 0.0000 | breadth | dwelt |
| 19 | `8a8d45a9-5327-4355-ae3c-c1fff734b327:11` | King Arthur Fan | tweet | Abusrdity | 0.1526 | 0.1526 | 0.0000 | 0.0000 | breadth | dwelt |
| 20 | `a428492a-08f5-4d66-8da6-a307bcdaea62:25` | America Is NOT The Greatest Country Anymore! - Jeff Daniels/HBO Newsroom [edited/clean version] | youtube | Philosophy and Art | 0.0864 | 0.0864 | 0.0000 | 0.0000 | breadth | dwelt |
| 21 | `04c9c895-82cd-4e08-ad20-a5fc6eea12b6:2` | Bearly AI | tweet | Career | 0.0597 | 0.0000 | 0.0000 | 0.0597 | recency | added |

Dominant class: **breadth 9** (#1, 2, 6, 9, 13, 14, 18, 19, 20), **depth 11** (#3, 4, 5, 7, 8, 10, 11, 12, 15, 16, 17), **recency 1** (#21).

```sql
-- QA: t1 anchors + unclustered_attended with title / type / board / cluster / by_class / dominant
with s as (select generation_metadata g from weave_profile_snapshots where id='efa6d6e1-6fc5-4063-8a1e-0de59409d2ad'),
k as (
  select 'anchor' as set, ord, a->>'key' key, a->>'board_id' board_id, a->>'cluster_id' cluster_id,
         (a->>'w_total')::float8 w, (a->'by_class'->>'breadth')::float8 b, (a->'by_class'->>'depth')::float8 d,
         (a->'by_class'->>'recency')::float8 r, a->>'attention' att, (a->>'turns')::int turns
  from s, jsonb_array_elements(g->'anchors') with ordinality x(a,ord)
  union all
  select 'unclustered', ord, a->>'key', a->>'board_id', null, (a->>'w_total')::float8,
         (a->'by_class'->>'breadth')::float8, (a->'by_class'->>'depth')::float8, (a->'by_class'->>'recency')::float8,
         a->>'attention', (a->>'turns')::int
  from s, jsonb_array_elements(g->'unclustered_attended') with ordinality x(a,ord)
)
select k.set, k.ord, k.key, coalesce(n.title, left(e.content_summary, 70)) title, (n.id is not null) node_live,
       e.node_type, n.card_type, n.link_type, bd.name board, k.cluster_id,
       round(k.w::numeric,4) w_total, round(k.b::numeric,4) breadth, round(k.d::numeric,4) depth, round(k.r::numeric,4) recency,
       case when k.b>=k.d and k.b>=k.r then 'breadth' when k.d>k.r then 'depth' else 'recency' end dominant,
       k.att, k.turns, e.archived_at
from k
join weave_embeddings e on e.board_id||':'||e.node_id = k.key
left join nodes n on n.board_id::text = e.board_id and coalesce(n.data->>'_clientNodeId', n.id::text) = e.node_id
left join boards bd on bd.id::text = e.board_id
order by k.set, k.ord;
-- → 33 rows; node_live = t on all 33; archived_at null on all 33
```

---

## B. Re-engagement since t1, per node

**Qualifying roster events in W** (the dispatch's definition, matching the pipeline's resolvers in `netlify/lib/snapshot/engagement.ts:66-115`):

- `lightbox_closed` with `target_id = node:{board}:{node}` → that node;
- `connection_description_closed` with `target_id = connection:{board}:{from}:{to}` → both endpoints;
- real voice sessions (`session_kind = 'real'`, `ended_at` not null, `anchor_edge_id` not null, `ended_at` in W) → `anchor_edge_id` → `edges` → both endpoint `nodes` → client id (`data->>'_clientNodeId'`, falling back to the row uuid, as `reads.ts:140-144`).

**w_rule is undecayed** (no `2^(−age/H)` factor): breadth = `1.5 × min(log₂(s+1) / log₂(46), 1)` with s = `duration_ms / 1000`; depth = `VOICE_BASE × log₂(user_turns + 1)`, `VOICE_BASE = 1.5 / log₂ 5`, user_turns = `count(voice_utterances where speaker = 'user')`. `item_added` (recency) is outside the dispatch's qualifying set and is not counted here; §D shows no t1 node was re-added.

**Flag:** *re-engaged* = at least one qualifying event in W with `w_rule > 0` resolves to the node. No zero-weight rows occurred (gate below).

**qa columns:** rows attributed to the F1 qa voice sessions (§E) are shown and then excluded; the exclusion changes **no** flag.

**Cardinality gate (independent of the per-node table):**

| measure | count |
|---|---:|
| qualifying events in W | **91** = 17 `lightbox_closed` + 71 `connection_description_closed` + 3 real anchored voice sessions |
| events whose target does not resolve | 0 |
| expected (event, key) pairs = 17×1 + 71×2 + 3×2 | **165** |
| resolved (event, key) pairs | **165** |
| → hit one of the 33 nodes in §A | **48** |
| → hit another t1 node-set key | 37 |
| → hit a live key outside the t1 set | 74 |
| → hit an archived key outside the t1 set | 6 |
| → absent (no `weave_embeddings` row) | 0 |
| zero-weight pairs (`duration_ms` null or ≤ 0) | 0 |

48 + 37 + 74 + 6 + 0 = 165 ✓. Sum of event columns in B.1 + B.2: lightbox 0 + 3, connection closes 10 + 32, voice 1 + 2 → 48 ✓.

### B.1 Anchors

| # | title | t1 dominant | t1 depth = 0 | lightbox_closed | conn_desc_closed | real voice (turns) | Σ w_rule breadth | Σ w_rule depth | of which qa-attributed rows | Σ w_rule breadth excl. qa | flag |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | WIRED | breadth | no | 0 | 3 | 1 (1) | 3.5234 | 0.6460 | 0 | 3.5234 | **re-engaged** |
| 2 | Bloomberg | depth | no | 0 | 1 | 0 (0) | 0.8556 | 0.0000 | 0 | 0.8556 | **re-engaged** |
| 3 | arian ghashghai | depth | no | 0 | 0 | 0 (0) | 0.0000 | 0.0000 | 0 | 0.0000 | **not re-engaged** |
| 4 | ​𝐥𝐲𝐫𝐚 | breadth | yes | 0 | 0 | 0 (0) | 0.0000 | 0.0000 | 0 | 0.0000 | **not re-engaged** |
| 5 | 🧬Maxpein🧬 | breadth | yes | 0 | 1 | 0 (0) | 0.3909 | 0.0000 | 0 | 0.3909 | **re-engaged** |
| 6 | Sherry | breadth | yes | 0 | 0 | 0 (0) | 0.0000 | 0.0000 | 0 | 0.0000 | **not re-engaged** |
| 7 | Early Retirement Taught Me That We’ve All Been S | depth | no | 0 | 2 | 0 (0) | 2.6931 | 0.0000 | 0 | 2.6931 | **re-engaged** |
| 8 | The Silent Revolution And The Great Resignation | depth | no | 0 | 0 | 0 (0) | 0.0000 | 0.0000 | 0 | 0.0000 | **not re-engaged** |
| 9 | Cinema Tweets | breadth | no | 0 | 0 | 0 (0) | 0.0000 | 0.0000 | 0 | 0.0000 | **not re-engaged** |
| 10 | (TRUE DETECTIVE) RUST COHLE - DEVASTATION | breadth | yes | 0 | 3 | 0 (0) | 2.3974 | 0.0000 | 0 | 2.3974 | **re-engaged** |
| 11 | James Lucas | breadth | yes | 0 | 0 | 0 (0) | 0.0000 | 0.0000 | 0 | 0.0000 | **not re-engaged** |
| 12 | James Lucas | breadth | yes | 0 | 0 | 0 (0) | 0.0000 | 0.0000 | 0 | 0.0000 | **not re-engaged** |

**Anchors re-engaged: 5** (#1 WIRED, #2 Bloomberg, #5 Maxpein, #7 Early Retirement, #10 Rust Cohle). **Not re-engaged: 7** (#3, 4, 6, 8, 9, 11, 12).

### B.2 Unclustered attended

| # | title | t1 dominant | t1 depth = 0 | lightbox_closed | conn_desc_closed | real voice (turns) | Σ w_rule breadth | Σ w_rule depth | of which qa-attributed rows | Σ w_rule breadth excl. qa | flag |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | Überkierk | breadth | no | 0 | 1 | 0 (0) | 1.1502 | 0.0000 | 0 | 1.1502 | **re-engaged** |
| 2 | 𝓐𝔂𝓸✯ | breadth | yes | 0 | 0 | 0 (0) | 0.0000 | 0.0000 | 0 | 0.0000 | **not re-engaged** |
| 3 | shouko | depth | no | 0 | 5 | 1 (11) | 4.4604 | 2.3159 | 2 | 2.4695 | **re-engaged** |
| 4 | MeidasTouch | depth | no | 0 | 3 | 0 (0) | 2.2735 | 0.0000 | 0 | 2.2735 | **re-engaged** |
| 5 | Documenting Saylor | depth | no | 0 | 2 | 0 (0) | 2.1875 | 0.0000 | 0 | 2.1875 | **re-engaged** |
| 6 | GigSlave Goes Public With $84 Billion Valuation  | breadth | yes | 0 | 0 | 0 (0) | 0.0000 | 0.0000 | 0 | 0.0000 | **not re-engaged** |
| 7 | Tony Soprano - 'Is This All There Is' | depth | no | 1 | 3 | 0 (0) | 4.8340 | 0.0000 | 0 | 4.8340 | **re-engaged** |
| 8 | Naruto | depth | no | 0 | 7 | 0 (0) | 6.2075 | 0.0000 | 2 | 4.2166 | **re-engaged** |
| 9 | Columbus Trailer #1 (2017) \| Movieclips Indie | breadth | yes | 0 | 0 | 0 (0) | 0.0000 | 0.0000 | 0 | 0.0000 | **not re-engaged** |
| 10 | The Driven Man | depth | no | 0 | 2 | 0 (0) | 2.4993 | 0.0000 | 0 | 2.4993 | **re-engaged** |
| 11 | RyanPatrick🇺🇸🦅 | depth | no | 0 | 0 | 0 (0) | 0.0000 | 0.0000 | 0 | 0.0000 | **not re-engaged** |
| 12 | New York Magazine | depth | no | 0 | 0 | 0 (0) | 0.0000 | 0.0000 | 0 | 0.0000 | **not re-engaged** |
| 13 | Alan Watts - Acceptance of Death | breadth | yes | 0 | 0 | 0 (0) | 0.0000 | 0.0000 | 0 | 0.0000 | **not re-engaged** |
| 14 | Big Brain Philosophy | breadth | yes | 0 | 0 | 0 (0) | 0.0000 | 0.0000 | 0 | 0.0000 | **not re-engaged** |
| 15 | cinesthetic. | depth | no | 0 | 0 | 0 (0) | 0.0000 | 0.0000 | 0 | 0.0000 | **not re-engaged** |
| 16 | 60 Minutes | depth | no | 0 | 2 | 1 (1) | 2.5624 | 0.6460 | 0 | 2.5624 | **re-engaged** |
| 17 | Hate_Room_08.03.2022_MidJourney | depth | no | 0 | 0 | 0 (0) | 0.0000 | 0.0000 | 0 | 0.0000 | **not re-engaged** |
| 18 | gomi | breadth | yes | 0 | 0 | 0 (0) | 0.0000 | 0.0000 | 0 | 0.0000 | **not re-engaged** |
| 19 | King Arthur Fan | breadth | yes | 2 | 7 | 0 (0) | 7.8166 | 0.0000 | 0 | 7.8166 | **re-engaged** |
| 20 | America Is NOT The Greatest Country Anymore! - J | breadth | yes | 0 | 0 | 0 (0) | 0.0000 | 0.0000 | 0 | 0.0000 | **not re-engaged** |
| 21 | Bearly AI | recency | yes | 0 | 0 | 0 (0) | 0.0000 | 0.0000 | 0 | 0.0000 | **not re-engaged** |

**Unclustered re-engaged: 9** (#1, 3, 4, 5, 7, 8, 10, 16, 19). **Not re-engaged: 12** (#2, 6, 9, 11, 12, 13, 14, 15, 17, 18, 20, 21).

### B.3 The lists predictions 4 and 5 point at

Definitions, stated so the lists are reproducible: **breadth-only** = t1 `by_class.depth = 0` and `by_class.breadth > 0` (recency may be non-zero — only anchor #4 has any, 0.0553). **Depth-dominated** = t1 dominant class = depth (§A rule).

| list | anchors | unclustered attended |
|---|---|---|
| **breadth-only and not re-engaged** | **4**: #4 ​𝐥𝐲𝐫𝐚 (c2), #6 Sherry (c2), #11 James Lucas / Death (c7), #12 James Lucas / Philosophy and Art (c7) | **7**: #2 𝓐𝔂𝓸✯, #6 GigSlave (Onion), #9 Columbus Trailer, #13 Alan Watts, #14 Big Brain Philosophy, #18 gomi, #20 Jeff Daniels / Newsroom |
| **depth-dominated and not re-engaged** | **2**: #3 arian ghashghai (c1), #8 The Silent Revolution And The Great Resignation (c3) | **4**: #11 RyanPatrick🇺🇸🦅, #12 New York Magazine, #15 cinesthetic., #17 Hate_Room (image) |
| breadth-only and re-engaged (for completeness) | #5 Maxpein (c2), #10 Rust Cohle (c5) | #19 King Arthur Fan |
| depth-dominated and re-engaged (for completeness) | #2 Bloomberg (c1), #7 Early Retirement (c3) | #3 shouko, #4 MeidasTouch, #5 Documenting Saylor, #7 Tony Soprano, #8 Naruto, #10 The Driven Man, #16 60 Minutes |
| in neither defined list, not re-engaged | #9 Cinema Tweets (c4) — breadth-dominated but has depth 0.2034, so not breadth-only | #21 Bearly AI — recency-only (`added`) |
| in neither defined list, re-engaged | #1 WIRED (c1) — breadth-dominated with depth 0.7172 | #1 Überkierk — breadth-dominated with depth 3.2933 |

Checks: anchors 4 + 2 + 2 + 2 + 1 + 1 = 12 ✓; unclustered 7 + 4 + 1 + 7 + 1 + 1 = 21 ✓.

Cluster c7 (the duplicated tweet, both members are anchors) is entirely breadth-only and not re-engaged. Cluster c2 has 2 of 3 anchors breadth-only and not re-engaged.

```sql
-- QB: per-node re-engagement in W (undecayed w_rule, with qa attribution)
with w as (select '2026-09-07T02:37:59.815Z'::timestamptz lo, '2026-10-04 16:27:57+00'::timestamptz hi),
qs as (select distinct e.session_id from weave_events e join voice_sessions vs on vs.id=e.voice_session_id where vs.session_kind='qa'),
ev as (
  select e.id::text ev_id, e.event_type, e.timestamp at_, e.duration_ms, null::int turns, 'breadth' cls, e.target_id,
         case when e.event_type='lightbox_closed' and e.target_id like 'node:%' then array[substr(e.target_id,6)]
              when e.event_type='connection_description_closed' and array_length(string_to_array(e.target_id,':'),1)=4 and split_part(e.target_id,':',1)='connection'
                then array[split_part(e.target_id,':',2)||':'||split_part(e.target_id,':',3), split_part(e.target_id,':',2)||':'||split_part(e.target_id,':',4)]
              else array[]::text[] end keys,
         1.5*least( (ln(greatest(e.duration_ms,0)/1000.0+1)/ln(2)) / (ln(46)/ln(2)), 1) w_rule,
         (e.session_id in (select session_id from qs)) qa
  from weave_events e, w
  where e.event_type in ('lightbox_closed','connection_description_closed') and e.timestamp > w.lo and e.timestamp <= w.hi
  union all
  select vs.id::text, 'voice_session', vs.ended_at, null, (select count(*) from voice_utterances u where u.session_id=vs.id and u.speaker='user')::int, 'depth',
         'connection:'||ed.board_id||':'||coalesce(fn.data->>'_clientNodeId',fn.id::text)||':'||coalesce(tn.data->>'_clientNodeId',tn.id::text),
         array[ed.board_id||':'||coalesce(fn.data->>'_clientNodeId',fn.id::text), ed.board_id||':'||coalesce(tn.data->>'_clientNodeId',tn.id::text)],
         (1.5/(ln(5)/ln(2))) * ln((select count(*) from voice_utterances u where u.session_id=vs.id and u.speaker='user')+1)/ln(2),
         false
  from voice_sessions vs join w on vs.ended_at > w.lo and vs.ended_at <= w.hi
  left join edges ed on ed.id=vs.anchor_edge_id
  left join nodes fn on fn.id=ed.source_node_id left join nodes tn on tn.id=ed.target_node_id
  where vs.session_kind='real' and vs.ended_at is not null and vs.anchor_edge_id is not null
),
r as (select ev.*, unnest(ev.keys) key from ev),
s as (select generation_metadata g from weave_profile_snapshots where id='efa6d6e1-6fc5-4063-8a1e-0de59409d2ad'),
k as (
  select 'anchor' set, ord, a->>'key' key, a->>'cluster_id' cl, (a->'by_class'->>'breadth')::float8 b,(a->'by_class'->>'depth')::float8 d,(a->'by_class'->>'recency')::float8 rc
  from s, jsonb_array_elements(g->'anchors') with ordinality x(a,ord)
  union all
  select 'unclustered', ord, a->>'key', null, (a->'by_class'->>'breadth')::float8,(a->'by_class'->>'depth')::float8,(a->'by_class'->>'recency')::float8
  from s, jsonb_array_elements(g->'unclustered_attended') with ordinality x(a,ord))
select k.set, k.ord, k.key, k.cl,
  case when k.b>=k.d and k.b>=k.rc then 'breadth' when k.d>k.rc then 'depth' else 'recency' end t1_dominant,
  (k.d=0) t1_depth_zero,
  count(*) filter (where r.event_type='lightbox_closed') n_lbx,
  count(*) filter (where r.event_type='connection_description_closed') n_cdc,
  count(*) filter (where r.event_type='voice_session') n_voice,
  coalesce(sum(r.turns) filter (where r.event_type='voice_session'),0) turns,
  round(coalesce(sum(r.w_rule) filter (where r.cls='breadth'),0)::numeric,4) w_breadth,
  round(coalesce(sum(r.w_rule) filter (where r.cls='depth'),0)::numeric,4) w_depth,
  count(*) filter (where r.key is not null and not (r.w_rule>0)) n_zero_w,
  count(*) filter (where r.qa) n_qa,
  round(coalesce(sum(r.w_rule) filter (where r.cls='breadth' and not r.qa),0)::numeric,4) w_breadth_excl_qa,
  case when count(r.key) filter (where r.w_rule>0 and not r.qa) > 0 then 're-engaged' else 'not re-engaged' end flag_excl_qa,
  case when count(r.key) filter (where r.w_rule>0) > 0 then 're-engaged' else 'not re-engaged' end flag
from k left join r on r.key=k.key
group by k.set,k.ord,k.key,k.cl,k.b,k.d,k.rc order by k.set,k.ord;
-- → 33 rows (B.1, B.2)

-- QB-gate: replace the final select of QB (keep CTEs w, qs, ev, r, s) with:
--   k33 as (anchors ∪ unclustered_attended keys), t1k as (jsonb_array_elements_text(g->'node_set'->'keys')),
--   emb as (select board_id||':'||node_id key, archived_at from weave_embeddings)
-- and count: ev; ev by event_type; ev where cardinality(keys)=0; r; r ∈ k33; r ∈ t1k \ k33;
--   r ⋈ emb live ∉ t1k; r ⋈ emb archived ∉ t1k; r ⟕ emb where emb.key is null; r where not (w_rule>0)
-- → 91 | 17 | 71 | 3 | 0 | 165 | 48 | 37 | 74 | 6 | 0 | 0
```

---

## C. Period engagement summary (W)

### C.1 `weave_events` by type in W

| event_type | count | roster? |
|---|---:|---|
| `connection_label_clicked` | 76 | no (pair open) |
| `connection_description_closed` | 71 | **yes — breadth** |
| `session_started` | 38 | no |
| `board_switched` | 36 | no |
| `node_selected` | 25 | no |
| `lightbox_opened` | 17 | no (pair open) |
| `lightbox_closed` | 17 | **yes — breadth** |
| `item_added` | 16 | **yes — recency** |
| `weave_triggered` | 13 | no |
| `voice.session.started` | 11 | no |
| `voice.session.ended` | 11 | no |
| `session_ended` | 7 | no |
| `item_deleted` | 4 | no |
| `board_created` | 2 | no |
| **total** | **346** | roster rows in `weave_events`: **104** (71 + 17 + 16) |

```sql
select event_type, count(*) from weave_events
where timestamp > '2026-09-07T02:37:59.815Z' and timestamp <= '2026-10-04 16:27:57+00' group by 1 order by 2 desc;
```

### C.2 Voice sessions in W

11 sessions with `coalesce(ended_at, started_at)` in W: **9 real, 2 qa**. All 11 ended (`end_reason = user_closed`). `user_turns` = utterances with `speaker = 'user'`.

| session | kind | started (UTC) | user turns | `anchor_edge_id` | launch connection (board) |
|---|---|---|---:|---|---|
| `2048d084…` | real | 2026-09-09 05:03 | 10 | null | — |
| `abca7e03…` | **qa** | 2026-09-17 05:18 | 5 | `15b5e181…` | shouko (:4) ⟷ Naruto (:9) (Tech and Business) — §E |
| `f01d4346…` | **qa** | 2026-09-17 05:26 | 7 | `15b5e181…` | shouko (:4) ⟷ Naruto (:9) (Tech and Business) — §E |
| `ae2ca271…` | real | 2026-09-17 06:54 | **14** | `0d9c97e7…` | Maine (:3) ⟷ Autism Capital 🧩 (:4) (Abusrdity) |
| `02144349…` | real | 2026-09-17 23:04 | 5 | null | — |
| `1defbdf7…` | real | 2026-09-24 07:58 | 13 | null | — |
| `3ffe9e77…` | real | 2026-09-26 10:25 | 20 | null | — |
| `d289fffc…` | real | 2026-09-27 08:47 | **11** | `bbe0f77c…` | 'Your brain literally atrophies' … (:28) ⟷ shouko (:4) (Tech and Business) |
| `4949baac…` | real | 2026-09-28 05:08 | **1** | `2ffeebeb…` | WIRED (:20) ⟷ 60 Minutes (:18) (Tech and Business) |
| `477db21d…` | real | 2026-10-01 01:43 | 8 | null | — |
| `71cb3d68…` | real | 2026-10-03 07:17 | 17 | null | — |

- **Roster-qualifying (real, ended, anchored): 3 sessions, 3 distinct edges, 26 user turns** (14 + 11 + 1). These are the depth events in §B.
- Real but **unanchored** (`anchor_edge_id` null): 6 sessions, 73 user turns (10 + 5 + 13 + 20 + 8 + 17). The pipeline's voice predicate (`reads.ts:165`) excludes them; they carry no node attribution. Their launch surface was not characterised by this read.
- For reference, t1's depth window held 16 roster-qualifying real sessions (t1 `events_read.voice_sessions.rows_returned`).

```sql
select vs.id, vs.session_kind, vs.started_at, vs.ended_at, vs.end_reason, vs.anchor_edge_id, ed.board_id, b.name,
  (select count(*) from voice_utterances u where u.session_id=vs.id and u.speaker='user') user_turns,
  coalesce(fn.data->>'_clientNodeId',fn.id::text) from_cid, fn.title from_title,
  coalesce(tn.data->>'_clientNodeId',tn.id::text) to_cid, tn.title to_title
from voice_sessions vs left join edges ed on ed.id=vs.anchor_edge_id left join boards b on b.id=ed.board_id
left join nodes fn on fn.id=ed.source_node_id left join nodes tn on tn.id=ed.target_node_id
where coalesce(vs.ended_at, vs.started_at) > '2026-09-07T02:37:59.815Z'
  and coalesce(vs.ended_at, vs.started_at) <= '2026-10-04 16:27:57+00' order by vs.started_at;
-- → 11 rows
```

### C.3 Nodes added, nodes archived, edges drawn, boards

Three sources for "nodes added", reported separately because they do not count the same thing:

| source | total in W | by board |
|---|---:|---|
| live `nodes` rows with `created_at` in W (deleted nodes have no row) | **11** | Abusrdity 4 · Tech and Business 3 · Depression 2 · Geopolitics 1 · Philosophy and Art 1 |
| `weave_embeddings` rows with `created_at` in W (any archival state) | **13** (10 live now, 3 archived) | Abusrdity 4 (3 live) · Tech and Business 4 (3 live) · Depression 2 · Geopolitics 1 · Philosophy and Art 1 · Relationships 1 (0 live) |
| `item_added` events in W (board = target segment) | **16** | Tech and Business 7 · Abusrdity 4 · Depression 2 · Geopolitics 1 · Philosophy and Art 1 · Relationships 1 |
| `item_deleted` events in W | 4 | Tech and Business 3 · Relationships 1 |

`nodes.created_at` survives saves (`replace_board_contents` updates existing rows in place, `supabase/migrations/030_replace_board_contents_directionless_edges.sql:100-123`), so it is an add time, not a last-save time.

**Nodes archived in W** (`weave_embeddings.archived_at` in W): **3**; **none is a t1 node-set key** (§D).

| key | board | created → archived | live `nodes` row now? |
|---|---|---|---|
| `b3c1473b…:27` | Tech and Business | 09-14 23:41:30 → 23:42:00 | no |
| `fef6c2a3…:14` | Relationships | 10-03 09:00:55 → 09:02:05 | no |
| `8a8d45a9…:45` | Abusrdity | 09-24 20:12:05 → 20:36:54 | **yes** — a `nodes` row with the same client id has `created_at` 20:38:04, 70 s after the archive stamp |

The third row is **archived-but-live** — the second such row in prod (the first is the adjudicated Galloway ghost `8a8d45a9…:33`, archived 2026-08-14). It is outside the t1 set, so it does not touch a pinned run; a live run would not see it. Recorded, not investigated.

**Edges drawn in W** (`edges.created_at` in W; id and `created_at` survive saves per migration 030): **66** — Abusrdity 27 (weave), Tech and Business 23 (weave), Philosophy and Art 10 (weave), Geopolitics 3 (weave), Depression 3 (weave 1, deeper 1, tensions 1). `weave_triggered` events in W: 13 (Abusrdity 5, Depression 3, Tech and Business 3, Geopolitics 1, Philosophy and Art 1).

**Boards:** one new board, **Depression**, created `2026-09-13 08:50:27 UTC`. `board_created` events in W = 2 vs. 1 surviving `boards` row — not reconciled.

```sql
-- nodes added (live rows)
select b.name, count(*) from nodes n join boards b on b.id=n.board_id
where n.created_at > '2026-09-07T02:37:59.815Z' and n.created_at <= '2026-10-04 16:27:57+00' group by 1 order by 2 desc;   -- → 11
-- embedding rows created in W
select b.name, count(*) total, count(*) filter (where e.archived_at is null) live_now
from weave_embeddings e left join boards b on b.id::text=e.board_id
where e.created_at > '2026-09-07T02:37:59.815Z' and e.created_at <= '2026-10-04 16:27:57+00' group by 1 order by 2 desc;   -- → 13 / 10
-- item_added by target board
select b.name, count(*) from weave_events e left join boards b on b.id::text=split_part(e.target_id,':',2)
where e.event_type='item_added' and e.timestamp > '2026-09-07T02:37:59.815Z' and e.timestamp <= '2026-10-04 16:27:57+00' group by 1;   -- → 16
-- archived in W, with live-node check
select e.board_id||':'||e.node_id, e.created_at, e.archived_at,
  exists(select 1 from nodes n where n.board_id::text=e.board_id and coalesce(n.data->>'_clientNodeId',n.id::text)=e.node_id) node_live
from weave_embeddings e where e.archived_at > '2026-09-07T02:37:59.815Z' and e.archived_at <= '2026-10-04 16:27:57+00';   -- → 3
-- archived-but-live, all time
select e.board_id||':'||e.node_id, e.archived_at from weave_embeddings e
where e.archived_at is not null
  and exists(select 1 from nodes n where n.board_id::text=e.board_id and coalesce(n.data->>'_clientNodeId',n.id::text)=e.node_id);   -- → 2
-- edges drawn
select b.name, e.mode, count(*) from edges e join boards b on b.id=e.board_id
where e.created_at > '2026-09-07T02:37:59.815Z' and e.created_at <= '2026-10-04 16:27:57+00' group by 1,2 order by 3 desc;   -- → 66
-- boards created
select name, created_at from boards where created_at > '2026-09-07T02:37:59.815Z' and created_at <= '2026-10-04 16:27:57+00';   -- → 1
```

### C.4 Roster engagement by board — at t1 vs. since t1 (prediction 6 reference)

Two windows. **T1** = t1's own read windows: `weave_events` roster rows with `timestamp` in [`breadth_from` `2026-06-29T02:37:59.815Z`, `generated_at`] and real anchored voice with `ended_at` in [`depth_from` `2026-02-09T02:37:59.815Z`, `generated_at`] (both bounds from t1's `events_read`). **W** as above. Board = the board segment of `target_id` (events) or `edges.board_id` (voice). Roster here includes `item_added` (all four rules).

**Gate:** the T1 window reproduces t1's `events_read.by_type` exactly — `lightbox_closed` 28, `connection_description_closed` 58, `item_added` 10 — and its voice count 16. T1 rows: 41 + 37 + 21 + 12 + 1 = 112 = 28 + 58 + 10 + 16 ✓. W rows: 52 + 33 + 9 + 8 + 4 + 1 = 107 = 17 + 71 + 16 + 3 ✓.

| window | board | events | lightbox | conn. close | added | voice | qa rows | Σ w_rule undecayed | Σ excl. qa | Σ decayed at t1 |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| T1 | Philosophy and Art | **41** | 19 | 16 | 3 | 3 | 0 | 40.008 | 40.008 | **14.459** |
| T1 | Tech and Business | 37 | 2 | 24 | 2 | 9 | 0 | **40.376** | 40.376 | 7.688 |
| T1 | Abusrdity | 21 | 5 | 8 | 4 | 4 | 0 | 20.263 | 20.263 | 4.030 |
| T1 | Death | 12 | 2 | 10 | 0 | 0 | 0 | 9.439 | 9.439 | 0.780 |
| T1 | Career | 1 | 0 | 0 | 1 | 0 | 0 | 0.200 | 0.200 | 0.060 |
| W | **Abusrdity** | **52** | 12 | 35 | 4 | 1 | 0 | **43.147** | **43.147** | — |
| W | Tech and Business | 33 | 4 | 20 | 7 | 2 | 2 | 28.146 | 26.155 | — |
| W | Philosophy and Art | 9 | 1 | 7 | 1 | 0 | 0 | 9.093 | 9.093 | — |
| W | Depression | 8 | 0 | 6 | 2 | 0 | 0 | 6.468 | 6.468 | — |
| W | Geopolitics | 4 | 0 | 3 | 1 | 0 | 0 | 3.773 | 3.773 | — |
| W | Relationships | 1 | 0 | 0 | 1 | 0 | 0 | 0.200 | 0.200 | — |

- **At t1:** most roster engagement is **Philosophy and Art** by event count (41) and by t1-decayed weight (14.459); **Tech and Business** by undecayed weight (40.376 vs. 40.008, a 0.9 % margin; Tech and Business holds 9 of the 16 T1-window voice sessions). The measure must be named in the prediction; the three do not agree.
- **Since t1:** **Abusrdity** on every measure (52 events; 43.147 undecayed).
- "Σ decayed at t1" is summed per event before node hit/miss classification, so it includes events whose nodes were already archived at t1 (which the pipeline drops). It is a board-level measure, not a sum of t1 node weights.

```sql
-- QC6
with p as (select '2026-06-29T02:37:59.815Z'::timestamptz bf, '2026-02-09T02:37:59.815Z'::timestamptz df,
                  '2026-09-07T02:37:59.815Z'::timestamptz t1, '2026-10-04 16:27:57+00'::timestamptz hi),
qs as (select distinct e.session_id from weave_events e join voice_sessions vs on vs.id=e.voice_session_id where vs.session_kind='qa'),
ev as (
  select case when e.timestamp <= p.t1 then 'T1' else 'W' end win, e.event_type,
         split_part(e.target_id,':',2) board, (e.session_id in (select session_id from qs)) qa,
         case when e.event_type='item_added' then 0.2 else 1.5*least((ln(greatest(e.duration_ms,0)/1000.0+1)/ln(2))/(ln(46)/ln(2)),1) end w_rule,
         14 h, extract(epoch from (p.t1 - e.timestamp))/86400 age_t1
  from weave_events e, p
  where e.event_type in ('lightbox_closed','connection_description_closed','item_added') and e.timestamp >= p.bf and e.timestamp <= p.hi
  union all
  select case when vs.ended_at <= p.t1 then 'T1' else 'W' end, 'voice_session', ed.board_id::text, false,
         (1.5/(ln(5)/ln(2)))*ln((select count(*) from voice_utterances u where u.session_id=vs.id and u.speaker='user')+1)/ln(2), 42,
         extract(epoch from (p.t1 - vs.ended_at))/86400
  from voice_sessions vs join edges ed on ed.id=vs.anchor_edge_id, p
  where vs.session_kind='real' and vs.ended_at is not null and vs.ended_at >= p.df and vs.ended_at <= p.hi
)
select ev.win, coalesce(b.name, ev.board) board, count(*) n_all,
  count(*) filter (where event_type='lightbox_closed') lbx, count(*) filter (where event_type='connection_description_closed') cdc,
  count(*) filter (where event_type='item_added') added, count(*) filter (where event_type='voice_session') voice,
  count(*) filter (where qa) n_qa,
  round(sum(w_rule)::numeric,3) w_undecayed, round(sum(w_rule) filter (where not qa)::numeric,3) w_undecayed_excl_qa,
  round(sum(case when win='T1' then w_rule*power(2,-age_t1/h) end)::numeric,3) w_decayed_at_t1
from ev left join boards b on b.id::text=ev.board group by 1,2 order by 1, n_all desc;

-- gate
select event_type, count(*) from weave_events where event_type in ('lightbox_closed','connection_description_closed','item_added')
  and timestamp >= '2026-06-29T02:37:59.815Z' and timestamp <= '2026-09-07T02:37:59.815Z' group by 1;   -- → 28 / 58 / 10
select count(*) from voice_sessions where session_kind='real' and ended_at is not null and anchor_edge_id is not null
  and ended_at >= '2026-02-09T02:37:59.815Z' and ended_at <= '2026-09-07T02:37:59.815Z';                  -- → 16
```

---

## D. Pinned set drift

| measure | count |
|---|---:|
| t1 `node_set.keys` (source `live`) | **71** (71 distinct) |
| t1 keys with a `weave_embeddings` row now | 71 |
| t1 keys with **no** row now | **0** |
| t1 keys **archived** now | **0** |
| t1 keys with a null vector now | 0 |
| live set now (`archived_at is null`) | **81** (all with a vector) |
| live now, not in the t1 set | **10** (all created after t1) |
| all `weave_embeddings` rows now | 114 |

71 + 10 = 81 ✓. **A run pinned to t1 will carry 71 nodes; no t1 node has been archived, so nothing leaves the pinned set.**

**Contradicts the dispatch premise (code fact, count-neutral today).** The dispatch says archived t1 nodes "drop from the pinned run via the map-builder filter". At `bb23d8f` they do not: for a pinned run, `selectNodeRows` returns **exactly the pinned keys in any archival state** (`netlify/lib/snapshot/generate.ts:80-89`), and `buildWeightMap` keys the map on those keys without an archival filter (`engagement.ts:220-229`). A pinned key with **no** `weave_embeddings` row throws (`generate.ts:84-87`). Only a *live* run filters on `archived_at is null`. With 0 archived t1 keys, this changes no count now; it would if one were archived before t2 runs.

**Instrument fact for a pinned run (also count-neutral to the node set).** Events that resolve to a *live* node outside the pinned set are counted by `attribute()` as `dropped.absent`, not as archived and not as a hit (`engagement.ts:281-306`: the key is not in `weights` and not in the `archived` set). So t2's `attribution.dropped.absent` will include engagement on the 10 additions; in W that is 74 of 165 resolved pairs (§B gate, "live key outside the t1 set").

**Live additions since t1 (10):**

| key | board | created (UTC) | title |
|---|---|---|---|
| `8a8d45a9…:41` | Abusrdity | 09-09 04:45 | Evan Hubinger |
| `28681bee…:2` | Depression | 09-13 08:55 | beowulf - savior (Lyrics) \| "spirit lead me where my trust is without borders" |
| `28681bee…:3` | Depression | 09-13 09:21 | "I know who I am, and after all these years, there is a victory in that" |
| `b3c1473b…:26` | Tech and Business | 09-14 23:41 | You Can See Everything - Official Trailer (2026) Nathan Fielder, Lance Oppenheim |
| `8a8d45a9…:43` | Abusrdity | 09-17 21:57 | The_Real_Fly |
| `a428492a…:41` | Philosophy and Art | 09-24 10:41 | Being a Better Person Is Making You Lonelier |
| `b3c1473b…:28` | Tech and Business | 09-26 10:22 | 'Your brain literally atrophies': Tech payouts are leaving people suddenly rich … |
| `b3c1473b…:30` | Tech and Business | 09-28 16:17 | FactPost |
| `a358f35c…:7` | Geopolitics | 09-30 23:44 | Tony of 1Dime |
| `8a8d45a9…:47` | Abusrdity | 10-03 05:53 | Rust Cohle x Snowfall \|\| Edit |

By board: Abusrdity 3, Tech and Business 3, Depression 2, Philosophy and Art 1, Geopolitics 1.

```sql
with s as (select generation_metadata g from weave_profile_snapshots where id='efa6d6e1-6fc5-4063-8a1e-0de59409d2ad'),
t1k as (select jsonb_array_elements_text(g->'node_set'->'keys') key from s),
emb as (select board_id||':'||node_id key, board_id, archived_at, created_at, embedding is not null has_vec from weave_embeddings),
live as (select key, board_id, created_at from emb where archived_at is null)
select 't1 keys' m, count(*)::text v from t1k
union all select 't1 keys distinct', count(distinct key)::text from t1k
union all select 't1 keys with an embeddings row now', count(*)::text from t1k join emb using (key)
union all select 't1 keys with NO embeddings row now', count(*)::text from t1k left join emb using (key) where emb.key is null
union all select 't1 keys archived now', count(*)::text from t1k join emb using (key) where emb.archived_at is not null
union all select 't1 keys live now', count(*)::text from t1k join emb using (key) where emb.archived_at is null
union all select 't1 keys with null vector now', count(*)::text from t1k join emb using (key) where not emb.has_vec
union all select 'live set now (archived_at null)', count(*)::text from live
union all select 'live set now with vector', count(*)::text from emb where archived_at is null and has_vec
union all select 'live now, not in t1 set', count(*)::text from live where key not in (select key from t1k)
union all select 'live now, not in t1 set, created after t1', count(*)::text from live where key not in (select key from t1k) and created_at > '2026-09-07T02:37:59.815Z'
union all select 'all rows now', count(*)::text from emb;
-- → 71 | 71 | 71 | 0 | 0 | 71 | 0 | 81 | 81 | 10 | 10 | 114
```

Note: the live count (81) is a point-in-time figure; unlike W-bounded counts it is not frozen and will move as nodes are added or archived.

---

## E. Known confound: the F1 preview sessions

**Sessions.** Two `session_kind = 'qa'` voice sessions exist in W, both on the same launch edge; there are no others:

| voice session | browser `session_id` | started → ended (UTC) | user turns |
|---|---|---|---:|
| `abca7e03-1755-4b61-adf9-8fe514a96fb7` | `b7bf80ce-7821-44a5-9978-50014c9cd470` | 2026-09-17 05:18:35 → 05:25:28 | 5 |
| `f01d4346-76bd-4a73-a787-d85b5440a246` | `4e0f36dc-4dbd-4d8d-bedb-f575c0f76678` | 2026-09-17 05:26:38 → 05:41:17 | 7 |

UTC date is 2026-09-17; at UTC−4 (the offset t1.md's Reflect observation implies) this is 01:18–01:41 local on 09-17, i.e. the night of 09-16 in the dispatch's framing.

**Edge.** `anchor_edge_id = 15b5e181-93aa-44a0-8d6e-306fc195007c` = `connection:b3c1473b…:4:9`, **shouko (:4) ⟷ Naruto (:9)**, Tech and Business. **Neither endpoint is a t1 anchor; both are t1 `unclustered_attended`** (A.2 #3 shouko, rank 3, depth-dominated, 41 turns; A.2 #8 Naruto, rank 8, depth-dominated, 16 turns). The edge itself is t1 conversation `9b74ca61…` (12 turns, `both_singletons`, ended 2026-06-09).

**Attributed `weave_events` rows (5).** Attribution method: the browser `session_id` of the `voice.session.started` / `voice.session.ended` rows whose `voice_session_id` is a qa session; every connection/lightbox row sharing that browser `session_id`.

| timestamp (UTC) | browser session | event | `duration_ms` | roster weight (undecayed, each endpoint) |
|---|---|---|---:|---:|
| 05:18:32.066 | `b7bf80ce…` | `connection_label_clicked` | — | none (pair open) |
| 05:25:29.647 | `b7bf80ce…` | `connection_description_closed` | **417,744** | **1.5** (capped) |
| 05:26:32.818 | `4e0f36dc…` | `connection_label_clicked` | — | none |
| 05:26:35.260 | `4e0f36dc…` | `connection_description_closed` | **2,501** | **0.4907** |
| 05:26:36.898 | `4e0f36dc…` | `connection_label_clicked` | — | none — orphan open, no close follows in that browser session |

The 417,744 ms close brackets the whole first qa session (label click 05:18:32 → voice start 05:18:36 → voice end 05:25:28 → close 05:25:29): consistent with the decision of record from the 2026-09-28 sitting (PR #55) that a voice launch from the connection popup counts its duration as that connection's dwell. That decision lives in the planning layer, not in the repo. The second qa session launched from the re-opened popup (05:26:36.9) whose close was never emitted.

**Confidence: high, with the precondition stated.** `weave_events` carries no `session_kind` / host marker, so qa attribution of connection rows is only possible through the browser `session_id` join. It is sound here because (i) both browser sessions contain voice sessions of kind qa only (qa 2, real 0), (ii) every attributed row targets the qa sessions' anchor edge, and (iii) the rows bracket the voice sessions in time. If a browser `session_id` could span a qa and a real voice session, this join would over-attribute; it does not in W. Whether these rows came from a preview origin or the prod origin is not observable from the rows.

**Effect on §B and §C.4.** The two closes are the only qa-attributed qualifying rows in W. They add ≈ 1.991 undecayed breadth (1.5 + 0.4907) to each of shouko and Naruto (B.2 #3: 4.4604 → 2.4695 excluding qa; #8: 6.2075 → 4.2166) and 1.991 to Tech and Business in §C.4 (28.146 → 26.155). **No re-engaged flag changes** — both nodes have non-qa qualifying events in W. The qa voice sessions themselves contribute no depth (excluded by `session_kind = 'real'` in the pipeline query, `reads.ts:163`). Other events on this edge in W: one real-session pair on 09-27 (`c38a502e…`, label click + close 1,146 ms).

```sql
-- E1 qa voice sessions in W and their browser sessions
select vs.id, vs.started_at, vs.ended_at, vs.anchor_edge_id, array_agg(distinct e.session_id) browser_sessions
from voice_sessions vs left join weave_events e on e.voice_session_id=vs.id
where vs.session_kind='qa' and vs.started_at > '2026-09-07T02:37:59.815Z' and vs.started_at <= '2026-10-04 16:27:57+00'
group by 1,2,3,4 order by 2;                                              -- → 2 rows
-- E2 roster/pair rows sharing a browser session with a qa voice session in W
with qs as (select distinct e.session_id from weave_events e join voice_sessions vs on vs.id=e.voice_session_id
            where vs.session_kind='qa' and vs.started_at > '2026-09-07T02:37:59.815Z' and vs.started_at <= '2026-10-04 16:27:57+00')
select e.timestamp, e.session_id, e.event_type, e.target_id, e.duration_ms from weave_events e join qs using (session_id)
where e.event_type in ('lightbox_closed','lightbox_opened','connection_label_clicked','connection_description_closed','item_added') order by 1;   -- → 5 rows
-- E3 voice-session kinds inside those browser sessions
select vs.session_kind, count(distinct vs.id) from weave_events e join voice_sessions vs on vs.id=e.voice_session_id
where e.session_id in ('b7bf80ce-7821-44a5-9978-50014c9cd470','4e0f36dc-4dbd-4d8d-bedb-f575c0f76678') group by 1;   -- → qa 2
-- E4 every event on the edge in W
select e.timestamp, e.event_type, e.session_id, e.duration_ms from weave_events e
where e.target_id in ('connection:b3c1473b-85bd-405b-90d0-917754d3da5f:4:9','connection:b3c1473b-85bd-405b-90d0-917754d3da5f:9:4')
  and e.timestamp > '2026-09-07T02:37:59.815Z' and e.timestamp <= '2026-10-04 16:27:57+00' order by 1;   -- → 7 rows
-- E5 the edge in t1's conversations
select c->>'voice_session_id', c->>'user_turns', c->>'placement' from weave_profile_snapshots, jsonb_array_elements(generation_metadata->'conversations') c
where id='efa6d6e1-6fc5-4063-8a1e-0de59409d2ad' and c->>'anchor_edge_id'='15b5e181-93aa-44a0-8d6e-306fc195007c';   -- → 9b74ca61… | 12 | both_singletons
```

---

## F. Instrument check (code at `bb23d8f`)

### F.0 Has anything moved since t1?

```bash
git diff --stat bc2279581feade06462534d3dad02456434a9ac7..bb23d8f -- netlify/ netlify.toml scripts/
#  netlify/functions/claude-proxy.ts | 47 ---  (deleted, PR #52; not on the snapshot path)
```

`netlify/lib/snapshot/*`, `netlify/lib/stage2/*`, the three snapshot functions, `scripts/` and `netlify.toml` are unchanged since t1's deployed SHA. (Consequence of `netlify.toml` being unchanged: t1.md §9's narrative-response timeout fix is not applied, so a lost HTTP response on stage 2b remains possible; verify the row, not the response.)

### F.1 Locked parameters: code vs. t1 `generation_metadata.parameters`

| parameter | code (`netlify/lib/snapshot/constants.ts`) | t1 `parameters` | match |
|---|---|---|---|
| roster: breadth ceiling | `BREADTH_MAX = 1.5` (:6) | `breadth_max 1.5` | ✅ |
| roster: dwell cap | `DWELL_CAP_S = 45` (:9) | `dwell_cap_s 45` | ✅ |
| roster: voice turns anchor | `MIN_REAL_TURNS = 4` (:15) | `min_real_turns 4` | ✅ |
| roster: voice base (derived) | `VOICE_BASE = BREADTH_MAX / log₂(MIN_REAL_TURNS + 1)` = 0.6460148371100897 (:21) | `voice_base 0.6460148371100897` | ✅ |
| roster: item_added | `ITEM_ADDED_WEIGHT = 0.2` (:24) | `item_added_weight 0.2` | ✅ |
| `H_BREADTH` | `H_BREADTH_DAYS = 14` (:30) | `h_breadth_days 14` | ✅ |
| `H_DEPTH` | `H_DEPTH_DAYS = 42` (:33) | `h_depth_days 42` | ✅ |
| `K` | `K_HALF_LIVES = 5` (:36) | `k 5` | ✅ |
| cluster threshold | `CLUSTER_SIMILARITY_THRESHOLD = 0.72` (:45) | `cluster_threshold 0.72` | ✅ |
| `ANCHOR_COUNT` | `ANCHOR_COUNT = 3` (:27) | `anchor_count 3` | ✅ |
| run options | `uniform_weights false`, `page_size 500` (defaults, :67-71) | `uniform_weights false`, `page_size 500` | ✅ |

The roster's rule → class → curve mapping is not itself in t1's `parameters` block; it is in code at `engagement.ts:94-115` (four rules: `lightbox_closed` breadth/dwell, `connection_description_closed` breadth/dwell, `voice_session` depth/voice curve, `item_added` recency/flat) and is unchanged since t1 (F.0).

```sql
select generation_metadata->'parameters' from weave_profile_snapshots where id='efa6d6e1-6fc5-4063-8a1e-0de59409d2ad';
```

### F.2 Request shape for a pinned run

`POST /api/generate-profile-snapshot` (`generate-profile-snapshot.ts:191-193`), header `Authorization: Bearer <Supabase access token>` (required; `auth.ts:21-33`, 401 otherwise). Body fields (`:18-28`, validated `:75-100`):

| field | accepted | default / behaviour |
|---|---|---|
| `trigger_reason` | **any string** | non-string or absent → `'manual'`. DB column is `text not null default 'unknown'` with **no CHECK constraint** (prod `pg_constraint` on `weave_profile_snapshots`: pkey + user_id fkey only). Values in use: `fixture`, `r2_unweighted`, `t1`. |
| `pin_node_set_from_snapshot_id` | snapshot id string | **this is the pinning parameter — there is no `node_set` request field.** The function reads `generation_metadata.node_set.keys` from that row (`reads.ts:268-284`) and stamps the new row's `node_set.source = 'pinned:<id>'`. Non-string → 400. |
| `page_size` | positive integer | 500 (`READ_PAGE_SIZE`) |
| `anchor_count` | positive integer | 3 |
| `uniform_weights` | boolean | `false` |

So t1's id is passed as `"pin_node_set_from_snapshot_id": "efa6d6e1-6fc5-4063-8a1e-0de59409d2ad"`. Pinning fixes the **node set only**: `generated_at` is the request time (`:91`), so decay ages and both horizons (`breadth_from = generated_at − 70 d`, `depth_from = generated_at − 210 d`) move with the run; events and voice are read globally as in t1.

### F.3 Stage 2

Both stage-2 functions still read the model from the one constant: `extract-snapshot-themes.ts:9` and `generate-snapshot-narrative.ts:10` import from `netlify/lib/stage2/models.mjs`, and `stage2/claude.ts:25` defaults to it. **`STAGE2_MODEL = 'claude-opus-4-7'`**, `TITLE_MODEL = 'claude-sonnet-4-6'` (`models.mjs:3-4`). t1 recorded `theme_extraction_model` / `narrative_model` = `claude-opus-4-7`. (The voice turn moved to Opus 5 in `e54a031`; that is `conversationOrchestrator.ts`, not stage 2.)

---

## G. t1 title, narrative and themes, verbatim

Copied from the t1 row, not from t1.md. The narrative export was diffed against t1.md §7: identical.

```sql
select generation_metadata->>'title', narrative, md5(narrative) from weave_profile_snapshots where id='efa6d6e1-6fc5-4063-8a1e-0de59409d2ad';
select c->>'cluster_id', c->>'theme_description' from weave_profile_snapshots, jsonb_array_elements(clusters) with ordinality x(c,ord)
where id='efa6d6e1-6fc5-4063-8a1e-0de59409d2ad' order by ord;
```

### G.1 Title (`generation_metadata.title`)

> A collection that sorts by mood, not subject

### G.2 Narrative (`weave_profile_snapshots.narrative`, 4,023 chars, md5 `c333463f117fefcd9c74afe75885f524`)

> The structural center is a 14-piece indictment of rigged sorting systems — meritocracy that isn't, networks that grade their guests, closed loops of capital that pretend to be open contests. But sitting right next to it, and drawing the single longest conversation in the collection (41 turns on the Chamath clip about pain building unicorns), is a cluster of unclustered pieces that take the opposite posture almost admiringly: Ben Affleck on greatness requiring the sacrifice of everything else, the Yale professor on privilege, Tony Soprano asking if this is all there is. The curator has hand-joined Chamath to Affleck, Chamath to the Yale professor, Chamath to the Bill Gates daughter's shopping app. The 14-thread says the game is rigged. The most-discussed pieces say the winners paid a price the losers didn't have to pay. Both can be true, but holding them at once is a particular kind of holding — the machinery is corrupt *and* the people inside it are worth listening to about what it cost them.
>
> The second-largest thread — ten pieces on traps with no exit on their own terms — gets split across Philosophy, Absurdity, and Death depending on register, and this filing behavior repeats elsewhere: the same tweet saved twice into two boards, a three-piece thread on "the exit doesn't deliver" split between Absurdity and Philosophy, aphorisms sorted by which domain of life they arbitrate rather than by who spoke them. The curator is not sorting by source or subject. They are sorting by what mood the same idea arrives in. This is a collection that has decided the content is stable and the frame is the variable, which is unusual — most collections do it the other way.
>
> The conversations do something the threads alone don't. The 14-turn pairing of "Early Retirement Taught Me We've Been Sold A Lie" with the Dostoevsky tweet joins the "exit doesn't deliver" thread to an unclustered piece about suffering as revelation — proposing that the person who escapes the rigged system arrives at the same problem the person who never escaped was already facing. The RDJ-on-Wall-Street pairing with a MAGA "golden age" tweet, and again with "The Silent Revolution and the Great Resignation," keeps re-staging the same scene: someone from inside the machine looking at it from a small distance, not quite outside. The Cinema Tweets pairing of an extracted 60-second monologue with a MidJourney "Hate Room" image is stranger and quieter — joining the belief that a short passage can transmit a whole truth to an AI-generated interior of concentrated feeling. The curator is insisting that compressed transmissions work.
>
> What recurs across subject matter is a figure who sees the structure and is worse off for seeing it — Rust Cohle, Tony Soprano, the early retiree, the person who read the Dostoevsky, the Yale professor's audience, the Ben Affleck who achieved greatness. The rigged-systems thread names the machine; the no-exit thread names the condition of knowing about it; the "exit doesn't deliver" thread names what happens if you try to leave. Read together they describe one shape three times: diagnosis, entrapment, failed escape. The Manson tweets inside the rigged-systems thread are the only pieces in the whole collection that propose an alternative move — dropping the ranking apparatus entirely inside a specific relationship — and they are filed alongside the indictments rather than treated as their own thing.
>
> The small untouched thread of philosopher-aphorisms is worth noting precisely because it hasn't been attended to. Everywhere else the curator is skeptical of authority, alert to hidden hierarchies, willing to spend 39 or 41 turns arguing with a single clip. But the aphorisms get saved and left alone, sorted by which domain they rule over. The one place the collection accepts a pronouncement without working it over is the place where a canonical name is doing the pronouncing — which, given everything else here about concealed rankings of worth, is the quietest tension in the room.

### G.3 Themes (`clusters[].theme_description`, cluster order)

**c1** (size 14, 4 boards, anchors 3):

> Each piece exposes a system that claims to sort by merit or connection but actually runs on a hidden ranking, rigged accounting, or closed loop that excludes what it pretends to measure. The Manson tweets fit because they name the opposite move: intimacy and love as the willingness to drop the ranking apparatus and let someone be seen without being scored. The person has filed these under four different topics, but the underlying complaint is the same one — social reality organized around concealed hierarchies of worth, and the rare exits from that arrangement.

**c2** (size 10, 3 boards, anchors 3):

> Each piece names a trap that has no exit on its own terms: whichever choice you make you regret, seeing clearly makes you suffer more, power finds the corruptible, universal lying destroys belief itself, the party continues without you. The structure is always a closed system where the usual moves (choose better, know more, resist, leave) don't work because the problem is the system's geometry, not your position in it.
>
> The three boards splitting these apart is telling — the person files "the condition has no escape" under Philosophy, Absurdity, or Death depending on register, but the underlying move is one move.

**c3** (size 3, 2 boards, anchors 2):

> Each piece is structured as a report from someone who stepped off the standard track and discovered the exit doesn't deliver what was promised — the freedom reveals a harder problem underneath, the knowledge can't be returned, the cage at least gave you something to lean against. The rhetorical move is always the same: begin by dismantling a cultural lie, then refuse the clean reversal, and land on the fact that seeing through it leaves you responsible for something you now don't know how to hold. That the person filed two of these under "Absurdity" and one under "Philosophy and Art" suggests they read the same gesture as either cosmic joke or serious inquiry depending on the day.

**c4** (size 2, 2 boards, anchors 1):

> Both pieces isolate a short verbal passage from a longer film and treat that passage as a self-contained transmission capable of hitting a viewer who has no context for it. The structural move is the same: extract the monologue, present it as a standalone truth about how to live, and trust it to work without the surrounding story.

**c5** (size 2, 2 boards, anchors 1):

> Both are fan-edited montages that assemble Rust Cohle's monologues into a single argument, then place the daughter's death and the near-death vision at the endpoint so that the pessimism gets qualified rather than refuted. The structural move is the same: build the case for meaninglessness across the runtime, then admit one exception at the close and let it stand without resolving the contradiction.

**c6** (size 2, 2 boards, anchors 0):

> Both are aphorisms attributed to canonical philosophers, screenshotted from literary quote accounts and filed as if the authority of the name settles the claim. The person is sorting these declarative pronouncements by which domain of life they arbitrate — how relationships should work, how absurdity should be borne — rather than by who said them or in what voice.

**c7** (size 2, 2 boards, anchors 2):

> The same tweet, saved twice into two different boards.

---

## H. Query map

| id | measures | section |
|---|---|---|
| P | `now()`, role, bypassrls, policies, grants, tenant count | §0 |
| W-bound | events between t1 `generated_at` and `created_at` | §0 |
| QA | t1 anchors + unclustered_attended, joined live | §A |
| QB / QB-gate | per-node re-engagement in W; cardinality of resolution | §B |
| QC1 | `weave_events` by type in W | §C.1 |
| QC2 | voice sessions in W with launch edge and turns | §C.2 |
| QC3 | nodes / embeddings / item_added / archived / edges / boards in W | §C.3 |
| QC6 (+ gate) | roster engagement by board, T1 window vs W | §C.4 |
| QD | pinned-set drift | §D |
| QE1–5 | qa sessions, browser-session attribution, edge events | §E |
| git diff | snapshot code drift since `bc22795` | §F.0 |
| QG | title, narrative, themes | §G |
