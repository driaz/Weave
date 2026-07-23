# Token-Limit Bisection + Four-Way Multimodal Probe — Issue #2, Decisions 3 & 4 (READ-MOSTLY)

**Date:** 2026-07-23
**Prod queries:** role `weave_readonly` @ `aws-1-us-east-2.pooler.supabase.com`, db `postgres` (Weave prod), via `WEAVE_PROD_RO_DATABASE_URL`. SELECTs only.
**Gemini calls:** `gemini-embedding-2-preview`, `taskType: SEMANTIC_SIMILARITY`, no `outputDimensionality` — byte-identical config to every production call site. **49 embedding API calls total** (2 determinism, 28 bisection across three runs, 15 multimodal probe, 4 control floor). Three calls carried inline video+audio (~3.7M base64 chars each); the rest were text-only. No vector produced in this session touched any database — all live in scratchpad JSON and this doc.
**Scripts:** throwaway, session scratchpad only (`embed-lib.mjs`, `task01.mjs`, `task1b.mjs`, `task1c.mjs`, `task2.mjs`, `control.mjs`). Not wired into anything.
**Companions:** the four prior Issue-#2 read docs.

---

## 0. Task 0 — determinism baseline

Same 2,000-char text (2,000 bytes), two separate API calls: **repeat cosine 0.9999999999999998** (i.e. 1.0000 to well past 4 decimals; 3,072 dims). The API is deterministic for identical input. Every "exact identity" claim below uses this as the reference level; the bisection method is valid.

## 1. Task 1 — truncation bisection

**Corpus:** programmatically built, positionally distinctive — head topic deep-sea marine biology, tail (always the final 5,000 chars) quantum computing, every sentence tagged with a running index so no two regions are textually identical. Base corpus 40,000 chars / 40,008 bytes.

### 1.1 First pass at 40k (the documented-limit region) — no truncation found where it was expected

Cosines vs. the full-40k vector (exact values):

| Input | cos vs full-40k |
|---|---|
| prefix 24,000 | 0.9312 |
| prefix 28,000 | 0.9337 |
| prefix 32,000 | 0.9356 |
| prefix 36,000 | 0.9956 |
| head 35,000 alone (no tail) | 0.9350 |
| tail 5,000 alone | 0.7520 |

The signature of truncation at the "documented" ~32.7k chars (8,192 tokens × 4 chars/token) would be prefix-32k ≈ 1.0000 and a full vector blind to the tail. Observed instead: the full-40k vector is **strongly tail-aware** (head-only = 0.9350, far from identity; tail-alone = 0.7520, far above the ~0.17–0.50 unrelated floor of §2.4). At 40k chars, nothing had been truncated.

### 1.2 Size sweep — truncation exists, higher up

Signature per total size T: `cos(embed(full_T), embed(head_T))` where head_T is full_T minus the 5,000-char tail. Identity (repeat level) ⇔ both truncate to the same prefix ⇔ tail invisible.

| T (chars) | cos(full, head-only) | Tail visible? |
|---|---|---|
| 40,000 | 0.9350 | **yes** |
| 42,000 | 1.0000 | no |
| 44,000 | 1.0000 | no |
| 46,000 | 1.0000 | no |
| 48,000 | 1.0000 | no |
| 64,000 | 1.0000 | no |
| 80,000 | 1.0000 | no |
| 100,000 | 1.0000 | no |
| 140,000 | 1.0000 | no |

Every over-limit call **succeeded silently** — a 140,000-char input (~4× the limit) returned a normal vector with no error, warning, or response metadata hinting at truncation. The silent-truncation behavior is confirmed photographically: at T ≥ 42,000, the full-text vector is bit-level indistinguishable from a vector that never saw the tail.

### 1.3 Char-level bisection

Against a 42,000-char corpus (tail at 37,000–42,000), prefix-identity signature (`cos ≥ 0.999999` = identical):

| Prefix P | cos vs full-42k |
|---|---|
| 36,000 | 0.998608 |
| 36,500 | 0.998329 |
| 36,750 | 0.998363 |
| 37,000 | **1.000000** |

**Inferred truncation boundary: N ∈ (36,750, 37,000] chars** for this corpus.

### 1.4 Token interpretation

- At the task's stated ~4 chars/token approximation, the boundary implies **~9,190–9,250 tokens** — apparently above the documented 8,192.
- At the documented **8,192-token** limit, the boundary implies **~4.49–4.52 chars/token** for this corpus — a perfectly ordinary ratio for English prose with spaces.

The two readings are observationally degenerate from this experiment alone (chars were measured, tokens inferred). The measurement that is *not* degenerate: **the practical budget is ~36,800 chars of English-like text, not ~32,700** — and for Weave's composition arithmetic, chars are the unit that matters. No `countTokens` exists for the embedding surface in the codebase to break the tie (per the earlier call-site read).

