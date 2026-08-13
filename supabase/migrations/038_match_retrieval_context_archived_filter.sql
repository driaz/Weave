-- Migration 038: match_retrieval_context excludes archived rows.
--
-- PR-3 makes archived_at exact: `archived_at is not null` ⟺ the row's node
-- was deleted (migration 037 trigger) or its vector was superseded. Dead
-- rows must not serve. This migration adds `archived_at is null` to the
-- serving RPC's corpus predicate — both the diagnostics pass and the
-- eligible CTE, so the NOTICE counts keep describing exactly what the
-- query did.
--
-- Everything else is byte-for-byte migration 034 (node-only retrieval).
-- Signature is unchanged, so `create or replace` cleanly replaces the
-- single canonical overload 034 guaranteed.
--
-- The companion serving path, netlify/functions/extract-snapshot-themes.ts,
-- gets the same filter client-side in this PR — zero live cost (that
-- pipeline is dormant) but it prevents the dormant pipeline from waking
-- someday with different serving semantics than this one.
--
-- Archived rows stay in the table on purpose: dreaming substrate (H1) and
-- deletion traces. Filter at serving time, never reap. See migration 037's
-- header before touching them.
--
-- Down migration:
--   re-run migration 034.

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
  -- Diagnostics over the board's candidate pool (post thin-summary guard,
  -- post archived filter). The null-guard on p_live_node_ids matches the
  -- RETURN QUERY predicate below so the counts describe exactly what the
  -- query did.
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
    and e.archived_at is null
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
      -- Archived filter (PR-3): node deleted or vector superseded — never serve.
      and e.archived_at is null
      -- Thin-summary guard: drop empty / filename-only summaries that match on
      -- vector but inject meaningless text. Length is a blunt proxy for "real
      -- content"; unchanged from 032/033.
      and e.content_summary is not null
      and char_length(btrim(e.content_summary)) >= 20
      -- Self-exclusion: edge source nodes + graph-adjacent nodes (caller-supplied).
      and e.node_id <> all (coalesce(p_excluded_node_ids, array[]::text[]))
      -- Orphan-drop: keep only live board members. NULL disables (see 034 header).
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
    'match_retrieval_context[node-only,unarchived] board=% eligible=% self_excluded=% orphan_dropped=% deduped=% returned=%',
    p_board_id, v_eligible, v_self_excluded, v_orphan_dropped, v_deduped, v_total;
end;
$$;
