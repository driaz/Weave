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
| 013 | `013_allow_authenticated_read_snapshots.sql` | Mirrors the anon snapshot-read policy for the `authenticated` role so signed-in users on prod can render the Reflect view. Superseded by 014, which scopes reads to `auth.uid() = user_id`. |
| 014 | `014_auth_rls_cutover.sql` | Phase 1 auth lockdown — adds `user_id` (default `auth.uid()`, FK→`auth.users` ON DELETE CASCADE) to `weave_profile_snapshots` and `weave_profile_cluster_embeddings`; flips hardcoded UUID defaults on `boards`/`nodes`/`edges`/`weave_events`/`weave_embeddings` to `auth.uid()`; drops every permissive / anon-scoped policy; replaces them with explicit `TO authenticated` SELECT/INSERT/UPDATE/DELETE policies on all seven tables (28 new policies). Service-role writes via Netlify functions still bypass RLS as before. |
| 015 | `015_patch_node_data_rpc.sql` | `patch_node_data(p_node_id uuid, p_board_id, p_user_id, p_patch jsonb)` — atomic shallow jsonb merge into `nodes.data`, used by the Fly media-server to write `media_analysis` without racing the client's debounced full-board save. **Superseded by 016 — uuid-based lookup was wrong (server only knows the client string id). Apply 015 then 016.** |
| 016 | `016_patch_node_data_by_client_id.sql` | Drops `patch_node_data(uuid,…)` from 015 and recreates it as `patch_node_data(p_client_id text, p_board_id, p_user_id, p_patch jsonb)`, looking up nodes via `data->>'_clientNodeId'`. The Fly server only ever has the ReactFlow string id (the UUID `nodes.id` is server-minted by `replace_board_contents`), so this is the only signature it can call. |

## Deferred cutovers tracked in migration comments

_All previously deferred cutovers were resolved by migration 014._

## Regenerating TypeScript types

```bash
npx supabase gen types typescript --linked > src/types/database.ts
```

Run this after any migration that adds/changes tables, columns, enums, or functions. Commit the regenerated file alongside the migration.