## 2. Task 2 — four-way multimodal probe

### 2.1 Acquisition notes (deviations from the brief's premises, stated before any numbers)

- **`imageBase64` is NOT in prod JSONB** for "philosophy memes 🔗" (or any card) — `syncBoard.ts` strips binary fields before persistence (established in the coverage probe; the brief's premise didn't hold). The node's `imageUrl` is a **signed Supabase Storage URL whose token expired 2026-07-13** (HTTP 400 today), and the bucket rejects public access. The image was recovered from the public tweet via the fxtwitter API → `pbs.twimg.com` original: **67,651 bytes**, 1125×858 JPEG. Presumed identical content to the stored copy but not byte-verified against it.
- **Sopranos video** re-downloaded via yt-dlp with the media-server's exact format selector (`bestvideo[height<=720]+bestaudio/best[height<=720]`, mp4 merge). Source clip is **70.88s** — *shorter than the 120s trim*, so prod's `-t 120` copy-trim is a no-op on this card and the full clip was sent: video 2,208,467 bytes (2,944,624 base64 chars), audio (opus 64k, media-server settings) 561,956 bytes (749,276 base64 chars).
- **Modern Dad's tweet video: skipped** per the brief (re-download would mean fighting Twitter). Modern Dad therefore has variant (a) only.

### 2.2 Inputs (exact sizes) and query texts

Composed-text recipes used (stated explicitly; full fields joined with " — ", no caps):
- **Sopranos (976 chars):** title — author — contentDescription(398) — transcript(504).
- **Modern Dad (2,017 chars):** authorName — authorHandle — tweetText(336) — transcript(760) — media_analysis(1,109).
- **Meme (121 chars):** title — handle — tweetText (the oEmbed boilerplate; semantically empty).

Query vectors, embedded as plain text:
- Sopranos edge (real prod edge): "Survival is not living — Christopher Moltisanti says 'I'm alive, I'm surviving, that's it — I don't want to just survive,' which directly ech…" (full label+explanation as stored).
- Sopranos thematic (written): "a character yearning for a narrative arc, wanting his suffering to mean something more than mere survival".
- Modern Dad edge: "Suffering as intimacy's proof — …" (full stored text). Thematic: "choosing a partner who stays through hardship, illness, and suffering rather than one who is only fun".
- Meme edge: "Meaningless world denies arcs — …" (full stored text). Thematic: "living meaningfully in a meaningless world under late stage capitalism".

### 2.3 Sopranos card — full matrix

Variants: (a) text only; (b) video+audio only; (c) text, video, audio; (d) video, audio, text.

Pairwise:

| | b_media | c_text_first | d_media_first |
|---|---|---|---|
| **a_text** | 0.5210 | 0.5894 | 0.6017 |
| **b_media** | | 0.9455 | 0.9491 |
| **c_text_first** | | | 0.9954 |

Vs queries:

| Variant | edge query | thematic query |
|---|---|---|
| a_text | **0.7309** | **0.4563** |
| b_media | 0.4723 | 0.3840 |
| c_text_first | 0.4595 | 0.4077 |
| d_media_first | 0.4791 | 0.4246 |

Key observations (numbers only; reading deferred to §4):
- (c) and (d) sit at 0.945–0.949 to media-only and 0.59–0.60 to text-only: **the mixed vector is far closer to the media vector than to its own text.**
- Adding media to text *lowered* the edge-query score from 0.7309 to 0.4595 — below media-only's 0.4723.
- (c) vs (d) = 0.9954 — order changes almost nothing, and both orders land in the same media-dominated place. Neither equals the other exactly (repeat level is 1.0000), so the text is not literally absent in either order.
- Same-card cross-modal alignment (a~b = 0.5210) is at the level of *unrelated text pairs* (§2.4: sourdough~tax = 0.5007).

### 2.4 Control floor (typical cosines between unrelated short texts)

sourdough~tax 0.5007 · sourdough~soccer 0.3207 · tax~soccer 0.2734 · sourdough~arcQuery 0.1878 · tax~arcQuery 0.1702 · soccer~arcQuery 0.1877. **Unrelated ≈ 0.17–0.50.** Scores in the 0.38–0.48 band are barely above this floor.

### 2.5 Modern Dad card (text variant only; video skipped)

| Variant | edge query | thematic query |
|---|---|---|
| a_text (2,017 chars) | 0.6624 | 0.6857 |

### 2.6 Meme card — full matrix (the image-only ballgame)

Variants: (a) boilerplate text only (121 chars); (b) image only; (c) text, image; (d) image, text.

