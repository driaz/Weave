# Pre-Composition Gate Reads — Issue #2, pre-PR-1 (READ-ONLY)

**Date:** 2026-07-21
**Prod queries:** role `weave_readonly` @ `aws-1-us-east-2.pooler.supabase.com`, db `postgres` (Weave prod), via `WEAVE_PROD_RO_DATABASE_URL`. SELECTs only; the only write anywhere is this doc.
**Companions:** `docs/embedding-coverage-probe.md`, `docs/delete-path-and-embed-call-read.md` (same-day and prior reads).
**Scan mode:** full scans of the relevant prod populations (52 tweets, 11 YouTube nodes, all snapshots); the processing-log analyses are complete over *logged* nodes but the pre-logging era is unclassifiable — flagged inline wherever it matters.

---

## 1. Read 1 — snapshot and theme consumers of `weave_embeddings`

### 1.1 `generate-profile-snapshot.ts` — **vectors only; summaries fetched but never consumed**

The function's entire use of embedding rows is similarity math feeding agglomerative clustering. Consumption sites:

```ts
// netlify/functions/generate-profile-snapshot.ts:164-175
function cosineSimilarity(a: number[], b: number[]): number { … }

// :224-228 — pairwise similarity matrix inside agglomerativeClustering
const s = cosineSimilarity(nodes[i].embedding, nodes[j].embedding)

// :457 — the only clustering call
const rawClusters = agglomerativeClustering(nodes, CLUSTER_SIMILARITY_THRESHOLD)
```

`content_summary` **is** selected (:348) and carried onto `NodeEntry.contentSummary` (:375) — and then never read again anywhere in the file. There is no LLM call in this function; `theme_description` is written as the empty string (:499, "Filled by later pipeline step"). So for this consumer, summary length is irrelevant; only the *vector* matters.

### 1.2 `extract-snapshot-themes.ts` — **summary text fed verbatim into a Claude prompt, one call per cluster, no truncation**

```ts
// netlify/functions/extract-snapshot-themes.ts:114-125 (buildUserPrompt)
for (const key of cluster.member_node_ids) {
  const entry = contentLookup.get(key)
  const prefix = anchorSet.has(key) ? '★ ' : ''
  …
  if (summary && summary.trim().length > 0) {
    lines.push(`${prefix}[${nodeType}] ${summary}`)      // full summary, uncapped
  } else {
    lines.push(`${prefix}[${nodeType}] (visual content — no text description available)`)
  }
}

// :252-258 — one Claude call per cluster
for (const cluster of clusters) {
  const userPrompt = buildUserPrompt(cluster, contentLookup)
  …
  const result = await callClaude(anthropicKey, SYSTEM_PROMPT, userPrompt)
```

Model `claude-opus-4-7`, `max_tokens: 1024` (:12-14). **No truncation is applied to any summary anywhere in the file** — each member node contributes its complete `content_summary` to its cluster's prompt. The function's own config comment plans for "17 sequential Claude calls" (:332).

