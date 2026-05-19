-- Migration: 026_backfill_fixture_snapshot_title
-- Adds a hand-written title to the fixture snapshot row's generation_metadata
-- so ReflectView (which now reads generation_metadata.title exclusively) has
-- a headline to display for the seed fixture.

update weave_profile_snapshots
set generation_metadata =
  coalesce(generation_metadata, '{}'::jsonb)
  || '{"title": "Clarity as cost, not reward"}'::jsonb
where id = '204af847-fa26-4e61-a699-c059fc5cd9e4';
