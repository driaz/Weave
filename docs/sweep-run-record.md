# Corpus Sweep Run Record — Issue #2, PR-2

**Status: DEV REHEARSAL COMPLETE — prod execution pending Daniel's review.**
This file stays uncommitted until reviewed. The prod section below is a
read-only preview; no prod write has occurred from this session, and the prod
run happens from Daniel's terminal (invocation at the bottom).

**Script:** `scripts/sweep-corpus-embeddings.mjs` (branch `feat/pr2-corpus-sweep`)
**Rehearsal date:** 2026-07-28
**Dev target:** Weave-Dev `bxbhjybahfyeqytwpkry` (service role via local `.env`)
**Prod preview:** role `weave_readonly` via `WEAVE_PROD_RO_DATABASE_URL` — SELECTs only

---

## 1. Preflight gates (all passed)

- Branch `feat/pr2-corpus-sweep` cut from `main` at `148f9a2` (the PR #35 merge).
- `git log` shows both merges: `5e38fc0` (PR #34, PR-1) and `148f9a2` (PR #35, PR-1.1).
  Note: local main was stale at `5e38fc0`; `git pull --ff-only` brought in `148f9a2` first.
- Clean tree before branch cut.
- `npm ci` clean (1,351 packages).

## 2. Fly deploy re-verification

**The primary check came back empty:** prod holds **zero** `media.pipeline`
entries across all 67 nodes' `processing_log`s (only `embed.client` ×34 and
`enrich.complete` ×33 exist). The Todd Spence card that carried the PR-1.1
diagnostic entry was deleted from prod after testing, and no later pipeline
run has persisted an entry. Per the brief, verified via the alternate route:

| Evidence | Value |
|---|---|
| PR #35 merged | 2026-07-25 **03:37:02Z** |
| Fly release v41 | 2026-07-25 **03:38** (60s after merge, by daniel.riaz@gmail.com) |
| Fly release v42 | 2026-07-25 **03:42** — `WEAVE_NETLIFY_FN_URL` secret deployed (a PR-1.1-only concept; status "Deployed" in `fly secrets list`) |
| Running image (both machines) | `weave-media:deployment-01KYBNRXFRFKMYVNT1KVEHG6R8`, digest `sha256:43b262ff296f679721ff82fa66ea458e0e3dd5d6197bc3e5195461e449a13288` |
| Prior release v40 | 2026-07-24 01:33 — matches the PR-1 deploy that produced Todd Spence's prod log |

Verdict: the deployed server is the post-PR-1.1 build; the sweep will not be
overwritten by pre-union compositions. (Direct bundle inspection via
`fly ssh console` was blocked by session permissions; the release-timeline +
secret evidence stands.)

**⚠️ Flag — MeidasTouch missing pipeline entry.** The newest prod card
(dropped 2026-07-25 03:44:59Z, two minutes after v42) logged
`enrich.complete` with `mediaTriggered: true`, then **no `embed.server` and
no `media.pipeline` entry ever landed** — in the current code the catch
block persists a `media.pipeline: failed` entry, so the run died before any
persist (Fly machine auto-stop mid-pipeline, hard crash, or the trigger
never reached the server; one machine shows state `stopped`). This does not
indicate a code regression, but it is a pipeline-reliability question worth
its own look. The card itself is fine for the sweep: its client-side
description-led embed (gen 4, 3,935 chars) is current, and the sweep
re-embeds it from JSONB regardless.

## 3. Script design notes (judgment calls)

- **Camus guard = skip-and-flag fallback**, as sanctioned by the brief. The
  union-rule alternative (treating `content_summary` as an analysis-slot
  source) would splice a mid-sentence 500-cap fragment into an otherwise
  clean composition; judged too fragile.
- **Legacy-reconstruction exception** (added after rehearsal run 1): the
  guard compares lengths, but pre-PR-1 client tweet summaries were
  `authorName — authorHandle — tweetText — domain` and the new text-tweet
  recipe deliberately drops handle+domain (~25 chars of boilerplate). Without
  the exception, every legacy text tweet skipped — which would also have
  blocked reviving archived-only text tweets. The exception allows the write
  only when the existing summary is **byte-identical** to a reconstruction
  from JSONB fields the sweep still holds (nothing unique can be lost).
  These writes are tracked separately (`legacySweeps`) and excluded from
  verification 6 with an explicit count.
- **Log event phase is `embed.sweep`** (source `script`), detail shaped like
  `embed.server`'s with `trigger: 'sweep'` — the `EmbedTrigger` enum value
  PR-1 reserved for this sweep. Budget tripwires persist as `embed.budget`,
  same as the live paths.
- **`node_type` values**: DB columns use short names (`link`/`tweet`); the
  script classifies from the JSONB canonical fields (`_clientNodeType`,
  `data.type`) with a mapped column fallback, and writes `node_type` in the
  client's vocabulary (`linkCard` etc.), matching existing rows.
- **Image-presence signal** for the image-tweet exclusion: `imageMimeType`
  present in JSONB (the base64 is stripped at sync; the mime type survives
  exactly when a tweet image was fetched).

## 4. Dev rehearsal (full three-phase execution ×3)

Dev corpus: 34 nodes, 52 embedding rows (24 orphaned), 7 archived-only
current nodes. Plan: 4 backfill-description / 15 embed-only / 15 excluded.

**Run 1** (initial script): 3/4 descriptions generated+patched (690, 641,
645 chars); 14 nodes swept to gen 1; guard fired 5× — 3 correct catches
(dev YouTube nodes whose JSONB holds neither transcript nor description, so
the 500-cap analysis summaries are genuinely richer: "How to pull yourself…",
RUST COHLE-dev, Tracks Trailer) and 2 boilerplate false-positives
(Francisco Ribeiro 226<246, Words of Wise 217<240) → led to the
legacy-reconstruction exception.

**Run 2** (final guard logic): the two false-positives swept via the
exception ("existing is legacy boilerplate reconstruction — sweeping");
the 3 correct catches still skipped; all prior swept rows advanced gen 1→2
(idempotency demonstrated). "Emotion & Music" description failed both runs —
root-caused to **my rehearsal harness, not the script or function**: the
local `netlify functions:serve` had been launched piped through `head -30`,
so the pipe closed after 30 log lines and SIGPIPE killed the server
mid-rehearsal. The script's downgrade path (log loudly → embed-only,
analysis-led composition, 1,330 chars) behaved exactly per the never-throws
posture.

