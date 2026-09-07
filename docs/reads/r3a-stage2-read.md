# R3a — Stage-2 (narrative) path and run 1 contents

> **This is a point-in-time read, as of 2026-09-06.**
>
> **Read opened:** `2026-09-06 23:54:33 UTC` (`select now()` at first RO connection, P2). Harness reference time T0 = `2026-09-06 23:57:06 UTC`.
> **Repo SHA:** `f40f580cb2f055a3ca97a720da9fc25219acd434` (`origin/main` after `git fetch origin`; branch
> `reads/r3a-stage2-read` cut from it; working tree clean).
> **Database:** Weave prod (`wndfikmpifyqkgivmnwv`).
> **Role:** `weave_readonly` via `WEAVE_PROD_RO_DATABASE_URL` / `--db-url` only. No writes,
> no Anthropic API calls, no stage-2 execution, no code changes.
>
> **Findings in this document decay; the query map does not.** Every count is
> verified by re-running the query directly above it, never by citing this file.
>
> Sixth occupant of the `docs/reads/` class. Depends on
> [`revival-r2-verify.md`](revival-r2-verify.md) (run 1 = `253c9a8c-5170-4461-86e0-e9c9fece9cbd`).

**Scope.** S1 how stage 2 works today (code, verbatim prompts); S2 run-1 contents; S3 what t1
anchors look like under real weights and Decision A (harness, not a run); S4 content fields
available to a prompt. No prompt is written or evaluated here.


---

## 0. Preflight (RO; recorded verbatim)

**P1 — checkout currency.** `git fetch origin`; `main` reset to `origin/main` = `f40f580` (PR #47
merged). Branch `reads/r3a-stage2-read` cut from it; tree clean. Stage-2 code cited below is at
this SHA; `git log` shows no change to `netlify/functions/extract-snapshot-themes.ts` or
`generate-snapshot-narrative.ts` since the census (`ff0b4f8`).

**P2.** `2026-09-06 23:54:33.742617+00 | weave_readonly | off`; `rolbypassrls f, rolsuper f`.
**P3.** `readonly_audit_select` with `qual = true` on 13/13 public base tables.
**P4.** `weave_events` QA marker: none (restated). `voice_session_id → session_kind`: null 2,554 |
qa 115 | real 50 (= 2,719; +14 rows since R2, none of the five read types inside the window — S3
confirms 191 unchanged). `voice_sessions`: qa 62 | real 25 (= 87 ✅). Every voice query below carries
`session_kind = 'real'`.
**P5.** `SELECT` only on every relation.

```sql
select id, created_at, trigger_reason, (narrative is not null) as has_narrative, jsonb_array_length(coalesce(clusters,'[]')) as n_clusters, generation_metadata->>'pipeline_version'
from weave_profile_snapshots order by created_at desc;
-- → e7adade7… 2026-09-06 04:01 r2_unweighted f 7 v2 | 253c9a8c… 2026-09-06 03:13 r2_unweighted f 7 v2 | 204af847… 2026-04-17 fixture t 0 (null)
```

Three rows; both stage-1 rows have `narrative` null and `clusters[].theme_description = ''`.

---

## S1 — How stage 2 works today

**Shape.** "Stage 2" is two separate Netlify functions, each its own HTTP route, each invoked
manually with a `snapshot_id`, each calling the Anthropic Messages REST API directly from the
function with `process.env.ANTHROPIC_API_KEY` (not the Fly `/api/claude` proxy), and each writing
back into the same `weave_profile_snapshots` row with the service role:

| step | function | route | reads | model | writes |
|---|---|---|---|---|---|
| 2a themes | [`extract-snapshot-themes.ts`](../../netlify/functions/extract-snapshot-themes.ts) | `POST /api/extract-snapshot-themes` `{snapshot_id}` (`:333-337`, timeout 300 s) | `weave_profile_snapshots(id, clusters, generation_metadata)` `:184-188`; `weave_embeddings(board_id, node_id, node_type, content_summary)` for the members' boards, `archived_at is null` `:222-228` | `claude-opus-4-7` `:12`, max_tokens 1024 `:14`, one call per cluster `:255-284` | `clusters[].theme_description` (in place) + `generation_metadata.theme_extraction_model / _timing_ms / _per_cluster_ms / _errors` `:291-306` |
| 2b narrative | [`generate-snapshot-narrative.ts`](../../netlify/functions/generate-snapshot-narrative.ts) | `POST /api/generate-snapshot-narrative` `{snapshot_id}` (`:325-328`, timeout 120 s) | `weave_profile_snapshots(id, clusters, generation_metadata)` `:186-190` — **no node content, no embeddings** | `claude-opus-4-7` `:13`, max_tokens 2048 `:16`, one call `:228`; title: `claude-sonnet-4-6` `:14`, 150 tokens `:17` | `narrative` column + `generation_metadata.narrative_model / narrative_timing_ms / narrative_input_themes` and `title` (if valid) `:282-300` |

**Trigger.** Nothing automatic. No call site in `src/`; `netlify.toml` declares no schedule. The
repo's invocation surfaces are `scripts/test-themes.sh` / `scripts/test-narrative.sh` (curl the
*latest* `weave_profile_snapshots.id` via PostgREST with the service-role key from `.env`, then POST
to `localhost:8888`) and the standalone `scripts/run-themes.mjs` / `scripts/run-narrative.mjs`
(same logic, same `.env`, **model `claude-opus-4-6`** at `:25` in both — drifted from the functions'
`claude-opus-4-7`). All four target whatever `.env` points at (dev locally).

**Gate between 1 and 2b.** Narrative filters to clusters whose `theme_description` is non-empty
and returns **400 `No themes to synthesize`** otherwise (`:204-216`). Run 1 and run 2 have
`theme_description = ''` on all 7 clusters, so narrative cannot run on them until themes has.

### S1.1 — Theme prompt (2a), verbatim

System (`extract-snapshot-themes.ts:16-32`):

```text
You are analyzing a cluster of content curated by one person onto a spatial canvas. Each piece was chosen because it resonated with them. Your job is to describe the thread that binds these pieces together.

Describe the thread in 2-4 sentences.

Rules:

Do not describe the topic. The person already knows what subjects they curate. "These explore mortality" or "these are about the startup ecosystem" is the answer they could give themselves. You are looking for the answer they could not.

Do not match the content's emotional register. If the content is poetic, do not be poetic. If it is cynical, do not be cynical. Use your own voice — precise, observational, specific. You are describing what you see from outside, not performing what the content performs.

Look for the structural pattern, not the subject. What do these pieces DO that is the same? Do they all present a character in the same position? Do they all make the same rhetorical move? Do they all locate meaning in the same unexpected place? Do they all handle knowledge the same way — as burden, as weapon, as consolation, as trap?

Be specific enough that someone could say "no, that is wrong." The description should be falsifiable. "These pieces share a concern with authenticity" is unfalsifiable mush. "Each of these presents someone performing expertise while privately suspecting they are fraudulent" is specific enough to be wrong, which means it is specific enough to be interesting.

The anchor nodes (marked with ★) are the pieces this person engages with most. They are probably closest to the center of what this cluster means. Weight them accordingly.

Respond with ONLY the 2-4 sentence description. No preamble, no labels, no "This cluster..." opening. Just the observation.
```

