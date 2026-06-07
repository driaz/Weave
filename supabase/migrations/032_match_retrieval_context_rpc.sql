-- Migration 032: Phase 10A — unified retrieval RPC.
--
-- One greenfield function that, given a query vector, returns the most
-- relevant past material for a board across TWO corpora that share the same
-- halfvec(3072) cosine space:
--
--   1. Curated artifacts  — weave_embeddings  (node content_summary)
--   2. Prior reasoning    — voice_utterances  (what was said in past sessions)
--
-- Returned ranked together so 10B can frame a single tight prompt section.
-- 10B owns prompt assembly and speaker framing; this function owns retrieval,
-- gating, and scoring.
--
-- SECURITY INVOKER (the default, stated explicitly): the function runs with the
-- caller's privileges, so RLS on both base tables applies automatically. A
-- caller only ever sees their own weave_embeddings and their own
-- voice_utterances — no cross-user leakage, no SECURITY DEFINER carve-out to
-- audit.
--
-- Exclusions are computed CLIENT-side and passed in (p_excluded_node_ids).
-- Rationale: weave_embeddings is keyed on client node ids while edges use
-- server uuids; joining those two id spaces in SQL is the only hard part, and
-- the client already holds the full graph in memory. So the client computes the
-- excluded set (anchor endpoints + graph-adjacent nodes) and we collapse the
-- join into `node_id <> all(:excluded)`.
--
-- Scoring is structured as f(similarity, engagement) with engagement pinned to
-- the identity value 1.0 — a one-line forward-compat hook for Phase 11. Today
-- score == similarity. No recency decay.
--
-- Down migration:
--   drop function if exists match_retrieval_context(
--     extensions.halfvec, text, double precision, int, text[], uuid);

create or replace function match_retrieval_context(
  query_embedding       extensions.halfvec(3072),
  p_board_id            text,
  p_match_threshold     double precision,   -- similarity floor; rows below are dropped
  p_match_count         int,                -- k: cap on total rows returned
  p_excluded_node_ids   text[],             -- client node ids to exclude (nodes corpus)
  p_current_session_id  uuid                -- utterances from this session are excluded
)
returns table (
  source     text,              -- corpus tag: 'node' | 'utterance'
  ref_id     text,              -- client node id (nodes) or utterance uuid (utterances)
  content    text,              -- injectable text: content_summary or utterance text
  speaker    text,              -- null for nodes; 'user' | 'assistant' for utterances
  node_type  text,              -- node_type for nodes; null for utterances
  similarity double precision,  -- cosine similarity vs. query_embedding (1 = identical)
  score      double precision   -- f(similarity, engagement); engagement = 1.0 today
)
language sql
stable
security invoker
set search_path = public, extensions
as $$
  with
  -- The Phase-11 engagement hook lives here as an explicit CTE column so the
  -- score expression below is literally f(similarity, engagement). Pinned to
  -- the identity value 1.0 in v1; no engagement logic yet.
  nodes_corpus as (
    select
      'node'::text                                          as source,
      e.node_id                                             as ref_id,
      e.content_summary                                     as content,
      null::text                                            as speaker,
      e.node_type                                           as node_type,
      (1 - (e.embedding <=> query_embedding))::double precision as similarity,
      1.0::double precision                                 as engagement
    from weave_embeddings e
    where e.board_id = p_board_id
      and e.embedding is not null
      -- Thin-summary guard: drop empty summaries and filename-only image/PDF
      -- summaries that match on vector but inject meaningless text. Length is a
      -- blunt proxy for "real content"; tune the floor as the corpus evolves.
      and e.content_summary is not null
      and char_length(btrim(e.content_summary)) >= 20
      -- Client-supplied exclusions (anchor endpoints + graph-adjacent nodes).
      and e.node_id <> all (coalesce(p_excluded_node_ids, array[]::text[]))
  ),
  utterances_corpus as (
    select
      'utterance'::text                                     as source,
      u.id::text                                            as ref_id,
      u.text                                                as content,
      u.speaker                                             as speaker,
      null::text                                            as node_type,
      (1 - (u.embedding <=> query_embedding))::double precision as similarity,
      1.0::double precision                                 as engagement
    from voice_utterances u
    where u.embedding is not null
      -- Prior sessions only. NULL current-session id (e.g. isolated tests with
      -- no live session) disables the filter rather than excluding everything,
      -- which a bare `<> NULL` would do.
      and (p_current_session_id is null or u.session_id <> p_current_session_id)
      -- Speaker is NOT filtered here: assistant utterances are returned, tagged,
      -- and left for 10B to frame/demote. Never silently dropped.
  ),
  combined as (
    select * from nodes_corpus
    union all
    select * from utterances_corpus
  )
  select
    source,
    ref_id,
    content,
    speaker,
    node_type,
    similarity,
    (similarity * engagement)::double precision as score
  from combined
  where similarity >= p_match_threshold       -- floor: nothing below clears
  order by score desc, ref_id                 -- ref_id tiebreak → stable ordering
  limit greatest(p_match_count, 0);           -- cap at k (guard negative k → 0)
$$;
