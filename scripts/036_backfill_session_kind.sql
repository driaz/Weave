-- 036 backfill: flag pre-036 QA sessions. Run manually after confirming the
-- Phase A ID list AND resolving the threshold flag below.
--
-- Migration 036's column default already set every existing row to 'real';
-- this script flips the QA ones to 'qa'. Flag-never-delete: QA deposits stay
-- queryable via active_voice_session_deposits.
--
-- ┌────────────────────────────────────────────────────────────────────────┐
-- │ ⛔ BLOCKED — DO NOT RUN AS-IS. The duration-gap premise FAILED.          │
-- │                                                                          │
-- │ The proposed rule assumes a clean empty band between ~5 and ~10 min      │
-- │ (QA ≤5, real 10+). Phase A (read-only, prod, 2026-06-15) REFUTES this:   │
-- │ the band is populated by 5 multi-utterance sessions —                    │
-- │   e1b8bf89  5.54 min  13 utterances                                      │
-- │   f61f63eb  5.71 min   9 utterances                                      │
-- │   248f8460  7.88 min  19 utterances                                      │
-- │   8bde239f  8.11 min  13 utterances                                      │
-- │   47d96c14  9.81 min  23 utterances                                      │
-- │ A 7-min cut flags the first two (5.54/13utt, 5.71/9utt) as 'qa' — they   │
-- │ read as REAL reflection sessions, not QA pokes. The threshold runs       │
-- │ through live data, not a gap. CONFIRM the cut (or switch the signal,     │
-- │ e.g. utterance count) before running. The 7-minute value below is the    │
-- │ template's placeholder, NOT a vetted choice.                             │
-- └────────────────────────────────────────────────────────────────────────┘
--
-- Phase A facts baked in below (prod, weave_readonly, 2026-06-15):
--   • Fixture 02b8222e resolved → 02b8222e-3867-417e-8355-d20d33caf8d0
--     (1.75 min, end_reason user_closed) — lands in the short cluster, as expected.
--   • Distinct end_reason values present: 'user_closed' (67), 'error' (4), NULL (2).
--     Deposit-producing sessions: 'user_closed' (63), NULL (2). No 'idle_timeout'.
--   • All 73 sessions belong to ONE user_id (92fcfcc8-…). No other user owns
--     deposits, so NO user_id filter is needed or would discriminate — omitted
--     deliberately (surfaced per the Phase D instruction, not silently dropped).
--
-- end_reason guard — NOTE A LOGIC CORRECTION vs the proposed template:
--   The stated goal is "don't flag a real session a bug killed early." A
--   bug-/idle-killed session ends with an ABNORMAL reason ('error',
--   'idle_timeout'), so to KEEP it 'real' we must EXCLUDE those reasons from
--   the QA flag → `end_reason NOT IN ('error','idle_timeout')`. The template's
--   placeholder text said "<normal-end values>", which read literally as
--   `NOT IN ('user_closed')` would do the OPPOSITE (flag the bug-kills, spare
--   the QA). Implemented to match the GOAL, not the literal placeholder — flag
--   me if you intended otherwise. (Moot for the corpus today: every short
--   deposit-producing session ended 'user_closed'; the 4 'error' rows produce
--   no deposits. The guard is a free safeguard for n≤1, included as specified.)

UPDATE voice_sessions
SET session_kind = 'qa'
WHERE
  id = '02b8222e-3867-417e-8355-d20d33caf8d0'      -- validated QA fixture, always
  OR (
    (ended_at - started_at) < interval '7 minutes'  -- ⛔ UNCONFIRMED cut — gap is NOT empty (see banner)
    AND end_reason NOT IN ('error', 'idle_timeout') -- keep bug-/idle-killed real sessions 'real'
  );

-- Dry-run preview (run this SELECT first; it mirrors the UPDATE's WHERE):
--   SELECT id,
--          round(extract(epoch from (ended_at - started_at))/60.0, 2) AS dur_min,
--          end_reason,
--          (SELECT count(*) FROM voice_session_deposits d
--             WHERE d.session_id = voice_sessions.id AND d.superseded_at IS NULL) AS active_deposits
--   FROM voice_sessions
--   WHERE id = '02b8222e-3867-417e-8355-d20d33caf8d0'
--      OR ((ended_at - started_at) < interval '7 minutes'
--          AND end_reason NOT IN ('error', 'idle_timeout'))
--   ORDER BY dur_min NULLS FIRST;
