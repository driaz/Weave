# Embedding Coverage Probe — Production (Issue #2, Step 1)

**Date:** 2026-07-21
**Target database:** role `weave_readonly` @ `aws-1-us-east-2.pooler.supabase.com`, db `postgres` (Weave **prod**, project `wndfikmpifyqkgivmnwv`), via `WEAVE_PROD_RO_DATABASE_URL`. Read-only role; every query in this probe was a SELECT.
**Scan mode:** FULL SCAN — all 65 nodes and all 93 embedding rows examined. Nothing sampled; absence claims below are exhaustive over current prod state.

The drafted probe (backlog item 4b) could not be located in the repo, git history (all branches), memory, or session transcripts; per gate resolution it was specified in an uncommitted design session, and this probe was written fresh against real rows (shapes read before queries were finalized).

---

## 1. Population

| Population | Count |
|---|---|
| Boards | 7 |
| Nodes | 65 |
| — linkCard / tweet | 52 |
| — linkCard / youtube | 11 |
| — imageCard | 2 |
| — textCard | **0** |
| — pdfCard | **0** |
| `weave_embeddings` rows | 93 (58 active, 35 archived) |
| — attributable to a current node | 65 (58 active + 7 archived-only) |
| — orphaned (no current node) | 28 |

Prod contains **no textCards and no pdfCards at all.** Two of the four embedding code paths have never run against a real prod node.

**Join-key caveat (affects all attribution here):** `weave_embeddings.node_id` is the client-side React Flow id preserved as `data->>'_clientNodeId'` — a **small integer** (`"2"`, `"3"`, …) unique only *per board* (27 distinct values across 65 nodes). The join used throughout is `(node_id, board_id)`, which is unique across the whole embeddings table (93 distinct pairs = 93 rows), so active-row attribution is sound. **Archived-row attribution is not reliable**: an archived row matching a current node's `(node_id, board_id)` can belong to an earlier card that reused the id. Observed directly: the archived row matching current node "(TRUE DETECTIVE) RUST COHLE" contains content from a different card entirely ("Felsefe Parrhesia — 'Kapitalist sistemde insan…'").

## 2. Observed JSONB shapes (read from real rows before queries were written)

Key inventory per type, with occurrence counts out of the type's population:

**linkCard / tweet (52):** always present — `url, type, title, domain, loading, imageUrl, position, embedHtml, tweetText, authorName, authorHandle, description, _clientNodeId, _clientNodeType`. Partial: `imageMimeType` 43, `processing_log` 25, **`transcript` 17**, **`media_analysis` 12**, `test_patch` 0. The key `youtubeTranscript` (handled in `embeddingService.ts`) appears on **zero** prod rows.

**linkCard / youtube (11):** always present — `url, type, title, domain, loading, imageUrl, position, authorName, description, contentDescription, transcript, _clientNodeId, _clientNodeType`. Partial: `processing_log` 6. Both `transcript` and `contentDescription` are at 11/11.

**imageCard (2):** only `fileName, label, position, _clientNodeId, _clientNodeType` (+ `test_patch` on one). **No transcript, no contentDescription, no image data** — binary fields are stripped at sync (`syncBoard.ts` deletes `imageDataUrl` etc. before the blob goes over the wire).

`media_analysis` is a plain string (Gemini prose about the video/image), not an object. `transcript` and `contentDescription` are top-level string keys — names exactly as assumed in the handoff.

### Length distributions (chars, over rows where the key is present and non-empty)

| Field | Type | n | min | median | max |
|---|---|---|---|---|---|
| `transcript` | youtube | 11 | 504 | 3,587 | 20,650 |
| `transcript` | tweet | 17 | 28 | 760 | 2,520 |
| `contentDescription` | youtube | 11 | 358 | 538 | 717 |
| `contentDescription` | tweet | 0 | — | — | — |
| `media_analysis` | tweet | 12 | 831 | 915 | 1,164 |
| `tweetText` | tweet | 52 | 75 | 278 | 352 |
| `contentDescription` / `transcript` | imageCard | 0 | — | — | — |

## 3. Coverage per board × type

Counts of nodes having each field non-empty in JSONB; `none` = none of transcript / contentDescription / media_analysis (tweets still have `tweetText`; imageCards have only filename/label).

| Board | Type | Total | transcript | contentDescription | media_analysis | none |
|---|---|---|---|---|---|---|
| Abusrdity | tweet | 15 | 6 | 0 | 2 | 9 |
| Abusrdity | youtube | 5 | 5 | 5 | 0 | 0 |
| Death | tweet | 2 | 1 | 0 | 1 | 1 |
| Death | youtube | 1 | 1 | 1 | 0 | 0 |
| Geopolitics | tweet | 2 | 1 | 0 | 2 | 0 |
| Geopolitics | youtube | 1 | 1 | 1 | 0 | 0 |
| Parenting | tweet | 1 | 0 | 0 | 1 | 0 |
| Philosophy and Art | imageCard | 2 | 0 | 0 | 0 | 2 |
| Philosophy and Art | tweet | 12 | 3 | 0 | 2 | 8 |
| Philosophy and Art | youtube | 4 | 4 | 4 | 0 | 0 |
| Relationships | tweet | 7 | 2 | 0 | 3 | 3 |
| Tech and Business | tweet | 13 | 4 | 0 | 1 | 9 |

