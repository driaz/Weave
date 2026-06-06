-- Migration 029: enforce edge uniqueness by construction.
--
-- Unique index on the SHARED CANONICAL RULE (see 028's header for the full
-- definition — this expression must match it, 030's upsert, and the client
-- helper byte-for-byte):
--
--     (board_id,
--      coalesce(mode, ''),
--      least(source_node_id, target_node_id),
--      greatest(source_node_id, target_node_id))
--
-- Because the key normalizes direction via least()/greatest(), this is a
-- unique index on an EXPRESSION, not a plain multi-column constraint — a
-- column constraint can't express "either ordering of the pair collides."
--
-- Requires migration 028 to have removed all duplicates first; index creation
-- fails loudly otherwise (good — that means a duplicate survived reconciliation
-- and the table should NOT be silently constrained around it).
--
-- After this index exists the table itself guarantees no directionless,
-- mode-aware duplicate can be inserted — the protection no longer depends on
-- the model honoring a soft "only NEW connections" instruction or on any
-- single client code path.
--
-- Down migration:
--   drop index edges_unique_directionless_mode;

create unique index if not exists edges_unique_directionless_mode
  on edges (
    board_id,
    coalesce(mode, ''),
    least(source_node_id, target_node_id),
    greatest(source_node_id, target_node_id)
  );
