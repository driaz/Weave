-- Soft delete support for weave_embeddings. When a node is deleted
-- from the canvas, its embedding row is marked with archived_at
-- rather than hard-deleted. The reasoning layer filters these out.
-- NULL = active node. Timestamp = archived at that time.

alter table weave_embeddings
  add column archived_at timestamptz default null;

-- Partial index so queries with `where archived_at is null` (which is
-- every query the snapshot function and Reflect view make) only scan
-- active rows.
create index idx_weave_embeddings_active
  on weave_embeddings (board_id)
  where archived_at is null;
