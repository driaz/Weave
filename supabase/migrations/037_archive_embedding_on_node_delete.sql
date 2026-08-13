-- Migration 037: system-layer archive of weave_embeddings on node deletion.
--
-- AFTER DELETE ON nodes, FOR EACH ROW: stamp archived_at on the matching
-- weave_embeddings row(s) via (board_id, data->>'_clientNodeId'). This
-- replaces the client-side archive side effects (the App.tsx queueSideEffect
-- path for confirm-dialog deletes and the useBoardStorage board-delete
-- archive, both removed in the same PR) with one mechanism at the database
-- layer that covers all three deletion paths — confirm-dialog delete, board
-- delete (cascade deletes nodes, firing this trigger per node, which is the
-- intended behavior), and sync prune inside replace_board_contents — and
-- cannot be dropped, raced, or fail-softed by the client.
--
-- ARCHIVE, NOT DELETE — do not "simplify" this into a DELETE. Archived rows
-- are designated dreaming substrate (H1); deletion traces are the ONLY
-- surviving evidence a card existed, because nodes hard-delete by cascade.
-- An archived embedding is a record, not garbage.
--
-- Identity join. weave_embeddings.board_id is text holding the board uuid
-- (the client-generated uuid is upserted verbatim as boards.id — see
-- syncBoard.upsertBoardRow), so old.board_id::text matches byte-for-byte
-- (both sides lowercase). weave_embeddings.node_id is the client node id,
-- i.e. nodes.data->>'_clientNodeId'.
--
-- Identity is knowingly generation-ambiguous: client node ids reuse across
-- card generations (backlog #5). Harmless here — at deletion time, every
-- row bearing the identity refers to a dead card; if a future card reuses
-- the id, un-archive-on-write revives the row on its first embed (embed
-- writers upsert with archived_at = null). Cross-board identity design
-- (#5) owns the real fix; do not attempt it in this trigger.
--
-- SECURITY DEFINER: deletes arrive under the deleting user's role (e.g.
-- replace_board_contents is security invoker), and weave_embeddings RLS
-- (migration 014) scopes updates to auth.uid() = user_id. A system-layer
-- archive must not silently miss rows whose user_id differs from the
-- deleting role (e.g. rows written by the media server's service role), so
-- the trigger function runs as its owner and pins search_path.
--
-- Hardening: search_path lists pg_temp explicitly LAST — otherwise
-- Postgres searches the caller's temp schema first, where a hostile
-- session could mask objects. The body's table reference is
-- schema-qualified on top of the pin (defense in depth).
--
-- The `archived_at is null` guard preserves the original archive timestamp
-- on already-archived rows instead of re-stamping it.
--
-- Row-level trigger is fine at this corpus size.
--
-- Down migration:
--   drop trigger if exists trg_archive_embedding_on_node_delete on nodes;
--   drop function if exists archive_embedding_on_node_delete();

create or replace function archive_embedding_on_node_delete()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if old.data->>'_clientNodeId' is not null then
    update public.weave_embeddings
       set archived_at = now()
     where board_id = old.board_id::text
       and node_id = old.data->>'_clientNodeId'
       and archived_at is null;
  end if;
  return old;
end;
$$;

drop trigger if exists trg_archive_embedding_on_node_delete on nodes;
create trigger trg_archive_embedding_on_node_delete
  after delete on nodes
  for each row
  execute function archive_embedding_on_node_delete();
