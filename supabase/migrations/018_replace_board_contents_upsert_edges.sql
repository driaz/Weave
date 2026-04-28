-- Migration 018: replace_board_contents upserts edges, mirroring 017's node path.
--
-- 017 left edges on delete-and-reinsert with the rationale that edges
-- are derived data and created_at carries no meaning. Closing the
-- consistency gap anyway: same algorithm everywhere is easier to reason
-- about than "nodes upsert but edges don't, except when X."
--
-- Edge identity has no client-supplied id the way nodes do
-- (connectionToRpcPayload only sends client_source_id, client_target_id,
-- relationship_label). The match key is therefore the natural triple:
-- (source_node_id, target_node_id, relationship_label). With node UUIDs
-- now stable across saves (017), an edge between the same pair of nodes
-- with the same label is the same edge across saves. Two edges between
-- the same pair with the same label would only have one match here and
-- the rest would get pruned — the client doesn't generate that, the
-- canvas can't show it, fine.
--
-- "is not distinct from" handles the NULL-label case symmetrically:
-- two edges with NULL labels match each other (= would return NULL).
--
-- Algorithm: upsert each incoming edge, accumulate touched ids, prune
-- everything else in this board. Order chosen so we never need to
-- pre-resolve client_source_id / client_target_id twice.
--
-- Down migration:
--   re-run migration 017.

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
  v_user_id           uuid;
  v_node              jsonb;
  v_edge              jsonb;
  v_client_id         text;
  v_existing_id       uuid;
  v_resolved_id       uuid;
  v_source_id         uuid;
  v_target_id         uuid;
  v_label             text;
  v_existing_edge_id  uuid;
  v_resolved_edge_id  uuid;
  id_map              jsonb := '{}'::jsonb;
  incoming_client_ids text[];
  touched_edge_ids    uuid[] := array[]::uuid[];
begin
  -- Auth + ownership: unchanged from 012/017.
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

  ----------------------------------------------------------------------
  -- Nodes: prune + upsert (unchanged from 017).
  ----------------------------------------------------------------------
  select array_agg(elem->>'client_id')
    into incoming_client_ids
    from jsonb_array_elements(p_nodes) elem;

  delete from nodes
   where board_id = p_board_id
     and user_id  = v_user_id
     and (data->>'_clientNodeId') <> all (
           coalesce(incoming_client_ids, array[]::text[])
         );

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

  ----------------------------------------------------------------------
  -- Edges: upsert keyed on (source, target, label), then prune.
  ----------------------------------------------------------------------
  for v_edge in select * from jsonb_array_elements(p_edges)
  loop
    v_source_id := (id_map->>(v_edge->>'client_source_id'))::uuid;
    v_target_id := (id_map->>(v_edge->>'client_target_id'))::uuid;
    v_label     := v_edge->>'relationship_label';

    if v_source_id is null or v_target_id is null then
      raise exception 'replace_board_contents: edge references unknown node (source=%, target=%)',
        v_edge->>'client_source_id', v_edge->>'client_target_id'
        using errcode = '22023';
    end if;

    select id into v_existing_edge_id
      from edges
     where board_id = p_board_id
       and user_id  = v_user_id
       and source_node_id = v_source_id
       and target_node_id = v_target_id
       and relationship_label is not distinct from v_label
     limit 1;

    if v_existing_edge_id is not null then
      -- data jsonb is fully replaced; relationship_label is part of
      -- the match key so it's by definition unchanged.
      update edges
         set data = coalesce(v_edge->'data', '{}'::jsonb)
       where id = v_existing_edge_id;
      v_resolved_edge_id := v_existing_edge_id;
    else
      insert into edges (
        board_id, user_id,
        source_node_id, target_node_id,
        relationship_label, data
      ) values (
        p_board_id,
        v_user_id,
        v_source_id,
        v_target_id,
        v_label,
        coalesce(v_edge->'data', '{}'::jsonb)
      )
      returning id into v_resolved_edge_id;
    end if;

    touched_edge_ids := array_append(touched_edge_ids, v_resolved_edge_id);
  end loop;

  -- Prune edges this save didn't touch. Empty incoming → wipes all
  -- edges in the board (id <> all (empty_array) is TRUE for any id).
  delete from edges
   where board_id = p_board_id
     and user_id  = v_user_id
     and id <> all (touched_edge_ids);

  -- Sidebar "recently active" ordering.
  update boards
    set updated_at = now()
  where id = p_board_id
    and user_id = v_user_id;
end;
$$;

grant execute on function replace_board_contents(uuid, jsonb, jsonb)
  to authenticated, anon;