**Run 3** (server relaunched cleanly): Emotion & Music description generated
(746 chars) and patched; swept description-led at 2,079 chars; **zero
failures, zero budget tripwires**; 16 rows swept (gens 2→3, legacy pair
1→2), 3 guard skips (the correct catches).

**The 4 empty-summary server-video reference rows** (`node_id` 25/21/9/16,
board Test Board 2): all four are **orphans** — their client ids match no
current node — so the sweep's join never touches them. Recorded as expected
behavior (out of scope by the join rule), not "fixed".

### Dev verification results (run 3)

| # | Check | Result |
|---|---|---|
| 1 | Zero current nodes with only-archived rows | **✗ 3 remain — all explained** (below) |
| 2 | Swept-row invariants (archived null / trigger sweep / chars match / gen strictly greater) | ✓ 0 violations over 16 rows |
| 3 | Summary shape (no 500-cap, no 3k artifacts, none over budget; transcript-tail check) | ✓ 0 violations |
| 4 | Excluded rows byte-identical (embedding fingerprint pre/post) | ✓ 0 changed |
| 5 | Spot-checks | dev only holds RUST COHLE (analysis-rich 500-cap summary correctly *preserved* by the guard); prod names absent from dev |
| 6 | Never-worse (3 flagged skips, legacy sweeps excluded) | ✓ 0 violations |

The 3 remaining archived-only current nodes on dev: Tracks Trailer
(camus-guard skip — reviving it would write a poorer summary), Lari
(excluded image tweet), My bookshelf.jpg (excluded imageCard). All three are
the verification surfacing real corpus properties, not script defects —
the same class of result expected in prod (next section).

Artifacts: `tmp/sweep/dev-rehearsal{,-2,-3}/sweep-{plan,results}.json`.

## 5. Prod plan preview (read-only, 2026-07-28)

67 nodes → **17 backfill-description / 21 embed-only / 29 excluded**
(27 image tweets + 2 imageCards). ~17 generator calls + ~38 Gemini embeds —
under the 200-call backfill precedent that saw zero 429s.

<details><summary>Full prod plan table (67 rows, read-only preview — the script re-derives this authoritatively at run time)</summary>

