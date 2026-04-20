-- Phase 1 of the localStorage -> Supabase migration.
-- Greenfield tables for boards, nodes, edges, and voice sessions.
-- All four get strict RLS (auth.uid() = user_id) from the start — no
-- existing clients touch these tables, so we enforce from day one.
--
-- Down migration: drop tables in reverse order (voice_sessions, edges,
-- nodes, boards), then drop the update_updated_at_column() function.

-- Shared trigger function to keep updated_at honest on row updates.
create or replace function update_updated_at_column()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

-- boards -------------------------------------------------------------
create table boards (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index boards_user_id_idx on boards(user_id);

create trigger update_boards_updated_at
  before update on boards
  for each row execute function update_updated_at_column();

alter table boards enable row level security;

create policy "Users can access their own boards"
  on boards
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- nodes --------------------------------------------------------------
create table nodes (
  id uuid primary key default gen_random_uuid(),
  board_id uuid not null references boards(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  card_type text not null check (card_type in ('text', 'image', 'link', 'pdf')),
  link_type text check (link_type in ('tweet', 'youtube', 'generic') or link_type is null),
  position_x double precision not null default 0,
  position_y double precision not null default 0,
  title text,
  url text,
  source text,
  text_content text,
  image_url text,
  description text,
  data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index nodes_board_id_idx on nodes(board_id);
create index nodes_user_id_idx on nodes(user_id);
create index nodes_card_type_idx on nodes(card_type);

create trigger update_nodes_updated_at
  before update on nodes
  for each row execute function update_updated_at_column();

alter table nodes enable row level security;

create policy "Users can access their own nodes"
  on nodes
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- edges --------------------------------------------------------------
create table edges (
  id uuid primary key default gen_random_uuid(),
  board_id uuid not null references boards(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  source_node_id uuid not null references nodes(id) on delete cascade,
  target_node_id uuid not null references nodes(id) on delete cascade,
  relationship_label text,
  data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index edges_board_id_idx on edges(board_id);
create index edges_user_id_idx on edges(user_id);
create index edges_source_node_id_idx on edges(source_node_id);
create index edges_target_node_id_idx on edges(target_node_id);

create trigger update_edges_updated_at
  before update on edges
  for each row execute function update_updated_at_column();

alter table edges enable row level security;

create policy "Users can access their own edges"
  on edges
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- voice_sessions (Phase 2 placeholder) -------------------------------
create table voice_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  board_id uuid not null references boards(id) on delete cascade,
  connection_context jsonb not null default '{}'::jsonb,
  audio_url text,
  transcript jsonb,
  started_at timestamptz,
  ended_at timestamptz,
  created_at timestamptz not null default now()
);

create index voice_sessions_user_id_idx on voice_sessions(user_id);
create index voice_sessions_board_id_idx on voice_sessions(board_id);

alter table voice_sessions enable row level security;

create policy "Users can access their own voice sessions"
  on voice_sessions
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
