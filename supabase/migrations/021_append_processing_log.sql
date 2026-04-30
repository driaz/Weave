-- Migration 021: append_processing_log RPC.
--
-- Atomic array-append into nodes.data->'processing_log'. Used by the Fly
-- media server's structured logger (media-server/src/logger.ts) to record
-- phase-level events on a node as it moves through the pipeline.
--
-- Why a dedicated RPC instead of reusing patch_node_data:
--   patch_node_data does `data = data || p_patch` (top-level merge), which
--   replaces the entire processing_log array on every call. We need an
--   atomic array concatenation so concurrent persist() calls don't clobber
--   each other.
--
-- Why p_client_id text and not a UUID:
--   The Fly server only sees the ReactFlow string id (e.g. "11"). The
--   actual nodes.id UUID is a server-side detail it never receives. Same
--   pattern as migration 016 (patch_node_data_by_client_id) — lookup by
--   data->>'_clientNodeId'.
--
-- Why p_user_id:
--   Service role bypasses RLS, so the WHERE clause is the only thing
--   stopping a buggy or compromised server from poking at other users'
--   nodes. Matches patch_node_data's defense-in-depth pattern.
--
-- Why jsonb_build_array(p_entry):
--   `jsonb || jsonb` does object-merge when both sides are objects and
--   array-concat when both sides are arrays. Wrapping the entry in a
--   one-element array forces array semantics so we don't accidentally
--   merge the entry into the existing array's last object.
--
-- Down migration:
--   drop function if exists append_processing_log(text, uuid, uuid, jsonb);

create or replace function append_processing_log(
  p_client_id text,
  p_board_id  uuid,
  p_user_id   uuid,
  p_entry     jsonb
)
returns void
language plpgsql
security invoker
as $$
declare
  v_updated int;
begin
  update nodes
     set data = jsonb_set(
       coalesce(data, '{}'::jsonb),
       '{processing_log}',
       coalesce(data->'processing_log', '[]'::jsonb) || jsonb_build_array(p_entry)
     )
   where data->>'_clientNodeId' = p_client_id
     and board_id = p_board_id
     and user_id  = p_user_id;

  get diagnostics v_updated = row_count;

  -- Soft-fail when the node hasn't been persisted yet — the client may
  -- still be inside its 500ms debounced save window when the server tries
  -- to log. Logging is fire-and-forget; never block the pipeline.
  if v_updated = 0 then
    raise notice 'append_processing_log: client node % not found in board % for user % (node may not be persisted yet)',
      p_client_id, p_board_id, p_user_id;
  end if;
end;
$$;

grant execute on function append_processing_log(text, uuid, uuid, jsonb)
  to service_role;
