-- 036 backfill: flag pre-036 QA voice sessions as session_kind = 'qa'.
-- Run MANUALLY (write creds), dry-run SELECT first, after reviewing.
--
-- Migration 036's column default already set every existing row to 'real';
-- this script flips the confirmed QA rows to 'qa'. Flag-never-delete: nothing
-- is deleted — every row here stays queryable via active_voice_session_deposits.
--
-- CONFIRMED QA SET — 56 sessions, enumerated explicitly by id (no duration
-- rule, no computed HAVING). Utterance count decided the deposit-producing
-- members, but the artifact is fully explicit and auditable line-by-line:
--
--   • 48 deposit-producing sessions at ≤3 utterances
--       33 at utt=1, 2 at utt=2, 13 at utt=3 (includes fixture 02b8222e).
--   • 8 non-deposit-producing sessions:
--       4 zero-utterance smoke tests (end_reason user_closed),
--       4 error-end rows (end_reason error) — flagged, NOT deleted, so one
--         can serve as the chunk_sequence_gap repro if needed later.
--
-- Everything else stays 'real' and is untouched: the 3 reviewed 4–5-utterance
-- sessions (a2d72d70, 751f9335, 41cc85a8 — confirmed real), the 14 sessions in
-- the ≥6-utterance band, and any session not named below.
--
-- Residual-leak note: a real-band session (≥4 utt) could still be QA; that's
-- the accepted, visible leak — correctable later on read (real_voice_session_
-- deposits), not worth chasing in this backfill.
--
-- The dry-run SELECT and the UPDATE carry the SAME 56-id list. Run the SELECT
-- first; confirm it returns exactly 56 rows, all current_kind = 'real', before
-- running the UPDATE.

-- ========================================================================
-- DRY RUN — run this first. Expect 56 rows, every current_kind = 'real'.
-- ========================================================================
select
  s.id,
  s.session_kind as current_kind,
  (select count(*) from voice_utterances u where u.session_id = s.id) as utterances,
  (select count(*) from voice_session_deposits d
     where d.session_id = s.id and d.superseded_at is null) as active_deposits
