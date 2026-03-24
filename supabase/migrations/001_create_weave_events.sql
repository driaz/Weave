-- Weave behavioral event log
-- Run this in the Supabase SQL editor or as a migration

create table if not exists weave_events (
  id          uuid primary key default gen_random_uuid(),
  event_type  text not null,
  target_id   text,                          -- board_id:node_id or edge ID (weave-{src}-{tgt}-{idx})
  board_id    text not null,
  session_id  text not null,
  timestamp   timestamptz not null default now(),
  duration_ms integer,
  metadata    jsonb
);

-- Index for querying events by session
create index if not exists idx_weave_events_session
  on weave_events (session_id, timestamp desc);

-- Index for querying events by board
create index if not exists idx_weave_events_board
  on weave_events (board_id, timestamp desc);

-- Index for querying by event type
create index if not exists idx_weave_events_type
  on weave_events (event_type, timestamp desc);

-- Enable Row Level Security (keeps table locked down by default)
alter table weave_events enable row level security;

-- Allow inserts from the anon key (public client-side tracking)
create policy "Allow anonymous inserts"
  on weave_events
  for insert
  to anon
  with check (true);

-- Allow reads from the anon key (needed for future analytics queries)
create policy "Allow anonymous reads"
  on weave_events
  for select
  to anon
  using (true);
