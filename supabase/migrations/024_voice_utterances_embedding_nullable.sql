-- Migration 024: drop NOT NULL on voice_utterances.embedding.
--
-- Phase 8 write-path foundation. Embedding generation is asynchronous
-- relative to utterance write: the conversation cannot block waiting
-- for the Gemini API to return a 3072-dim vector for every spoken
-- turn. Each utterance row is inserted with embedding = null as soon
-- as STT / Claude returns the text; a background call then populates
-- the column via UPDATE when the embedding lands.
--
-- A failed embedding leaves the row with embedding = null forever.
-- That's fine for retrieval — the HNSW index simply doesn't return
-- the row — and is recoverable by re-embedding from `text` if it
-- ever matters. The failure is logged to processing_log.
--
-- Down migration: ALTER TABLE voice_utterances ALTER COLUMN embedding
-- SET NOT NULL. Will fail if any null embeddings exist; the recovery
-- path is to re-embed from text first.

alter table voice_utterances
  alter column embedding drop not null;
