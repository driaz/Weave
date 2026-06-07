-- Migration 031: Phase 10A — edge embedding store.
--
-- Mirrors weave_embeddings (the per-node store), but keyed on the SHIPPED
-- directionless, mode-aware EDGE identity instead of a node id. One row per
-- connection, holding the embedding of its "label — explanation" text so a
-- future phase can retrieve similar past *relationships*. (10A only WRITES
-- this store; the 10A retrieval RPC reads nodes + utterances, not edges.)
--
-- Identity. The canonical rule (migrations 028/029, connectionIdentity.ts):
--
--     (board_id, coalesce(mode, ''), least(src, tgt), greatest(src, tgt))
--
-- Here the canonicalization is MATERIALIZED into columns rather than computed
-- in an expression index: the client sorts the pair and coalesces the mode
-- before writing, so `mode` lands as '' (never NULL) and (node_lo, node_hi)
-- arrive already ordered. That keeps the unique index a plain multi-column
-- index — which `upsert(..., { onConflict: 'board_id,mode,node_lo,node_hi' })`
-- can target directly (an expression index cannot be named in onConflict). The
-- stored tuple is byte-for-byte the same identity the unique edge index and the
-- client dedup use; the only difference is WHERE the coalesce/least/greatest
-- happen (write-time here vs. query-time there).
--
-- Node id space. node_lo / node_hi are CLIENT node ids (text), matching
-- weave_embeddings.node_id — NOT the edges table's server uuids. This keeps the
-- edge-embedding store in the same id space as the node-embedding store and the
-- client-supplied exclusion arrays, so no cross-id-space join is ever needed.
--
-- Vector type. halfvec(3072) + halfvec_cosine_ops, identical to
-- weave_embeddings and voice_utterances (see migration 023), so all three
-- corpora share one comparable vector space.
--
-- RLS. User-scoped (auth.uid() = user_id), mirroring weave_embeddings after the
-- auth cutover (migration 014). user_id defaults to auth.uid() so the
-- client-side write — which never sets user_id explicitly, same as the node
-- embedding path — lands under the caller automatically.
--
-- Down migration:
--   drop table if exists weave_edge_embeddings;

create table if not exists weave_edge_embeddings (
  id              uuid        primary key default gen_random_uuid(),
  board_id        text        not null,
  user_id         uuid        not null default auth.uid()
                                  references auth.users(id) on delete cascade,
  -- Canonical identity, materialized. `mode` is the coalesced value (never
  -- NULL; '' stands in for "no mode"). node_lo <= node_hi by construction.
  mode            text        not null default '',
  node_lo         text        not null,
  node_hi         text        not null,
  embedding       extensions.halfvec(3072),
  content_summary text,
  metadata        jsonb,
  created_at      timestamptz not null default timezone('utc'::text, now())
);

-- The identity. Plain columns (not an expression) so onConflict can name it.
create unique index if not exists weave_edge_embeddings_identity_unique
  on weave_edge_embeddings (board_id, mode, node_lo, node_hi);

create index if not exists weave_edge_embeddings_board_idx
  on weave_edge_embeddings (board_id);

create index if not exists weave_edge_embeddings_user_id_idx
  on weave_edge_embeddings (user_id);

-- Vector index for parity with the other corpora and for the future
-- edges-as-corpus retrieval path (not queried in 10A). Pgvector defaults
-- (m=16, ef_construction=64), same as migration 023.
create index if not exists weave_edge_embeddings_embedding_hnsw_idx
  on weave_edge_embeddings
  using hnsw (embedding extensions.halfvec_cosine_ops);

alter table weave_edge_embeddings enable row level security;

create policy "weave_edge_embeddings_select_own" on weave_edge_embeddings
  for select to authenticated using (auth.uid() = user_id);
create policy "weave_edge_embeddings_insert_own" on weave_edge_embeddings
  for insert to authenticated with check (auth.uid() = user_id);
create policy "weave_edge_embeddings_update_own" on weave_edge_embeddings
  for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "weave_edge_embeddings_delete_own" on weave_edge_embeddings
  for delete to authenticated using (auth.uid() = user_id);
