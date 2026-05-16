-- Migration 023: Phase 8 voice persistence HNSW indexes.
--
-- Follow-up to migration 022, which deferred the HNSW index because
-- vector(3072) exceeds pgvector's 2000-dim limit for vector_cosine_ops.
-- Strategy chosen: halfvec(3072) with halfvec_cosine_ops, which lifts
-- the HNSW ceiling to 4000 dims at half the storage cost. Precision
-- loss from float32 -> float16 is negligible for cosine similarity at
-- this scale; values that ever need higher precision can be recovered
-- by re-embedding from the source text.
--
-- Retroactively indexes weave_embeddings as well. That table has been
-- doing sequential scans for similarity queries since migration 002 —
-- this is the first vector index it gets. weave_profile_cluster_
-- embeddings is intentionally left alone for now: it's small,
-- service-role-only, and queried by foreign-key join rather than
-- nearest-neighbor today.
--
-- One-way concerns: halfvec is bit-level lossy vs. vector. Recoverable
-- by re-embedding from source text; the embedding service already does
-- this on every node update. No backfill needed.
--
-- Locking: ALTER COLUMN ... TYPE rewrites the table under an ACCESS
-- EXCLUSIVE lock. weave_embeddings holds ~52 rows in dev as of this
-- migration (confirmed via REST count); the rewrite is sub-second and
-- safe to run in the application window. voice_utterances is empty.
-- If prod row count has grown materially before this is applied,
-- re-check the locking implication.
--
-- Down migration: drop the two HNSW indexes, then ALTER COLUMN both
-- columns back to extensions.vector(3072) USING embedding::vector(3072).
-- The reverse cast widens float16 back to float32 without recovering
-- precision. Practically, prefer to forward-fix.

-- ========================================================================
-- 1. Convert embedding columns from vector(3072) to halfvec(3072)
-- ========================================================================

alter table weave_embeddings
  alter column embedding type extensions.halfvec(3072)
  using embedding::extensions.halfvec(3072);

alter table voice_utterances
  alter column embedding type extensions.halfvec(3072)
  using embedding::extensions.halfvec(3072);

-- ========================================================================
-- 2. HNSW indexes
-- ========================================================================
-- Pgvector defaults (m=16, ef_construction=64); not specified
-- explicitly so the index inherits whatever pgvector ships with.
-- The Phase 8 design doc's open-questions section ("HNSW performance
-- at 3072 dims") is the place these parameters get revisited once a
-- few weeks of real sessions have landed.

create index weave_embeddings_embedding_hnsw_idx
  on weave_embeddings
  using hnsw (embedding extensions.halfvec_cosine_ops);

create index voice_utterances_embedding_hnsw_idx
  on voice_utterances
  using hnsw (embedding extensions.halfvec_cosine_ops);
