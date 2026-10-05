-- Migration 040: create_voice_session + end_voice_session RPCs.
--
-- Why. Voice sessions launched on an edge woven in the current page load
-- landed with anchor_edge_id = null: the client's Connection had no db id
-- yet (replace_board_contents returned void; only the page-load fetch assigns
-- ids). 13 of 15 edge-less real sessions all-time, per
-- docs/reads/voice-launch-attribution.md (#61). Backfilled in #62.
--
-- create_voice_session replaces the client's direct PostgREST insert. When the
-- client supplies no anchor_edge_id but does supply the launch edge's
-- endpoints, the edge is resolved server-side on the SHARED CANONICAL RULE
-- (028/029/030 and #62's backfill key):
--
--     (board_id, coalesce(mode, ''), least(pair), greatest(pair))
--
-- The client only holds CLIENT node ids ("5", "7"), so endpoints are first
-- mapped to node uuids via nodes.data->>'_clientNodeId' within the board.
-- Each mapping must hit exactly one node; the edge lookup is unique by
-- edges_unique_directionless_mode. Anything else → anchor stays null. Never
-- guess.
--
-- The resolution attempt is recorded as the session's FIRST processing_log
-- entry: phase launch.anchor_edge_resolved (source server_resolve) or
-- launch.anchor_edge_unresolved (with the inputs and a reason). No entry when
-- the client supplied an id or supplied no endpoints — same as before.
--
-- end_voice_session replaces the client's direct UPDATE, which overwrote
-- processing_log with the client buffer and would erase the server entry
-- above. It APPENDS: server entries first, then the client buffer. Never
-- replaces. Not idempotent by design — the controller calls it exactly once
-- per session (it clears its session before persisting).
--
-- Both are security invoker: RLS on voice_sessions / nodes / edges applies
-- under the caller's rights, so resolution can only ever see the caller's
-- own rows. No new columns.
--
-- Down migration:
--   drop function if exists create_voice_session(uuid, jsonb, timestamptz, text, uuid, text, text, text);
--   drop function if exists end_voice_session(uuid, timestamptz, text, jsonb);
--   (the previous client inserts/updates directly; old bundles keep working
--   against the table either way.)

create or replace function create_voice_session(
  p_anchor_edge_id uuid,
  p_board_snapshot jsonb,
  p_started_at     timestamptz,
  p_session_kind   text,
  p_board_id       uuid default null,
  p_client_from    text default null,
  p_client_to      text default null,
  p_mode           text default null
)
returns voice_sessions
language plpgsql
security invoker
as $$
declare
  v_user_id     uuid;
  v_anchor      uuid := p_anchor_edge_id;
  v_from_id     uuid;
  v_to_id       uuid;
  v_n           int;
  v_reason      text;
  v_log         jsonb := '[]'::jsonb;
  v_inputs      jsonb;
  v_row         voice_sessions;
begin
  v_user_id := auth.uid();
  if v_user_id is null then
    raise exception 'create_voice_session: not authenticated'
      using errcode = '28000';
  end if;

  if v_anchor is null
     and p_board_id is not null
     and p_client_from is not null
     and p_client_to is not null then

    v_inputs := jsonb_build_object(
      'boardId', p_board_id,
      'clientFrom', p_client_from,
      'clientTo', p_client_to,
      'mode', p_mode
    );

    select count(*), min(id::text)::uuid into v_n, v_from_id
      from nodes
     where board_id = p_board_id
       and user_id  = v_user_id
       and data->>'_clientNodeId' = p_client_from;
    if v_n <> 1 then
      v_reason := case when v_n = 0 then 'from_node_not_found' else 'from_node_ambiguous' end;
    end if;

    if v_reason is null then
      select count(*), min(id::text)::uuid into v_n, v_to_id
        from nodes
       where board_id = p_board_id
         and user_id  = v_user_id
         and data->>'_clientNodeId' = p_client_to;
      if v_n <> 1 then
        v_reason := case when v_n = 0 then 'to_node_not_found' else 'to_node_ambiguous' end;
      end if;
    end if;

    if v_reason is null then
      -- Identical to 029's unique index expression — keep in lockstep.
      select id into v_anchor
        from edges
       where board_id = p_board_id
         and user_id  = v_user_id
         and least(source_node_id, target_node_id)    = least(v_from_id, v_to_id)
         and greatest(source_node_id, target_node_id) = greatest(v_from_id, v_to_id)
         and coalesce(mode, '') = coalesce(p_mode, '');
      if v_anchor is null then
        v_reason := 'edge_not_found';
      end if;
    end if;

    if v_anchor is not null then
      v_log := jsonb_build_array(jsonb_build_object(
        'phase', 'launch.anchor_edge_resolved',
        'outcome', 'success',
        'ts', to_char(clock_timestamp() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'detail', v_inputs || jsonb_build_object(
          'source', 'server_resolve',
          'anchorEdgeId', v_anchor
        )
      ));
    else
      v_log := jsonb_build_array(jsonb_build_object(
        'phase', 'launch.anchor_edge_unresolved',
        'outcome', 'degraded',
        'ts', to_char(clock_timestamp() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'detail', v_inputs || jsonb_build_object(
          'source', 'server_resolve',
          'reason', v_reason
        )
      ));
    end if;
  end if;

  insert into voice_sessions (
    user_id, anchor_edge_id, board_snapshot, started_at,
    processing_log, session_kind
  ) values (
    v_user_id,
    v_anchor,
    coalesce(p_board_snapshot, '{}'::jsonb),
    coalesce(p_started_at, now()),
    v_log,
    coalesce(p_session_kind, 'real')
  )
  returning * into v_row;

  return v_row;
end;
$$;

create or replace function end_voice_session(
  p_session_id uuid,
  p_ended_at   timestamptz,
  p_end_reason text,
  p_log        jsonb
)
returns voice_sessions
language plpgsql
security invoker
as $$
declare
  v_row voice_sessions;
begin
  if auth.uid() is null then
    raise exception 'end_voice_session: not authenticated'
      using errcode = '28000';
  end if;

  if p_log is not null and jsonb_typeof(p_log) <> 'array' then
    raise exception 'end_voice_session: p_log must be a jsonb array'
      using errcode = '22023';
  end if;

  update voice_sessions
     set ended_at       = p_ended_at,
         end_reason     = p_end_reason,
         processing_log = processing_log || coalesce(p_log, '[]'::jsonb)
   where id = p_session_id
     and user_id = auth.uid()
  returning * into v_row;

  if v_row.id is null then
    raise exception 'end_voice_session: session % not found or not owned', p_session_id
      using errcode = 'P0002';
  end if;

  return v_row;
end;
$$;

grant execute on function create_voice_session(uuid, jsonb, timestamptz, text, uuid, text, text, text)
  to authenticated;
grant execute on function end_voice_session(uuid, timestamptz, text, jsonb)
  to authenticated;