Totals: youtube 11/11 transcript and 11/11 contentDescription; tweets 17/52 transcript (33%), 12/52 media_analysis (23%), 30/52 neither (58%); imageCards 0/2 everything.

## 4. Embedding presence (secondary read — presence/absence only)

> **Correction (same day, follow-up read):** this section assumes "archived = invisible to retrieval." The delete-path read (`docs/delete-path-and-embed-call-read.md` §1.6) found that `match_retrieval_context` does **not** filter `archived_at` — archived rows with live node ids are still served by voice retrieval. Read "no active vector" below as "invisible to the archived-filtering readers (profile snapshot), still servable by voice retrieval."

- **58/65 nodes have an active embedding row.**
- **7/65 have only archived rows and therefore no active vector at all** (invisible to retrieval regardless of JSONB content):

| Node | Board | Type | JSONB riches lost with the vector |
|---|---|---|---|
| King Arthur Fan | Abusrdity | tweet | transcript 1,304 chars |
| Daniel Ahmad | Abusrdity | tweet | none (tweetText only) |
| 🧬Maxpein🧬 | Philosophy and Art | tweet | none |
| 𝓐𝔂𝓸✯ | Philosophy and Art | tweet | media_analysis 846 chars |
| Pope Leo XIV | Philosophy and Art | tweet | none |
| (TRUE DETECTIVE) RUST COHLE | Abusrdity | youtube | transcript 2,775 + contentDescription |
| America Is NOT The Greatest Country… | Philosophy and Art | youtube | transcript 3,149 + contentDescription |

- **No NULL or empty `content_summary` anywhere in prod** (0/93 rows, active or archived). The dev reference case — 4 server-video rows with empty `content_summary` — has **no prod analogue**.
- 28 embedding rows are orphans (their `(node_id, board_id)` matches no current node) — deleted nodes/boards or earlier generations.

