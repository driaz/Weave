-- Migration 017: replace_board_contents upserts nodes instead of delete-and-reinsert.
--
-- Migration 012 wiped all nodes for the board on every save and reinserted
-- them, which reset created_at to now() on every save. The original creation
-- time of any node was lost the moment a second save touched the board —
-- "node added 3 weeks ago" was indistinguishable from "node added 1s ago".
--
-- This migration changes the node path to:
--   1. Prune: delete nodes whose data->>'_clientNodeId' isn't in the
--      incoming payload (FK cascade still drops their edges).
--   2. Match each incoming node against the existing row by client id.
--      Hit  → UPDATE in place. created_at is preserved; the existing
--             update_nodes_updated_at trigger advances updated_at.
--      Miss → INSERT a fresh row, capturing the new uuid.
--   3. Either way, populate id_map[client_id] = server uuid so edges can
--      resolve their source/target the same way as before.
--
-- Edges still wipe-and-reinsert. Edges are derived (Claude can redraw
-- the whole connection set on a single reasoning run), so a stable
-- created_at carries no meaning the way it does on user-created nodes.
-- If edges grow load-bearing metadata later, mirror this pattern.
--
-- The data jsonb on UPDATE is replaced by the client-provided value, not
-- merged. Same semantic as before (the client save is authoritative for
-- the data blob). Server-added fields like media_analysis live in data
-- too — they survive a save iff hydration round-trips them through the
-- client. That's an existing assumption, not a new one this migration
-- introduces.
--
-- Assumes every live node has data->>'_clientNodeId' set. syncBoard.ts:117
-- has stashed it on every write since migration 012 shipped, so any live
-- row in the table must have it. Rows missing it would be invisible to
-- both the prune step (NULL <> all (...) is NULL → not deleted) and the
-- upsert lookup (would always miss → orphaned). Don't expect to see any.
--
-- Down migration:
--   re-run migration 012.

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
  v_user_id          uuid;
  v_node             jsonb;
  v_edge             jsonb;
  v_client_id        text;
  v_existing_id      uuid;
  v_resolved_id      uuid;
  v_source_id        uuid;
  v_target_id        uuid;
  id_map             jsonb := '{}'::jsonb;
  incoming_client_ids text[];
begin
  -- Auth + ownership: same checks migration 012 had, same error codes.
  v_user_id := auth.uid();
  if v_user_id is null then
    raise exception 'replace_board_contents: not authenticated'
      using errcode = '28000';
  end if;

  if not exists (
    select 1 from boards
    where id = p_board_id and user_id = v_user_id
  ) then
    raise exception 'replace_board_contents: board % not found or not owned', p_board_id
      using errcode = '42501';
  end if;

  -- Collect every incoming client id once so the prune step is a single
  -- DELETE rather than N separate ones.
  select array_agg(elem->>'client_id')
    into incoming_client_ids
    from jsonb_array_elements(p_nodes) elem;

  -- Prune nodes the client no longer has. Empty array case (board fully
  -- cleared) works because <> all (array[]::text[]) is TRUE for any value.
  delete from nodes
   where board_id = p_board_id
     and user_id  = v_user_id
     and (data->>'_clientNodeId') <> all (
           coalesce(incoming_client_ids, array[]::text[])
         );

  -- Upsert loop. Look up by client id; UPDATE if found, INSERT if not.
  for v_node in select * from jsonb_array_elements(p_nodes)
  loop
    v_client_id := v_node->>'client_id';

    select id into v_existing_id
      from nodes
     where board_id = p_board_id
       and user_id  = v_user_id
       and data->>'_clientNodeId' = v_client_id
     limit 1;

    if v_existing_id is not null then
      update nodes
         set card_type    = v_node->>'card_type',
             link_type    = v_node->>'link_type',
             position_x   = coalesce((v_node->>'position_x')::double precision, 0),
             position_y   = coalesce((v_node->>'position_y')::double precision, 0),
             title        = v_node->>'title',
             description  = v_node->>'description',
             url          = v_node->>'url',
             source       = v_node->>'source',
             text_content = v_node->>'text_content',
             image_url    = v_node->>'image_url',
             data         = coalesce(v_node->'data', '{}'::jsonb)
       where id = v_existing_id;
      v_resolved_id := v_existing_id;
    else
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
      returning id into v_resolved_id;
    end if;

    id_map := id_map || jsonb_build_object(v_client_id, v_resolved_id);
  end loop;

  -- Edges: wipe and reinsert. See header comment for why this stays
  -- delete-and-reinsert rather than mirroring the node upsert.
  delete from edges
   where board_id = p_board_id
     and user_id  = v_user_id;

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

  -- Sidebar "recently active" ordering relies on this; the
  -- update_boards_updated_at trigger handles the assignment.
  update boards
    set updated_at = now()
  where id = p_board_id
    and user_id = v_user_id;
end;
$$;

-- create or replace preserves the existing privileges, but re-granting
-- keeps the migration self-contained for fresh-project bootstraps.
grant execute on function replace_board_contents(uuid, jsonb, jsonb)
  to authenticated, anon;
