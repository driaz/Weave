# Session record — 2026-09-06/07 — R3b: Decision A/B, provenance additions, prompt v2, stage-2 wiring

> Provenance note: written at the close of the sitting, from the transcript.
> Dev only: no prod connection of any kind, RO included. No Anthropic calls;
> the REST path is not exercised by tests. No schema change; every addition is
> JSONB-additive. No emitter, clustering, weight, clock, horizon or Reflect
> change.
>
> Dispatch: "R3b — Build: Decision A/B, metadata additions, prompt v2, t1
> runbook", issued 2026-09-06 with the companion `prompt-v2-draft.md`. Fourth
> and last revival dispatch. PR opened, not merged; t1 is Daniel's to run after
> merge and deploy, with `docs/reads/t1.md` as a follow-on read.

## What shipped (branch `feat/snapshot-r3b-prompt-v2`)

**Stage 1** (`netlify/lib/snapshot`, handler):
- `attention.ts` — `attentionFor(by_class)` (dwelt / discussed / added; ties → dwelt)
  and `turnsFor(contributions)`.
- `generate.ts` — Decision A (anchors require `w_total > 0`, top
  `min(ANCHOR_COUNT, size)`, a cluster may have none); `anchors[].attention`
  (+ `turns` when discussed); Decision B `unclustered_attended[]` (ranked,
  anchor-shaped); `conversations[]` with `placement` from endpoint cluster
  membership and a cardinality assert against the voice read; `boards[]`;
  `top_events[].event_id`. `summary` gains anchor / unclustered / conversation
  counts.
- `reads.ts` — `readBoards` (gated on the id list); `pageAll` / `assertGate`
  exported for stage 2.
- `generate-profile-snapshot.ts` — reads board names for the node set's boards.

**Stage 2** (`netlify/lib/stage2`, both functions):
- `models.mjs` (+ `.d.mts`) — `STAGE2_MODEL = 'claude-opus-4-7'`,
  `TITLE_MODEL = 'claude-sonnet-4-6'`; imported by both functions and by
  `scripts/run-themes.mjs` / `run-narrative.mjs`, which had drifted to
  `'claude-opus-4-6'`.
- `prompts.ts` — `THEME_SYSTEM_PROMPT_V2` and `NARRATIVE_SYSTEM_PROMPT_V2`
  verbatim from the companion §2.1 / §3.1 (diff empty, 2,635 and 3,075 bytes);
  title prompt unchanged; prompt version constants; token caps.
- `content.ts`, `renderTheme.ts`, `renderNarrative.ts` — pure renderers with
  every label and cap named once (`UNCLUSTERED_MIN_W_TOTAL 0.5`,
  `UNCLUSTERED_MAX_ENTRIES 10`, `UNCLUSTERED_SUMMARY_MAX_CHARS 300`,
  `ENDPOINT_TEXT_MAX_CHARS 80`, `BOARD_ID_PREFIX_LEN 8`).
- `reads.ts` — `readNodeContent(keys)`: `weave_embeddings` (live) + `nodes`,
  both paged and count-gated on the identical board predicate.
- `claude.ts` — the shared REST call.
- `extract-snapshot-themes.ts` — theme-v2: anchors first, `★ attention (turns)`,
  author/title, board names; 400 without v2 provenance; records
  `prompt_version_theme`, gates, and the rendered prompts.
- `generate-snapshot-narrative.ts` — narrative-v2: THREADS (size desc, attention
  line from anchors, `engagement_weight` dropped from the prompt), ATTENDED BUT
  UNCLUSTERED (≥ 0.5, ≤ 10), CONVERSATIONS (turns desc, placement words); first
  content read on this function, gated; 400 without themes or v2 provenance;
  records `prompt_version_narrative`, gates, the rendered prompt.

**Tests:** 52 in the netlify suite (18 new: Decision A, attention, Decision B,
placements + cardinality, event_id round-trip; theme c3 fixture exact,
two-board duplicate, no-anchor, singular grammar; narrative exact fixture,
empty sections, wording, admission caps, word-boundary truncation).

## Sequence

1. Prerequisites checked (#45–#48 merged); `main` → `2fff8ee`; branch cut.
2. `npm ci` wiped `node_modules` then failed with `EACCES` renaming into
   `~/.npm/_cacache` (sandbox permission on the shared cache). Re-ran with a
   private cache under the scratchpad; 205 packages restored. Nothing in the
   repo was touched by the failure.
3. Wrote stage 1, the stage-2 library, both functions, script imports, tests.
4. First run: 3 test failures, all on my side (an 80-char truncation my expected
   string omitted; two "singleton" vectors at cosine 0.82; an anchor whose only
   events are `item_added` is `added`, not `dwelt`), and 4 type errors from a
   result union TypeScript cannot narrow on a falsy error string. Fixed; 52/52,
   `tsc` clean, eslint clean.
5. Prompt verification: the sandbox cannot open `~/Desktop`, so a second
   independent transcription of §2.1 and §3.1 was diffed against the landed
   constants — empty, byte lengths equal. Paragraph counts 12 / 16 match the
   companion's line structure.
6. Session record, PR.

## Contradicts the dispatch / companion (also in the PR)

- **Companion §3.2 example vs §1.1 + dispatch §4.** The illustrative line
  `dwelt and discussed (20 turns)` is not producible: attention is one label
  (§1.1; dispatch §2.2 "largest class") and `turns` renders only when
  `discussed` (dispatch §2.2). Implemented per the normative text; the
  Dostoevsky entry renders `dwelt`. Needs ratification if the combined form is
  wanted.
- **Companion §3.2 conversation endpoints** are shown as bare quoted text; the
  dispatch says author + first 80 chars. Implemented `Author: "text…"` for
  tweets, `"title"` for video/image, the key when content is missing.
- **Grammar with count 1.** The ratified grammar has fixed plurals ("pieces",
  "boards", "turns"). Rendered `1 piece / 1 board / 1 turn` by count; tested.
- **Scripts** share the model constant but still carry v1 prompt copies and v1
  rendering; they are not the deployed path. Left as-is and flagged.
- **Other model literals** (`tweetDescription.ts`, `youtubeDescription.ts`,
  `voice-insight.ts`, `summarizeVoiceSession.mjs`) belong to other pipelines;
  untouched.
- **Existing stage-1 rows** (run 1, run 2) lack `boards`, `conversations`,
  `unclustered_attended` and `attention`; both stage-2 functions now return 400
  on them. t1 must be a fresh stage-1 run, as the runbook already says.
- **Judgment calls recorded:** theme members render anchors first (matches the
  companion's c3 example); `conversations[].edge_id` is the connection target
  string (same identity as `top_events[].edge_id`) with `anchor_edge_id` (the
  `edges.id` uuid) alongside; an endpoint outside the node set counts as
  unclustered for placement; the rendered user prompts are stored in
  `generation_metadata` (`theme_user_prompts`, `narrative_user_prompt`) so the
  t1 read can quote what the model saw.

## Not done, by scope

t1 itself (Daniel, after merge + deploy); `docs/reads/t1.md` (follow-on read
PR); the pre-registration doc (planning layer).