User prompt builder (`:102-133`) — the model sees, per cluster: piece count, boards count, then
one line per member `[node_type] content_summary` with `★ ` prefixed on anchors, or
`[node_type] (visual content — no text description available)` when the summary is blank or the
member is not in the live-embeddings lookup:

```ts
function buildUserPrompt(
  cluster: ClusterObj,
  contentLookup: Map<string, { nodeType: string; summary: string | null }>,
): string {
  const anchorSet = new Set(cluster.anchor_node_ids)
  const lines: string[] = []

  lines.push(
    `Content in this cluster (${cluster.size} pieces across ${cluster.boards_touched.length} boards):`,
  )
  lines.push('')

  for (const key of cluster.member_node_ids) {
    const entry = contentLookup.get(key)
    const prefix = anchorSet.has(key) ? '★ ' : ''
    const nodeType = entry?.nodeType ?? 'unknown'
    const summary = entry?.summary

    if (summary && summary.trim().length > 0) {
      lines.push(`${prefix}[${nodeType}] ${summary}`)
    } else {
      lines.push(`${prefix}[${nodeType}] (visual content — no text description available)`)
    }
  }

  lines.push('')
  lines.push('---')
  lines.push('')
  lines.push('What thread binds these pieces?')

  return lines.join('\n')
}
```

**What 2a does not see:** titles, URLs, authors, tweet text, transcripts, `nodes` rows of any kind,
embeddings, cluster ids, `engagement_weight`, `w_total`, `by_class`, `top_events`, or which board a
member is on (only the *count* of boards). Anchors reach the prompt only as the `★` glyph. The
lookup excludes archived rows (`:228`), so under a pinned node set an archived member would print as
`[unknown] (visual content — no text description available)`.

### S1.2 — Narrative prompt (2b), verbatim

System (`generate-snapshot-narrative.ts:26-46`):

```text
You are looking at a set of thematic observations about one person's curated content — tweets, videos, images, articles they've collected on a spatial canvas over time. Each observation describes a structural thread found across a cluster of related pieces. Your job is to synthesize these observations into a short reflective narrative about the person behind the curation.

Write 3-5 paragraphs.

Rules:

This is not a summary of the themes. Do not walk through them one by one. The person can already read the individual themes — they are looking at them on the same page. Your job is to find what the themes reveal together that no single theme says on its own.

Look for tensions between themes. A person who curates content about vulnerability-as-strength AND content about intelligence-as-armor is holding two contradictory postures simultaneously. That contradiction is more interesting than either theme alone. Name it.

Look for recurring moves across themes. If three different clusters all share a structure where someone who understands something is worse off for understanding it, that repetition across different subject matter is a signal. The person is drawn to that move regardless of context.

Do not psychoanalyze. Do not diagnose. Do not presume to know why the person curates what they curate. Describe what you observe in the curation patterns — the postures, the tensions, the recurring figures — and let the person draw their own conclusions. The tone should be that of a perceptive friend who noticed something, not a therapist interpreting symptoms.

Do not use the word "you" — write about "the curation" or "the collection" or "the curator" in third person. This creates the slight distance that makes self-reflection possible rather than self-conscious. The person is looking at a portrait, not being addressed directly.

Weight larger clusters and higher-engagement clusters more heavily in the narrative. A thread that spans 8 pieces across 4 boards is more structurally significant than a pair. But do not ignore the pairs — sometimes the smallest cluster contains the sharpest observation.

Do not open with "This collection..." or any throat-clearing. Start with the most striking observation and build from there.

Respond with ONLY the narrative paragraphs. No titles, no headers, no labels. Just the prose.
```

User prompt builder (`:110-135`) — clusters with a theme, **sorted by size desc**, each as
`Thread (N pieces, B boards, engagement: W):` + `theme_description`:

```ts
function buildUserPrompt(clustersWithThemes: ClusterObj[]): string {
  const totalPieces = clustersWithThemes.reduce((sum, c) => sum + c.size, 0)
  const totalClusters = clustersWithThemes.length

  const lines: string[] = []
  lines.push(
    `Thematic observations from a curated canvas (${totalPieces} pieces across ${totalClusters} threads):`,
  )
  lines.push('')

  for (const cluster of clustersWithThemes) {
    const boardsTouched = cluster.boards_touched.length
    const weight = cluster.engagement_weight.toFixed(2)
    lines.push(
      `Thread (${cluster.size} pieces, ${boardsTouched} boards, engagement: ${weight}):`,
    )
    lines.push(cluster.theme_description)
    lines.push('')
  }

  lines.push('---')
  lines.push('')
  lines.push('What do these threads reveal together?')

  return lines.join('\n')
}
```

Title prompt (`:20-24`), run with an empty system prompt on `claude-sonnet-4-6`, output rejected if
empty or > 64 chars (`:262-269`):

```text
Below is a snapshot narrative. Find the phrase within it that would best serve as the headline — the line that captures what the piece is doing. Under 64 characters. Must be a complete phrase, not a sentence fragment. Return only the phrase, nothing else.

---


```

**What 2b sees:** only `size`, `boards_touched.length`, `engagement_weight` (2 dp) and
`theme_description` per cluster, plus the totals. No node content, no anchors, no provenance, no
singletons. **Post-processing:** `text.trim()` (`:104`) and paragraph splitting happens in the
client, not here.

### S1.3 — What Reflect and the voice opening turn read

[`profileSnapshots.ts:36-63`](../../src/persistence/profileSnapshots.ts):
`select('id, created_at, node_count, clusters, narrative, generation_metadata').order('created_at', desc).limit(1).maybeSingle()`,
then **returns `null` if `narrative` is null/blank** (`:53-57`). [`ReflectView.tsx:56-83`](../../src/components/ReflectView.tsx):
paragraphs = `narrative.split(/\n\s*\n/)`; `themes` = `clusters[].theme_description` (non-empty);
`threadCount` = clusters.length; `pieceCount` = Σ size; `title` = `generation_metadata.title`;
`mode` hardcoded `'weave'`. Anchors, provenance, `boards_touched`, singletons: **not read**. The
store caches the last usable snapshot in `localStorage` (`weave.snapshot.latest`,
[`profileSnapshotStore.ts:40`](../../src/services/profileSnapshot/profileSnapshotStore.ts)). The
voice opening turn reads the same row and passes `narrative` as `recentThinking`
([`vadController.ts:533-548`](../../src/services/voice/vadController.ts),
[`buildSystemPrompt.ts:53-58`](../../src/services/voice/buildSystemPrompt.ts)); nothing else from
the snapshot reaches the voice prompt.

---

## S2 / S3 / S4 — run 1 contents, t1 under Decision A, content fields

**Method.** RO exports (`run1-meta.json`, `run1-clusters.json`, the five read types of
`weave_events` all-time, all `weave_embeddings`, the 16 qualifying real voice sessions with the
anchor hop synthesized in SQL, and the 71 nodes joined `weave_embeddings ⟷ nodes` on
`board_id` + `coalesce(nodes.data->>'_clientNodeId', nodes.id)`), then the **real pure modules**
(`netlify/lib/snapshot/{engagement,constants,reads}.ts` @ `f40f580`) imported by the harness
(Appendix A) over run 1's `node_set.keys`, three ways:

| harness run | `generated_at` | weights | events bound | purpose |
|---|---|---|---|---|
| `h-uniform-run1` | `2026-09-06T03:13:50.574Z` (run 1) | uniform | `≤ generated_at` | stop-condition check against stored run 1 |
| `h-real-run1` | run 1 | **real** (`w_rule` from the curves) | `≤ generated_at` | S2 singletons "as stage 1 computes it" for t1 |
| `h-real-now` | `2026-09-06T23:57:06.256Z` (T0) | **real** | none (as the pipeline) | S3 "t1 today" |

