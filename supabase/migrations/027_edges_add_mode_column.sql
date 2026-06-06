-- Migration 027: promote edge `mode` to a first-class column.
--
-- Background. Edge identity is about to become directionless + mode-aware
-- (migrations 028/029). `mode` ("weave" | "deeper" | "tensions") is the
-- analysis layer a connection belongs to, and it is part of identity:
-- cross-mode connections on the same node pair are DISTINCT edges that must
-- both survive. Until now `mode` lived only inside `data->>'mode'`. A unique
-- index and an upsert key are far cleaner against a real column than against
-- a jsonb path expression, so we promote it.
--
-- Dual-write, not migration of readers. `data->>'mode'` is still read by the
-- client hydration path (`connectionFromEdge` in src/persistence/hydration.ts
-- reads `edge.data.mode`). We do NOT touch that reader. Instead both the
-- column and the jsonb key are kept in sync going forward (the RPC in
-- migration 030 writes both). This migration backfills the column from the
-- existing jsonb so the two are consistent for historical rows.
--
-- Nullability. The column is left NULLABLE on purpose. Dev has 0 rows missing
-- data->>'mode', but prod is unmeasured; a NOT NULL with no sensible default
-- would be unsafe for legacy rows. The CHECK permits the three known modes or
-- NULL. The directionless unique index (029) and the reconciliation (028)
-- both canonicalize NULL via coalesce(mode, '') so a missing mode is treated
-- consistently everywhere rather than silently escaping dedup.
--
-- Safe to stop here: adds a nullable column + backfill, breaks nothing.
--
-- Down migration:
--   alter table edges drop column mode;

alter table edges
  add column if not exists mode text
    check (mode in ('weave', 'deeper', 'tensions') or mode is null);

-- Backfill the column from the jsonb that has been the source of truth.
update edges
   set mode = data->>'mode'
 where mode is null
   and data->>'mode' is not null;
