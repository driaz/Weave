-- Migration 034: node-only retrieval (Phase 10B retrieval v1).
--
-- RESCOPE: drop the utterance corpus entirely. The utterance was the wrong
-- atomic unit for retrieval — fragments lack the context to be injectable on
-- their own — and the right unit (session summaries) does not exist:
-- voice_sessions.summary is NULL on every row (the summarization feature was
-- never built). So the only real retrieval corpus today is the node corpus,
-- whose content_summary carries genuine context (tweet author+text, YouTube
-- title+transcript) for the ~95% text-only LinkCards. Voice memory becomes a
-- separate future track that STARTS with summarization; until then, retrieving
-- raw utterances was surfacing context-free fragments. This migration removes
-- the utterance corpus and every utterance/session-only mechanism with it.
--
-- This is a SELECTION-LOGIC + SIGNATURE change only. No embedding changes, no
-- backfill, no write-path edits. voice_utterances / voice_sessions are left
-- entirely untouched (nothing is dropped) — they simply stop being read.
--
-- CHANGES vs. migration 033
--   KEEP (node side of 033):
--     - corpus = weave_embeddings where board_id = p_board_id, embedding not null
--     - thin-summary guard: content_summary not null AND char_length(btrim) >= 20
--     - self-exclusion: node_id <> all(p_excluded_node_ids)  [caller-supplied;
--       excludes the edge's source nodes + graph-adjacent nodes]
--     - similarity = 1 - (embedding <=> query_embedding), per-node floor
--     - score = similarity * engagement, engagement pinned to 1.0 (Phase-11 hook)
--     - ranked similarity desc, ref_id tiebreak
--   ADD:
--     - orphan-drop (Option B): new param p_live_node_ids text[]. Keep a row only
--       if its node_id is a live board member. The CALLER supplies live membership
--       from its in-memory graph (same source/contract as p_excluded_node_ids), so
--       the RPC stays dumb — no client-id <-> server-uuid join in SQL (the coupling
--       migration 032 deliberately avoided). Drops weave_embeddings rows whose
--       source node was deleted but whose embedding row was never reconciled.
--     - defensive `distinct on (node_id)` — a NO-OP within a single board, since
--       weave_embeddings has unique(board_id, node_id). Present as an explicit
--       contract + v2-readiness (cross-board pools can carry the same node twice).
--       Not load-bearing today; do not read meaning into it.
--   REPLACE:
--     - p_match_count -> p_total_cap (cap on total node rows returned). Same role,
--       clearer name now that there is one corpus and one cap.
--   REMOVE (utterance-only machinery — no second corpus to gate):
--     - the utterances_corpus CTE and the UNION
--     - p_current_session_id (session exclusion)
--     - the `speaker = 'user'` filter (migration 033's whole change)
--
-- The returns table is UNCHANGED (source, ref_id, content, speaker, node_type,
-- similarity, score); `source` is always 'node' and `speaker` always null now,
-- so the TS consumer (RetrievalRow) maps rows without any change.
--
-- SIGNATURE CHANGE NOTE: the old 6th arg was `uuid` (p_current_session_id); the
-- new 6th arg is `text[]` (p_live_node_ids). Postgres overloads on argument
-- types, so `create or replace` alone would leave the OLD function in place as a
-- second overload. We `drop function` the exact old signature first, then create
-- the new one.
--
-- OBSERVABILITY: language is plpgsql (was sql) solely so the function can
-- RAISE NOTICE one diagnostic line per call — nodes eligible, self-excluded,
-- orphan-dropped, deduped (expect 0 within-board), total returned — making a
-- node-light result explainable at a glance. The result set stays pure (no
-- diagnostic columns).
--
-- p_live_node_ids null-guard: a NULL array DISABLES orphan-drop (returns all
-- live + stale rows) rather than dropping everything, mirroring 032/033's
-- "NULL disables the filter" stance for p_current_session_id and avoiding a
-- footgun where a caller that forgot to populate the array silently zeroes
-- retrieval. An EMPTY array '{}' is meaningful: "no live nodes" -> drop all.
-- The live caller always passes a populated array, so this is pure defense.
--
-- Reversible: drop the new (… text[]) signature and re-run migration 033 to
-- restore the dual-corpus, user-utterances-only version.
--
-- Down migration:
--   drop function if exists match_retrieval_context(
--     extensions.halfvec, text, double precision, int, text[], text[]);
--   then re-run migration 033.

-- Remove EVERY existing overload of match_retrieval_context before recreating.
-- The old signature's 6th arg was `uuid` (p_current_session_id); the new one is
-- `text[]` (p_live_node_ids), so Postgres treats them as distinct overloads and
-- `create or replace` alone would leave the old one callable alongside the new.
-- An explicit `drop function (… uuid)` is brittle (one arg-type mismatch and it
-- silently no-ops, leaving a stale overload), so drop signature-agnostically by
-- iterating pg_proc — guaranteeing a single canonical function afterward.
do $$
declare
  r record;
begin
  for r in
    select oid::regprocedure as sig
    from pg_proc
    where proname = 'match_retrieval_context'
      and pronamespace = 'public'::regnamespace
  loop
    execute 'drop function ' || r.sig::text;
  end loop;
end $$;

create or replace function match_retrieval_context(
  query_embedding     extensions.halfvec(3072),
  p_board_id          text,
  p_match_threshold   double precision,   -- similarity floor; rows below are dropped
  p_total_cap         int,                -- cap on total node rows returned
  p_excluded_node_ids text[],             -- self-exclusion: edge source + adjacent nodes
  p_live_node_ids     text[]              -- orphan-drop: live board membership (null disables)
)
returns table (
  source     text,              -- always 'node' in v1
  ref_id     text,              -- client node id
  content    text,              -- content_summary
  speaker    text,              -- always null for nodes
  node_type  text,              -- node_type
  similarity double precision,  -- cosine similarity vs. query_embedding (1 = identical)
  score      double precision   -- f(similarity, engagement); engagement = 1.0 today
)
language plpgsql
stable
security invoker
set search_path = public, extensions
as $$
declare
  v_self_excluded  int := 0;
  v_orphan_dropped int := 0;
  v_eligible       int := 0;   -- survive thin-summary + self-excl + live (pre-floor)
  v_distinct       int := 0;   -- distinct node_id among eligible
  v_deduped        int := 0;   -- eligible - distinct (expect 0 within-board)
  v_total          int := 0;   -- rows actually returned (post-floor, post-cap)
begin
  -- Diagnostics over the board's candidate pool (post thin-summary guard).
  -- The null-guard on p_live_node_ids matches the RETURN QUERY predicate below
  -- so the counts describe exactly what the query did.
  select
    count(*) filter (
      where e.node_id = any (coalesce(p_excluded_node_ids, array[]::text[]))
    ),
    count(*) filter (
      where not (e.node_id = any (coalesce(p_excluded_node_ids, array[]::text[])))
        and p_live_node_ids is not null
        and not (e.node_id = any (p_live_node_ids))
    ),
    count(*) filter (
      where not (e.node_id = any (coalesce(p_excluded_node_ids, array[]::text[])))
        and (p_live_node_ids is null or e.node_id = any (p_live_node_ids))
    ),
    count(distinct e.node_id) filter (
      where not (e.node_id = any (coalesce(p_excluded_node_ids, array[]::text[])))
        and (p_live_node_ids is null or e.node_id = any (p_live_node_ids))
    )
  into v_self_excluded, v_orphan_dropped, v_eligible, v_distinct
  from weave_embeddings e
  where e.board_id = p_board_id
    and e.embedding is not null
    and e.content_summary is not null
    and char_length(btrim(e.content_summary)) >= 20;

  v_deduped := greatest(v_eligible - v_distinct, 0);

  return query
  with eligible as (
    -- distinct on (node_id): within-board no-op (unique(board_id, node_id)
    -- already guarantees one row per node). Explicit contract + v2-readiness.
    select distinct on (e.node_id)
      e.node_id                                                  as node_id,
      e.content_summary                                          as content,
      e.node_type                                                as node_type,
      (1 - (e.embedding <=> query_embedding))::double precision  as similarity
    from weave_embeddings e
    where e.board_id = p_board_id
      and e.embedding is not null
      -- Thin-summary guard: drop empty / filename-only summaries that match on
      -- vector but inject meaningless text. Length is a blunt proxy for "real
      -- content"; unchanged from 032/033.
      and e.content_summary is not null
      and char_length(btrim(e.content_summary)) >= 20
      -- Self-exclusion: edge source nodes + graph-adjacent nodes (caller-supplied).
      and e.node_id <> all (coalesce(p_excluded_node_ids, array[]::text[]))
      -- Orphan-drop: keep only live board members. NULL disables (see header).
      and (p_live_node_ids is null or e.node_id = any (p_live_node_ids))
    order by e.node_id
  )
  select
    'node'::text                            as source,
    el.node_id                              as ref_id,
    el.content                              as content,
    null::text                              as speaker,
    el.node_type                            as node_type,
    el.similarity                           as similarity,
    (el.similarity * 1.0)::double precision as score   -- engagement = 1.0 (Phase-11 hook)
  from eligible el
  where el.similarity >= p_match_threshold           -- floor: nothing below clears
  order by score desc, ref_id                        -- ref_id tiebreak → stable order
  limit greatest(p_total_cap, 0);                    -- cap (guard negative → 0)

  get diagnostics v_total = row_count;

  raise notice
    'match_retrieval_context[node-only] board=% eligible=% self_excluded=% orphan_dropped=% deduped=% returned=%',
    p_board_id, v_eligible, v_self_excluded, v_orphan_dropped, v_deduped, v_total;
end;
$$;
