-- Migration: 003_create_weave_profile_snapshots
-- Creates the profile snapshot and cluster embedding tables for the Weave reasoning layer.

create table weave_profile_snapshots (
  id                  uuid        primary key default gen_random_uuid(),
  created_at          timestamptz not null    default now(),
  board_ids           text[]      not null,
  node_count          int         not null,
  event_count         int         not null,

  -- Each element follows the shape:
  -- {
  --   cluster_id: string,
  --   member_node_ids: string[],     -- composite "board_id:node_id" keys
  --   anchor_node_ids: string[],     -- top 1-3 by engagement weight
  --   theme_description: string,
  --   engagement_weight: number,
  --   size: int,
  --   boards_touched: string[]
  -- }
  clusters            jsonb,

  -- Each element follows the shape:
  -- {
  --   node_a: string,                -- composite key
  --   node_b: string,                -- composite key
  --   similarity: number,
  --   surprise_score: number
  -- }
  bridges             jsonb,

  narrative           text,
  trigger_reason      text        not null default 'unknown',
  generation_metadata jsonb
);

-- Client always reads the latest snapshot first.
create index idx_profile_snapshots_created_at
  on weave_profile_snapshots (created_at desc);

-- For future jsonb querying against clusters.
create index idx_profile_snapshots_clusters
  on weave_profile_snapshots using gin (clusters);

-- Companion table: stores one embedding per cluster per snapshot.
create table weave_profile_cluster_embeddings (
  snapshot_id uuid  not null references weave_profile_snapshots(id) on delete cascade,
  cluster_id  text  not null,
  embedding   extensions.vector(3072) not null,
  primary key (snapshot_id, cluster_id)
);
