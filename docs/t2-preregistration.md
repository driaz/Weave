# t2 pre-registration

**Status:** committed before any t2 generation. Nothing below is edited after the first curl.
**Written:** 2026-10-04, revised same day against Claude Code's pre-commit review (read-only queries; breadth rebuild reproduced t1 `by_class` exactly on 19/19 nodes tested).
**t1 `generated_at`:** 2026-09-07T02:37:59.815Z. Δ (days) is computed from this to each t2 row's `generated_at`.
**Run window:** t2-pinned must run **before 2026-10-11 15:46 UTC**. Between 2026-10-03 03:49 and that time, the set of t1 events surviving the 70 d breadth horizon is constant; after it, the 08-02 events on A#12 and U#2 fall out too. Re-engagement flags below were frozen at 2026-10-04 16:27:57 UTC; the comparison re-checks them at the actual `generated_at`.
**Inputs:** `docs/reads/t2-preflight.md` (PR #56), `docs/reads/t1.md` (PR #50), Notion #8 row body.

## 1. What runs

Three stages through the Netlify functions (never the offline scripts). Daniel executes prod writes; Claude Code verifies via RO and writes `docs/reads/t2.md`.

1. **t2-pinned** — stage 1 only. `pin_node_set_from_snapshot_id = <t1 snapshot id>`, `trigger_reason = 't2_pinned'`, real weights, default page size, fresh JWT. Node set = t1's 71 (none archived since; pinned keys are kept regardless of archival — `generate.ts:80-89`).
2. **Comparison** — read-only, before anything else runs. Scored against §4.
3. **t2** — stage 1 on the live set (81 nodes), `trigger_reason = 't2'` → themes → narrative → Reflect. The real portrait.

Expected: the narrative function's HTTP response may cut at ~26 s (t1 §9 `netlify.toml` fix not applied). Verify the row, not the response.

## 2. Parameters in force (locked since t1)

Code at HEAD `bb23d8f` is not t1's SHA (`bc22795`), but the snapshot code is identical between them (preflight §F).

| Parameter | Value | Provenance |
|---|---|---|
| Roster | `lightbox_closed` and `connection_description_closed`: breadth, dwell curve `1.5 × min(log₂(s+1)/log₂46, 1)`, cap 1.5 (node grain / edge grain → endpoints). `voice_session`: depth, edge grain, `0.6460 × log₂(user_turns+1)`, no cap. `item_added`: recency 0.2, breadth clock. | roster sitting 2026-08-30 |
| `H_BREADTH` | 14 d | instrument-driven: 2–4 wk gap spans 1–2 half-lives. Not fitted. |
| `H_DEPTH` | 42 d | intuition-driven: "3-week conversation still live" ≈ 70% at 21 d. Not fitted. |
| `K` | 5 → horizons 70 d (breadth, recency) / 210 d (depth). **Events older than the horizon are excluded from the read, not decayed.** | derived from H |
| Cluster threshold | 0.72, agglomerative average-linkage stop | |
| `ANCHOR_COUNT` | 3 per cluster, `min(3, size)`; anchors require `w_total > 0` | roster sitting; Decision A |
| `STAGE2_MODEL` | `claude-opus-4-7` | unchanged since t1 |
| Prompt | theme-v2 / narrative-v2, unchanged (not a locked parameter; not changed in the window) | |

Age reference: event `timestamp` (voice: `ended_at`) → snapshot `generated_at`.

## 3. The period, plainly

### 3a. What the data says (preflight read, as of 2026-10-04 16:27:57 UTC)
- 3 real voice sessions launched from a connection (26 user turns total): `ae2ca271` (14 turns, ~18 m), `4949baac` (1 turn), `d289fffc`. 6 further real sessions had no launch connection and are invisible to the pipeline.
- 11–16 nodes added (source-dependent; preflight reports each). 10 are live and in the t2 unpinned set. 66 edges drawn. One new board: *Depression*.
- Roster engagement since t1: the board stored as **"Abusrdity"** leads by event count and by undecayed weight (decayed weight since t1 was not computed).
- At t1: Philosophy and Art led by event count (41) and decayed weight; Tech and Business by undecayed weight (+0.9%).
- Re-engaged since t1: 5 of 12 anchors, 9 of 21 unclustered-attended nodes.

### 3b. What I actually did
Four weeks of ordinary use alongside voice-pipeline work on the repo (Opus 5 swap 09-17, latency markers 09-28 — neither touched the snapshot code). One QA listening test on 09-17 (F1) ran on the shouko ⟷ Naruto edge and is named in §5.

**Curator's account (Daniel, 2026-10-04, before the run):** Absurdity and Tech and Business were the two boards I was actually in. The conversations were about decay and collapse, and about the pathological game in tech.

### 3c. Reflexivity — what I remember from t1 (ticked before the run, without re-reading)
- [ ] The title — *a collection that sorts by mood, not subject*
- [ ] The "rigged sorting systems" thread (meritocracy, Manson tweets as the exception)
- [x] The "traps with no exit" thread split across Philosophy / Absurdity / Death
- [x] The "exit doesn't deliver" thread (early retirement, Dostoevsky)
- [x] The Chamath → Affleck / Yale professor / Gates-daughter pairings being called out
- [ ] The Rust Cohle fan-edit theme
- [ ] The "philosopher aphorisms left alone" closing paragraph
- [ ] The CONVERSATIONS paragraph (RDJ / MAGA / Silent Revolution; Cinema Tweets / Hate Room)
- [ ] Something in t1 sent me back to a node or board I'd otherwise have left alone
- [ ] I don't remember reading t1 closely at all

Reading for the comparison: the curator remembers t1's no-exit / failed-escape threads and the Chamath pairings, which map onto his own "decay and collapse." He does **not** remember the rigged-systems thread, which is t1's version of "the pathological game in tech." Continuity in the first group is read cautiously (attention may have followed t1); continuity in the second is clean evidence.

## 4. Predictions

Failure layers, pre-agreed: **L1 inert** → parameters; **L2 wrong trace** → plumbing; **L3 moves against prediction with others passing** → the roster measures acts that aren't attention. Only L3 bears on the thesis.

### P-M. Mechanism — exact decay with horizon (t2-pinned vs. t1)
For every t1 anchor / unclustered-attended node **not re-engaged** since t1, each component at t2 equals the decayed sum over its t1 events with `timestamp ≥ generated_at − 70 d` (breadth, recency) or `ended_at ≥ generated_at − 210 d` (depth); events outside contribute 0.
- **Exact 2^(−Δ/H) ratio holds** (no t1 events lost) for: A#3, A#4, A#6, A#8, A#9, A#12; U#2, U#14, U#17, U#18, U#21.
- **Events lost to the horizon** (pre-computed; must reproduce): A#11 James Lucas 11/11 → `w_total = 0`; U#13 Alan Watts 11/11 → 0; U#20 Jeff Daniels 3/3 → 0; U#6 GigSlave 16/17; U#9 Columbus 1/3; U#11, U#12, U#15 1/1 breadth each (depth survives). No voice session is outside 210 d (earliest 05-18).
**Pass:** every value within 1e-6 relative (the R2 standard). Deviation is L2.

### P1. Long lightbox dwells outrank clicked-but-dismissed edges
Age-0 weights on the curve: 3 s close = 0.543; 20 s lightbox = 1.193.
**Pass:** no t2-pinned anchor's top-weighted breadth event is a `connection_description_closed` with `durationMs < 3000` while a `lightbox_closed ≥ 20000 ms` on a non-anchor clustermate exists in window. Vacuous pass if no such pair; state it.

### P2. Dismissed edges drop out of anchors t1→t2
Premise holds for **A#6 Sherry** (t1 led by a 0.222 close, not re-engaged; c2 has re-engaged non-anchor members). A#5 Maxpein also qualifies on the close but was re-engaged — excluded.
**Pass:** #6 is out of the t2-pinned anchor set.

### P3. Real voice sessions anchor their edges
Scored on launch sessions with **≥ 4 user turns** (per-session depth ≥ 1.5, i.e. at least one full breadth act): `ae2ca271` (14 turns, depth ≈ 2.52 at age 0). `4949baac` (1 turn, depth 0.646 vs. its own launch dwell at 1.5) and `d289fffc` are observed, not scored.
**Pass (pinned):** both endpoints of `ae2ca271`'s edge that are in the t1 set are t2-pinned anchors if clustered, or in `unclustered_attended` if singletons. Depth dominance is **recorded, not required** (Autism Capital :4 carries 5.84 undecayed breadth since t1; c1 has three slots).
**Pass (unpinned):** same over the live set.

### P4. Breadth clock — no re-engagement, breadth-only
- **A#11 James Lucas (c7):** `w_total = 0` by horizon truncation → **out of the anchor set**. **A#12:** c7's remaining member, present at ≈ 2^(−Δ/14) of t1 `w_total`.
- **A#4 𝐥𝐲𝐫𝐚, A#6 Sherry (c2):** c2 has re-engaged non-anchor members (philosophy memes, Saganism, no context memes) → **both out of the t2-pinned anchor set.**
**Pass:** all three statements hold. The original "absent at t2" wording is retained for #4, #6, #11 (now testable) and retired for #12.

### P5. Depth clock — no re-engagement, depth-dominated
- **A#8 Silent Revolution (c3, 3 members, all `w_total > 0`):** **present**, depth ≈ 2^(−Δ/42) of t1, depth-dominant.
- **A#3 arian ghashghai (c1):** depth ≈ 2^(−Δ/42), breadth ≈ 2^(−Δ/14) → `w_total` ≈ 0.51. c1 clustermates Maine and Autism Capital carry **new depth** via `ae2ca271`. **Pre-decided reading:** if #3 is displaced by a clustermate whose new weight includes depth, that is the design working (a newer conversation outranks an older one in the same cluster) — **pass**, provided #3's own components match P-M. L1 ("`H_DEPTH` too short") applies **only** if #3 is displaced by a clustermate whose new weight is breadth-only.

### P6. Cross-board reading (unpinned run)
Reference board = **"Abusrdity"** (stored name; leads since-t1 engagement by event count and undecayed weight).
**Pass:** at least one t2 (unpinned) anchor sits on a board other than "Abusrdity". Secondary observation, not scored: any anchor on a board with no roster engagement since t1.

### P7. Launch dwell counts as breadth (decision of record 2026-09-28)
Known before the run: of the three launches, **two** left a close row — `ae2ca271` (1,104,735 ms), `4949baac` (125,904 ms). **`d289fffc` has a label click (09-27 08:46:38.99) and no close** — the D3/F1 unmount-without-close pattern; recorded, not a prediction.
**Pass:** for the two, the launching edge's endpoints show both breadth (dwell, capped 1.5 at age 0) and depth (session) in `by_class`.

### P8. Pipeline self-report
- t2-pinned: `attribution.absent` = resolved (event, node) pairs onto the 10 post-t1 nodes — **74 as of 16:27:57 UTC**, plus any added before `generated_at`; `archived` = pairs onto archived embeddings in window; `resolved = hit + archived + absent`; all page gates hold.
- t2 unpinned: `absent` = 0 (t1's live run had 0); `archived` ≥ 1 if any in-window event resolves to `8a8d45a9…:45` (embedding archived 09-24, node live).
- Pair-asymmetry counters for both pairs; no strict-order phantom.
- t2-pinned cluster structure identical to t1 (set-of-sets). **Precondition:** no t1 node's vector was overwritten since t1 — unobservable in the read (no `updated_at`); if clusters differ, check this before reading it as anything else.

### P9. Portrait shape (unpinned, descriptive — not scored)
Depth-heavy again; mid-July breadth is past horizon; the three new conversations are inside 42 d. "Abusrdity" and *Depression* enter the reading; whether Depression clusters or sits in `unclustered_attended` is noted, not predicted.

## 5. Known confounds (named in advance)
1. **F1 preview session (2026-09-17 ~05:18 UTC).** Two qa voice sessions on shouko ⟷ Naruto left two `connection_description_closed` rows (417,744 ms and 2,501 ms), attributed via shared browser `session_id`. Both endpoints are t1 unclustered-attended, neither an anchor. The long dwell is 1.5 per endpoint at age 0, ≈ 0.65 at t2. Excluding the rows changes no re-engagement flag. The comparison reports those two nodes' `w_total` with and without them.
2. **Breadth read has no host/kind predicate.** Any other preview/local session would leak the same way; the preflight found only the F1 pair. Post-t2 instrument change; not applied before t2 so t1/t2 stay comparable.
3. **Stage 2 is not blind.** t1 was visible in Reflect and the voice opening throughout. §3c records what the curator remembers.
4. **`8a8d45a9…:45`** — second archived-embedding / live-node case, outside the t1 set; affects unpinned `archived` only.
5. **One launch click without a close** (`d289fffc`) — the orphan pattern D7 classified as session-terminal; recurs.

## 6. t1 baseline
- 12 anchors — clusters 3/3/2/1/1/0/2; 8 breadth-dominated, 4 depth-dominated; `w_total` / `by_class` per anchor in preflight §A.
- 21 unclustered attended; 16 conversations in window; **186 resolved (event, node) pairs** = 178 hit + 8 archived + 0 absent.
- Title: *A collection that sorts by mood, not subject.* Narrative and seven themes verbatim in preflight §G.

## 7. What `docs/reads/t2.md` must report
Δ in days per row; per-node table (t1 / predicted / observed / ratio / pass) for P-M incl. the horizon-lost nodes; P1–P8 verdicts with failure layer where applicable; the F1 with/without pair; both runs' `generation_metadata` gates; the unpinned title, narrative and themes verbatim; one paragraph, written after reading §3c, on whether the shift followed the curator or the curator followed t1.
