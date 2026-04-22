# Persistence

Pure CRUD wrapper around Supabase for Weave's canvas data: **boards**,
**nodes**, **edges**, **voice sessions**, and **media**. React-agnostic
— no hooks, no stateful caches. Consumed by `useBoardStorage`, which
treats Supabase as the sole source of truth and uses `cache.ts` as a
downstream read cache for fast cold starts.

The module does two things the generic Supabase client does not:

1. **Injects `user_id`** from the active session on every write so RLS
   passes. Callers never pass `user_id`.
2. **Translates errors** into typed exceptions
   (`AuthError`, `NotFoundError`, `PermissionError`,
   `ValidationError`, `NetworkError`, base `PersistenceError`) so
   callers can branch on `instanceof` instead of parsing error strings.

## Public API

```ts
import { persistence } from '@/persistence'

const board = await persistence.boards.create({ name: 'Untitled' })
const nodes = await persistence.nodes.batchCreate(board.id, [...])
const edges = await persistence.edges.listByBoard(board.id)
const url   = await persistence.media.getSignedUrl(`${userId}/${board.id}/x.png`)
```

### Surface

| Domain           | Functions                                                                                        |
| ---------------- | ------------------------------------------------------------------------------------------------ |
| `boards`         | `list`, `get`, `create`, `update`, `delete`                                                      |
| `nodes`          | `listByBoard`, `get`, `create`, `update`, `delete`, `batchCreate`, `batchUpdate`                 |
| `edges`          | `listByBoard`, `create`, `update`, `delete`, `batchCreate`, `deleteByBoard`                      |
| `voiceSessions`  | `listByBoard`, `get`, `create`, `update`, `delete` *(Phase 2 — API exists, not wired up yet)*    |
| `media`          | `upload`, `getSignedUrl`, `delete`                                                               |

### Types

- `Board`, `Node`, `Edge`, `VoiceSession` — row types from the
  generated schema (`src/types/database.ts`).
- `NewBoardInput`, `NewNodeInput`, `NewEdgeInput`,
  `NewVoiceSessionInput` — insert shapes with server-generated fields
  (`id`, `user_id`, `created_at`, `updated_at`) omitted.
- Update paths take `Partial<Row>`. The module silently drops
  `id`, `user_id`, `board_id`, and `created_at` from patches to prevent
  cross-row mutations.

### Errors

```ts
import {
  PersistenceError,  // base class — catch this to catch everything
  AuthError,         // no active session
  NotFoundError,     // row doesn't exist or RLS hides it
  PermissionError,   // RLS denied the write / storage path mismatch
  ValidationError,   // check, FK, not-null, or unique constraint violation
  NetworkError,      // fetch failed / timed out
} from '@/persistence'
```

Every function wraps its Supabase call and converts raw
`PostgrestError` / `StorageError` / `AuthError` shapes into these
classes via `mapSupabaseError`. See `errors.ts` for the code → class
mapping.

### Conventions

- **Auth is mandatory.** Every function calls `supabase.auth.getUser()`
  and throws `AuthError` if no user is authenticated — fail-fast,
  rather than an opaque 403 from RLS.
- **`user_id` is module-supplied** — callers never pass it. This keeps
  RLS denials impossible on the client side.
- **Media paths are user-scoped.** `upload(file, path)` requires
  `path` to start with `${userId}/` because Storage RLS enforces the
  same prefix. Callers construct paths like
  `${userId}/${boardId}/${nodeId}.png`.
- **Batch operations exist for a reason.** `nodes.batchCreate`,
  `nodes.batchUpdate`, `edges.batchCreate`, and `edges.deleteByBoard`
  are there so Prompt 5 can replace-all-on-save without N round-trips.
- **`get()` returns `null`** on miss. `update()` and `delete()` throw
  `NotFoundError` if the target row is missing.

## Regenerating database types

When the schema changes, regenerate the types:

```bash
npx supabase gen types typescript --linked > src/types/database.ts
```

The Supabase CLI must be linked to the project (`supabase link --project-ref <ref>`).
The types file is committed so CI doesn't need database access to
build.

## Running tests

Tests run against the real linked Supabase project. Each suite spins
up a throwaway auth user via the admin API and tears it down in
`afterAll` — nothing pollutes existing data.

```bash
npm test            # one-off
npm run test:watch  # watch mode
```

Required in `.env`:

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY` — service role is used **only** for test
  setup (creating users) and teardown (deleting users + stray storage
  objects). The persistence module itself only ever uses the anon key
  + authenticated session.

Suites automatically `describe.skipIf(!hasServiceRole())` when the
service key is absent, so CI without secrets won't fail — it just
skips integration tests.

### What's covered

- CRUD happy path for each of the five domains
- Batch create + batch update for nodes
- `edges.deleteByBoard` wipes everything and `listByBoard` returns []
- Validation errors (invalid `card_type`)
- `NotFoundError` on missing rows
- Media upload + signed URL round-trip + delete
- Storage RLS: rejects uploads under another user's path
- Storage RLS: blocks signed URLs for another user's object

## Known limitations (intentionally deferred)

- **No real-time subscriptions.** The canvas saves via debounced
  replace-all; live collab isn't planned for Phase 1.
- **No offline queue.** When a write fails, `useBoardStorage` rolls
  React state back to the last-synced snapshot and surfaces an error
  toast — no retry, no queue. Supabase is the sole source of truth.
- **No optimistic local cache.** Callers (`useBoardStorage`) own the
  UI-facing state; this module is stateless. The cache module
  (`cache.ts`) is a downstream read cache — writes happen AFTER a
  successful Supabase write, never speculatively.
- **`batchUpdate` is not atomic.** PostgREST has no bulk-update
  statement, so it fans out one HTTP request per row. Partial
  failures are surfaced as the first rejection. If you need
  atomicity, use `deleteByBoard` + `batchCreate` instead.
- **`voiceSessions` is a Phase 2 placeholder.** The API and migrations
  exist so consumers can start writing voice features, but no call
  site uses it yet.
