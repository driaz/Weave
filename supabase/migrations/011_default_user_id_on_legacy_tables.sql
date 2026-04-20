-- Transition-period patch. Migration 009 made weave_embeddings.user_id
-- and weave_events.user_id NOT NULL, but the live localStorage app
-- still writes with the anon key and does not supply user_id. Without
-- a default, every embed and event insert fails with a 23502 NOT NULL
-- violation (failures are swallowed in console.warn, so the break is
-- silent).
--
-- Set the default to the single existing user's UUID — same value used
-- for the 009 backfill. Safe because there is exactly one user until
-- auth lands.
--
-- Down migration: alter table <t> alter column user_id drop default;
--
-- Deferred auth-cutover TODO (update for this migration):
-- When the persistence layer starts writing with authenticated
-- sessions, the follow-up migration should:
--   - drop these defaults (so callers must supply user_id)
--   - drop the anon policies on weave_embeddings and weave_events
--   - add user_id (+ backfill + NOT NULL + strict RLS) to
--     weave_profile_cluster_embeddings
--   - add strict "Users can access their own rows" policies on all
--     three tables

alter table weave_embeddings
  alter column user_id set default '92fcfcc8-fac9-466f-be22-afdfa71b9102'::uuid;

alter table weave_events
  alter column user_id set default '92fcfcc8-fac9-466f-be22-afdfa71b9102'::uuid;
