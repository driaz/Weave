-- Migration 014: Phase 1 auth RLS cutover.
--
-- Closes the patchwork of permissive / legacy RLS that accumulated
-- through the pre-auth era. After this runs, every public-schema
-- table that holds per-user data enforces strict
-- `auth.uid() = user_id` from authenticated clients only. The anon
-- role loses all access. Service-role writes (Netlify functions —
-- generate-profile-snapshot, extract-snapshot-themes, etc.) continue
-- to bypass RLS as they always have, which is correct.
--
-- Audit findings before this migration:
--   boards, nodes, edges       — user_id NOT NULL, no default,
--                                 FOR ALL policy with no role clause.
--   weave_events,
--   weave_embeddings           — user_id NOT NULL, default = the
--                                 single legacy user UUID
--                                 (migration 011), permissive policies
--                                 granted to anon.
--   weave_profile_snapshots    — no user_id column; permissive read
--                                 policies for anon and authenticated.
--   weave_profile_cluster_      — no user_id column; no policies
--   embeddings                    (service-role-only).
--
-- Down migration: drop the 28 new policies, drop the user_id
-- columns from the two snapshot tables, restore prior defaults
-- (hardcoded UUID for legacy tables, none for boards/nodes/edges),
-- and recreate the prior permissive policies. Practically, prefer to
-- forward-fix.

-- ========================================================================
-- 1. Add user_id to reasoning-layer tables
-- ========================================================================
-- Existing rows (pre-auth snapshots from prior runs) get NULL user_id
-- and become invisible under the new authenticated policies. Service
-- role still sees them. The snapshot generator will populate user_id
-- on future inserts via the auth.uid() default — but those inserts
-- run as service_role from a Netlify function, so the function must
-- pass user_id explicitly. (No code change needed: this migration
-- only locks the reads; writes already supply user_id where they
-- need to be readable client-side.)

alter table weave_profile_snapshots
  add column user_id uuid
    default auth.uid()
    references auth.users(id) on delete cascade;

create index idx_profile_snapshots_user_id
  on weave_profile_snapshots (user_id);

alter table weave_profile_cluster_embeddings
  add column user_id uuid
    default auth.uid()
    references auth.users(id) on delete cascade;

create index idx_profile_cluster_embeddings_user_id
  on weave_profile_cluster_embeddings (user_id);

-- ========================================================================
-- 2. Replace defaults: hardcoded UUID / none -> auth.uid()
-- ========================================================================
alter table boards            alter column user_id set default auth.uid();
alter table nodes             alter column user_id set default auth.uid();
alter table edges             alter column user_id set default auth.uid();
alter table weave_events      alter column user_id set default auth.uid();
alter table weave_embeddings  alter column user_id set default auth.uid();

-- ========================================================================
-- 3. Drop all existing policies on the in-scope tables
-- ========================================================================
drop policy if exists "Users can access their own boards" on boards;
drop policy if exists "Users can access their own nodes"  on nodes;
drop policy if exists "Users can access their own edges"  on edges;

drop policy if exists "Allow anonymous inserts" on weave_events;
drop policy if exists "Allow anonymous reads"   on weave_events;

drop policy if exists "Allow anon insert" on weave_embeddings;
drop policy if exists "Allow anon select" on weave_embeddings;

drop policy if exists "Allow anonymous reads on snapshots"     on weave_profile_snapshots;
drop policy if exists "Allow authenticated reads on snapshots" on weave_profile_snapshots;

-- ========================================================================
-- 4. Authenticated-only CRUD policies on every in-scope table
-- ========================================================================
-- Four policies per table (SELECT / INSERT / UPDATE / DELETE), all
-- TO authenticated, all qualified by auth.uid() = user_id.

-- boards -----------------------------------------------------------------
create policy "boards_select_own" on boards
  for select to authenticated using (auth.uid() = user_id);
create policy "boards_insert_own" on boards
  for insert to authenticated with check (auth.uid() = user_id);
create policy "boards_update_own" on boards
  for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "boards_delete_own" on boards
  for delete to authenticated using (auth.uid() = user_id);

-- nodes ------------------------------------------------------------------
create policy "nodes_select_own" on nodes
  for select to authenticated using (auth.uid() = user_id);
create policy "nodes_insert_own" on nodes
  for insert to authenticated with check (auth.uid() = user_id);
create policy "nodes_update_own" on nodes
  for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "nodes_delete_own" on nodes
  for delete to authenticated using (auth.uid() = user_id);

-- edges ------------------------------------------------------------------
create policy "edges_select_own" on edges
  for select to authenticated using (auth.uid() = user_id);
create policy "edges_insert_own" on edges
  for insert to authenticated with check (auth.uid() = user_id);
create policy "edges_update_own" on edges
  for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "edges_delete_own" on edges
  for delete to authenticated using (auth.uid() = user_id);

-- weave_events -----------------------------------------------------------
create policy "weave_events_select_own" on weave_events
  for select to authenticated using (auth.uid() = user_id);
create policy "weave_events_insert_own" on weave_events
  for insert to authenticated with check (auth.uid() = user_id);
create policy "weave_events_update_own" on weave_events
  for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "weave_events_delete_own" on weave_events
  for delete to authenticated using (auth.uid() = user_id);

-- weave_embeddings -------------------------------------------------------
create policy "weave_embeddings_select_own" on weave_embeddings
  for select to authenticated using (auth.uid() = user_id);
create policy "weave_embeddings_insert_own" on weave_embeddings
  for insert to authenticated with check (auth.uid() = user_id);
create policy "weave_embeddings_update_own" on weave_embeddings
  for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "weave_embeddings_delete_own" on weave_embeddings
  for delete to authenticated using (auth.uid() = user_id);

-- weave_profile_snapshots ------------------------------------------------
create policy "weave_profile_snapshots_select_own" on weave_profile_snapshots
  for select to authenticated using (auth.uid() = user_id);
create policy "weave_profile_snapshots_insert_own" on weave_profile_snapshots
  for insert to authenticated with check (auth.uid() = user_id);
create policy "weave_profile_snapshots_update_own" on weave_profile_snapshots
  for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "weave_profile_snapshots_delete_own" on weave_profile_snapshots
  for delete to authenticated using (auth.uid() = user_id);

-- weave_profile_cluster_embeddings ---------------------------------------
create policy "weave_profile_cluster_embeddings_select_own" on weave_profile_cluster_embeddings
  for select to authenticated using (auth.uid() = user_id);
create policy "weave_profile_cluster_embeddings_insert_own" on weave_profile_cluster_embeddings
  for insert to authenticated with check (auth.uid() = user_id);
create policy "weave_profile_cluster_embeddings_update_own" on weave_profile_cluster_embeddings
  for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "weave_profile_cluster_embeddings_delete_own" on weave_profile_cluster_embeddings
  for delete to authenticated using (auth.uid() = user_id);
