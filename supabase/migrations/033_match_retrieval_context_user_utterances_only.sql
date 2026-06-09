-- Migration 033: restrict match_retrieval_context's utterance corpus to
-- user-speaker rows.
--
-- Live QA (Phase 10B) showed the retrievable utterance corpus is dominated by
-- speaker='assistant' rows. Assistant prose is generated FROM the edge being
-- discussed, so it scores artificially high against an edge-derived query
-- vector, crowds curated nodes out of top-k, and compresses the score band.
--
-- Decision: retrieval should surface USER utterances only — the user's own
-- prior reasoning. Assistant turns stay in voice_utterances (nothing is
-- deleted, no embedding/write-path/schema change); they are simply no longer
-- returned by retrieval.
--
-- This is the ONLY change from migration 032: a single `and u.speaker = 'user'`
-- predicate added to the utterances_corpus CTE. It supersedes 032's deliberate
-- "speaker is NOT filtered here" stance (which deferred demotion to 10B prose
-- framing) — demoting at the framing layer didn't help because assistant rows
-- win on similarity and occupy top-k before framing ever runs. The node corpus,
-- the floor, the k-cap, exclusions, the prior-session filter, scoring, and the
-- function signature are all unchanged. Reversible: re-run 032 to restore.
--
-- Down migration:
--   re-run migration 032.

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
      -- User utterances only (migration 033). Assistant prose is generated from
      -- the edge and scores artificially high; it stays in the table but is not
      -- retrieved. This is the sole change vs. migration 032.
      and u.speaker = 'user'
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
