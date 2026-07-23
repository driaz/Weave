# Delete Path & Embed Call Read — Issue #2 pre-design (READ-ONLY)

**Date:** 2026-07-21
**Prod queries:** role `weave_readonly` @ `aws-1-us-east-2.pooler.supabase.com`, db `postgres` (Weave prod), via `WEAVE_PROD_RO_DATABASE_URL`. One SELECT (§3). Everything else is code reading; no writes anywhere.
**Companion doc:** `docs/embedding-coverage-probe.md` (same-day coverage probe).

---

## 1. Read 1 — the delete path and the archive mechanism

### 1.0 Structural fact that frames everything: one row per node, ever

`weave_embeddings` has `unique(board_id, node_id)` ([supabase/migrations/002_create_weave_embeddings.sql:14](../supabase/migrations/002_create_weave_embeddings.sql)). There is never an "active + archived pair" for a node — archiving flips the single row's `archived_at`; a re-embed **overwrites** that same row via upsert. The probe's observation that all 93 `(node_id, board_id)` pairs are distinct is this constraint, not delete-path behavior.

### 1.1 Path (a) — node deleted from a board: row **archived**, but deferred and droppable

[src/App.tsx:254-292](../src/App.tsx). Confirmation dialog → local state removal → the archive is **queued as a side effect that only fires after the next successful Supabase save**:

```ts
// App.tsx:254-257 (comment, verbatim)
// Intentional delete: confirmation → local state cleanup → queue an
// embedding archive to fire AFTER the next successful Supabase save
// for this board. If the save rolls back (node reappears on canvas),
// the archive side-effect is dropped and the embedding stays active.

// App.tsx:271-277
queueSideEffect(boardId, async () => {
  if (!supabase) return
  const { error } = await supabase
    .from('weave_embeddings')
    .update({ archived_at: new Date().toISOString() })
    .eq('board_id', boardId)
    .eq('node_id', nodeId)
```

Queue semantics ([src/hooks/useBoardStorage.ts:179-209](../src/hooks/useBoardStorage.ts)): `drainSideEffects` runs on save success (:456), `dropSideEffects` discards the queue on save rollback (:467) and on board delete (:677). Archive failure is `console.warn` only ([App.tsx:278-283](../src/App.tsx)) — **on failure the row stays active with no retry**.

### 1.2 Path (b) — whole board deleted: nodes hard-deleted by cascade, embeddings **archived**

[src/hooks/useBoardStorage.ts:646-674](../src/hooks/useBoardStorage.ts). `persistence.boards.delete(boardId)` removes the board — "Cascade handles nodes + edges on the DB side" (:649) — then, only after the delete succeeds:

```ts
// useBoardStorage.ts:662-665
supabase
  .from('weave_embeddings')
  .update({ archived_at: new Date().toISOString() })
  .eq('board_id', boardId)
```

Again warn-only on error (:667-671), no retry. This is the source of most archived orphans: node rows are gone (cascade), embedding rows persist as archived.

### 1.3 Path (c) — sync prune (board saves without a previously-synced node): embedding row **untouched, stays active**

`replace_board_contents` prunes node rows absent from the payload ([supabase/migrations/020_replace_board_contents_skip_node_noops.sql:77-82](../supabase/migrations/020_replace_board_contents_skip_node_noops.sql)):

```sql
delete from nodes
 where board_id = p_board_id
   and user_id  = v_user_id
   and (data->>'_clientNodeId') <> all (
         coalesce(incoming_client_ids, array[]::text[])
       );
```

The RPC **never touches `weave_embeddings`** (the string does not appear in the function; nodes/edges/boards only). Any node that leaves client state without going through `deleteNode`'s confirm dialog is pruned from `nodes` while its embedding row **remains active**. In the normal UI flow the only removal path is `deleteNode`, so prune and archive travel together — but the archive is the deferred, droppable side effect of §1.1, not a property of the prune.

### 1.4 Live-correctness: can a new card acquire a dead card's still-active vector?

