-- Migration 035: voice session deposits + summarization prompts + active view.
--
-- Deposits are interpretive claims about voice session transcripts — the
-- regenerable index layer over immutable utterances (the record). Contract:
-- a deposit row, once inserted, is immutable except `superseded_at`, and its
-- UUID never changes for the life of the row. Regeneration inserts new rows
-- under a new `generation` and stamps `superseded_at` on the prior
-- generation; it never updates row content. Consumers read
-- `active_voice_session_deposits` unless they explicitly need history.
-- Dreams (cross-session recombination) do NOT belong in this table — the
-- `type` check is deliberately closed.
--
-- Schema only — no write path. The summarization script stays read-only in
-- this PR; persistence lands in a follow-up. No backfill of the existing
-- session catalog here either.
--
-- No HNSW index on `embedding`: sequential scan is fine at current scale
-- (dozens of sessions); index when there's a corpus.
--
-- Down migration:
--   drop view if exists active_voice_session_deposits;
--   drop table if exists voice_session_deposits;
--   drop table if exists summarization_prompts;

-- ========================================================================
-- 1. summarization_prompts
-- ========================================================================
-- Versioned prompt bodies, so every deposit can name the exact prompt that
-- produced it (provenance for regeneration / comparison across versions).
-- Rows are written by the summarization pipeline via service role; the
-- table is global (not user-scoped), so there is no `user_id` and no
-- own-row policy — see RLS notes below.

create table summarization_prompts (
  version    text primary key,
  body       text not null,
  created_at timestamptz not null default now()
);

alter table summarization_prompts enable row level security;

-- Prompts are not per-user data; authenticated clients may read them (e.g.
-- to display provenance next to a deposit). Writes are service-role only
-- (no insert/update/delete policies; service role bypasses RLS).
create policy "summarization_prompts_select_authenticated" on summarization_prompts
  for select to authenticated using (true);

-- ========================================================================
-- 2. voice_session_deposits
-- ========================================================================
-- `embedding` is extensions.halfvec(3072) — verified identical to the live
-- voice_utterances.embedding type (migration 023), so deposits share the
-- same comparable vector space as the other three corpora. NOT NULL unlike
-- voice_utterances (024): deposits are minted by an offline script that
-- embeds synchronously, so there is no async-embedding window to allow for.
--
-- session_id cascades on session delete (matching voice_utterances):
-- deposits are derived, regenerable data — and auth.users → voice_sessions
-- already cascades, so a restrict here would break user deletion.
-- prompt_version deliberately restricts: a prompt version still referenced
-- by deposits must not be deleted.

create table voice_session_deposits (
  id             uuid        primary key default gen_random_uuid(),
  session_id     uuid        not null references voice_sessions(id) on delete cascade,
  generation     int         not null default 1,
  ordinal        int         not null,
  type           text        not null check (type in ('deposit', 'open_edge')),
  body           text        not null check (length(trim(body)) > 0),
  provenance     jsonb,
  embedding      extensions.halfvec(3072) not null,
  model          text        not null,
  prompt_version text        not null references summarization_prompts(version),
  created_at     timestamptz not null default now(),
  superseded_at  timestamptz,
  unique (session_id, generation, ordinal)
);

alter table voice_session_deposits enable row level security;

-- RLS: the prevailing voice-table pattern is four own-row policies on a
-- denormalized `user_id` (022/031). Deposits carry no user_id; ownership
-- flows through the parent session, so the select policy joins to
-- voice_sessions instead. Only SELECT is granted to authenticated: all
-- writes (insert new generation, stamp superseded_at) belong to the
-- server-side summarization pipeline via service role, and the
-- immutability contract above means client mutation policies would be
-- unused surface area.
create policy "voice_session_deposits_select_own" on voice_session_deposits
  for select to authenticated using (
    exists (
      select 1 from voice_sessions s
      where s.id = session_id and s.user_id = auth.uid()
    )
  );

-- ========================================================================
-- 3. Active view
-- ========================================================================
-- security_invoker so the caller's RLS on the base table applies (same
-- posture as match_retrieval_context, migration 032).

create view active_voice_session_deposits
  with (security_invoker = true) as
  select * from voice_session_deposits
  where superseded_at is null;

-- ========================================================================
-- 4. weave_readonly audit pass-through
-- ========================================================================
-- Prod (and only prod) has a `weave_readonly` role with a per-table
-- `readonly_audit_select` SELECT-using-(true) policy on every table, plus
-- default privileges that auto-grant it SELECT on new tables. The role
-- does not exist on dev, and `create policy ... to <role>` errors if the
-- role is missing — so the policies are created only when the role exists.
-- No-op on dev today; takes effect when this migration is promoted to prod.

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'weave_readonly') then
    create policy "readonly_audit_select" on summarization_prompts
      for select to weave_readonly using (true);
    create policy "readonly_audit_select" on voice_session_deposits
      for select to weave_readonly using (true);
  end if;
end
$$;
