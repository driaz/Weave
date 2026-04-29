-- Migration 020: skip the node UPDATE entirely when nothing would change.
--
-- update_nodes_updated_at fires on every UPDATE that touches the row,
-- even one where every assigned column equals its existing value. Combined
-- with debounced client saves, that means moving the cursor over a card
-- can be enough to refresh updated_at — "last edited" timestamps lose
-- meaning fast.
--
-- Add a WHERE on the UPDATE that requires at least one assigned column
-- to actually differ. The data jsonb gets the merge-aware comparison
-- `data IS DISTINCT FROM (data || coalesce(...))` so a payload that
-- would merge to the same blob is treated as no-op. Other columns get
-- the direct comparison.
--
-- IS DISTINCT FROM (rather than <>) is required throughout because most
-- of these columns are nullable; <> on NULLs returns NULL, which the
-- WHERE treats as not-true and the row gets a stealth false-positive
-- "no change" verdict in the wrong direction.
--
-- Why all columns instead of just data: most columns are derived from
-- the client's data blob (title from data.title, position_x from
-- data.position.x, etc. — see syncBoard.ts:80-134), so they tend to
-- co-vary. But image_url can change when a fresh Storage upload lands
-- without the data blob changing, so a data-only check would miss real
-- changes there.
--
-- Down migration:
--   re-run migration 019.

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
  -- Nodes: prune + upsert. UPDATE skips no-ops via comprehensive
  -- IS DISTINCT FROM check.
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
             data         = data || coalesce(v_node->'data', '{}'::jsonb)
       where id = v_existing_id
         and (
              card_type    is distinct from v_node->>'card_type'
           or link_type    is distinct from v_node->>'link_type'
           or position_x   is distinct from coalesce((v_node->>'position_x')::double precision, 0)
           or position_y   is distinct from coalesce((v_node->>'position_y')::double precision, 0)
           or title        is distinct from v_node->>'title'
           or description  is distinct from v_node->>'description'
           or url          is distinct from v_node->>'url'
           or source       is distinct from v_node->>'source'
           or text_content is distinct from v_node->>'text_content'
           or image_url    is distinct from v_node->>'image_url'
           or data         is distinct from (data || coalesce(v_node->'data', '{}'::jsonb))
         );
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
  -- Edges: unchanged from 018. (No no-op skip — edges are wholesale
  -- regenerated by Claude reasoning runs; "no real change" cases are
  -- rare and the no-op check would add complexity for little gain.)
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

  delete from edges
   where board_id = p_board_id
     and user_id  = v_user_id
     and id <> all (touched_edge_ids);

  update boards
    set updated_at = now()
  where id = p_board_id
    and user_id = v_user_id;
end;
$$;

grant execute on function replace_board_contents(uuid, jsonb, jsonb)
  to authenticated, anon;
