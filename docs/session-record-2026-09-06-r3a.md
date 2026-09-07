# Session record — 2026-09-06 — R3a: stage-2 path and run 1 contents (read-only)

> Provenance note: written 2026-09-06 at the close of the sitting, from the
> transcript and `docs/reads/r3a-stage2-read.md`. Prod figures are quoted from
> that record, which carries the producing queries. No writes, no Anthropic
> calls, no stage-2 execution, no code changes.
>
> Dispatch: "R3a — Read: stage-2 (narrative) path and run 1 contents", issued
> 2026-09-06 from the planning layer; first half of R3. Purpose: give the prompt
> author one real stage-1 output and the exact contract stage 2 already has.

## What shipped

- **`docs/reads/r3a-stage2-read.md`** (PR, not merged): header, P1–P5, S1 with
  both v1 prompts quoted verbatim from source and the trigger/route/input/output
  contract per function, S2 run-1 cluster table (all 35 members, 17 anchors with
  provenance) and the 36 singletons ranked under real weights, S3 Decision-A
  anchors and `unclustered_attended` under real weights today, S4 content-field
  table over the 71 nodes, contradicts-dispatch, query map, harness appendix.
- **This record.**

## Sequence

1. `git fetch origin`; `main` → `f40f580` (PR #47 merged); branch cut; record
   header created before the first query; P1–P5.
2. Read `extract-snapshot-themes.ts`, `generate-snapshot-narrative.ts`, the
   four scripts, `profileSnapshots.ts`, `profileSnapshotStore.ts`,
   `ReflectView.tsx`, `useProfileSnapshot.ts`, `vadController.ts`,
   `buildSystemPrompt.ts`.
3. RO exports: run 1 metadata + clusters; five read types of `weave_events`
   (1,349 all-time); 101 embeddings; 16 real qualifying voice sessions with the
   anchor hop in SQL; the 71 nodes joined `weave_embeddings ⟷ nodes` (71/71
   matched, 0 duplicates); `nodes.data` key histogram.
4. Harness (real pure modules at `f40f580`) three ways. Stop-condition check:
   uniform weights at run 1's `generated_at` with events bounded at
   `≤ generated_at` reproduces every stored anchor per cluster and every anchor
   `w_total` within 1e-9; attribution 186 = 178 + 8 + 0 identical. Then real
   weights at run 1's time (S2) and at T0 `2026-09-06 23:57 UTC` (S3).
5. Tables generated; one presentation fix (tweet titles are author display
   names → show `data.tweetText`); record, this file, PR.

## Headline facts

- **Stage 2 is two functions**, `extract-snapshot-themes` then
  `generate-snapshot-narrative`, both manual (`POST … {snapshot_id}`), both
  calling `https://api.anthropic.com/v1/messages` directly with the function's
  `ANTHROPIC_API_KEY` (not Fly, not an SDK), `claude-opus-4-7`; title on
  `claude-sonnet-4-6`. Narrative 400s unless at least one cluster has a theme.
- **Themes see** `[node_type] content_summary` per member with `★` on anchors,
  plus piece and board counts. **Narrative sees** only `size`, boards count,
  `engagement_weight` and `theme_description` per cluster. Neither sees titles,
  URLs, authors, tweet text, transcripts, provenance, singletons, or `by_class`.
- **Reflect reads** `id, created_at, node_count, clusters, narrative,
  generation_metadata`, newest first, `limit 1`, and discards a null narrative.
  It renders `narrative` paragraphs, `clusters[].theme_description`, counts and
  `generation_metadata.title`. The voice opening turn reads the same
  `narrative` as `recentThinking`.
- **Run 1:** 7 clusters (35 nodes) + 36 singletons = 71 ✅; 17 anchors, 5 at
  `w_total = 0` ✅. Under real weights at run 1's time, 21 of 36 singletons carry
  weight and 15 are at zero; the top singleton (`a428492a…:35`, Dostoevsky
  tweet, 8.616) out-weighs every anchor.
- **t1 today (real weights, Decision A):** 12 anchors (c1 3, c2 3, c3 2, c4 1,
  c5 1, c6 0, c7 2), 4 voice-dominated; `unclustered_attended` 21, of which 11
  voice-dominated. Class totals over the node set: breadth 24.36, depth 20.51,
  recency 0.38.
- **Content available:** `content_summary` 71/71 (median 923 chars),
  `data.tweetText` 56/56 tweets, `data.transcript` 33/71, `contentDescription`
  26/71, `media_analysis` 12/71, author name 69/71, handle 56/71, url/domain
  69/71, `created_at` 71/71. No OCR field exists. `text_content` is empty on all
  71.

## What surprised me

- The narrative model never sees a single piece of content — only 2–4-sentence
  theme descriptions and three numbers per cluster. Everything the prompt author
  might want to reference (anchors, provenance, singletons, class mix) stops at
  stage 2a's `★` glyph.
- Under real weights the depth class is almost as heavy as breadth across the
  whole set, and more than half of the engaged singletons are voice-dominated.
  Uniform weights hid this in R2.
- `nodes.title` on a tweet is the author, not the tweet.

## Contradicts the dispatch (also §5 of the record)

Route is raw REST from Netlify (neither option offered); "stage 2" is two
functions with a gate; OCR text does not exist; tweet titles are author names;
standalone scripts pin a different model than the functions; reproducing a past
run needs an `≤ generated_at` bound the pipeline does not have.

## Not done, by scope

No prompt written or judged; stage 2 not run; Decision A/B not implemented;
no t1.
