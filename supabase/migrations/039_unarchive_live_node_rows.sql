-- Migration 039: one-time data fix — un-archive embedding rows that are
-- still attached to live nodes.
--
-- This is coherence, not an exception. Post-PR-3, archived_at means "node
-- deleted or vector superseded" — dead rows don't serve (migrations 037 and
-- 038). The PR-2 corpus sweep left exactly three rows archived-but-live on
-- prod: the verified image tweets Daniel Ahmad, 🧬Maxpein🧬, and Pope Leo
-- XIV. They are attached to current nodes, their vectors verified to hold
-- their OWN content (never-worse invariant check, sweep cycle,
-- docs/sweep-run-record.md verification 1), and they are archived only as a
-- historical artifact of sweep exclusion. Leaving them archived would serve
-- a state contradiction — live cards dark for reasons the flag no longer
-- means. Their vectors are thin-but-honest until #17 ships image
-- analysis-at-ingest, at which point arrival triggers re-embed them richly.
--
-- The predicate is the invariant itself rather than hardcoded identifiers
-- (the sweep record identifies the rows by author, not node_id): un-archive
-- any archived row whose (board_id, node_id) matches a live node. After
-- this migration the invariant is exact in both directions:
--   archived_at is not null ⟺ node deleted or vector superseded.
--
-- Expected impact — prod: exactly 3 rows (the image tweets above; the 29
-- archived orphans have no live node and are untouched — they are dreaming
-- substrate, do not reap). Dev: whatever archived-but-live rows rehearsal
-- state holds; the NOTICE lists every affected row — check it against
-- expectations on each apply. Idempotent: a second run matches nothing.
--
-- Down migration: none (one-time data fix; re-archiving would need the
-- pre-apply row list from the NOTICE output).

do $$
declare
  r record;
  v_count int := 0;
begin
  for r in
    update weave_embeddings e
       set archived_at = null
     where e.archived_at is not null
       and exists (
         select 1
           from nodes n
          where n.board_id::text = e.board_id
            and n.data->>'_clientNodeId' = e.node_id
       )
    returning e.board_id, e.node_id, left(coalesce(e.content_summary, ''), 60) as summary_head
  loop
    v_count := v_count + 1;
    raise notice 'unarchived live-node row: board=% node=% summary=%',
      r.board_id, r.node_id, r.summary_head;
  end loop;

  raise notice 'migration 039: un-archived % archived-but-live row(s)', v_count;
end $$;
