-- Backfill title for fixture snapshot row(s).
-- Matches by fixture flag (env-agnostic across dev/prod) and
-- skips rows that already have a title (idempotent).

update weave_profile_snapshots
set generation_metadata = coalesce(generation_metadata, '{}'::jsonb)
  || '{"title": "Clarity as cost, not reward"}'::jsonb
where generation_metadata @> '{"fixture": true}'::jsonb
  and not (generation_metadata ? 'title');
