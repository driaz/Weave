-- Add user_id to the pre-auth tables (weave_embeddings, weave_events)
-- in preparation for strict RLS. This migration does NOT flip the
-- anon-permissive policies to auth.uid() = user_id — the existing
-- localStorage-backed app still writes with the anon key and would
-- break the instant strict RLS lands. The deferred cutover is tracked
-- below.
--
-- Steps per table:
--   1. Add nullable user_id referencing auth.users(id)
--   2. Backfill with the sole existing user (hardcoded UUID below).
--      Safe because there is exactly one user today.
--   3. Set NOT NULL
--   4. Add user_id index
--
-- Down migration: drop index, drop column on each table.
--
-- TODO (deferred auth cutover):
-- Flip anon policies to strict RLS on weave_embeddings, weave_events,
-- and weave_profile_cluster_embeddings after the persistence layer is
-- writing with authenticated sessions. That follow-up migration
-- should:
--   - drop "Allow anon insert/select/update" on weave_embeddings and
--     weave_events
--   - add user_id (+ backfill + NOT NULL + RLS) to
--     weave_profile_cluster_embeddings (skipped here per spec)
--   - create "Users can access their own rows" policies using
--     auth.uid() = user_id on all three tables

-- weave_embeddings ---------------------------------------------------
alter table weave_embeddings
  add column user_id uuid references auth.users(id) on delete cascade;

update weave_embeddings
  set user_id = '92fcfcc8-fac9-466f-be22-afdfa71b9102'
  where user_id is null;

alter table weave_embeddings
  alter column user_id set not null;

create index idx_weave_embeddings_user_id on weave_embeddings(user_id);

-- weave_events -------------------------------------------------------
alter table weave_events
  add column user_id uuid references auth.users(id) on delete cascade;

update weave_events
  set user_id = '92fcfcc8-fac9-466f-be22-afdfa71b9102'
  where user_id is null;

alter table weave_events
  alter column user_id set not null;

create index idx_weave_events_user_id on weave_events(user_id);