from voice_sessions s
where s.id in (
  -- ≤3-utterance deposit-producing (48) ----------------------------------
  -- utt = 1 (33)
  '0a2b4abd-993f-41b7-8ca4-1a29b8bf7c8f',
  '0bb4c3a4-f038-4d35-9187-059e18914e5e',
  '13d84693-a7be-445a-9518-779a335889dc',
  '1461eed4-2bd3-43cd-acec-cf38f130f295',
  '34af7fa1-cf2d-423d-bca8-a6832e7223c2',
  '3a885c55-454b-4ba6-841b-73620c951478',
  '3b63dc9c-38b4-4cc7-9e71-62cd28b22677',
  '3bf143a5-78d2-4e33-8fab-eeb69b93115c',
  '42426400-6da8-40ff-8055-c126349230eb',
  '526fdabc-a3e1-431b-b904-ae377dd73309',
  '56dc8ba6-480a-4b2e-ac3f-87932991b366',
  '57a77a51-d6e6-4b2c-925f-8553aa47bf3d',
  '5e308ee7-bc3c-404e-b26f-bd4833be45cd',
  '5fd00afc-f005-4542-8cf7-b4a3b6bd45ab',
  '6861aece-819d-4f96-b10f-c5a2757f819c',
  '6b7ea45c-29a2-450b-bb1c-46d17a2a0b69',
  '6efc2ba3-29ef-4de7-a9a2-9628e1614399',
  '72a855bd-c18c-43cd-bc81-80771caeccc4',
  '8153d70c-9fa4-4ce6-bf47-46386062e792',
  '93f0e380-5d33-4f0e-afb4-1b73b69a526e',
  '9c0c4244-b853-4f90-91e6-27e5b065dd6b',
  'a036667b-c2ff-4b16-aa52-a3e190cfc936',
  'a346a3af-7d40-4d49-ae58-19442860ded5',
  'a6494797-ba07-4358-8d34-fc0d9c9fc57a',
  'a8275b6d-bf81-4121-827e-38a6daab3382',
  'b40daded-816f-4930-898d-4d2bd7bf6029',
  'd20330f6-8545-4324-af0e-490242a53d89',
  'e1cb7cd8-2d0e-404f-b205-b20acdd13dbd',
  'e7e53922-82a4-4262-910e-1a6587012630',
  'ef5b9e36-a7e8-4390-88cf-2e00474a8c0f',
  'eff7d606-4d91-429a-af1b-121e5dfed1a2',
  'f52acca7-9c69-4535-a499-6e280223fc38',
  'faf36a13-c8c3-4977-93da-70764b68de84',
  -- utt = 2 (2)
  '3c2a77e6-9885-4437-96ee-716c887f90ae',
  '72b5201c-9c74-46c1-8f31-828a70094dfe',
  -- utt = 3 (13)
  '02b8222e-3867-417e-8355-d20d33caf8d0',  -- validated QA fixture
  '0664209d-5a12-4924-92fb-8fca822f9e62',
  '1e3c3271-c6ed-4003-a0ef-990c25986fa9',
  '7b647564-7022-4809-a55e-1ff810e5d19d',
  '93411f47-b423-4afd-a2e3-5cb39e810480',
  '94559db4-afed-4095-98f8-5a0907b68f29',
  '98821c24-5397-40aa-8672-fba123cf0b0a',
  'a8ab5f73-8e7d-4527-a001-a7c4a2afce21',
  'b79d28d3-3348-44e6-a314-bca79d119dc1',
  'd2b45361-5ee1-4aad-bc8f-0b106abcd784',
  'dcee729e-a54c-4d8f-a798-b79a42c1524b',
  'e728b9c6-550f-4922-8933-63846963b52f',
  'fa6e74fc-d111-43ac-b233-a09bb1c2f5fd',
  -- non-deposit smoke tests, user_closed, 0 utt (4) ----------------------
  '7f000e91-5c0a-41a6-b914-e89ce8ab1426',
  '896ba8d6-7f7a-4317-b05e-80acfb0ae5fb',
  '9bc43582-1a2e-48a5-baa0-5da1e46011af',
  'd07e3390-3737-46a8-916f-7346ed8336ad',
  -- non-deposit error-end, 0 utt (4) -------------------------------------
  '44d63a5a-d783-4499-96fb-40f0194e99d5',
  '9e8f1cbe-0a90-40d8-9f90-4e724c4a372d',
  'd15b4be1-c9cf-458c-bc1e-b52b6df2258d',
  'd53e2a4e-e76e-49d8-806b-5627c6fb83ed'
)
order by utterances, active_deposits, s.id;

