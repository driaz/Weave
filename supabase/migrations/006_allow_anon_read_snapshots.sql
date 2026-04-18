-- Allow the browser client to read snapshots for the Reflect view.
-- Read-only: anon can SELECT but not INSERT, UPDATE, or DELETE.
-- Writes remain service-role-only (via generate-profile-snapshot and
-- extract-snapshot-themes functions).
-- This will be replaced with auth.uid()-scoped policies in the
-- pre-demo auth pass.

create policy "Allow anonymous reads on snapshots"
  on weave_profile_snapshots
  for select
  to anon
  using (true);