```
       board        |                    title                     |   type    |       gate        |        action        | gen | sum_ch | archived |  tr   |  an  | de  | img
--------------------+----------------------------------------------+-----------+-------------------+----------------------+-----+--------+----------+-------+------+-----+-----
 Abusrdity          | cinesthetic.                                 | twitter   | fusion            | backfill-description |   0 |    500 | f        |   281 |  980 |   0 | t
 Abusrdity          | King Arthur Fan                              | twitter   | compression       | backfill-description |   0 |   1478 | t        |  1304 |    0 |   0 | f
 Abusrdity          | Lola                                         | twitter   | compression       | backfill-description |   0 |   1174 | f        |  1047 |    0 |   0 | t
 Abusrdity          | matrixbot                                    | twitter   | fusion            | backfill-description |   0 |    500 | f        |   339 |  907 |   0 | t
 Abusrdity          | RyanPatrick🇺🇸🦅                              | twitter   | compression       | backfill-description |   0 |   1332 | f        |  1190 |    0 |   0 | t
 Death              | James Lucas                                  | twitter   | fusion            | backfill-description |   0 |    500 | f        |    28 |  895 |   0 | t
 Geopolitics        | BreakThrough News                            | twitter   | fusion            | backfill-description |   0 |    500 | f        |     0 |  848 |   0 | f
 Geopolitics        | Clash Report                                 | twitter   | fusion            | backfill-description |   0 |    500 | f        |  1368 |  831 |   0 | f
 Parenting          | Dubs⛧                                        | twitter   | fusion            | backfill-description |   0 |    500 | f        |     0 | 1164 |   0 | f
 Philosophy and Art | 𝓐𝔂𝓸✯                                         | twitter   | fusion            | backfill-description |   0 |    497 | t        |     0 |  846 |   0 | t
 Philosophy and Art | James Lucas                                  | twitter   | fusion            | backfill-description |   0 |    500 | f        |    28 |  893 |   0 | t
 Relationships      | Camus                                        | twitter   | fusion            | backfill-description |   0 |    500 | f        |     0 | 1020 |   0 | f
 Relationships      | Emir Han                                     | twitter   | fusion            | backfill-description |   0 |    500 | f        |     0 |  923 |   0 | t
 Relationships      | Modern Dad                                   | twitter   | fusion            | backfill-description |   0 |    500 | f        |   760 | 1109 |   0 | t
 Tech and Business  | 60 Minutes                                   | twitter   | fusion            | backfill-description |   0 |    500 | f        |  1098 |  944 |   0 | f
 Tech and Business  | Naruto                                       | twitter   | compression       | backfill-description |   0 |   1709 | f        |  1560 |    0 |   0 | t
 Tech and Business  | The Driven Man                               | twitter   | compression       | backfill-description |   0 |    169 | f        |  2520 |    0 |   0 | t
 Abusrdity          | (TRUE DETECTIVE) RUST COHLE - DEVASTATION    | youtube   | already-described | embed-only           |   0 |    500 | t        |  2775 |    0 | 632 | f
 Abusrdity          | Acyn                                         | twitter   | below-threshold   | embed-only           |   0 |    282 | f        |   654 |    0 |   0 | t
 Abusrdity          | Camus                                        | twitter   | n/a               | embed-only           |   0 |    500 | f        |     0 |    0 |   0 | f
 Abusrdity          | Do reasons for living eventually run out? |  | youtube   | already-described | embed-only           |   0 |   3071 | f        |  8327 |    0 | 523 | f
 Abusrdity          | Is Ignorance Really Bliss?                   | youtube   | already-described | embed-only           |   0 |   3043 | f        | 18755 |    0 | 411 | f
 Abusrdity          | MeidasTouch                                  | twitter   | already-described | embed-only           |   4 |   3935 | f        |  1997 |    0 | 744 | t
 Abusrdity          | New York Magazine                            | twitter   | n/a               | embed-only           |   0 |    383 | f        |     0 |    0 |   0 | f
 Abusrdity          | The Silent Revolution And The Great Resignat | youtube   | already-described | embed-only           |   0 |   3061 | f        | 20650 |    0 | 654 | f
 Abusrdity          | 𝘞𝘩𝘦𝘳𝘦'𝘴 𝘔𝘺 𝘈𝘳𝘤 | 𝘛𝘩𝘦 𝘚𝘰𝘱𝘳𝘢𝘯𝘰𝘴 𝘦𝘥𝘪𝘵           | youtube   | already-described | embed-only           |   0 |    552 | f        |   504 |    0 | 398 | f
 Abusrdity          | 𐙚⋆                                           | twitter   | n/a               | embed-only           |   0 |    114 | f        |     0 |    0 |   0 | f
 Death              | Alan Watts - Acceptance of Death             | youtube   | already-described | embed-only           |   0 |   2172 | f        |  2126 |    0 | 543 | f
 Geopolitics        | Chris Hedges, Stephen Walt and Ryan Grim on  | youtube   | already-described | embed-only           |   0 |   3090 | f        | 19129 |    0 | 524 | f
 Philosophy and Art | America Is NOT The Greatest Country Anymore! | youtube   | already-described | embed-only           |   0 |    500 | t        |  3149 |    0 | 616 | f
 Philosophy and Art | Big Brain Philosophy                         | twitter   | below-threshold   | embed-only           |   0 |    144 | f        |   858 |    0 |   0 | t
 Philosophy and Art | Columbus Trailer #1 (2017) | Movieclips Indi | youtube   | already-described | embed-only           |   0 |   1048 | f        |   989 |    0 | 358 | f
 Philosophy and Art | gomi                                         | twitter   | below-threshold   | embed-only           |   0 |    623 | f        |   446 |    0 |   0 | t
 Philosophy and Art | Tony Soprano - 'Is This All There Is'        | youtube   | already-described | embed-only           |   0 |   3051 | f        |  4302 |    0 | 538 | f
 Philosophy and Art | True Detective - World Needs Bad Men         | youtube   | already-described | embed-only           |   0 |   3053 | f        |  3587 |    0 | 717 | f
 Relationships      | gomi                                         | twitter   | below-threshold   | embed-only           |   0 |    623 | f        |   446 |    0 |   0 | t
 Tech and Business  | GigSlave Goes Public With $84 Billion Valuat | youtube   | already-described | embed-only           |   0 |   2194 | f        |  2112 |    0 | 710 | f
 Tech and Business  | shouko                                       | twitter   | below-threshold   | embed-only           |   0 |    817 | f        |   652 |    0 |   0 | t
 Abusrdity          | Autism Capital 🧩                            | twitter   | n/a               | excluded:image-tweet |   0 |    168 | f        |     0 |    0 |   0 | t
 Abusrdity          | Daniel Ahmad                                 | twitter   | n/a               | excluded:image-tweet |   0 |    500 | t        |     0 |    0 |   0 | t
 Abusrdity          | Maine                                        | twitter   | n/a               | excluded:image-tweet |   0 |    368 | f        |     0 |    0 |   0 | t
 Abusrdity          | no context memes                             | twitter   | n/a               | excluded:image-tweet |   0 |    120 | f        |     0 |    0 |   0 | t
 Abusrdity          | philosophy memes 🔗                          | twitter   | n/a               | excluded:image-tweet |   0 |    127 | f        |     0 |    0 |   0 | t
 Abusrdity          | Saganism                                     | twitter   | n/a               | excluded:image-tweet |   0 |    369 | f        |     0 |    0 |   0 | t
 Death              | Saganism                                     | twitter   | n/a               | excluded:image-tweet |   0 |    306 | f        |     0 |    0 |   0 | t
 Philosophy and Art | 🧬Maxpein🧬                                  | twitter   | n/a               | excluded:image-tweet |   0 |    384 | t        |     0 |    0 |   0 | t
 Philosophy and Art | Cinema Tweets                                | twitter   | n/a               | excluded:image-tweet |   0 |    392 | f        |     0 |    0 |   0 | t
 Philosophy and Art | Dylan O'Sullivan                             | twitter   | n/a               | excluded:image-tweet |   0 |    286 | f        |     0 |    0 |   0 | t
 Philosophy and Art | Poetic Outlaws                               | twitter   | n/a               | excluded:image-tweet |   0 |    394 | f        |     0 |    0 |   0 | t
 Philosophy and Art | Pope Leo XIV                                 | twitter   | n/a               | excluded:image-tweet |   0 |    351 | t        |     0 |    0 |   0 | t
 Philosophy and Art | Saganism                                     | twitter   | n/a               | excluded:image-tweet |   0 |    361 | f        |     0 |    0 |   0 | t
 Philosophy and Art | Saganism                                     | twitter   | n/a               | excluded:image-tweet |   0 |    201 | f        |     0 |    0 |   0 | t
 Philosophy and Art | Sherry                                       | twitter   | n/a               | excluded:image-tweet |   0 |    223 | f        |     0 |    0 |   0 | t
 Relationships      | ✒️                                            | twitter   | n/a               | excluded:image-tweet |   0 |    145 | f        |     0 |    0 |   0 | t
 Relationships      | Mark Manson                                  | twitter   | n/a               | excluded:image-tweet |   0 |    179 | f        |     0 |    0 |   0 | t
 Relationships      | Mark Manson                                  | twitter   | n/a               | excluded:image-tweet |   0 |    170 | f        |     0 |    0 |   0 | t
 Tech and Business  | arian ghashghai                              | twitter   | n/a               | excluded:image-tweet |   0 |    394 | f        |     0 |    0 |   0 | t
 Tech and Business  | Bloomberg                                    | twitter   | n/a               | excluded:image-tweet |   0 |    347 | f        |     0 |    0 |   0 | t
 Tech and Business  | Bo Ren                                       | twitter   | n/a               | excluded:image-tweet |   0 |    320 | f        |     0 |    0 |   0 | t
 Tech and Business  | Branko Marcetic                              | twitter   | n/a               | excluded:image-tweet |   0 |    357 | f        |     0 |    0 |   0 | t
 Tech and Business  | Dan Gray                                     | twitter   | n/a               | excluded:image-tweet |   0 |    376 | f        |     0 |    0 |   0 | t
 Tech and Business  | Jay                                          | twitter   | n/a               | excluded:image-tweet |   0 |    370 | f        |     0 |    0 |   0 | t
 Tech and Business  | signüll                                      | twitter   | n/a               | excluded:image-tweet |   0 |    336 | f        |     0 |    0 |   0 | t
 Tech and Business  | unusual_whales                               | twitter   | n/a               | excluded:image-tweet |   0 |    337 | f        |     0 |    0 |   0 | t
 Tech and Business  | WIRED                                        | twitter   | n/a               | excluded:image-tweet |   0 |    330 | f        |     0 |    0 |   0 | t
 Philosophy and Art | Bookshelf                                    | imageCard | n/a               | excluded:imageCard   |   0 |     16 | f        |     0 |    0 |   0 | f
 Philosophy and Art | Hate_Room_08.03.2022_MidJourney              | imageCard | n/a               | excluded:imageCard   |   0 |     35 | f        |     0 |    0 |   0 | f
```

