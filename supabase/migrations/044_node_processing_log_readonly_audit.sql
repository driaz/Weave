-- Migration 044: weave_readonly audit pass-through on node_processing_log.
--
-- 043 created node_processing_log with RLS enabled and an owner-only
-- SELECT policy, but without the `readonly_audit_select` policy every
-- other prod table carries (pattern: 035 §4). weave_readonly does not
-- bypass RLS, so prod audit reads of the table returned 0 rows with no
-- error while pg_stat_user_tables showed rows inserted (observed
-- 2026-10-07 after the first prod pipeline run).
--
-- Same guard as 035: the role exists only on prod, and `create policy
-- ... to <role>` errors if the role is missing. No-op on dev. Prod
-- default privileges already grant the role SELECT on the table; this
-- adds only the RLS pass-through. The pass-through also covers
-- null-node rows (write.unresolved), which are otherwise service-role
-- only — weave_readonly is a read-only audit role, not an app user.
--
-- Down migration:
--   drop policy if exists "readonly_audit_select" on public.node_processing_log;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'weave_readonly') then
    create policy "readonly_audit_select" on public.node_processing_log
      for select to weave_readonly using (true);
  end if;
end
$$;
