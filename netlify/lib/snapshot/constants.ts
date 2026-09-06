// Every ratified v2 parameter of the snapshot engagement layer, named once.
// Nothing in the pipeline may carry one of these values as a literal.
// Source of record: dispatch R1 §2.1–2.2 (2026-09-05).

/** Ceiling of the breadth curve: one maximal lightbox dwell or edge close. */
export const BREADTH_MAX = 1.5

/** Dwell seconds at which the breadth curve saturates. */
export const DWELL_CAP_S = 45

/** log₂(DWELL_CAP_S + 1) — divisor of the dwell curve; dwell = cap → 1.0. */
export const DWELL_LOG_DIVISOR = Math.log2(DWELL_CAP_S + 1)

/** User turns at which one voice session equals one maximal breadth act. */
export const MIN_REAL_TURNS = 4

/**
 * Depth curve base — derived, never hardcoded: a MIN_REAL_TURNS-turn session
 * weighs exactly BREADTH_MAX. VOICE_BASE × log₂(MIN_REAL_TURNS + 1) = BREADTH_MAX.
 */
export const VOICE_BASE = BREADTH_MAX / Math.log2(MIN_REAL_TURNS + 1)

/** Flat weight of an item_added event (recency class). */
export const ITEM_ADDED_WEIGHT = 0.2

/** Anchors per cluster: top-N by normalized weight, Math.min(N, members). */
export const ANCHOR_COUNT = 3

/** Half-life of the breadth clock (breadth and recency classes), in days. */
export const H_BREADTH_DAYS = 14

/** Half-life of the depth clock (voice), in days. */
export const H_DEPTH_DAYS = 42

/** Scan horizon in half-lives; applied in the query, never client-side. */
export const K_HALF_LIVES = 5

/** Breadth/recency horizon: events with timestamp >= generated_at − this. */
export const BREADTH_HORIZON_DAYS = K_HALF_LIVES * H_BREADTH_DAYS

/** Depth horizon: voice sessions with ended_at >= generated_at − this. */
export const DEPTH_HORIZON_DAYS = K_HALF_LIVES * H_DEPTH_DAYS

/** Average-linkage stopping threshold (unchanged from v1). */
export const CLUSTER_SIMILARITY_THRESHOLD = 0.72

/** Contributing events kept per anchor in provenance. */
export const TOP_EVENTS_PER_ANCHOR = 5

/** Page size for PostgREST reads. Every page is range-bounded; a short page ends the scan. */
export const READ_PAGE_SIZE = 500

/** Stamped into generation_metadata.pipeline_version. */
export const PIPELINE_VERSION = 'v2'

export const MS_PER_DAY = 86_400_000

/** Run-time knobs the entry point accepts; every one is recorded in parameters. */
export type RunOptions = {
  anchorCount: number
  /** When true, w_rule = 1 for every rule; decay and horizons stay on. */
  uniformWeights: boolean
  /** PostgREST page size for every read. */
  pageSize: number
}

export const DEFAULT_RUN_OPTIONS: RunOptions = {
  anchorCount: ANCHOR_COUNT,
  uniformWeights: false,
  pageSize: READ_PAGE_SIZE,
}

/** The named parameter block recorded in generation_metadata.parameters. */
export function ratifiedParameters(opts: RunOptions) {
  return {
    anchor_count: opts.anchorCount,
    uniform_weights: opts.uniformWeights,
    page_size: opts.pageSize,
    breadth_max: BREADTH_MAX,
    dwell_cap_s: DWELL_CAP_S,
    voice_base: VOICE_BASE,
    min_real_turns: MIN_REAL_TURNS,
    item_added_weight: ITEM_ADDED_WEIGHT,
    h_breadth_days: H_BREADTH_DAYS,
    h_depth_days: H_DEPTH_DAYS,
    k: K_HALF_LIVES,
    cluster_threshold: CLUSTER_SIMILARITY_THRESHOLD,
  }
}