</details>

### Things Daniel should weigh before the prod run

1. **Only 4 of the 7 archived-only nodes will revive.** King Arthur Fan,
   𝓐𝔂𝓸✯, RUST COHLE, and America Is NOT sweep normally. **Daniel Ahmad,
   🧬Maxpein🧬, and Pope Leo XIV are image tweets** — the brief's own
   hard exclusion (their vectors would be replaced with boilerplate text).
   Verification 1 will report exactly these 3. The brief's "the 7 revived"
   expectation and its exclusion rule conflict for them; the exclusion
   (never-worse-informed) was given precedence. They stay archived-only —
   invisible to archived-filtering readers, still served by voice retrieval —
   until Issue #17 gives image tweets analysis text. Un-archiving without
   re-embedding was NOT done (a row may hold predecessor content —
   the RUST COHLE lesson).
2. **The Camus anomaly moved.** Relationships "Camus" now holds
   `media_analysis` (1,020 chars) in JSONB — the patch landed sometime after
   the 2026-07-21 probe — so it takes the normal backfill+sweep path. The
   **Abusrdity "Camus"** card (500-cap summary, no JSONB assets, no image
   marker) is the row the guard will skip+flag in prod.
3. **Expected prod camus-guard flags:** Abusrdity Camus (above), plus any
   text tweet whose 500-cap or non-reconstructable summary exceeds its
   composition. Expected legacy-reconstruction sweeps: New York Magazine,
   𐙚⋆-class text tweets. The run prints each decision as it happens.