Pairwise:

| | b_media | c_text_first | d_media_first |
|---|---|---|---|
| **a_text** | 0.3236 | 0.6728 | 0.6259 |
| **b_media** | | 0.7225 | 0.7320 |
| **c_text_first** | | | 0.9287 |

Vs queries:

| Variant | edge query | thematic query |
|---|---|---|
| a_text | 0.6390 | 0.6552 |
| b_media | 0.4514 | 0.4791 |
| c_text_first | 0.5769 | 0.6238 |
| d_media_first | 0.5142 | 0.5211 |

Key observations:
- Image-only vs the thematic query ("living meaningfully in a meaningless world under late stage capitalism" — which is *what the meme says on its face*): **0.4791**, inside the unrelated-floor band's upper edge.
- The semantically-empty boilerplate text (author name + pic link + date) scores **higher** (0.6552) than the actual image content — with the caveat, flagged: the author name contains "philosophy" and both queries are philosophy-adjacent, so (a)'s score is partly a lexical accident.
- Text+image mixes more evenly than video did (a~c 0.6728 vs Sopranos' 0.5894), and order matters more (c~d 0.9287 vs 0.9954).

## 3. Task 3 — video token arithmetic, dots connected

- Clip actually sent: **70.88s** (source < 120s trim; full clip). The request succeeded — as did prod-shaped calls at every size tried; no media call errored.
- At the ~101 tokens/sec mental model, 70.88s of video ≈ **~7,160 tokens**, plus audio and ~220 tokens of text — a total near or above the 8,192 window. If media and text competed positionally for that window, (d) media-first should have starved the text far more than (c) text-first. Observed: **c~d = 0.9954** — order is nearly irrelevant, and *both* orders are media-dominated (0.945+ to media-only) while the text remains faintly present in both (neither equals (b) or each other at repeat level).
- Connected to Task 1's finding that the *text* limit sits at ~36.8k chars (~8.2k tokens at ~4.5 chars/token): the observed behavior does **not** look like text and media sharing one positional token window with truncation of whatever comes last. It looks like modality dominance — the media parts pull the vector toward media-space regardless of order, with text as a minor perturbation. The ~101 tokens/sec figure is neither confirmed nor refuted by this probe; what is refuted is the "position in the parts array determines what survives" model at these sizes (one 70.88s clip; larger media untested).

## 4. Interpretation (quarantined — everything above is measurement)

- **Decision 3 (budget):** the effective text budget is ~36,800 chars of English-like prose (8,192 tokens at the empirical ~4.5 chars/token), not the ~32,700 a 4.0 ratio predicts, and overflow is perfectly silent. Every composed text in the current corpus (max observed need ≈ 21k chars for the largest YouTube card) fits with >40% headroom; no truncation-aware composition is needed at current content sizes.
- **Decision 4 (pixels):** on this card, mixing media into the embed made text-query retrieval *worse than either modality alone* — the multimodal vector lives in media-space (0.95 to media-only) while queries live in text-space. Notably, prod's media-server embeds are exactly variant (c); this probe suggests the server's "richer" multimodal overwrite may be a *retrieval downgrade* relative to the text-only client embed it replaces, for text queries. The meme result sharpens it: even for an image-only card — the case pixels were supposed to rescue — the image-only vector barely clears the unrelated floor against a query stating the meme's own thesis, and text+image beats image alone. Cross-modal alignment in this embedding space is weak (same-card a~b ≈ unrelated-pair level).
- The single strongest retrieval vector measured anywhere in this session was **plain composed text against the real edge query (0.7309)**.
- All of §2 rests on one card per media type and two queries per card — directional, not statistical.

## 5. Open questions

1. Is the text limit exactly 8,192 tokens (ratio ~4.5) or genuinely higher (~9,200 at ratio 4.0)? Breakable with a corpus of known token count (e.g., single-token words), ~4 calls, if the design ever needs token precision rather than the ~36.8k-char budget.
2. Does media dominance scale with media size — would a 10s clip or a lower-resolution image let text contribute proportionally more to the mixed vector? (This session tested one 70.88s clip and one 1125×858 image.)
3. Do *multimodal queries* (image query → image card) score well in this space? Text queries barely find the meme image, but the failure could be cross-modal alignment rather than the image vector being information-poor. Untested — Weave's queries are all text today, so this matters only for hypothetical future query surfaces.
4. The meme card's a_text advantage rode the word "philosophy" in the author name — with a neutral author, does boilerplate text still beat image-only, or collapse to the floor?
5. Modern Dad's video variants were skipped; is the video-dominance pattern tweet-video-general or clip-specific? (One Sopranos data point.)
