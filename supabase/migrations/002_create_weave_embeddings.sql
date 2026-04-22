-- Weave vector embedding store
-- Run this in the Supabase SQL editor or as a migration
-- Requires the pgvector extension (already enabled)

create table public.weave_embeddings (
  id uuid default gen_random_uuid() primary key,
  board_id text not null,
  node_id text not null,
  node_type text not null,
  embedding extensions.vector(3072),
  content_summary text,
  created_at timestamptz default timezone('utc'::text, now()) not null,
  metadata jsonb,
  unique(board_id, node_id)
);

create index idx_weave_embeddings_board on public.weave_embeddings(board_id);
create index idx_weave_embeddings_node_type on public.weave_embeddings(node_type);

alter table public.weave_embeddings enable row level security;
create policy "Allow anon insert" on public.weave_embeddings for insert with check (true);
create policy "Allow anon select" on public.weave_embeddings for select using (true);