The `≤ generated_at` bound exists only to reproduce a past run from a later export; the pipeline
itself has no upper bound because it reads at generation time. Every harness run read 191 events
and 16 voice sessions in window and attributed 186 = 178 + 8 + 0 — identical to the stored run 1
and unchanged at T0 (the 14 `weave_events` rows added since run 1 are not among the five read
types).

```sql
-- the 71-node content join (RO)
with keys as (select k as composite_key, split_part(k,':',1) as board_id, split_part(k,':',2) as node_id
              from weave_profile_snapshots, jsonb_array_elements_text(generation_metadata->'node_set'->'keys') k where id='253c9a8c-…')
select k.composite_key, w.node_type, w.content_summary, w.created_at, n.id, n.card_type, n.link_type, n.title, n.url, n.source, n.text_content, n.image_url, n.description, n.created_at, n.data
from keys k
left join weave_embeddings w on w.board_id = k.board_id and w.node_id = k.node_id
left join nodes n on n.board_id::text = k.board_id and coalesce(n.data->>'_clientNodeId', n.id::text) = k.node_id;
-- → 71 rows, 71 with a nodes row, 0 duplicate composites
```

### Harness vs stored run 1 (stop-condition check) (uniform weights, events ≤ generated_at): anchors identical per cluster = true; anchor w_total within 1e-9 = true; attribution 186=178+8+0 vs stored 186=178+8+0

### S2.1 — run 1 clusters (stored anchors; w_total under uniform weights as stored)

### c1 — size 14, boards 4, engagement_weight 0.2353