-- ========================================================================
-- APPLY — same 56-id list. Run only after the dry-run looks right.
-- ========================================================================
update voice_sessions
set session_kind = 'qa'
where session_kind = 'real'   -- idempotent: re-running flips nothing already 'qa'
  and id in (
  -- ≤3-utterance deposit-producing (48) ----------------------------------
  -- utt = 1 (33)
  '0a2b4abd-993f-41b7-8ca4-1a29b8bf7c8f',
  '0bb4c3a4-f038-4d35-9187-059e18914e5e',
  '13d84693-a7be-445a-9518-779a335889dc',
  '1461eed4-2bd3-43cd-acec-cf38f130f295',
  '34af7fa1-cf2d-423d-bca8-a6832e7223c2',
  '3a885c55-454b-4ba6-841b-73620c951478',
  '3b63dc9c-38b4-4cc7-9e71-62cd28b22677',
  '3bf143a5-78d2-4e33-8fab-eeb69b93115c',
  '42426400-6da8-40ff-8055-c126349230eb',
  '526fdabc-a3e1-431b-b904-ae377dd73309',
  '56dc8ba6-480a-4b2e-ac3f-87932991b366',
  '57a77a51-d6e6-4b2c-925f-8553aa47bf3d',
  '5e308ee7-bc3c-404e-b26f-bd4833be45cd',
  '5fd00afc-f005-4542-8cf7-b4a3b6bd45ab',
  '6861aece-819d-4f96-b10f-c5a2757f819c',
  '6b7ea45c-29a2-450b-bb1c-46d17a2a0b69',
  '6efc2ba3-29ef-4de7-a9a2-9628e1614399',
  '72a855bd-c18c-43cd-bc81-80771caeccc4',
  '8153d70c-9fa4-4ce6-bf47-46386062e792',
  '93f0e380-5d33-4f0e-afb4-1b73b69a526e',
  '9c0c4244-b853-4f90-91e6-27e5b065dd6b',
  'a036667b-c2ff-4b16-aa52-a3e190cfc936',
  'a346a3af-7d40-4d49-ae58-19442860ded5',
  'a6494797-ba07-4358-8d34-fc0d9c9fc57a',
  'a8275b6d-bf81-4121-827e-38a6daab3382',
  'b40daded-816f-4930-898d-4d2bd7bf6029',
  'd20330f6-8545-4324-af0e-490242a53d89',
  'e1cb7cd8-2d0e-404f-b205-b20acdd13dbd',
  'e7e53922-82a4-4262-910e-1a6587012630',
  'ef5b9e36-a7e8-4390-88cf-2e00474a8c0f',
  'eff7d606-4d91-429a-af1b-121e5dfed1a2',
  'f52acca7-9c69-4535-a499-6e280223fc38',
  'faf36a13-c8c3-4977-93da-70764b68de84',
  -- utt = 2 (2)
  '3c2a77e6-9885-4437-96ee-716c887f90ae',
  '72b5201c-9c74-46c1-8f31-828a70094dfe',
  -- utt = 3 (13)
  '02b8222e-3867-417e-8355-d20d33caf8d0',  -- validated QA fixture
  '0664209d-5a12-4924-92fb-8fca822f9e62',
  '1e3c3271-c6ed-4003-a0ef-990c25986fa9',
  '7b647564-7022-4809-a55e-1ff810e5d19d',
  '93411f47-b423-4afd-a2e3-5cb39e810480',
  '94559db4-afed-4095-98f8-5a0907b68f29',
  '98821c24-5397-40aa-8672-fba123cf0b0a',
  'a8ab5f73-8e7d-4527-a001-a7c4a2afce21',
  'b79d28d3-3348-44e6-a314-bca79d119dc1',
  'd2b45361-5ee1-4aad-bc8f-0b106abcd784',
  'dcee729e-a54c-4d8f-a798-b79a42c1524b',
  'e728b9c6-550f-4922-8933-63846963b52f',
  'fa6e74fc-d111-43ac-b233-a09bb1c2f5fd',
  -- non-deposit smoke tests, user_closed, 0 utt (4) ----------------------
  '7f000e91-5c0a-41a6-b914-e89ce8ab1426',
  '896ba8d6-7f7a-4317-b05e-80acfb0ae5fb',
  '9bc43582-1a2e-48a5-baa0-5da1e46011af',
  'd07e3390-3737-46a8-916f-7346ed8336ad',
  -- non-deposit error-end, 0 utt (4) -------------------------------------
  '44d63a5a-d783-4499-96fb-40f0194e99d5',
  '9e8f1cbe-0a90-40d8-9f90-4e724c4a372d',
  'd15b4be1-c9cf-458c-bc1e-b52b6df2258d',
  'd53e2a4e-e76e-49d8-806b-5627c6fb83ed'
);

-- ========================================================================
-- VERIFY — after APPLY. Expect qa = 56, and the named real-band survivors.
-- ========================================================================
--   select session_kind, count(*) from voice_sessions group by session_kind;
--   -- expect: qa = 56, real = remainder (17: 3 reviewed 4–5 + 14 ≥6 band).
