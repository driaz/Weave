// Gemini embedding model for operator scripts. Mirrors
// GEMINI_EMBEDDING_MODEL in src/services/embeddingService.ts and MODEL in
// media-server/src/embed.ts — those runtimes can't import this file, so
// keep all three in lockstep.
export const GEMINI_EMBEDDING_MODEL = 'gemini-embedding-2'