| member | board | type | title / first 120 chars | source field | anchor? | w_total (stored, uniform) | breadth / depth / recency |
|---|---|---|---|---|---|---:|---|
| `8a8d45a9…:3` | `8a8d45a9…` | link/tweet/linkCard | Are you enjoying the golden age, MAGA? - New Regime Change War - Rising Gas Prices - TSA shutdown - Record Insurance Pre… | data.tweetText (title = author "Maine") |  |  |  |
| `8a8d45a9…:4` | `8a8d45a9…` | link/tweet/linkCard | This kind of becomes truer and truer every day. pic.twitter.com/Ho8tgTPgNz— Autism Capital 🧩 (@AutismCapital) March 31,… | data.tweetText (title = author "Autism Capital 🧩") |  |  |  |
| `b3c1473b…:7` | `b3c1473b…` | link/tweet/linkCard | "The top 1 percent of American households, which have a minimum net worth of $11.1 million, now collectively own about $… | data.tweetText (title = author "unusual_whales") |  |  |  |
| `b3c1473b…:3` | `b3c1473b…` | link/tweet/linkCard | The reality described in this article is bleak. The "winners" in venture capital are now so few, and absorb so much capi… | data.tweetText (title = author "Dan Gray") |  |  |  |
| `b3c1473b…:6` | `b3c1473b…` | link/tweet/linkCard | YC is run by completely malevolent, highly unaccomplished neerdowells. Tan started a failed blogging site. Who cares? I … | data.tweetText (title = author "Jay") |  |  |  |
| `b3c1473b…:10` | `b3c1473b…` | link/tweet/linkCard | I generally bemoan the reality that Bay Area (and increasingly global) startup culture is devolving into an MBA-ified ze… | data.tweetText (title = author "arian ghashghai") |  |  |  |
| `b3c1473b…:14` | `b3c1473b…` | link/tweet/linkCard | venture capital is too easy to dunk on cuz variance is enormous & noise dwarfs even that. capital access should function… | data.tweetText (title = author "signüll") | **anchor** | 1.0672 | 1.0672 / 0.0000 / 0.0000 |
| `fef6c2a3…:3` | `fef6c2a3…` | link/tweet/linkCard | Intimacy is directly proportional to the willingness of two people to be hurt by one another.— Mark Manson (@Markmanson)… | data.tweetText (title = author "Mark Manson") |  |  |  |
| `fef6c2a3…:6` | `fef6c2a3…` | link/tweet/linkCard | The most powerful form of love is when you give someone permission to simply be who they already are.— Mark Manson (@Mar… | data.tweetText (title = author "Mark Manson") |  |  |  |
| `b3c1473b…:12` | `b3c1473b…` | link/tweet/linkCard | NEW: Emails show that Peter Thiel & Jeffrey Epstein's friendship was much closer than was known - and that Epstein encou… | data.tweetText (title = author "Branko Marcetic") |  |  |  |
| `a428492a…:23` | `a428492a…` | link/tweet/linkCard | When simulation becomes the norm, it weakens the human capacity for discernment. As a result, our social bonds close in … | data.tweetText (title = author "Pope Leo XIV") | **anchor** | 1.5363 | 1.5363 / 0.0000 / 0.0000 |
| `b3c1473b…:16` | `b3c1473b…` | link/tweet/linkCard | SF tech myopia is an occupational hazard and social byproduct of knowing the top 0.1%. I call it the silver medalist min… | data.tweetText (title = author "Bo Ren") |  |  |  |
| `b3c1473b…:20` | `b3c1473b…` | link/tweet/linkCard | Dialog, the private network cofounded by Peter Thiel, grades its event attendees on a hidden scale, ranking them by weal… | data.tweetText (title = author "WIRED") | **anchor** | 1.9028 | 1.6267 / 0.2760 / 0.0000 |
| `b3c1473b…:22` | `b3c1473b…` | link/tweet/linkCard | Phia — the buzzy shopping app co-founded by Bill Gates' daughter, Phoebe — is claiming credit for online sales it didn’t… | data.tweetText (title = author "Bloomberg") |  |  |  |

- anchor `b3c1473b…:20` top_events (5): connection_description_closed[breadth] w_eff 0.9040 age 2.0d; voice_session[depth] w_eff 0.2760 age 78.0d vs=2c18bad5 turns=16; connection_description_closed[breadth] w_eff 0.1033 age 45.9d; connection_description_closed[breadth] w_eff 0.1033 age 45.9d; connection_description_closed[breadth] w_eff 0.1033 age 45.9d
- anchor `a428492a…:23` top_events (5): connection_description_closed[breadth] w_eff 0.7381 age 6.1d; lightbox_closed[breadth] w_eff 0.6313 age 9.3d; connection_description_closed[breadth] w_eff 0.0556 age 58.3d; connection_description_closed[breadth] w_eff 0.0556 age 58.3d; connection_description_closed[breadth] w_eff 0.0556 age 58.3d
- anchor `b3c1473b…:14` top_events (3): connection_description_closed[breadth] w_eff 0.9040 age 2.0d; connection_description_closed[breadth] w_eff 0.1033 age 45.9d; connection_description_closed[breadth] w_eff 0.0600 age 56.8d

### c2 — size 10, boards 3, engagement_weight 0.1422

| member | board | type | title / first 120 chars | source field | anchor? | w_total (stored, uniform) | breadth / depth / recency |
|---|---|---|---|---|---|---:|---|
| `a428492a…:4` | `a428492a…` | link/tweet/linkCard | “All power attracts pathological personalities. It is not that power corrupts but that it is magnetic to the corruptible… | data.tweetText (title = author "Saganism") |  |  |  |
| `a428492a…:29` | `a428492a…` | link/tweet/linkCard | “If you have selfish, ignorant citizens, you’re going to have selfish, ignorant leaders.” — George Carlin pic.twitter.co… | data.tweetText (title = author "Saganism") |  |  |  |
| `8a8d45a9…:19` | `8a8d45a9…` | link/tweet/linkCard | “If everybody always lies to you, the consequence is not that you believe the lies, but rather that nobody believes anyt… | data.tweetText (title = author "Saganism") |  |  |  |
| `2810ae3a…:6` | `2810ae3a…` | link/tweet/linkCard | “It will happen to all of us, that at some point you get tapped on the shoulder and told, not just that the party is ove… | data.tweetText (title = author "Saganism") |  |  |  |
| `a428492a…:5` | `a428492a…` | link/tweet/linkCard | “And what is death but an emancipation from time? That is of course only on condition that death really means death, not… | data.tweetText (title = author "Poetic Outlaws") |  |  |  |
| `a428492a…:27` | `a428492a…` | link/tweet/linkCard | Two people genuinely oriented toward the same thing will inevitably arrive at the same place by the logic of geometry: p… | data.tweetText (title = author "Sherry") | **anchor** | 0.7381 | 0.7381 / 0.0000 / 0.0000 |
| `a428492a…:37` | `a428492a…` | link/tweet/linkCard | You'll regret it if you get married, you'll regret it if you don't get married. You'll regret it if you have kids and yo… | data.tweetText (title = author "​𝐥𝐲𝐫𝐚") | **anchor** | 1.1608 | 0.8706 / 0.0000 / 0.2902 |
| `8a8d45a9…:27` | `8a8d45a9…` | link/tweet/linkCard | pic.twitter.com/aSouCF28LP— no context memes (@nocontextmemes) June 8, 2026 | data.tweetText (title = author "no context memes") |  |  |  |
| `8a8d45a9…:29` | `8a8d45a9…` | link/tweet/linkCard | pic.twitter.com/Bpd12mLIbY— philosophy memes 🔗 (@philosophymeme0) June 14, 2026 | data.tweetText (title = author "philosophy memes 🔗") |  |  |  |
| `a428492a…:12` | `a428492a…` | link/tweet/linkCard | Carl Jung wrote: "The more intelligent and self-aware a person is, the more they suffer from the general unconsciousness… | data.tweetText (title = author "🧬Maxpein🧬") | **anchor** | 0.8248 | 0.8248 / 0.0000 / 0.0000 |

- anchor `a428492a…:37` top_events (4): connection_description_closed[breadth] w_eff 0.2902 age 25.0d; connection_description_closed[breadth] w_eff 0.2902 age 25.0d; lightbox_closed[breadth] w_eff 0.2902 age 25.0d; item_added[recency] w_eff 0.2902 age 25.0d
- anchor `a428492a…:12` top_events (2): connection_description_closed[breadth] w_eff 0.7381 age 6.1d; connection_description_closed[breadth] w_eff 0.0868 age 49.4d
- anchor `a428492a…:27` top_events (1): connection_description_closed[breadth] w_eff 0.7381 age 6.1d

### c3 — size 3, boards 2, engagement_weight 0.1581

| member | board | type | title / first 120 chars | source field | anchor? | w_total (stored, uniform) | breadth / depth / recency |
|---|---|---|---|---|---|---:|---|
| `8a8d45a9…:6` | `8a8d45a9…` | link/youtube/linkCard | The Silent Revolution And The Great Resignation | nodes.title | **anchor** | 0.1598 | 0.0000 / 0.1598 / 0.0000 |
| `8a8d45a9…:9` | `8a8d45a9…` | link/youtube/linkCard | Is Ignorance Really Bliss? | nodes.title | **anchor (w=0)** | 0.0000 | 0.0000 / 0.0000 / 0.0000 |
| `a428492a…:39` | `a428492a…` | link/youtube/linkCard | Early Retirement Taught Me That We’ve All Been Sold A Lie? | nodes.title | **anchor** | 2.8679 | 1.3301 / 0.8730 / 0.6648 |

- anchor `a428492a…:39` top_events (4): voice_session[depth] w_eff 0.8730 age 8.2d vs=dd5f619b turns=14; connection_description_closed[breadth] w_eff 0.6653 age 8.2d; connection_description_closed[breadth] w_eff 0.6648 age 8.2d; item_added[recency] w_eff 0.6648 age 8.2d
- anchor `8a8d45a9…:6` top_events (1): voice_session[depth] w_eff 0.1598 age 111.1d vs=a2d72d70 turns=2
- anchor `8a8d45a9…:9` top_events (0): (none)

### c4 — size 2, boards 2, engagement_weight 0.062

| member | board | type | title / first 120 chars | source field | anchor? | w_total (stored, uniform) | breadth / depth / recency |
|---|---|---|---|---|---|---:|---|
| `a428492a…:8` | `a428492a…` | link/tweet/linkCard | Movies are moments. This monologue is barely 60 seconds. But it floats above a 3 hour masterpiece. You could know nothin… | data.tweetText (title = author "Cinema Tweets") | **anchor** | 0.7913 | 0.6313 / 0.1600 / 0.0000 |
| `fef6c2a3…:2` | `fef6c2a3…` | link/tweet/linkCard | life shrinks or expands according to one's courage. https://t.co/OTuZuIRSug pic.twitter.com/1YSPtfARti— gomi (@parveen__… | data.tweetText (title = author "gomi") | **anchor (w=0)** | 0.0000 | 0.0000 / 0.0000 / 0.0000 |

- anchor `a428492a…:8` top_events (2): lightbox_closed[breadth] w_eff 0.6313 age 9.3d; voice_session[depth] w_eff 0.1600 age 111.0d vs=0dac35fb turns=3
- anchor `fef6c2a3…:2` top_events (0): (none)

### c5 — size 2, boards 2, engagement_weight 0.0142

| member | board | type | title / first 120 chars | source field | anchor? | w_total (stored, uniform) | breadth / depth / recency |
|---|---|---|---|---|---|---:|---|
| `a428492a…:10` | `a428492a…` | link/youtube/linkCard | True Detective - World Needs Bad Men | nodes.title | **anchor (w=0)** | 0.0000 | 0.0000 / 0.0000 / 0.0000 |
| `8a8d45a9…:15` | `8a8d45a9…` | link/youtube/linkCard | (TRUE DETECTIVE) RUST COHLE - DEVASTATION | nodes.title | **anchor** | 0.1815 | 0.1815 / 0.0000 / 0.0000 |

- anchor `8a8d45a9…:15` top_events (1): lightbox_closed[breadth] w_eff 0.1815 age 34.5d
- anchor `a428492a…:10` top_events (0): (none)

### c6 — size 2, boards 2, engagement_weight 0

| member | board | type | title / first 120 chars | source field | anchor? | w_total (stored, uniform) | breadth / depth / recency |
|---|---|---|---|---|---|---:|---|
| `fef6c2a3…:4` | `fef6c2a3…` | link/tweet/linkCard | “True friendship can exist only between equals.” — Plato pic.twitter.com/blvPUy6TxX— ✒️ (@Literariium) April 7, 2026 | data.tweetText (title = author "✒️") | **anchor (w=0)** | 0.0000 | 0.0000 / 0.0000 / 0.0000 |
| `8a8d45a9…:13` | `8a8d45a9…` | link/tweet/linkCard | — Fyodor Dostoevsky pic.twitter.com/vF0FwNMj9L— 𐙚⋆ (@voidwithverses) April 29, 2026 | data.tweetText (title = author "𐙚⋆") | **anchor (w=0)** | 0.0000 | 0.0000 / 0.0000 / 0.0000 |

- anchor `fef6c2a3…:4` top_events (0): (none)
- anchor `8a8d45a9…:13` top_events (0): (none)

### c7 — size 2, boards 2, engagement_weight 0.1174

| member | board | type | title / first 120 chars | source field | anchor? | w_total (stored, uniform) | breadth / depth / recency |
|---|---|---|---|---|---|---:|---|
| `2810ae3a…:4` | `2810ae3a…` | link/tweet/linkCard | The gods envy us. They envy us because we're mortal, because any moment may be our last. Everything is more beautiful be… | data.tweetText (title = author "James Lucas") | **anchor** | 0.9545 | 0.9545 / 0.0000 / 0.0000 |
| `a428492a…:31` | `a428492a…` | link/tweet/linkCard | The gods envy us. They envy us because we're mortal, because any moment may be our last. Everything is more beautiful be… | data.tweetText (title = author "James Lucas") | **anchor** | 0.5443 | 0.5443 / 0.0000 / 0.0000 |

- anchor `2810ae3a…:4` top_events (5): connection_description_closed[breadth] w_eff 0.0868 age 49.4d; connection_description_closed[breadth] w_eff 0.0868 age 49.4d; connection_description_closed[breadth] w_eff 0.0868 age 49.4d; connection_description_closed[breadth] w_eff 0.0868 age 49.4d; lightbox_closed[breadth] w_eff 0.0868 age 49.4d
- anchor `a428492a…:31` top_events (3): connection_description_closed[breadth] w_eff 0.1815 age 34.5d; lightbox_closed[breadth] w_eff 0.1814 age 34.5d; connection_description_closed[breadth] w_eff 0.1814 age 34.5d

**Cardinality:** members across clusters = 35; singletons = 36; sum = 71 (node set 71). Stored anchors = 17; with w_total = 0: 5 (c3:8a8d45a9…:9, c4:fef6c2a3…:2, c5:a428492a…:10, c6:fef6c2a3…:4, c6:8a8d45a9…:13).


### S2.2 — the 36 singletons, w_total under REAL weights (uniform off), generated_at = 2026-09-06T03:13:50.574Z, events ≤ generated_at

Real-weight attribution over the run-1 node set: resolved 186 = hit 178 + archived 8 + absent 0; zero_weight_events 0.

| rank | singleton | board | type | title / first 120 chars | w_total | breadth / depth / recency | events | top_events |
|---:|---|---|---|---|---:|---|---:|---|
| 1 | `a428492a…:35` | `a428492a…` | link/tweet/linkCard | Dostoevsky talks about this pic.twitter.com/DiCVoPaJEd— Überkierk (@UberKierk) August 2, 2026 | 8.6160 | 5.2330 / 3.3467 / 0.0363 | 19 | voice_session[d] 2.2033 vs=dd5f619b t=14; voice_session[d] 1.1434 vs=f90a49c2 t=6; connection_description_closed[b] 0.9979; lightbox_closed[b] 0.9485; connection_description_closed[b] 0.3759 |
| 2 | `a428492a…:14` | `a428492a…` | link/tweet/linkCard | the more you understand this world, the more you destroy yourself. That's why fools are happy, and intelligent people li… | 3.0180 | 3.0180 / 0.0000 / 0.0000 | 5 | lightbox_closed[b] 0.9946; lightbox_closed[b] 0.8551; lightbox_closed[b] 0.7203; lightbox_closed[b] 0.2518; connection_description_closed[b] 0.1961 |
| 3 | `b3c1473b…:4` | `b3c1473b…` | link/tweet/linkCard | Chamath Palihapitiya: Why happy childhoods don't build unicorns. pic.twitter.com/rffwI8JRRc— shouko (@shoukointech) Apri… | 2.5945 | 0.5687 / 2.0257 / 0.0000 | 10 | voice_session[d] 1.1791 vs=4b7a9c05 t=23; voice_session[d] 0.5517 vs=9b74ca61 t=12; voice_session[d] 0.2948 vs=c12efded t=6; lightbox_closed[b] 0.1737; connection_description_closed[b] 0.1047 |
| 4 | `8a8d45a9…:37` | `8a8d45a9…` | link/tweet/linkCard | 🚨 Rep. Ro Khanna calls for the arrests of Netanyahu and Putin: "The American president should arrest Netanyahu or Putin… | 2.3228 | 0.8763 / 1.4227 / 0.0238 | 7 | voice_session[d] 1.4227 vs=1264631b t=10; connection_description_closed[b] 0.3870; connection_description_closed[b] 0.2049; connection_description_closed[b] 0.1184; connection_description_closed[b] 0.1027 |
| 5 | `b3c1473b…:24` | `b3c1473b…` | link/youtube/linkCard | GigSlave Goes Public With $84 Billion Valuation \| Onion News Network | 2.1124 | 2.0918 / 0.0000 / 0.0206 | 17 | connection_description_closed[b] 0.7889; connection_description_closed[b] 0.1272; connection_description_closed[b] 0.1085; connection_description_closed[b] 0.1070; connection_description_closed[b] 0.1047 |
| 6 | `8a8d45a9…:39` | `8a8d45a9…` | link/tweet/linkCard | ''If a perfectly moral man entered this world, he would be humiliated and impaled'' - Plato 400 years before Christ. pic… | 2.0661 | 0.5918 / 1.4227 / 0.0516 | 4 | voice_session[d] 1.4227 vs=1264631b t=10; connection_description_closed[b] 0.3870; connection_description_closed[b] 0.2049; item_added[r] 0.0516 |
| 7 | `a428492a…:33` | `a428492a…` | link/youtube/linkCard | Tony Soprano - 'Is This All There Is' | 2.0613 | 0.9179 / 1.1434 / 0.0000 | 6 | voice_session[d] 1.1434 vs=f90a49c2 t=6; connection_description_closed[b] 0.3759; connection_description_closed[b] 0.2253; connection_description_closed[b] 0.1581; connection_description_closed[b] 0.1315 |
| 8 | `b3c1473b…:9` | `b3c1473b…` | link/tweet/linkCard | Ben Affleck on the real cost of being Great pic.twitter.com/wbxLGcGnO5— Naruto (@NarutoNolimits) April 19, 2026 | 1.2218 | 0.3358 / 0.8860 / 0.0000 | 6 | voice_session[d] 0.5517 vs=9b74ca61 t=12; voice_session[d] 0.3343 vs=f61f63eb t=4; connection_description_closed[b] 0.1272; connection_description_closed[b] 0.1127; connection_description_closed[b] 0.0554 |
| 9 | `a428492a…:16` | `a428492a…` | link/youtube/linkCard | Columbus Trailer #1 (2017) \| Movieclips Indie | 0.9397 | 0.9397 / 0.0000 / 0.0000 | 3 | connection_description_closed[b] 0.5926; lightbox_closed[b] 0.2722; lightbox_closed[b] 0.0749 |
| 10 | `b3c1473b…:8` | `b3c1473b…` | link/tweet/linkCard | Yale professor perfectly explains childhood privilege. pic.twitter.com/TIYW6odaja— The Driven Man (@Thedrivenman) April … | 0.7956 | 0.0000 / 0.7956 / 0.0000 | 3 | voice_session[d] 0.3343 vs=f61f63eb t=4; voice_session[d] 0.2948 vs=c12efded t=6; voice_session[d] 0.1666 vs=41cc85a8 t=2 |

Singletons with w_total = 0: **15** of 36; with w_total > 0: 21.

(Under uniform weights at the same instant: 21 engaged singletons, 15 at zero — same identities as real weights: true.)


### S3.1 — t1 today: Decision A anchors (w_total > 0, top 3) under REAL weights, generated_at = 2026-09-06T23:57:06.256Z (current 70/210-day windows, run-1 node set)

Events in window 191, voice sessions in window 16; attribution 186 = 178 + 8 + 0; zero_weight_events 0.

| cluster | size | anchors (Decision A) | anchor | w_total | breadth / depth / recency | dominant class | voice-dominated? |
|---|---:|---:|---|---:|---|---|---|
| c1 | 14 | 3 | `b3c1473b…:20` | 1.9372 | 1.2187 / 0.7185 / 0.0000 | breadth | no |
|  |  |  | `b3c1473b…:22` | 1.5459 | 0.3720 / 1.1625 / 0.0115 | depth | **yes** |
|  |  |  | `b3c1473b…:10` | 0.9634 | 0.2448 / 0.7185 / 0.0000 | depth | **yes** |
| c2 | 10 | 3 | `a428492a…:37` | 0.5489 | 0.4933 / 0.0000 / 0.0556 | breadth | no |
|  |  |  | `a428492a…:12` | 0.2098 | 0.2098 / 0.0000 / 0.0000 | breadth | no |
|  |  |  | `a428492a…:27` | 0.1571 | 0.1571 / 0.0000 / 0.0000 | breadth | no |
| c3 | 3 | 2 | `a428492a…:39` | 3.4640 | 1.1645 / 2.1721 / 0.1274 | depth | **yes** |
|  |  |  | `8a8d45a9…:6` | 0.1613 | 0.0000 / 0.1613 / 0.0000 | depth | **yes** |
| c4 | 2 | 1 | `a428492a…:8` | 0.8797 | 0.6760 / 0.2038 / 0.0000 | breadth | no |
| c5 | 2 | 1 | `8a8d45a9…:15` | 0.2609 | 0.2609 / 0.0000 / 0.0000 | breadth | no |
| c6 | 2 | 0 | — | | | | |
| c7 | 2 | 2 | `2810ae3a…:4` | 0.6909 | 0.6909 / 0.0000 / 0.0000 | breadth | no |
|  |  |  | `a428492a…:31` | 0.6109 | 0.6109 / 0.0000 / 0.0000 | breadth | no |

Anchors under Decision A: **12** (per cluster: c1=3, c2=3, c3=2, c4=1, c5=1, c6=0, c7=2); voice-dominated (depth > breadth + recency): **4**.


### S3.2 — `unclustered_attended` (singletons with w_total > 0, ranked, real weights, now)

| rank | key | board | type | title / first 120 chars | w_total | breadth / depth / recency | dominant | voice-dominated? |
|---:|---|---|---|---|---:|---|---|---|
| 1 | `a428492a…:35` | `a428492a…` | link/tweet/linkCard | Dostoevsky talks about this pic.twitter.com/DiCVoPaJEd— Überkierk (@UberKierk) August 2, 2026 | 8.3481 | 5.0140 / 3.2994 / 0.0348 | breadth | no |
| 2 | `a428492a…:14` | `a428492a…` | link/tweet/linkCard | the more you understand this world, the more you destroy yourself. That's why fools are happy, and intelligent people li… | 2.8917 | 2.8917 / 0.0000 / 0.0000 | breadth | no |
| 3 | `b3c1473b…:4` | `b3c1473b…` | link/tweet/linkCard | Chamath Palihapitiya: Why happy childhoods don't build unicorns. pic.twitter.com/rffwI8JRRc— shouko (@shoukointech) Apri… | 2.5420 | 0.5449 / 1.9971 / 0.0000 | depth | **yes** |
| 4 | `8a8d45a9…:37` | `8a8d45a9…` | link/tweet/linkCard | 🚨 Rep. Ro Khanna calls for the arrests of Netanyahu and Putin: "The American president should arrest Netanyahu or Putin… | 2.2650 | 0.8396 / 1.4026 / 0.0228 | depth | **yes** |
| 5 | `b3c1473b…:24` | `b3c1473b…` | link/youtube/linkCard | GigSlave Goes Public With $84 Billion Valuation \| Onion News Network | 2.0240 | 2.0042 / 0.0000 / 0.0198 | breadth | no |
| 6 | `8a8d45a9…:39` | `8a8d45a9…` | link/tweet/linkCard | ''If a perfectly moral man entered this world, he would be humiliated and impaled'' - Plato 400 years before Christ. pic… | 2.0190 | 0.5671 / 1.4026 / 0.0494 | depth | **yes** |
| 7 | `a428492a…:33` | `a428492a…` | link/youtube/linkCard | Tony Soprano - 'Is This All There Is' | 2.0067 | 0.8795 / 1.1272 / 0.0000 | depth | **yes** |
| 8 | `b3c1473b…:9` | `b3c1473b…` | link/tweet/linkCard | Ben Affleck on the real cost of being Great pic.twitter.com/wbxLGcGnO5— Naruto (@NarutoNolimits) April 19, 2026 | 1.1952 | 0.3217 / 0.8735 / 0.0000 | depth | **yes** |
| 9 | `a428492a…:16` | `a428492a…` | link/youtube/linkCard | Columbus Trailer #1 (2017) \| Movieclips Indie | 0.9004 | 0.9004 / 0.0000 / 0.0000 | breadth | no |
| 10 | `b3c1473b…:8` | `b3c1473b…` | link/tweet/linkCard | Yale professor perfectly explains childhood privilege. pic.twitter.com/TIYW6odaja— The Driven Man (@Thedrivenman) April … | 0.7844 | 0.0000 / 0.7844 / 0.0000 | depth | **yes** |
| 11 | `8a8d45a9…:7` | `8a8d45a9…` | link/tweet/linkCard | We never had a chance. pic.twitter.com/mVQHeX7Rxp— RyanPatrick🇺🇸🦅 (@RyanHatesGovt) April 10, 2026 | 0.6857 | 0.0431 / 0.6426 / 0.0000 | depth | **yes** |
| 12 | `8a8d45a9…:25` | `8a8d45a9…` | link/tweet/linkCard | When writer Amil Niazi was struggling to find a job in her early 20s, she truly believed that things would work themselv… | 0.6847 | 0.0420 / 0.6426 / 0.0000 | depth | **yes** |
| 13 | `2810ae3a…:2` | `2810ae3a…` | link/youtube/linkCard | Alan Watts - Acceptance of Death | 0.6689 | 0.6689 / 0.0000 / 0.0000 | breadth | no |
| 14 | `a428492a…:21` | `a428492a…` | link/tweet/linkCard | Frankl's inverse law: "When a man can't find pleasure, he distracts himself with meaning." The examined life isn't alway… | 0.5678 | 0.5678 / 0.0000 / 0.0000 | breadth | no |
| 15 | `8a8d45a9…:21` | `8a8d45a9…` | link/tweet/linkCard | Robert Downey Jr. visiting Wall Street for a documentary in the early ’90s and openly criticizing the culture there feel… | 0.5354 | 0.0360 / 0.4994 / 0.0000 | depth | **yes** |
| 16 | `b3c1473b…:18` | `b3c1473b…` | link/tweet/linkCard | “We will have a crash, I just can't tell you when, and I can't tell you how deep. But I can assure you, unfortunately, I… | 0.4511 | 0.1025 / 0.3486 / 0.0000 | depth | **yes** |
| 17 | `a428492a…:3` | `a428492a…` | image/imageCard | Hate_Room_08.03.2022_MidJourney | 0.2038 | 0.0000 / 0.2038 / 0.0000 | depth | **yes** |
| 18 | `a428492a…:7` | `a428492a…` | link/tweet/linkCard | life shrinks or expands according to one's courage. https://t.co/OTuZuIRSug pic.twitter.com/1YSPtfARti— gomi (@parveen__… | 0.1571 | 0.1571 / 0.0000 / 0.0000 | breadth | no |
| 19 | `8a8d45a9…:11` | `8a8d45a9…` | link/tweet/linkCard | She describes what humanity is experiencing right now. pic.twitter.com/YVfMraJzcf— King Arthur Fan (@brandilwells) April… | 0.1534 | 0.1534 / 0.0000 / 0.0000 | breadth | no |
| 20 | `a428492a…:25` | `a428492a…` | link/youtube/linkCard | America Is NOT The Greatest Country Anymore! - Jeff Daniels/HBO Newsroom [edited/clean version] | 0.0869 | 0.0869 / 0.0000 / 0.0000 | breadth | no |
| 21 | `04c9c895…:2` | `04c9c895…` | link/tweet/linkCard | Sergey Brin said retiring in January 2020 was the “worst decision”. He planned to sit at cafes and read about physics al… | 0.0601 | 0.0000 / 0.0000 / 0.0601 | recency | no |

`unclustered_attended` count: **21** of 36 singletons; voice-dominated among them: 11. Class totals over the whole node set now: breadth 24.3625, depth 20.5140, recency 0.3813.


### S4.1 — content fields available across the 71 nodes

| field | non-null / non-empty of 71 | by type (link/tweet/linkCard, link/youtube/linkCard, image/imageCard) | median length (chars) |
|---|---:|---|---:|
| `nodes.title` | **71** | link/tweet/linkCard: 56/56; link/youtube/linkCard: 13/13; image/imageCard: 2/2 | 11 |
| `nodes.url` | **69** | link/tweet/linkCard: 56/56; link/youtube/linkCard: 13/13; image/imageCard: 0/2 | 56 |
| `nodes.source` | **69** | link/tweet/linkCard: 56/56; link/youtube/linkCard: 13/13; image/imageCard: 0/2 | 5 |
| `nodes.text_content` | **0** | link/tweet/linkCard: 0/56; link/youtube/linkCard: 0/13; image/imageCard: 0/2 | 0 |
| `nodes.description` | **56** | link/tweet/linkCard: 56/56; link/youtube/linkCard: 0/13; image/imageCard: 0/2 | 282 |
| `nodes.image_url` | **42** | link/tweet/linkCard: 27/56; link/youtube/linkCard: 13/13; image/imageCard: 2/2 | 79 |
| `nodes.created_at` | **71** | link/tweet/linkCard: 56/56; link/youtube/linkCard: 13/13; image/imageCard: 2/2 | 32 |
| `weave_embeddings.content_summary` | **71** | link/tweet/linkCard: 56/56; link/youtube/linkCard: 13/13; image/imageCard: 2/2 | 923 |
| `weave_embeddings.node_type` | **71** | link/tweet/linkCard: 56/56; link/youtube/linkCard: 13/13; image/imageCard: 2/2 | 8 |
| `weave_embeddings.created_at` | **71** | link/tweet/linkCard: 56/56; link/youtube/linkCard: 13/13; image/imageCard: 2/2 | 32 |
| `data.title` | **69** | link/tweet/linkCard: 56/56; link/youtube/linkCard: 13/13; image/imageCard: 0/2 | 11 |
| `data.description` | **56** | link/tweet/linkCard: 56/56; link/youtube/linkCard: 0/13; image/imageCard: 0/2 | 282 |
| `data.url` | **69** | link/tweet/linkCard: 56/56; link/youtube/linkCard: 13/13; image/imageCard: 0/2 | 56 |
| `data.domain` | **69** | link/tweet/linkCard: 56/56; link/youtube/linkCard: 13/13; image/imageCard: 0/2 | 5 |
| `data.authorName` | **69** | link/tweet/linkCard: 56/56; link/youtube/linkCard: 13/13; image/imageCard: 0/2 | 10 |
| `data.authorHandle` | **56** | link/tweet/linkCard: 56/56; link/youtube/linkCard: 0/13; image/imageCard: 0/2 | 13 |
| `data.tweetText` | **56** | link/tweet/linkCard: 56/56; link/youtube/linkCard: 0/13; image/imageCard: 0/2 | 282 |
| `data.transcript` | **33** | link/tweet/linkCard: 20/56; link/youtube/linkCard: 13/13; image/imageCard: 0/2 | 1190 |
| `data.contentDescription` | **26** | link/tweet/linkCard: 13/56; link/youtube/linkCard: 13/13; image/imageCard: 0/2 | 671 |
| `data.media_analysis` | **12** | link/tweet/linkCard: 12/56; link/youtube/linkCard: 0/13; image/imageCard: 0/2 | 923 |
| `data.imageUrl` | **40** | link/tweet/linkCard: 27/56; link/youtube/linkCard: 13/13; image/imageCard: 0/2 | 495 |
| `data.embedHtml` | **56** | link/tweet/linkCard: 56/56; link/youtube/linkCard: 0/13; image/imageCard: 0/2 | 489 |
| `data.type` | **69** | link/tweet/linkCard: 56/56; link/youtube/linkCard: 13/13; image/imageCard: 0/2 | 7 |

Node types in the set: link/tweet/linkCard 56, link/youtube/linkCard 13, image/imageCard 2 (sum 71).

OCR text: no field named ocr/ocrText exists on nodes or in data keys (data-key histogram above). "Analysis" = data.media_analysis (12) and data.contentDescription (26).

### S4.2 — reading the field table

- Every node has `weave_embeddings.content_summary` (71/71, median 923 chars) — the field stage 2a
  already consumes — and a `nodes.title`; **for tweets `nodes.title` is the author's display name**,
  and the content is `data.tweetText` (56/56, median 282), which also appears verbatim in
  `nodes.description`/`data.description`.
- Transcripts exist for 33/71 (13/13 YouTube, 20/56 tweets with video); `contentDescription` (the
  Gemini media description, PR-2 sweep) for 26/71; `media_analysis` for 12 tweets.
- `nodes.text_content` is empty on all 71 (no text cards in this set). Two image cards have only a
  file-name title, an `image_url`, and a `content_summary`.
- Author/source: `data.authorName` 69/71, `data.authorHandle` 56/71 (tweets), `nodes.source` /
  `data.domain` 69/71 (`x.com`, `youtube.com`); `nodes.url` 69/71.
- Dates: `nodes.created_at` and `weave_embeddings.created_at` on 71/71.
- **No OCR field exists** anywhere on `nodes` or in `nodes.data`.

---

## 5. Contradicts the dispatch

- **Route.** The dispatch offered "direct Anthropic SDK from Netlify, or via Fly `/api/claude`"; it
  is neither an SDK nor Fly — a raw `fetch` to `https://api.anthropic.com/v1/messages` from the
  Netlify function with the function's own `ANTHROPIC_API_KEY`.
- **"Stage 2" is two functions**, themes then narrative, with a hard 400 gate between them; a
  prompt v2 that replaces "the narrative prompt" alone still runs behind the theme prompt unless
  R3b changes the wiring.
- **OCR text** does not exist as a field; the dispatch's S4 list included it.
- **Titles for tweets are author display names**, not content; the "title / first 120 chars" column
  therefore shows `data.tweetText` for tweets and says so.
- **`nodes.title` vs `data.title`**: identical on 69/71; the two image cards have `nodes.title` only.
- **Standalone scripts drift**: `scripts/run-themes.mjs` / `run-narrative.mjs` pin `claude-opus-4-6`
  while the functions pin `claude-opus-4-7`. Not a finding for this read; recorded.
- **Reproduction bound.** To reproduce a past run from a later export the harness must bound events
  at `≤ generated_at`; the pipeline has no such bound and needs none.

## 6. Query map

| id | measures | where |
|---|---|---|
| `P2`–`P5` | role, RLS visibility, QA marker, grants | §0 |
| `T-snap` | snapshot inventory with `has_narrative`, cluster count, version | §0 |
| `X-events` | five read types, all-time export | S2/S3 |
| `X-emb` | all `weave_embeddings` with `archived_at` | S2/S3 |
| `X-voice` | real ∧ ended ∧ anchored sessions with anchor hop and `user_turns` | S2/S3 |
| `X-nodes71` | 71-node content join (above) | S2, S4 |
| `K-hist` | `nodes.data` key histogram over the 71 | S4 |
| script A | `r3a-harness.ts` — real modules over exports at a given `generated_at`, uniform on/off, optional `≤ generated_at` bound | S2, S3 |
| script B | `analyze.mjs` — tables above | S2–S4 |

## Appendix A — `r3a-harness.ts` (throwaway)

```ts
// R3a throwaway harness: attribute engagement over run 1's node set with the REAL pure modules.
//   node r3a-harness.mjs <dir> <generated_at ISO> <uniform true|false> <upperBound true|false> <outfile>
// upperBound=true restricts events/voice to occurred_at <= generated_at (reproduces a past run exactly).
import { readFileSync, writeFileSync } from 'node:fs'
import { BREADTH_HORIZON_DAYS, DEPTH_HORIZON_DAYS, MS_PER_DAY } from '/Users/danielriaz/Projects/Weave/netlify/lib/snapshot/constants'
import { attribute, buildWeightMap, fromVoiceSession, fromWeaveEvent, resolveEvents } from '/Users/danielriaz/Projects/Weave/netlify/lib/snapshot/engagement'
import { EVENT_TYPES_READ } from '/Users/danielriaz/Projects/Weave/netlify/lib/snapshot/reads'

const [D, atIso, uniformArg, upperArg, outfile] = process.argv.slice(2)
const generatedAt = new Date(atIso)
const uniform = uniformArg === 'true'
const upper = upperArg === 'true'
const meta = JSON.parse(readFileSync(`${D}/run1-meta.json`, 'utf8'))
const clusters = JSON.parse(readFileSync(`${D}/run1-clusters.json`, 'utf8'))
const events = JSON.parse(readFileSync(`${D}/events.json`, 'utf8'))
const embeddings = JSON.parse(readFileSync(`${D}/embeddings.json`, 'utf8'))
const voice = JSON.parse(readFileSync(`${D}/voice.json`, 'utf8'))

const nodeKeys: string[] = meta.node_set.keys
const bf = new Date(generatedAt.getTime() - BREADTH_HORIZON_DAYS * MS_PER_DAY)
const df = new Date(generatedAt.getTime() - DEPTH_HORIZON_DAYS * MS_PER_DAY)
const inWin = (t: string, from: Date) => { const d = new Date(t); return d >= from && (!upper || d <= generatedAt) }
const we = events.filter((e: any) => EVENT_TYPES_READ.includes(e.event_type) && inWin(e.timestamp, bf))
const wv = voice.filter((v: any) => inWin(v.ended_at, df))
const map = buildWeightMap(embeddings, nodeKeys)
const ev = [...we.map(fromWeaveEvent), ...wv.map((v: any) => fromVoiceSession({ session_id: v.session_id, anchor_edge_id: v.anchor_edge_id, ended_at: v.ended_at, user_turns: Number(v.user_turns), anchor_target: v.anchor_target, board_id: v.board_id }))]
const { resolved } = resolveEvents(ev, { uniformWeights: uniform })
const out = attribute(resolved, map, generatedAt)

const clustered = new Set(clusters.flatMap((c: any) => c.member_node_ids))
const perKey = (k: string) => ({
  key: k,
  board_id: k.split(':')[0],
  w_total: out.weights[k] ?? 0,
  by_class: out.byClass[k] ?? { breadth: 0, depth: 0, recency: 0 },
  top_events: [...(out.contributions[k] ?? [])].sort((a, b) => b.w_eff - a.w_eff).slice(0, 5),
  n_events: (out.contributions[k] ?? []).length,
})
const result = {
  generated_at: generatedAt.toISOString(), uniform, upper_bound: upper,
  events_in_window: we.length, voice_in_window: wv.length,
  attribution: out.attribution,
  clusters: clusters.map((c: any) => ({
    cluster_id: c.cluster_id, size: c.size, boards_touched: c.boards_touched,
    stored_anchor_node_ids: c.anchor_node_ids, stored_engagement_weight: c.engagement_weight,
    members: c.member_node_ids.map(perKey).sort((a: any, b: any) => b.w_total - a.w_total),
  })),
  singletons: nodeKeys.filter((k) => !clustered.has(k)).map(perKey).sort((a, b) => b.w_total - a.w_total),
}
writeFileSync(`${D}/${outfile}`, JSON.stringify(result, null, 1))
console.log(`wrote ${outfile}: events_in_window=${we.length} voice=${wv.length} resolved=${out.attribution.resolved} hit=${out.attribution.hit} clustered=${clustered.size} singletons=${result.singletons.length}`)

```

## Appendix B — `nodes.data` key histogram (RO)

```sql
with keys as (select split_part(k,':',1) as board_id, split_part(k,':',2) as node_id from weave_profile_snapshots, jsonb_array_elements_text(generation_metadata->'node_set'->'keys') k where id='253c9a8c-…'),
n as (select n.* from keys k join nodes n on n.board_id::text = k.board_id and coalesce(n.data->>'_clientNodeId', n.id::text) = k.node_id)
select kk, count(*), count(*) filter (where jsonb_typeof(n.data->kk) = 'string' and length(n.data->>kk) > 0) as non_empty_string
from n, jsonb_object_keys(n.data) kk group by 1 order by 2 desc, 1;
-- _clientNodeId 71/71 | _clientNodeType 71/71 | position 71 (object) | authorName 69/69 | description 69/56 | domain 69/69 | imageUrl 69/40
-- loading 69/0 | title 69/69 | type 69/69 | url 69/69 | authorHandle 56/56 | embedHtml 56/56 | tweetText 56/56 | imageMimeType 47/47
-- processing_log 43/0 | transcript 33/33 | contentDescription 26/26 | media_analysis 12/12 | fileName 2/2 | label 2/2 | test_patch 1/0
```
