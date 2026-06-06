-- Migration 030: replace_board_contents upserts edges on the directionless,
-- mode-aware identity instead of (source, target, relationship_label).
--
-- Why this is a correctness fix, not just alignment. Migration 018 matched
-- edges on (source_node_id, target_node_id, relationship_label). That key was
-- wrong in two directions:
--   * Direction-sensitive: a re-analysis that returned B -> A for an existing
--     A -> B minted a second row (the reconciled "Dopamine spiral" pair on dev
--     was exactly this).
--   * mode-blind, label-keyed: two LEGITIMATE cross-mode connections on the
--     same pair that happened to share a relationship_label collapsed into one
--     row — silent data loss of a real, distinct edge.
--
-- The new key is the SHARED CANONICAL RULE (see migration 028 header; matches
-- 029's unique index and the client helper byte-for-byte):
--
--     (board_id,
--      coalesce(mode, ''),
--      least(source_node_id, target_node_id),
--      greatest(source_node_id, target_node_id))
--
-- mode is read from the incoming edge's data blob (the client writes it to
-- data.mode in connectionToRpcPayload) and written to BOTH the new mode column
-- and — via the data blob, unchanged — data->>'mode', preserving the dual-write
-- that hydration's connectionFromEdge still reads.
--
-- On an identity match we keep the existing row (first-write-wins on identity:
-- its id and created_at survive, which is what voice_sessions.anchor_edge_id
-- and Phase 10 embeddings rely on) and refresh its derived content (data blob
-- and relationship_label — label is NOT identity here, so a re-label of the
-- same pair+mode updates in place rather than minting a row).
--
-- The directionless SELECT also makes the RPC safe against the unique index
-- from 029: a payload that contains both A->B and B->A for one mode resolves
-- the second against the row the first just wrote, so no INSERT ever violates
-- the constraint.
--
-- Nodes path is byte-for-byte unchanged from 018.
--
-- Down migration:
--   re-run migration 018.

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
  v_mode              text;
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
  -- Edges: upsert on the directionless, mode-aware identity, then prune.
  ----------------------------------------------------------------------
  for v_edge in select * from jsonb_array_elements(p_edges)
  loop
    v_source_id := (id_map->>(v_edge->>'client_source_id'))::uuid;
    v_target_id := (id_map->>(v_edge->>'client_target_id'))::uuid;
    v_label     := v_edge->>'relationship_label';
    v_mode      := v_edge->'data'->>'mode';

    if v_source_id is null or v_target_id is null then
      raise exception 'replace_board_contents: edge references unknown node (source=%, target=%)',
        v_edge->>'client_source_id', v_edge->>'client_target_id'
        using errcode = '22023';
    end if;

    -- Directionless + mode-aware match. least()/greatest() collapse A->B and
    -- B->A; coalesce(mode,'') keeps the NULL-mode case symmetric. Identical to
    -- migration 029's unique index expression — keep in lockstep.
    select id into v_existing_edge_id
      from edges
     where board_id = p_board_id
       and user_id  = v_user_id
       and least(source_node_id, target_node_id)
             = least(v_source_id, v_target_id)
       and greatest(source_node_id, target_node_id)
             = greatest(v_source_id, v_target_id)
       and coalesce(mode, '') = coalesce(v_mode, '')
     limit 1;

    if v_existing_edge_id is not null then
      -- First-write-wins on identity: keep the row (id + created_at survive),
      -- refresh derived content. relationship_label is NOT identity now, so a
      -- re-label of the same pair+mode updates in place.
      update edges
         set data               = coalesce(v_edge->'data', '{}'::jsonb),
             relationship_label = v_label
       where id = v_existing_edge_id;
      v_resolved_edge_id := v_existing_edge_id;
    else
      insert into edges (
        board_id, user_id,
        source_node_id, target_node_id,
        relationship_label, mode, data
      ) values (
        p_board_id,
        v_user_id,
        v_source_id,
        v_target_id,
        v_label,
        v_mode,
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