Active `content_summary` length by group: imageCard min 16 / max 35; tweet min 114 / median 370 / max 1,709, with **12 rows at exactly 500** (the media-server `SUMMARY_MAX_CHARS = 500` hard cap, `media-server/src/supabase.ts:40`); youtube min 552 / median 3,051 / max 3,090 (title + domain + transcript truncated at the client path's 3,000-char cap).

## 5. Cross-reference: rescue population vs. truly invisible

### 5a. imageCards — filename-only summary, and JSONB is just as empty (2/2)

Both rows, verbatim and in full:

```
id 75735a1d…  board "Philosophy and Art"
  fileName:        Hate_Room_08.03.2022_MidJourney.png
  label:           Hate_Room_08.03.2022_MidJourney
  content_summary: Hate_Room_08.03.2022_MidJourney.png   (35 chars, active)

id 900e93df…  board "Philosophy and Art"
  fileName:        My bookshelf.jpg
  label:           Bookshelf
  content_summary: My bookshelf.jpg                       (16 chars, active)
```

The handoff expected imageCards to be the worst rescue case; in prod they are instead the **truly invisible** case: the summary is literally the filename, and the JSONB holds no richer text to hydrate from (image bytes are stripped before sync). Whatever the image vector encoded multimodally at embed time, no text trace of the image content exists anywhere in the database.

### 5b. Tweets — transcript in JSONB but absent from the active vector's summary (9 rows + 1 with no vector)

Of the 16 active-embedded tweets holding a transcript, only 7 summaries contain it. The 9 misses split into two mechanisms:

**(i) Pre-transcript embeds — the 8-second timer race, observed in prod (3 rows).** Summary is title + tweetText only; the transcript landed after the embed fired. Verbatim example:

```
"The Driven Man"  (id 7e07b26e…, board Tech and Business)
  content_summary (169 chars, complete):
    The Driven Man — @Thedrivenman — Yale professor perfectly explains childhood
    privilege. pic.twitter.com/TIYW6odaja— The Driven Man (@Thedrivenman) April 23, 2026 — x.com
  transcript in JSONB (2,520 chars, head):
    If I look around this room of Oxford undergraduates, 40% of you were privately
    educated in a country in which 7% of students have private educations. 80% of you…
```

The other two: "Big Brain Philosophy" (transcript 858, summary 144) and "Acyn" (transcript 654, summary 282 — the summary holds the tweet's own text about one Trump clip while the transcript is a different speech entirely). The race mechanism is recorded in prod `processing_log`s on analogous rows: `enrich.complete` with `outcome: "degraded", durationMs: 8003/8438, transcriptLen: 0, mediaTriggered: true`, followed ~1s later by `embed.client` success.

**(ii) 500-cap crowd-out on media-server re-embeds (6 rows).** Summary = title + tweetText + media_analysis truncated to exactly 500 chars; the transcript never fits. Rows: "60 Minutes" (tr 1,098), "Modern Dad" (tr 760), "matrixbot" (tr 339), "cinesthetic." (tr 281), "James Lucas" ×2 (tr 28 — trivial rescue value).

Additionally **"King Arthur Fan"** (transcript 1,304) has no active vector at all (§4).

### 5c. Tweets — media_analysis truncated by the 500 cap (11 of 11 active rows)

Every active 500-cap row truncates its analysis mid-sentence: analyses run 831–1,164 chars, and title + tweetText alone consume 100–450, leaving well under half the analysis inside the vector's text. Verbatim example (truncation point shown exactly as stored):

```
"Modern Dad"  (id 6febc310…)
  content_summary ends: …The audio features a resonant, grave     [cut at 500]
  media_analysis in JSONB: 1,109 chars, complete
```

### 5d. YouTube — contentDescription exists on 11/11 nodes and appears in 0/11 summaries

All 11 youtube summaries are `title — domain — transcript[:3000]`. The 358–717-char curated `contentDescription` (a dense editorial summary, e.g. *"Many adults appear trapped in lives they experience as burdens — exhausted, joyless…"*) is present on every youtube node and referenced by no summary; the client embed path (`embeddingService.ts` linkCard branch) never reads it. Transcripts also exceed the 3,000-char cap on 7/11 nodes (median 3,587, max 20,650), so median ~600 and up to ~17,600 chars of transcript per node sit beyond what the summary retained. (Presence/absence read only — what the *vector* encoded is unrecoverable without provenance logging.)

### 5e. Reverse anomaly — vector richer than JSONB (1 row)

```
"Camus"  (id a214682b…, board Relationships)
  active content_summary (500 chars) contains media-analysis prose:
    …The speaker utilizes a measured, deliberate cadence, punctuating his cynicism…
  JSONB keys: NO media_analysis. processing_log shows only the client's degraded
  enrich (8,438 ms, transcriptLen 0) + client embed — no media-server patch entry.
```

The media-server re-embedded this node (500-cap summary) but its `media_analysis` patch to the node JSONB never landed. The analysis text survives *only* inside `content_summary`. Hydration-from-JSONB would lose it.

### 5f. Truly invisible in text — image-meme tweets

Among the 30 tweets with no transcript and no media_analysis, some have a `tweetText` that is only a `pic.twitter.com` link + attribution, i.e. zero semantic content. Verbatim:

```
"philosophy memes 🔗": philosophy memes 🔗 — @philosophymeme0 —
    pic.twitter.com/Bpd12mLIbY— philosophy memes 🔗 (@philosophymeme0) June 14, 2026 — x.com
"𐙚⋆": 𐙚⋆ — @voidwithverses — — Fyodor Dostoevsky
    pic.twitter.com/vF0FwNMj9L— 𐙚⋆ (@voidwithverses) April 29, 2026 — x.com
```

These are prod's real "truly invisible" class alongside the two imageCards: the content is entirely in an image nothing analyzed, and JSONB holds no rescue text. **Not counted precisely** — separating "semantically empty" from "short but meaningful" tweetText requires a judgment call outside this probe's brief (see open questions).

## 6. Interpretation (clearly labeled as such — everything above is raw observation)

- **The rescue population is real but its center of mass is not where the handoff guessed.** imageCards (the presumed worst case) have nothing to rescue — they are truly invisible in text. The substantial rescue populations are: (a) all 11 youtube nodes, whose 358–717-char `contentDescription` is never read and whose transcripts overflow the 3k cap; (b) ~9 tweets whose transcripts (281–2,520 chars) are absent from their vectors' text; (c) all 11 active media-analysis tweets, whose analyses are cut roughly in half by the 500 cap.
- **Both known write-path defects left fingerprints in prod data:** the 8s timer race (3 pre-transcript embeds, plus `processing_log` entries showing the 8,00x ms degraded enrich) and the 500-char media-server cap (12 exactly-500 summaries).
- **The 7 archived-only nodes are arguably the sharpest hole:** they have no vector at all, and 4 of the 7 carry rich JSONB (two youtube transcripts ~3k, one 1.3k tweet transcript, one 846-char analysis). Why they were archived without replacement was not investigated (out of scope).
- **Volumes are tiny.** 65 nodes total. Any fix — hydration at assembly, re-embedding, or both — is cheap at this scale; design can optimize for correctness over throughput.

## 7. Open questions (questions, not provisional answers)

1. How many of the 30 plain tweets are semantically empty image-memes (§5f)? Needs an agreed classification rule for "tweetText carries no content."
2. Why do 7 nodes have only archived embedding rows — what archives a row without writing a successor?
3. Do the 28 orphaned embedding rows matter (retrieval joins through current nodes, so presumably inert), and should they be reaped?
4. The client-id reuse problem (§1): is `(node_id, board_id)` collision across node generations only an attribution nuisance for this probe, or can retrieval itself resurrect a stale vector under a reused id? (The RUST COHLE archived row shows generations do collide.)
5. Should the Camus anomaly (§5e — vector richer than JSONB) be treated as a one-off patch failure or a recurring media-server write-path gap? One row cannot distinguish these.