4. **MeidasTouch pipeline silence** (§2) — separate investigation, not a
   sweep blocker.

## 6. Prod invocation (from Daniel's terminal)

```bash
# 1. Plan only (read-only) — review the authoritative plan table:
SUPABASE_URL=<prod-url> SUPABASE_SERVICE_ROLE_KEY=<prod-service-key> \
  node scripts/sweep-corpus-embeddings.mjs

# 2. Full run — re-prints the plan, then requires typing the word "sweep":
SUPABASE_URL=<prod-url> SUPABASE_SERVICE_ROLE_KEY=<prod-service-key> \
  WEAVE_NETLIFY_FN_URL=https://<prod-site>/.netlify/functions/generate-tweet-description \
  node scripts/sweep-corpus-embeddings.mjs --execute --out-dir tmp/sweep/prod
```

Idempotent — safe to re-run after a partial failure (generations advance,
descriptions become already-described). Verification runs automatically and
lands in `tmp/sweep/prod/sweep-results.json`; paste its numbers into §7 here.

## 7. Prod execution results (2026-07-28, from Daniel's terminal)

Script commit `27a821c`. **Phase 2: 17/17 descriptions generated and patched
(644–1,097 chars), zero failures. Phase 3: 33/38 swept, 5 camus-guard skips,
2 legacy-reconstruction sweeps, zero failures, zero budget tripwires.**
Artifacts: `tmp/sweep/prod/sweep-results.json`.

