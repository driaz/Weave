-- Migration 043: node_processing_log — the server's log of record for
-- work done on a node.
--
-- Why a table: server-side processing entries were appended into
-- nodes.data->'processing_log' (021). replace_board_contents merges
-- nodes.data key-by-key (042), so every client save replaced that array
-- with the client's copy, which never held server entries. Measured
-- 2026-10-06 on prod: 0 of 85 nodes held a server-written entry. A
-- separate table is out of the save path entirely.
--
-- Ownership split:
--   nodes.data.processing_log — client-owned only (card-drop entries).
--   node_processing_log       — server-owned only; written through
--                               append_node_processing_log, never by
--                               direct INSERT in application code.
--
-- Entry shape mirrors voice_sessions.processing_log entries:
-- phase / ts / outcome / detail (040; confirmed on prod data 2026-10-07).
--
-- node_id is nullable: a server writer that holds only
-- (board_id, user_id, _clientNodeId) resolves it to a uuid at write
-- time, and zero matches is reachable (node not yet saved, or deleted
-- mid-pipeline). An unresolved write records a 'write.unresolved' row
-- with node_id null and its inputs in detail. Null-node rows match no
-- RLS select policy, so only the service role sees them.
--
-- Additive only: no existing object is altered. append_processing_log
-- (021) stays live with no callers.
--
-- Down migration:
--   drop function if exists public.append_node_processing_log(uuid, text, text, jsonb);
--   drop table if exists public.node_processing_log;

create table public.node_processing_log (
  id       uuid primary key default gen_random_uuid(),
  node_id  uuid references public.nodes(id) on delete cascade,
  phase    text not null,
  ts       timestamptz not null default now(),
  outcome  text,
  detail   jsonb not null default '{}'::jsonb
);

create index node_processing_log_node_ts
  on public.node_processing_log (node_id, ts);

alter table public.node_processing_log enable row level security;

-- Read: the owner of the node's board. No insert/update/delete policy —
-- every writer uses the service role, which bypasses RLS.
create policy "Users can read their own nodes' processing log"
  on public.node_processing_log
  for select
  using (
    exists (
      select 1
        from public.nodes n
        join public.boards b on b.id = n.board_id
       where n.id = node_processing_log.node_id
         and b.user_id = auth.uid()
    )
  );

create or replace function public.append_node_processing_log(
  p_node_id uuid,
  p_phase   text,
  p_outcome text  default null,
  p_detail  jsonb default '{}'::jsonb
)
returns uuid
language sql
security invoker
as $$
  insert into public.node_processing_log (node_id, phase, outcome, detail)
  values (p_node_id, p_phase, p_outcome, coalesce(p_detail, '{}'::jsonb))
  returning id;
$$;

revoke execute on function public.append_node_processing_log(uuid, text, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.append_node_processing_log(uuid, text, text, jsonb)
  to service_role;