**Yes — three code paths allow it.** The probe's zero-active-orphans is consistent with the archive usually firing, but the mechanism does not guarantee it:

1. **Dropped/failed archive + id reuse.** If the archive side effect is dropped (save rollback, board switch races) or its UPDATE fails (warn-only), the dead card's row stays active. A later card reusing the small-integer client id on that board upserts onto the *same* row (`onConflict: 'board_id,node_id'`, [src/services/embeddingService.ts:215-225](../src/services/embeddingService.ts)) — but until that re-embed completes (or if it never fires), retrieval joins `(node_id, board_id)` and serves the dead card's vector attributed to the new card.

2. **The `processing: 'server'` precheck consults the predecessor's row.** Before embedding, the client reads the existing row's metadata and skips entirely if a server embedding exists ([embeddingService.ts:179-197](../src/services/embeddingService.ts)):

   ```ts
   // Don't downgrade a server-written multimodal embedding with a client text-only one.
   const existingProcessing = (existing?.metadata as { processing?: string } | null)?.processing
   if (existingProcessing === 'server') { … return }
   ```

   This `maybeSingle()` fetch has **no archived_at filter and no notion of card generations**. If the dead card's row carries `metadata.processing = 'server'`, the new card is *never client-embedded* — the stale vector is permanent until a media-server job happens to overwrite it: resurrection if the row is active, invisibility if archived.

3. **Archive-after-successor race.** The archive fires on the *next successful save*. A delete and a new card landing in the same debounce window would archive after the new card's row content was written — archiving the successor's fresh vector. Requires id reuse within one save cycle; likelihood not assessed here (client ids come from a per-board counter, so immediate reuse needs a counter reset — but reuse across generations is empirically real, see §1.5).

**No delete path ever hard-deletes an embedding row**, and **no write path ever clears `archived_at`** — see next.

### 1.5 What archives a row without writing a successor (the 7 archived-only nodes)

The delete-path read surfaces the mechanism directly: **no upsert clears `archived_at`.** Neither the client upsert ([embeddingService.ts:215-225](../src/services/embeddingService.ts) — payload is board/node/type/embedding/summary/metadata) nor the media-server upsert ([media-server/src/supabase.ts:72-87](../media-server/src/supabase.ts)) includes `archived_at: null`. So after a card is deleted (row archived) and its client id reused:

- If the new card **is** re-embedded, the upsert overwrites embedding + summary **but the row stays archived** — a fresh, correct vector that the archived-filtering readers never see (though voice retrieval still serves it — see §1.6). Matches "King Arthur Fan" (archived row's content matches the current card).
- If the new card is **never** re-embedded (no content at embed-time, enrichment skip, Gemini failure — all fail-soft, or the `'server'` precheck of §1.4.2), the archived row keeps the *predecessor's* content. Matches "RUST COHLE" (archived row holds a different card's tweet content).

Both observed archived-only variants from the probe are explained without any additional mechanism. (Not chased further per brief.)

### 1.6 ⚠️ Live-correctness finding: `archived_at` is NOT filtered by voice retrieval

Checking the "archived = invisible" assumption (carried through the coverage probe) against code shows it is **wrong for the main retrieval path**. Per reader of `weave_embeddings`:

| Reader | Filters `archived_at`? |
|---|---|
| `match_retrieval_context` (current: [034_match_retrieval_context_node_only.sql:166-177](../supabase/migrations/034_match_retrieval_context_node_only.sql), voice retrieval via `retrievalContext.ts`) | **NO** — filters are board, `embedding is not null`, summary ≥ 20 chars, self-exclusion, and caller-supplied live-node membership (`p_live_node_ids`). The word `archived` does not appear in migrations 032–034. |
| `generate-profile-snapshot.ts` main read ([:347-350](../netlify/functions/generate-profile-snapshot.ts)) | yes — `.is('archived_at', null)` |
| `extract-snapshot-themes.ts` ([:221-224](../netlify/functions/extract-snapshot-themes.ts)) | **NO** (client-side filtering by key pairs only) |

