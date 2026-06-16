-- Migration 036: session_kind on voice_sessions + real-only deposits view.
--
-- Distinguishes genuine reflection sessions ('real') from QA / smoke-test
-- sessions ('qa'). The deposit corpus (voice_session_deposits, migration 035)
-- should be built from real sessions only; QA sessions pollute it with
-- throwaway content. This migration flags rather than deletes — QA sessions
-- stay queryable through `active_voice_session_deposits` (035), which keeps
-- the full picture and is left untouched. The new `real_voice_session_deposits`
-- view is the read surface that scopes to real sessions.
--
-- Three parts ship with this migration's branch (one PR): this schema, the
-- client change that sets `session_kind` at create from the hostname, and a
-- standalone backfill .sql (run manually) that flips the pre-036 QA rows. The
-- column's `default 'real'` backfills every existing row to 'real'; the
-- targeted UPDATE in the backfill flips only the QA ones.
--
-- Column, not enum: a `text` column with a CHECK constraint, not a CREATE TYPE
-- enum. Easier to evolve (no ALTER TYPE dance), and the CHECK is the fail-loud
-- at the system layer — a bad value is rejected by the DB itself, not caught by
-- application procedure.
--
-- Down migration:
--   drop view if exists real_voice_session_deposits;
--   alter table voice_sessions drop column if exists session_kind;

-- ========================================================================
-- 1. session_kind column
-- ========================================================================
-- default 'real' so every existing row backfills to 'real' on apply; the
-- manual backfill (036 backfill .sql) flips the known QA rows afterward.

alter table voice_sessions
  add column session_kind text not null default 'real'
    check (session_kind in ('real', 'qa'));

-- ========================================================================
-- 2. real_voice_session_deposits view
-- ========================================================================
-- Modeled exactly on `active_voice_session_deposits` (035): same deposit
-- columns, same `superseded_at is null` active filter, same
-- `security_invoker = true` posture so the caller's RLS on the base tables
-- applies. Adds only the join to voice_sessions and the
-- `session_kind = 'real'` filter. Selects the deposit columns (`d.*`) so the
-- view's shape is identical to active's — the join column set is not exposed.
--
-- RLS: security_invoker means both base-table policies apply under the
-- caller's rights — voice_session_deposits' ownership-via-session SELECT
-- policy (035) and voice_sessions' own-row SELECT policy (022). A user only
-- ever sees their own real deposits. weave_readonly reads through the base
-- tables' `readonly_audit_select` policies (prod-only, 035/022) under invoker
-- rights; prod default privileges auto-grant the role SELECT on the new view,
-- matching how the active view (035) is reached — no explicit grant here.

create view real_voice_session_deposits
  with (security_invoker = true) as
  select d.*
  from voice_session_deposits d
  join voice_sessions s on s.id = d.session_id
  where d.superseded_at is null
    and s.session_kind = 'real';
