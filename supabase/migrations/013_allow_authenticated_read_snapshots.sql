-- Extend the Reflect read path to authenticated users.
--
-- Migration 006 granted SELECT on weave_profile_snapshots to the anon
-- role only, so signed-in users on production (who carry the
-- authenticated role in their JWT) got an empty response from RLS
-- even though the table had rows. That manifested as "No snapshots
-- found" in the Reflect view.
--
-- This grant mirrors the anon policy for the authenticated role. We
-- intentionally keep the policy wide (using (true)) because the table
-- has no user_id column yet — per-user scoping will land in a future
-- migration once we add ownership.
--
-- Writes remain service-role-only (generate-profile-snapshot /
-- extract-snapshot-themes functions).
--
-- Down migration:
--   drop policy if exists "Allow authenticated reads on snapshots"
--     on weave_profile_snapshots;

create policy "Allow authenticated reads on snapshots"
  on weave_profile_snapshots
  for select
  to authenticated
  using (true);
