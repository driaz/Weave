# Persistence

Pure CRUD wrapper around Supabase for Weave's canvas data: **boards**,
**nodes**, **edges**, **voice sessions**, **voice utterances**, and
**media**. React-agnostic — no hooks, no stateful caches. Consumed by
`useBoardStorage` (canvas) and the voice session controller (voice),
which treat Supabase as the sole source of truth and use `cache.ts`
as a downstream read cache for fast cold starts.

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
| `voiceSessions`  | `createSession`, `endSession`, `getSession`                                                      |
| `voiceUtterances`| `writeUtterance`, `updateUtteranceEmbedding`, `listUtterancesBySession`                          |
| `media`          | `upload`, `getSignedUrl`, `delete`                                                               |

### Types

- `Board`, `Node`, `Edge`, `VoiceSession`, `VoiceUtterance` — row
  types from the generated schema (`src/types/database.ts`).
- `NewBoardInput`, `NewNodeInput`, `NewEdgeInput`,
  `NewVoiceSessionInput`, `NewVoiceUtteranceInput` — insert shapes
  with server-generated fields (`id`, `user_id`, `created_at`,
  `updated_at`) omitted. `NewVoiceUtteranceInput` additionally narrows
  `speaker` from the generated `string` to `'user' | 'assistant'`.
- `Speaker`, `EndReason`, `VoiceSessionEndPatch`,
  `WriteUtteranceContext`, `WriteUtteranceResult`, `SentinelEvent`,
  `BoardSnapshot` — supporting types for the voice-session controller.
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

## Phase 8 voice persistence

`voiceSessions` and `voiceUtterances` back the durable voice memory
introduced in Phase 8. The intended caller is
`src/services/voice/voiceSessionController.ts`, which owns the
in-memory `processing_log` buffer, the per-session `utterance_index`
counter, and the `assistantHasSpokenInSession` flag; the persistence
layer stays stateless.

**Session lifecycle.** `createSession` inserts a new `voice_sessions`
row when the mic modal opens. `endSession` issues the single UPDATE
that stamps `ended_at`, `end_reason`, and the flushed
`processing_log` array on close. `getSession` is for inspector /
debugging reads.

**Per-utterance writes.** `writeUtterance` inserts a single
`voice_utterances` row with `embedding = null`. The caller passes a
`WriteUtteranceContext` carrying `assistantHasSpokenInSession` so
the module can apply the **sentinel-strip rule** centrally — see
[`docs/voice-persistence-design.md`](../../docs/voice-persistence-design.md)
for the rationale. When the rule fires, the row is intentionally not
written (no phantom row at `utterance_index = 0`); when it
near-matches, the row is written as-is and a degraded warning event
is returned so the controller can log it. The pure helper
`detectSentinel` is exported for unit testing.

**Async embedding.** Embeddings are populated after the row exists
via `updateUtteranceEmbedding`. The controller fires
`embedText(text)` from `services/embeddingService.ts` and calls
`updateUtteranceEmbedding(id, vec)` on success. Failures stay null —
HNSW skips them so retrieval simply doesn't return the row — and are
recoverable by re-embedding from `text`.
