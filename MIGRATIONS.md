# Migrations

Inventory of every SQL migration applied to the Weave Supabase schema. Entries are in apply order — the same order they're executed by `supabase db push`.

Two projects exist: **Weave-Dev** (`bxbhjybahfyeqytwpkry`) and **Weave** prod (`wndfikmpifyqkgivmnwv`). All migrations below have been applied to both unless otherwise noted. See [`Claude.md`](Claude.md#supabase-environments) for the promotion workflow.

When bootstrapping a new Supabase project, apply these in order. The pgvector extension must be installed before migration 002 (Supabase dashboard → **Database → Extensions**).

| # | File | One-liner |
|---|------|-----------|
| 001 | `001_create_weave_events.sql` | Behavioral event log — `weave_events` table for session + interaction telemetry. |
| 002 | `002_create_weave_embeddings.sql` | Node content embeddings — `weave_embeddings(board_id, node_id, embedding extensions.vector(3072), ...)` for semantic similarity. Note the `extensions.` schema-qualified type; Supabase puts `pgvector` there. |
| 003 | `003_create_weave_profile_snapshots.sql` | Reasoning-layer tables — `weave_profile_snapshots` (per-run cluster output) and `weave_profile_cluster_embeddings` (one embedding per cluster per snapshot). Powers the Reflect view. |
| 004 | `004_enable_rls_profile_tables.sql` | RLS on reasoning-layer tables — default-deny; service-role-only writes until a client-read policy lands (see 006). |
| 005 | `005_cleanup_target_id_format.sql` | One-shot data cleanup — removes "ghost board" events (sessions with no content) and normalises legacy `target_id` format. |
| 006 | `006_allow_anon_read_snapshots.sql` | Anon-read policy on `weave_profile_snapshots` so the browser can render the Reflect view. Writes stay service-role-only. To be replaced by `auth.uid()`-scoped policies in the auth pass. |
| 007 | `007_add_archived_at_to_embeddings.sql` | Soft-delete column on `weave_embeddings` (`archived_at timestamptz null`) + partial index `where archived_at is null`. Node deletion sets the timestamp; queries filter it out. |
| 008 | `008_create_core_schema.sql` | Phase 1 cutover tables — `boards`, `nodes`, `edges`, `voice_sessions`. Strict RLS from day one (`auth.uid() = user_id`). Shared `update_updated_at_column()` trigger + `updated_at` columns. |
| 009 | `009_add_user_id_to_legacy_tables.sql` | Backfill + NOT NULL on `weave_embeddings.user_id` and `weave_events.user_id`. Index on `user_id`. Anon-permissive policies still in place; strict RLS flip deferred. |
| 010 | `010_create_storage_bucket.sql` | `weave-media` Storage bucket for images/PDFs/audio. Private (signed-URL access). Path convention `{user_id}/...` enforced by RLS on `storage.objects`. |
| 011 | `011_default_user_id_on_legacy_tables.sql` | Default `user_id` on `weave_embeddings` and `weave_events` to the single existing user's UUID. Bridges the 009 NOT NULL constraint with the pre-auth anon-key writer so inserts don't fail silently. Dropped once all writes are authenticated. |
| 012 | `012_board_replace_all_rpc.sql` | `replace_board_contents(p_board_id, p_nodes, p_edges)` PL/pgSQL function — atomic replace-all for a board's nodes and edges in one transaction. Touches `boards.updated_at` so sidebar ordering reflects activity. Called from the client via `client.rpc(...)` instead of separate DELETE/INSERT round trips. |

## Deferred cutovers tracked in migration comments

- **Strict RLS on legacy tables.** `weave_embeddings` and `weave_events` still have anon-permissive policies from the pre-auth era. 009's comment block plans the flip to `auth.uid() = user_id` once the persistence layer is fully authenticated.
- **`auth.uid()`-scoped policies on snapshots.** 006's anon-read is a demo-era shortcut; to be narrowed with the auth pass.

## Regenerating TypeScript types

```bash
npx supabase gen types typescript --linked > src/types/database.ts
```

Run this after any migration that adds/changes tables, columns, enums, or functions. Commit the regenerated file alongside the migration.
