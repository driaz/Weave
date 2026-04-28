-- Migration 016: patch_node_data takes the client-side string id, not a UUID.
--
-- Migration 015 took p_node_id uuid, but the Fly media server only knows
-- the ReactFlow id (e.g. "11", "12"). The actual nodes.id column is a
-- UUID minted by replace_board_contents, which stashes the client id in
-- nodes.data->>'_clientNodeId' so hydration can round-trip and edges can
-- be resolved client_id → uuid. The 015 signature was unreachable — every
-- call from the server fails at the uuid type-cast before the WHERE clause
-- ever runs.
--
-- This migration drops the uuid-based function and recreates it with the
-- same name + new signature. Same name so the supabase.ts call site only
-- has to swap the param key (p_node_id → p_client_id). Old function had
-- no other callers (003-014 don't touch it; 015 only added it for the
-- Fly server which hadn't shipped yet).
--
-- Down migration:
--   drop function if exists patch_node_data(text, uuid, uuid, jsonb);
--   -- then re-run migration 015 to restore the uuid-based version.

drop function if exists patch_node_data(uuid, uuid, uuid, jsonb);

create or replace function patch_node_data(
  p_client_id text,
  p_board_id  uuid,
  p_user_id   uuid,
  p_patch     jsonb
)
returns void
language plpgsql
security invoker
as $$
declare
  v_updated int;
begin
  -- Lookup is by data->>'_clientNodeId' because the server's only handle
  -- on a node is the ReactFlow string id; the UUID nodes.id is a
  -- server-side detail it never sees. Same shallow merge semantics as
  -- 015 — top-level keys in p_patch overwrite, no deep merge.
  --
  -- board_id + user_id stay in the WHERE as the safety net regardless of
  -- caller. Service role bypasses RLS, so this clause is what stops a
  -- buggy or compromised server from poking at other users' nodes.
  update nodes
     set data = data || p_patch
   where data->>'_clientNodeId' = p_client_id
     and board_id = p_board_id
     and user_id  = p_user_id;

  get diagnostics v_updated = row_count;

  if v_updated = 0 then
    raise exception 'patch_node_data: client node % not found in board % for user %',
      p_client_id, p_board_id, p_user_id
      using errcode = '42501';
  end if;
end;
$$;

grant execute on function patch_node_data(text, uuid, uuid, jsonb)
  to service_role;