Consequences, combining with §1.5:

- The RPC's orphan-drop (`p_live_node_ids`) excludes archived rows of *deleted* ids — which is why zero-active-orphans looks clean — but an archived row whose node_id is a **live board member** passes every filter. The probe's 7 "archived-only" nodes are therefore **not invisible to voice retrieval**: their archived vectors are served.
- For the King-Arthur variant (row re-embedded with current content, `archived_at` stale) that is accidentally *correct* behavior. For the RUST-COHLE variant (row still holds a **predecessor card's** content) this is **live stale-vector serving in prod today**: voice retrieval can inject "Felsefe Parrhesia" tweet content attributed to the current "(TRUE DETECTIVE) RUST COHLE" YouTube card.
- The probe doc's framing "no active vector at all (invisible to retrieval)" (§4 there) holds only for the profile-snapshot reader; it should be read with this correction.

Incidental: the RPC's ≥ 20-char thin-summary guard means one of the two imageCards ("My bookshelf.jpg", summary length 16) is excluded from retrieval on length alone; the other (35 chars of filename) is served.

## 2. Read 2 — every Gemini embedding call site

All sites use the **same model string and API surface**: model `'gemini-embedding-2-preview'`, called through the `@google/genai` JS SDK's `ai.models.embedContent(...)` — i.e. the **Gemini API** (API-key auth: `VITE_GEMINI_API_KEY` client/scripts, `GEMINI_API_KEY` media-server), **not Vertex**. Every call sets `config: { taskType: 'SEMANTIC_SIMILARITY' }`, none sets `outputDimensionality` (default 3072 observed throughout).

| # | Site | Call | Input caps before the call | Token counting / overflow handling |
|---|---|---|---|---|
| 1 | Client node embed | [src/services/embeddingService.ts:199-207](../src/services/embeddingService.ts) (`embedNode`) | linkCard `transcript` → `slice(0, 3000)` (:86), tweet `transcript` → `slice(0, 3000)` (:95), tweet `youtubeTranscript` → `slice(0, 3000)` (:104). **No cap** on textCard text, title/description/tweetText, image/pdf labels. Tweets may add an inline image part (:115-121); imageCard/pdfCard add inline image data | **None** |
| 2 | Client generic text embed | [embeddingService.ts:277-290](../src/services/embeddingService.ts) (`embedText`) | **None — unbounded text** | **None** |
| 2a | — voice utterances | [src/services/voice/vadController.ts:1146](../src/services/voice/vadController.ts) (`embedText(transcript)`) | None (full utterance transcript) | None |
| 2b | — edge embeds | [embeddingService.ts:311-339](../src/services/embeddingService.ts) (`embedEdge` → `embedText`) | None ("label — explanation" text) | None |
| 3 | Media-server multimodal | [media-server/src/embed.ts:44-49](../media-server/src/embed.ts) (`embedMultimodal`) | Text = `transcript.slice(0, TRANSCRIPT_CHAR_LIMIT)` + `'\n\n'` + `mediaAnalysis` (uncapped) — `TRANSCRIPT_CHAR_LIMIT = 3000` ([process.ts:21](../media-server/src/process.ts)). Media: video trimmed to `EMBEDDING_TRIM_SECONDS = 120` (:22); videos > `LONG_FORM_THRESHOLD_SECONDS = 600` (:23) send audio-only. Comment (:161): "the embedding model caps video at 120s" | **None** on text; `retryOn503` wrapper is availability-retry, not overflow handling |
| 4 | Edge backfill script | [scripts/backfill-edge-embeddings.mjs:74-83](../scripts/backfill-edge-embeddings.mjs) | None | None |
| 5 | Deposits write path | [scripts/lib/depositsWritePath.mjs:165-170](../scripts/lib/depositsWritePath.mjs) | None (deposit bodies) | None |
| 6 | Multimodal probe (diagnostic only) | [scripts/probe-embedding-multimodal.mjs:29](../scripts/probe-embedding-multimodal.mjs) | n/a | n/a |

**`countTokens` appears nowhere in the codebase** (src, media-server, scripts). No call site inspects response metadata for truncation, and no site handles input-too-long errors distinctly. The only caps anywhere are the character constants above: the two independent **3,000-char transcript slices** (client and media-server — same number, duplicated constants) and the media-server's **post-embed** summary caps `SUMMARY_MAX_CHARS = 500` / `TWEET_TEXT_MAX_CHARS = 120` ([media-server/src/supabase.ts:40,47](../media-server/src/supabase.ts)) — note those two shape only the *stored* `content_summary`, **not** the embed input (the embedding is computed in `process.ts` before `upsertEmbedding` formats the summary).

Worst-case composed text input observed in code: a tweet with both `transcript` and `youtubeTranscript` → up to ~6,000 chars of transcript + tweetText/title segments (site 1); `embedText` callers are unbounded (sites 2a/2b/4/5). Whether any of these can exceed the governing token limit — and what that limit is for this model string on this API surface, given the documented 8,192-token / silent-truncation behavior varies by model and surface — is exactly the design question this read feeds; nothing in the code measures or guards it.

## 3. Prod cross-check — orphaned embedding rows (SELECT only, target echoed above)

```
orphan_rows | orphan_active | orphan_archived
         28 |             0 |              28
```

All 28 embedding rows whose `(node_id, board_id)` matches no current node are **archived; zero are active**. The probe's implication is confirmed on this axis — no active orphans. Per §1, this is evidence the archive side effect has fired reliably *so far*, not a guarantee: path (c) leaves active rows by construction, and path (a)'s archive is deferred, droppable, and fail-soft. Note the orphan axis turned out not to be the live-correctness risk anyway: §1.6 shows the retrieval RPC ignores `archived_at`, so the exposed rows are the archived ones with *live* node ids, not orphans.

## 4. Interpretation (quarantined — everything above is code citation and one SELECT)

- The archive mechanism is best-effort client-side bookkeeping layered on a sync path that knows nothing about embeddings. It has held in prod (0 active orphans), but three identified paths can leak an active stale vector, and the fix design should treat `(node_id, board_id)` as a generation-ambiguous key rather than a stable identity.
- The "archived-only current node" hole is not an exotic race — it's structural: *nothing ever un-archives a row*, so any card whose client id was ever deleted-and-reused never regains visibility in the archived-filtering readers, while voice retrieval serves whatever the row holds — current or predecessor content — with no signal distinguishing the two.
- The two sharpest single defects surfaced: the `'server'` precheck (§1.4.2), which can permanently pin a card to a predecessor's vector, and the missing `archived_at` filter in `match_retrieval_context` (§1.6), which makes one predecessor-content row servable in prod today.
- For the embed-composition fix: all sites share one model string and API surface, so one limit governs everywhere; the practical exposure is the unbounded `embedText` family and the media parts, not the 3,000-char transcript slices (which are comfortably under 8,192 tokens for English text on their own).

## 5. Open questions

1. What is the authoritative input-token limit for `gemini-embedding-2-preview` via the Gemini API's `embedContent`, and how are inline video/audio parts tokenized against it? (The 120s video trim suggests an empirically-found media cap; no doc reference exists in code.)
2. ~~Does retrieval filter on `archived_at IS NULL`?~~ Answered in §1.6: no — `match_retrieval_context` and `extract-snapshot-themes` do not; `generate-profile-snapshot`'s main read does. Follow-on question: was the omission in 032–034 deliberate (leaning on `p_live_node_ids` as the sole liveness signal) or an oversight?
3. Can the client id counter actually regress in prod (enabling the §1.4.3 same-cycle race), or is cross-generation reuse only via the counter-reset paths (`resetNodeIdCounter`) seen on board switch/delete?
4. Should the fix design clear `archived_at` on successful re-embed (making upsert mean "this node is live"), or key embeddings on a generation-stable id instead? (Design question, not answered here.)