### Verification

| # | Check | Result |
|---|---|---|
| 1 | Zero current nodes with only-archived rows | **✗ 3 remain — exactly the predicted image tweets** (confirmed by follow-up RO query): Daniel Ahmad, 🧬Maxpein🧬, Pope Leo XIV. 4 of 7 revived as forecast. |
| 2 | Swept-row invariants | ✓ 0 violations over 33 rows |
| 3 | Summary shape (500-cap / 3k artifacts / budget) | ✓ 0 violations |
| 4 | Excluded rows byte-identical | ✓ 0 changed (29 rows) |
| 5 | Spot-checks | ✓ all five: RUST COHLE now carries its own YouTube content (Turkish-tweet predecessor gone); King Arthur Fan description-led + revived; The Driven Man transcript in summary; Camus (Relationships) description-led with the podcast content; "Is Ignorance Really Bliss?" description-before-transcript **and** transcript-beyond-3k both true |
| 6 | Never-worse | ✓ 0 violations (5 flagged skips, 2 legacy sweeps excluded) |

Headline repairs: the 12 exactly-500 summaries are gone; the 3 timer-race
tweets carry their transcripts; all 11+ YouTube cards compose description-led
with uncapped transcripts (largest: The Silent Revolution, 21,386 chars —
was 3,061); every swept vector is text-only at generation ≥ 1 with
`embed_trigger: 'sweep'`.

### The 5 camus-guard skips, classified after follow-up read-only queries

| Row | Composed < existing | Class |
|---|---|---|
| Camus (Abusrdity) | 350 < 500 | **Genuine Camus-class** — 500-cap media-server summary holding analysis prose absent from JSONB. Stays protected; manual call. |
| MeidasTouch | 3,105 < 3,936 | **New Camus-class row, mechanism solved** — see below. |
| gomi (Philosophy and Art) | 597 < 623 | Boilerplate-only: legacy format *with transcript* (`authorName — authorHandle — tweetText — domain — transcript`, confirmed from `864f087`'s composition code). Delta = handle+domain. No information at risk. |
| gomi (Relationships) | 597 < 623 | Same. |
| shouko | 793 < 817 | Same. |

The initial legacy-reconstruction list covered only the transcript-less
variant; commit(s) after `27a821c` add the transcript-bearing variant, so a
re-run (idempotent) would sweep the two gomi rows and shouko. Equally
defensible to accept the skips: their old vectors already contain their
transcripts.

### MeidasTouch — the preflight flag resolved (and it's a different bug)

The §2 flag assumed the pipeline died before persisting anything. The prod
row proves otherwise: MeidasTouch's pre-sweep gen-4 row has
`processing: "server"`, `embed_trigger: "media_patch"`, `had_analysis: true`,
`had_description: true`, 3,936 chars — **the Fly pipeline completed
successfully**, composed union-style with its own ~830-char analysis, and
upserted. But today's JSONB has no `media_analysis` and no
`media.pipeline`/`embed.server` log entries. Since `patchNodeData` throws on
failure (which would have aborted before the upsert), the analysis patch
*succeeded* and was later erased — the client had the board open, and a
client full-board save (`replace_board_contents`) overwrites `nodes.data`
wholesale with client state, wiping both the server's `media_analysis` patch
and its appended log entries. **Server JSONB patches race client full-blob
saves and lose.** Separate bug, spun off for investigation; the sweep's
guard correctly preserved the richer server vector.

### Status

The sweep is complete. PR-3 (RPC `archived_at` filter + DB trigger) is now
unblocked, with the caveat that the 3 image-tweet rows remain archived-only
and servable by voice retrieval until Issue #17 — the PR-3 filter design
should decide their fate explicitly.
