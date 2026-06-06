-- Migration 028: reconcile duplicate edges before the unique index (029).
--
-- THE SHARED CANONICAL RULE (defined here, mirrored byte-for-byte in 029's
-- unique index, in 030's upsert SELECT, and in the client TS helper
-- src/utils/connectionIdentity.ts). Edge identity is:
--
--     (board_id,
--      coalesce(mode, ''),                          -- mode-aware
--      least(source_node_id, target_node_id),       -- directionless
--      greatest(source_node_id, target_node_id))
--
-- A -> B and B -> A in the same mode are the SAME edge. Cross-mode siblings
-- on the same pair are DISTINCT (mode is in the key) and must both survive.
-- If any of the four sites keys on raw (source, target) order while another
-- normalizes, reversed-direction pairs drift through. Keep them identical.
--
-- DEDUP RULE: first-write-wins. Keep the row with the earliest created_at;
-- discard the rest. Measurement against dev showed every duplicate group
-- shares an identical created_at (rows minted in one save transaction), so
-- created_at alone is NOT deterministic — we add `id ASC` as a stable
-- secondary tiebreak. The winner is therefore deterministic and the
-- migration is idempotent (a second run finds no duplicates, backs up
-- nothing, deletes nothing).
--
-- DESTRUCTIVE: this DELETEs rows. Every deleted row is first copied, in full,
-- into edges_dedup_backup_028 (whole row as jsonb) so a wrong first-write-wins
-- call is recoverable. The discarded row may be a divergent reading rather
-- than noise; that loss is the accepted trade for permanence + simplicity, and
-- the backup makes it reversible.
--
--   Recovery of a specific backed-up row:
--     insert into edges
--     select * from jsonb_populate_record(
--       null::edges,
--       (select row_data from edges_dedup_backup_028 where edge_id = '<uuid>')
--     );
--
-- Must run BEFORE 029 — the unique index would reject the table while dupes
-- remain. Safe to stop here: leaves a de-duplicated, still-unconstrained table.
--
-- Down migration:
--   restore from edges_dedup_backup_028 (see recovery query above), then
--   drop table edges_dedup_backup_028;

create table if not exists edges_dedup_backup_028 (
  edge_id      uuid primary key,
  board_id     uuid,
  row_data     jsonb not null,
  backed_up_at timestamptz not null default now()
);

-- 1. Back up the losers (everything but the first-write-wins survivor per key).
with ranked as (
  select
    id,
    row_number() over (
      partition by
        board_id,
        coalesce(mode, ''),
        least(source_node_id, target_node_id),
        greatest(source_node_id, target_node_id)
      order by created_at asc, id asc
    ) as rn
  from edges
),
losers as (
  select id from ranked where rn > 1
)
insert into edges_dedup_backup_028 (edge_id, board_id, row_data)
select e.id, e.board_id, to_jsonb(e)
  from edges e
  join losers l on l.id = e.id
on conflict (edge_id) do nothing;

-- 2. Delete the same losers. Identical partition expression — keep in lockstep.
with ranked as (
  select
    id,
    row_number() over (
      partition by
        board_id,
        coalesce(mode, ''),
        least(source_node_id, target_node_id),
        greatest(source_node_id, target_node_id)
      order by created_at asc, id asc
    ) as rn
  from edges
)
delete from edges
 where id in (select id from ranked where rn > 1);