**Rows per run:** every member node of every non-singleton cluster appears exactly once (in its cluster's prompt). Upper bound = all active embedding rows in scope. Current prod actuals (measured): 58 active rows, whose summaries total **42,538 chars (~10–11k tokens) across all clusters combined**; per-cluster prompts are slices of that.

**Dormancy observation:** prod has exactly **one** `weave_profile_snapshots` row — `trigger_reason = 'fixture'`, `clusters` NULL, dated 2026-04-17. The clustering/themes pipeline has never produced a real prod run; `extract-snapshot-themes` would 400 on the existing row ("No clusters to extract themes from", :195-199).

### 1.3 What uncapping does to this prompt (arithmetic on measured sums — interpretation-adjacent, flagged)

Measured JSONB totals over the same 58 active-embedded nodes: transcripts 91,644 chars + contentDescription 4,666 + media_analysis 10,514 + tweetText 11,233 ≈ **118k chars (~30k tokens)** if summaries were rebuilt fully uncapped from JSONB. That is a ~2.8× char inflation over today's 42.5k total — trivially affordable for a per-cluster Opus call at current board sizes, but the single-cluster worst case scales with the largest cluster's YouTube membership (one 20,650-char transcript already dominates today's biggest node).

## 2. Read 2 — transcript-race rate (prod `processing_log`)

Population: 52 tweet nodes; **25 carry a `processing_log`** (logging shipped mid-corpus; the other 27 predate it and are unclassifiable — 10 of the 17 transcripts in prod sit on unlogged nodes). All 25 logged tweets have exactly one `enrich.complete` entry, and **all 25 show `mediaTriggered: true`**.

Classification of the 25, cross-referenced against current JSONB:

| At the 8s mark | Now holds transcript | Count | Reading |
|---|---|---|---|
| `transcriptLen: 0` | **yes** | **6** | **race positives — embed fired without a transcript that later arrived** |
| `transcriptLen: 0` | no | 18 | transcript never arrived at all (13 logged `success` via tweet image, 5 `degraded`) |
| `transcriptLen: 28` | yes (28) | 1 | the only time a transcript beat the timer — and it was 28 chars |

**Lifetime race rate among logged tweets where a transcript ever materialized: 6 of 7 (86%) embedded without it.** The verbatim entries for the six positives (current transcript length prefixed):

```
matrixbot     tr_now=339   {"ts":"2026-05-18T05:55:11.602Z","phase":"enrich.complete","detail":{"kind":"twitter","hasTranscript":false,"hasTweetImage":true,"transcriptLen":0,"mediaTriggered":true,"transcriptField":"transcript"},"source":"client","outcome":"success","durationMs":8002}
Modern Dad    tr_now=760   {"ts":"2026-05-09T03:48:26.932Z", … "transcriptLen":0,"mediaTriggered":true … "outcome":"success","durationMs":8001}
cinesthetic.  tr_now=281   {"ts":"2026-05-16T07:54:55.881Z", … "transcriptLen":0,"mediaTriggered":true … "outcome":"success","durationMs":8002}
James Lucas   tr_now=28    {"ts":"2026-05-11T18:40:12.771Z", … "transcriptLen":0,"mediaTriggered":true … "outcome":"success","durationMs":8055}
60 Minutes    tr_now=1098  {"ts":"2026-05-25T04:42:43.730Z", … "transcriptLen":0,"hasTweetImage":false … "outcome":"degraded","durationMs":8002}
Clash Report  tr_now=1368  {"ts":"2026-05-24T02:15:46.724Z", … "transcriptLen":0,"hasTweetImage":false … "outcome":"degraded","durationMs":8522}
```

(Elided fields are byte-identical to the first entry's shape; full JSON retrieved verbatim from prod.) The single timer-beat, for contrast:

```
James Lucas   tr_now=28    {"ts":"2026-05-11T18:46:21.617Z", … "hasTranscript":true,"transcriptLen":28 … "outcome":"success","durationMs":8688}
```

Note the pair: the *same* James Lucas tweet was dropped twice, six minutes apart — one drop lost the race, the other won it, with a 28-char transcript either way.

Caveats stated loudly: (i) the 27 unlogged tweets are absent from every number above — this is the logged-era rate, not the true lifetime rate; (ii) the tweet `outcome` field encodes *image-or-transcript* success ([linkEnrichment.ts:100](../src/services/linkEnrichment.ts)), so `outcome: success` does **not** mean the transcript made it — `transcriptLen` is the race signal.

**YouTube, for contrast (relevant to the timer design): 6 of 6 logged YouTube nodes had `hasTranscript: true` at the 8s mark** (transcriptLen 504–19,129 — full entries in §3.3). The 8s race is empirically a *tweet* problem, not a YouTube problem (Supadata returns inside the window in every logged case). *(Corrected in the follow-up samples read: tweet transcripts also come from Supadata — via the client's independent async fetch ([linkEnrichment.ts:65-70](../src/services/linkEnrichment.ts)), which is simply slower/spottier for native Twitter video; the Fly pipeline fetches its own Supadata copy for embed text but never patches `transcript` into JSONB.)*

## 3. Read 3 — `contentDescription` provenance

### 3.1 Generation trace: transcript-text-dependent (Supadata), zero video-byte dependency

The chain, all client-orchestrated at ingest ([src/services/linkEnrichment.ts:109-163](../src/services/linkEnrichment.ts)):

1. `fetchTranscript(url)` → Netlify [youtube-transcript.ts](../netlify/functions/youtube-transcript.ts), which calls `https://api.supadata.ai/v1/transcript?…` (:31). Text API — no download.
2. On non-empty transcript: `patchNodeData({ transcript })`, then

```ts
// linkEnrichment.ts:131-141
const description = await fetchContentDescription({
  title: metadata.title,
  channel: metadata.authorName ?? null,
  transcript,
})
if (description) {
  patchNodeData({ contentDescription: description })
```

3. `fetchContentDescription` POSTs to Netlify [generate-content-description.ts](../netlify/functions/generate-content-description.ts) (:49 `generateYouTubeDescription(...)`), whose generator is [netlify/lib/youtubeDescription.ts](../netlify/lib/youtubeDescription.ts): **Claude `claude-sonnet-4-6`**, `max_tokens: 400` (:13-14), prompt = title + channel + transcript sliced at its own `TRANSCRIPT_CHAR_LIMIT = 3000` (:16, :29-33 — a **third independent 3,000-char constant**, after the client embed path's and the media-server's) + optional `tonalContext`.

**Failure branches, quoted:**

```ts
// linkEnrichment.ts:116-118 — no transcript ⇒ generation never attempted
if (!transcript) {
  logger?.debug('enrich.transcript', 'degraded', { field: 'transcript', reason: 'empty' })
  return
}

// linkEnrichment.ts:175-179 (contract comment)
// Mirrors fetchTranscript's never-throws contract: any failure (network,
// missing API key on the server, Sonnet error) returns empty string and
// the caller continues.
```

**Video download failing is irrelevant to this field** — no step above touches video/audio bytes, yt-dlp, or ffmpeg. Those live exclusively in the Fly media-server pipeline (`downloadVideo`/`analyzeMedia`, [media-server/src/process.ts](../media-server/src/process.ts)), which for YouTube produces `media_analysis` and the multimodal *embedding* — never `contentDescription`. A backfill pass ([netlify/functions/backfill-youtube-descriptions.ts](../netlify/functions/backfill-youtube-descriptions.ts)) uses the **same generator** for pre-feature nodes, optionally folding an existing `media_analysis` in as `tonalContext` (:39-48).

### 3.2 Distinction from tweet `media_analysis` — different everything

| | YouTube `contentDescription` | Tweet `media_analysis` |
|---|---|---|
| Generator | `netlify/lib/youtubeDescription.ts` | `analyzeMedia` in the Fly media-server |
| Model | Claude `claude-sonnet-4-6` | Gemini (multimodal, over downloaded bytes) |
| Input | Supadata transcript text (≤3,000 chars) + title/channel | Downloaded video/audio bytes (yt-dlp/ffmpeg) |
| Prompt | "Summarize this video in 2-3 sentences… core argument, thesis" | media-server analysis prompt (tone/composition register — see probe doc §5c samples) |
| Written by | client `patchNodeData` (or backfill UPDATE) | media-server `patchNodeData` RPC |

Same JSONB blob, entirely disjoint machinery.

### 3.3 Prod: the 11 YouTube nodes

| Created | Title (trunc) | transcript | contentDescription | log? | Persisted log phases |
|---|---|---|---|---|---|
| 2026-04-28 | True Detective - World Needs Bad Men | 3,587 | 717 | no | — |
| 2026-04-29 | The Silent Revolution And The Great Re… | 20,650 | 654 | no | — |
| 2026-04-29 | Is Ignorance Really Bliss? | 18,755 | 411 | no | — |
| 2026-04-29 | Do reasons for living eventually run o… | 8,327 | 523 | no | — |
| 2026-04-30 | Columbus Trailer #1 (2017) | 989 | 358 | no | — |
| 2026-05-01 | America Is NOT The Greatest Country… | 3,149 | 616 | yes | enrich.complete:success, **embed.client:skipped** |
| 2026-05-02 | (TRUE DETECTIVE) RUST COHLE - DEVAST… | 2,775 | 632 | yes | enrich.complete:success, **embed.client:skipped** |
| 2026-05-04 | Alan Watts - Acceptance of Death | 2,126 | 543 | yes | enrich.complete:success |
| 2026-05-10 | Where's My Arc \| The Sopranos edit | 504 | 398 | yes | enrich.complete:success, embed.client:success |
| 2026-05-23 | Chris Hedges, Stephen Walt and Ryan Gr… | 19,129 | 524 | yes | enrich.complete:success, embed.client:success |
| 2026-06-19 | Tony Soprano - 'Is This All There Is' | 4,302 | 538 | yes | enrich.complete:success, embed.client:success |

All six logged nodes show `hasTranscript: true` with the full transcript length at the `enrich.complete` mark (durationMs 7,994–8,910). Per-node *description* provenance is not in the logs — `enrich.transcript` / `enrich.description` are `logger.debug` calls, console-only by design ([src/utils/logger.ts:5-6](../src/utils/logger.ts): "debug/info/warn/error — console-only … persist — the entry is appended" via `append_processing_log`). The five unlogged nodes (2026-04-28..30) predate persisted logging; their descriptions came from either ingest or the backfill — indistinguishable from data, identical generator either way.

**Answer to the 11/11 question: independence from yt-dlp entirely.** contentDescription's only external dependency is Supadata; in every logged case Supadata delivered inside the 8s window, and generation is a text→Claude call with a never-throws fallback. The perfect coverage requires neither pipeline heroics nor curation-era survivorship — though note the sample: the within-8s claim rests on the 6 logged nodes; the 5 pre-logging nodes carry no timing evidence.

### 3.4 Bonus: prod logs confirm the `'server'`-precheck pinning mechanism

The two `embed.client:skipped` nodes above are exactly the two archived-only YouTube nodes from the coverage probe. Verbatim:

```
America Is NOT The Greatest Co…  {"ts":"2026-05-01T02:26:31.029Z","phase":"embed.client","detail":{"reason":"server-embedding-exists"},"source":"client","outcome":"skipped"}
(TRUE DETECTIVE) RUST COHLE…     {"ts":"2026-05-02T05:27:29.901Z","phase":"embed.client","detail":{"reason":"server-embedding-exists"},"source":"client","outcome":"skipped"}
```

The delete-path read (§1.4.2 there) predicted from code that the precheck could pin a new card to a predecessor's server-written row; these entries are that mechanism firing in prod, ~100ms after enrichment completed with a good transcript in hand. Both cards have never been client-embedded since.

## 4. Interpretation (quarantined — everything above is code citation and SELECT output)

- **Uncapping summaries is safe for both current consumers.** The snapshot function ignores summary text entirely; the themes function takes full summaries into per-cluster prompts, and even a fully-hydrated corpus (~118k chars total, ~30k tokens across all clusters) is comfortable for one-call-per-cluster Opus usage at present scale. The realistic constraint is per-cluster YouTube density, not the total. And the pipeline is dormant in prod anyway (one fixture snapshot, clusters NULL) — there is no live consumer that a summary-format change could regress today.
- **The 8s timer's cost is concentrated on tweets and is large where it bites:** 6 of the 7 logged tweets that ever got a transcript embedded without it. For YouTube the timer has never been observed to lose (6/6 beat it), because Supadata returns in-window for YouTube while its native-Twitter-video coverage is slower and spottier (see correction in §2 — both surfaces are Supadata; neither is Fly STT). A timer-removal design mainly buys tweet-transcript inclusion; for YouTube it buys margin, not observed wins.
- **contentDescription is the most robust text asset in the system:** Supadata + Claude Sonnet, no media download, never-throws fallbacks, 11/11 coverage across three provenance eras. Composing it into embeds adds no new infrastructure dependency that isn't already load-bearing for the transcript itself.
- The codebase now contains **three independent 3,000-char transcript constants** (client embed path, media-server, description generator). Any composition design should consolidate or at least name them once.

## 5. Open questions

1. The unlogged 27 tweets hold 10 transcripts with no way to classify race vs. post-hoc backfill — does the design need that answer, or is the logged-era rate (6/7 lost) sufficient to justify removing the timer?
2. When the reasoning-layer pipeline is revived, does the themes prompt want *summaries* at all, or should it read hydrated JSONB directly (making `content_summary` a pure retrieval-injection artifact)? The two consumers' needs have diverged.
3. Is Supadata's in-window delivery stable enough to treat as a synchronous dependency for YouTube (await transcript before embed, no timer), or does the 6/6 sample overstate it? (All six are from one account, one region, May–June 2026.)
4. Should the three 3,000-char constants remain independently tunable per surface, or become one shared composition parameter?
