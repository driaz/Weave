-- Migration 042: replace_board_contents restores node-data merge (019) and
-- the unchanged-node skip (020).
--
-- Base: migration 041 (the latest definition of this function; byte-identical
-- to live prod, md5(prosrc) = 662739c98377afe1ef818f492bd77db1 on 2026-10-06).
-- Restored intermediates: 019 (merge) and 020 (skip-unchanged), text copied
-- verbatim from 020_replace_board_contents_skip_node_noops.sql:107-121, which
-- carries 019's merge line unchanged.
--
-- Why. Migration 030 was written against 018's node path ("Nodes path is
-- byte-for-byte unchanged from 018", 030:38), silently reverting 019 and 020;
-- 041 inherited that body verbatim. Since then every client save has
-- (a) replaced nodes.data wholesale, deleting server-written keys the client
-- never loaded (media_analysis, server-written contentDescription), and
-- (b) UPDATEd every node on the board, so updated_at is board-uniform.
-- Record: docs/reads/board-sync-11.md.
--
-- Changes vs 041, node UPDATE branch only:
--   (a) data = coalesce(p_data)        ->  data = data || coalesce(p_data)  (019)
--   (b) where id = v_existing_id       ->  + IS DISTINCT FROM guard over all
--       eleven assigned columns, data compared merge-aware                (020)
-- Everything else — auth, prune, INSERT branch, the directionless
-- (pair, coalesce(mode,'')) edge path, and the jsonb return shape
-- [{id, client_source_id, client_target_id, mode}] — is byte-identical to 041.
--
-- Not addressed (by decision): server-appended processing_log entries are
-- still replaced when the client carries a stale array — the merge is
-- shallow, as it was under 019. No deep merge, no per-key special case.
--
-- CREATE OR REPLACE is sufficient: signature and return type (jsonb) are
-- unchanged from 041, and existing grants survive. The grant below is 041's,
-- repeated as an idempotent no-op. src/types/database.ts needs no
-- regeneration (no signature change).
--
-- Down migration:
--   re-run the function body of migration 041 with CREATE OR REPLACE
--   (do not re-run 041's DROP).

create or replace function replace_board_contents(
  p_board_id uuid,
  p_nodes    jsonb,
  p_edges    jsonb
)
returns jsonb
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
  resolved_edges      jsonb := '[]'::jsonb;
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
    resolved_edges := resolved_edges || jsonb_build_array(jsonb_build_object(
      'id',               v_resolved_edge_id,
      'client_source_id', v_edge->>'client_source_id',
      'client_target_id', v_edge->>'client_target_id',
      'mode',             v_mode
    ));
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

  return resolved_edges;
end;
$$;

grant execute on function replace_board_contents(uuid, jsonb, jsonb)
  to authenticated, anon;
