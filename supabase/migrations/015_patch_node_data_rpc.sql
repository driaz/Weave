-- Migration 015: partial jsonb update RPC for nodes.data.
--
-- The Fly media server (see media-server/) needs to write fields like
-- media_analysis into a node's data jsonb without round-tripping the
-- whole board through replace_board_contents. A direct UPDATE from the
-- server would race against the client's debounced full-board save:
-- read → modify → write loses any client edits that landed in between.
--
-- This RPC does the merge atomically inside one statement using the
-- jsonb || operator, so concurrent client saves and server patches
-- can't lose each other's changes.
--
-- Intentionally restricted to service_role for now. Clients save full
-- boards via replace_board_contents and don't have a use case for
-- partial node patches. Granting to authenticated would let any logged-in
-- session bypass the client's signature/debounce logic — open that door
-- only when there's a concrete reason to.
--
-- Down migration:
--   drop function if exists patch_node_data(uuid, uuid, uuid, jsonb);

create or replace function patch_node_data(
  p_node_id  uuid,
  p_board_id uuid,
  p_user_id  uuid,
  p_patch    jsonb
)
returns void
language plpgsql
security invoker
as $$
declare
  v_updated int;
begin
  -- Shallow merge via ||. Top-level keys in p_patch overwrite existing
  -- top-level keys in data; nested objects are replaced wholesale, not
  -- deep-merged. Matches our usage (one-shot writes of fields like
  -- media_analysis); revisit if a nested-key writer ever appears.
  --
  -- The board_id + user_id filter is the safety net regardless of who
  -- the caller is. Service role bypasses RLS, so this WHERE clause is
  -- what stops a buggy or compromised server from poking at other
  -- users' nodes. Triple-key match also catches stale node ids cleanly.
  update nodes
     set data = data || p_patch
   where id       = p_node_id
     and board_id = p_board_id
     and user_id  = p_user_id;

  get diagnostics v_updated = row_count;

  if v_updated = 0 then
    raise exception 'patch_node_data: node % not found in board % for user %',
      p_node_id, p_board_id, p_user_id
      using errcode = '42501';
  end if;
end;
$$;

grant execute on function patch_node_data(uuid, uuid, uuid, jsonb)
  to service_role;
