-- Migration 012: transactional replace-all RPC for board contents.
--
-- Before this, the client orchestrated the board-save sequence as four
-- separate PostgREST requests: board upsert → DELETE nodes → INSERT
-- nodes → INSERT edges. The cascade FK on edges handles edge delete
-- implicitly. The problem: DELETE commits before INSERT runs, so a
-- mid-sequence failure (network, constraint, etc.) can leave a board
-- at 0 nodes / 0 edges until the next save. Fix A+B in the Prompt 5
-- cutover narrowed this window dramatically (no spurious saves, no
-- concurrent saves), but didn't close it.
--
-- This function bundles the replace into a single PL/pgSQL call so
-- the DELETE and both INSERTs live inside one implicit transaction.
-- Any exception rolls back all three, leaving the prior state intact.
--
-- Also updates boards.updated_at — previously only the rename path
-- touched the `boards` row, so "recently active" ordering in the
-- sidebar was stale across session activity. The existing
-- update_boards_updated_at trigger (migration 008) handles the
-- timestamp; we just need an UPDATE to fire it.
--
-- Down migration:
--   drop function if exists replace_board_contents(uuid, jsonb, jsonb);

create or replace function replace_board_contents(
  p_board_id uuid,
  p_nodes    jsonb,
  p_edges    jsonb
)
returns void
language plpgsql
security invoker
as $$
declare
  v_user_id   uuid;
  v_node      jsonb;
  v_edge      jsonb;
  v_new_id    uuid;
  v_source_id uuid;
  v_target_id uuid;
  id_map      jsonb := '{}'::jsonb;
begin
  -- Require an authenticated session. RLS would deny writes anyway
  -- without one, but the explicit check produces a cleaner error.
  v_user_id := auth.uid();
  if v_user_id is null then
    raise exception 'replace_board_contents: not authenticated'
      using errcode = '28000';
  end if;

  -- Belt-and-suspenders ownership check. Catches typos / stale board
  -- ids with a 42501 rather than a misleading constraint violation
  -- further down the function.
  if not exists (
    select 1 from boards
    where id = p_board_id and user_id = v_user_id
  ) then
    raise exception 'replace_board_contents: board % not found or not owned', p_board_id
      using errcode = '42501';
  end if;

  -- Wipe existing nodes. FK cascade on edges (migration 008) clears
  -- any prior edges too, so there's no separate DELETE FROM edges.
  -- Both filters (board_id + user_id) guard against future RLS
  -- changes; RLS alone would enforce this today.
  delete from nodes
  where board_id = p_board_id
    and user_id  = v_user_id;

  -- Insert new nodes and build the client_id → server_id map so we
  -- can resolve edge source/target references in the same call.
  for v_node in select * from jsonb_array_elements(p_nodes)
  loop
    insert into nodes (
      board_id, user_id, card_type, link_type,
      position_x, position_y,
      title, description, url, source, text_content, image_url,
      data
    ) values (
      p_board_id,
      v_user_id,
      v_node->>'card_type',
      v_node->>'link_type',
      coalesce((v_node->>'position_x')::double precision, 0),
      coalesce((v_node->>'position_y')::double precision, 0),
      v_node->>'title',
      v_node->>'description',
      v_node->>'url',
      v_node->>'source',
      v_node->>'text_content',
      v_node->>'image_url',
      coalesce(v_node->'data', '{}'::jsonb)
    )
    returning id into v_new_id;

    id_map := id_map || jsonb_build_object(v_node->>'client_id', v_new_id);
  end loop;

  -- Insert edges, resolving client_source_id / client_target_id
  -- through the just-built map.
  for v_edge in select * from jsonb_array_elements(p_edges)
  loop
    v_source_id := (id_map->>(v_edge->>'client_source_id'))::uuid;
    v_target_id := (id_map->>(v_edge->>'client_target_id'))::uuid;

    if v_source_id is null or v_target_id is null then
      raise exception 'replace_board_contents: edge references unknown node (source=%, target=%)',
        v_edge->>'client_source_id', v_edge->>'client_target_id'
        using errcode = '22023';
    end if;

    insert into edges (
      board_id, user_id,
      source_node_id, target_node_id,
      relationship_label, data
    ) values (
      p_board_id,
      v_user_id,
      v_source_id,
      v_target_id,
      v_edge->>'relationship_label',
      coalesce(v_edge->'data', '{}'::jsonb)
    );
  end loop;

  -- Advance boards.updated_at so sidebar ordering reflects actual
  -- activity, not just renames. The update_boards_updated_at trigger
  -- does the assignment — the bare UPDATE is enough to fire it.
  update boards
    set updated_at = now()
  where id = p_board_id
    and user_id = v_user_id;
end;
$$;

grant execute on function replace_board_contents(uuid, jsonb, jsonb)
  to authenticated, anon;
