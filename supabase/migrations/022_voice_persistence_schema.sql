-- Migration 022: Phase 8 voice persistence schema.
--
-- Establishes durable storage for voice sessions and the utterances
-- within them. See docs/voice-persistence-design.md for the full
-- design rationale. Schema only — no client write logic, no sentinel
-- detection, no embedding generation. Those land in follow-up commits.
--
-- Drops the Phase 2 placeholder `voice_sessions` table introduced in
-- migration 008 and replaces it with the Phase 8 schema. The
-- placeholder has zero rows and no inbound foreign keys per the
-- pre-migration audit; no other migration references it. The client
-- module that targeted the old shape (src/persistence/voiceSessions.ts)
-- and the generated types in src/types/database.ts will go stale and
-- be rewritten alongside the Phase 8 write path.
--
-- Down migration: drop voice_utterances, drop voice_sessions, then
-- recreate the Phase 2 placeholder from migration 008. Practically,
-- prefer to forward-fix.

-- ========================================================================
-- 1. Drop the Phase 2 placeholder voice_sessions table
-- ========================================================================
-- The original policy from migration 008 was never updated by the auth
-- RLS cutover (014); both go away with the table.

drop table if exists voice_sessions cascade;

-- ========================================================================
-- 2. voice_sessions (Phase 8)
-- ========================================================================
create table voice_sessions (
  id              uuid        primary key default gen_random_uuid(),
  user_id         uuid        not null references auth.users(id) on delete cascade,
  anchor_edge_id  uuid        references edges(id) on delete set null,
  board_snapshot  jsonb       not null default '{}'::jsonb,
  started_at      timestamptz not null default now(),
  ended_at        timestamptz,
  end_reason      text        check (end_reason is null
                                     or end_reason in ('user_closed', 'idle_timeout', 'error')),
  processing_log  jsonb       not null default '[]'::jsonb,
  summary         text
);

-- anchor_edge_id is nullable so future entry points that aren't
-- edge-anchored (idle-prompt voice, etc.) can still record a session.
-- On edge delete we null the pointer rather than cascading — losing
-- the link is better than losing the session transcript.

create index voice_sessions_user_id_idx    on voice_sessions (user_id);
create index voice_sessions_started_at_idx on voice_sessions (started_at desc);

alter table voice_sessions enable row level security;

create policy "voice_sessions_select_own" on voice_sessions
  for select to authenticated using (auth.uid() = user_id);
create policy "voice_sessions_insert_own" on voice_sessions
  for insert to authenticated with check (auth.uid() = user_id);
create policy "voice_sessions_update_own" on voice_sessions
  for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "voice_sessions_delete_own" on voice_sessions
  for delete to authenticated using (auth.uid() = user_id);

-- ========================================================================
-- 3. voice_utterances
-- ========================================================================
create table voice_utterances (
  id               uuid        primary key default gen_random_uuid(),
  session_id       uuid        not null references voice_sessions(id) on delete cascade,
  user_id          uuid        not null references auth.users(id) on delete cascade,
  speaker          text        not null check (speaker in ('user', 'assistant')),
  text             text        not null,
  embedding        extensions.vector(3072) not null,
  utterance_index  int         not null,
  started_at       timestamptz not null,
  ended_at         timestamptz not null
);

-- user_id is denormalized from the parent session so the RLS policy
-- can be a single equality check without a join. Matches the pattern
-- used on weave_profile_cluster_embeddings (after migration 014).
--
-- The unique constraint on (session_id, utterance_index) enforces no
-- duplicate or out-of-order ordering: a client bug surfaces as a
-- constraint violation instead of silently corrupting transcript
-- order. Speaker column uses text + check (matching the card_type
-- pattern on nodes) rather than a Postgres enum, since the schema has
-- no enums elsewhere.

create unique index voice_utterances_session_index_unique
  on voice_utterances (session_id, utterance_index);

create index voice_utterances_user_id_idx
  on voice_utterances (user_id);

-- HNSW index deferred. vector(3072) exceeds pgvector's 2000-dim
-- limit for vector_cosine_ops (and the other standard vector ops).
-- The storage strategy that lifts this limit — halfvec(3072) with
-- halfvec_cosine_ops (4000-dim ceiling) vs. Matryoshka-truncating
-- the Gemini output to vector(2000) — affects weave_embeddings too,
-- so it's a broader design call. The index will be added in a
-- follow-up migration once the strategy is settled. Until then,
-- semantic retrieval over voice_utterances does a sequential scan,
-- which is fine while the table holds at most a few thousand rows.

alter table voice_utterances enable row level security;

create policy "voice_utterances_select_own" on voice_utterances
  for select to authenticated using (auth.uid() = user_id);
create policy "voice_utterances_insert_own" on voice_utterances
  for insert to authenticated with check (auth.uid() = user_id);
create policy "voice_utterances_update_own" on voice_utterances
  for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "voice_utterances_delete_own" on voice_utterances
  for delete to authenticated using (auth.uid() = user_id);
