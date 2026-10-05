-- Backfill voice_sessions.anchor_edge_id on edge-less real sessions (dispatch #62).
-- Source read: docs/reads/voice-launch-attribution.md (PR #61, merged 80ccaad).
-- Prepared by Claude Code 2026-10-05 from a read-only prod query; EXECUTED BY DANIEL in the Supabase SQL editor.
--
-- Scope: 15 real, ended sessions with anchor_edge_id null (all-time). 13 are updated; 2 are skipped:
--   c93c5e49-e468-4a98-8b03-2236385753a6: clicked connection (deeper, "ironic causation", from the 03:22:51 weave) no longer exists as its own row; the surviving (pair, deeper) edge d62c33ca is a different connection ("structural parallel", created 02:44:48, before that weave). Ambiguous: not backfilled
--   e1b8bf89-34e8-490a-bd02-ff6aa5ebfad9: no edges row matches the launch pair (both endpoint nodes are gone); FK would reject any id
-- 477db21d IS included: its edge is unambiguous (one (pair, mode) row, type matches the click, row existed at click,
--   click->start 0.934 s). Only the loss mechanism is undetermined (read §D.3), not the edge.
--
-- Confidence 'high' = all of: (1) the launch click is the last connection_label_clicked before voice.session.started in
--   the same browser session, with no C/X row between; (2) exactly one edges row matches (board, directionless pair,
--   click metadata.mode) — unique by edges_unique_directionless_mode; (3) edges.data.type = click metadata.connection_type;
--   (4) edges.created_at < click timestamp (the same row existed when Speak was pressed).
--
-- Columns touched: anchor_edge_id (set) and processing_log (ONE entry appended; prior entries unchanged — verified by md5
--   below). voice_sessions has no metadata column; processing_log is the row's own jsonb audit log and nothing
--   server-side reads it. Every other column is unchanged — verified by md5 below.
-- Each UPDATE is guarded by anchor_edge_id is null, so a re-run is a no-op (no double append).
-- Supabase editor note: no jsonb `?` operator is used (the editor misflags it).

-- ============================================================================
-- BEFORE (run first; expected values inline)
-- ============================================================================
select count(*) from voice_sessions where session_kind = 'real' and anchor_edge_id is null;  -- expect 15

select id, anchor_edge_id, jsonb_array_length(processing_log) n_log, md5(processing_log::text) log_md5,
  md5(row(id, user_id, board_snapshot, started_at, ended_at, end_reason, summary, session_kind)::text) other_md5
from voice_sessions where session_kind = 'real' and anchor_edge_id is null order by started_at;
-- expect 15 rows, anchor_edge_id null on all:
--   47d96c14-4cf6-478b-83cc-c513d31420b5 | n_log  393 | log_md5 6bac5f093c5cb87a65810c54e099683f | other_md5 fb7d8bf08c170c7c2278e5365364d8d9
--   c93c5e49-e468-4a98-8b03-2236385753a6 | n_log  561 | log_md5 1c9d484650c485224aa00629bbbd04aa | other_md5 c9eac52c07ea852785ee1989cffbdb43
--   6a2a4697-bfd6-4a12-90b4-3933d2ac3622 | n_log  563 | log_md5 6fd489d12b2a2c6e99e66fff42938f46 | other_md5 efff64f4186fcd2566fcc05a764382f7
--   fe43bab2-05d0-4818-b864-5289f99e8e17 | n_log  157 | log_md5 a526bde747c80b97c3c0fff0dc4064ca | other_md5 24751adc21a6e7ff1f68aa7204cd82fb
--   8dc55161-f1b5-4923-873c-0b5437283117 | n_log  396 | log_md5 6d798eae08f840f4cc3ddf1afbd0cb8b | other_md5 37a2037f346fc3e98ee021b5fdfd5743
--   e1b8bf89-34e8-490a-bd02-ff6aa5ebfad9 | n_log  247 | log_md5 6dd52eb58c3b679c18c6b022591558d2 | other_md5 6d5973799d883aece1de096b8c7ed496
--   22962f34-0c87-4a1f-adf0-5c00df157baa | n_log  921 | log_md5 ab11e4d85873ada499dc1cea5e996818 | other_md5 33267eda723528fa7b876f440d4186a4
--   119259fb-7e61-4de8-a9c4-fcd8fcdde771 | n_log  935 | log_md5 9c31d5cbc93eab13defc9a7c6946b7a4 | other_md5 393f12ed28bae390b757cdae928071fb
--   8feed1e5-0bde-469d-8d43-8eccaf0ad9a1 | n_log  841 | log_md5 de043ed5b8ffc7347910bc09877191d1 | other_md5 e5513e966b303d3b51d328b71f727f01
--   2048d084-6395-4fac-be21-b18f85c56bf3 | n_log  636 | log_md5 a763244dd780aa67eb278e5e5ccbedb6 | other_md5 c5744dfe42d87c05cd903e5a19c15ec7
--   02144349-94a7-4899-9943-b09942aa292f | n_log  266 | log_md5 70538e84b5b1196ac9a80b0aea4668b9 | other_md5 58cae619ecae1e6d085ab892077e1616
--   1defbdf7-bbb2-4228-8e5b-3fa94d887d06 | n_log  714 | log_md5 fd412235f8391cb9ad2cda487ba042a6 | other_md5 1de914704015922606b1c04eb4bb24c4
--   3ffe9e77-7220-4ed9-97a0-699ee849ed95 | n_log 1104 | log_md5 81938d4d5f5bd76ffd5ca87904689fda | other_md5 7e3a5e0e5d7794261597395d3f27133f
--   477db21d-352f-4be3-a117-847d09766786 | n_log  545 | log_md5 f6588f4f0e80d064374e264c22aa268a | other_md5 274b4baf3dd1dfe2f3eac27a61eb7b7f
--   71cb3d68-0424-4c5f-934f-8b96dc9a9360 | n_log  831 | log_md5 9783ff4ffad9869db483a4a29e3918a3 | other_md5 182e23b4f6d619d9f960224731490ffd

-- ============================================================================
-- BACKFILL (one transaction; the DO block aborts it unless the end state is exact)
-- ============================================================================
begin;

-- 47d96c14  connection:a358f35c-dc41-4df2-a942-1f35f527f2d9:2:3  click 2026-05-23 02:44:54.513378+00  +12.936 s
update voice_sessions
   set anchor_edge_id = '03bef9b8-5066-4101-b6b8-0d0a97ee46c5',
       processing_log = processing_log || jsonb_build_array(jsonb_build_object(
         'ts', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
         'phase', 'backfill.anchor_edge_id', 'outcome', 'success',
         'detail', jsonb_build_object('anchor_edge_id_source', '{"read": "docs/reads/voice-launch-attribution.md", "dispatch": "#62", "method": "launch click -> edges via (board, directionless pair, click metadata.mode)", "browser_session_id": "7abdfb19-865c-469c-83d9-4949a3ec1140", "click_event_id": "32091666-e263-4f78-b2db-1b7417803960", "click_ts": "2026-05-23 02:44:54.513378+00", "click_target_id": "connection:a358f35c-dc41-4df2-a942-1f35f527f2d9:2:3", "click_mode": "weave", "click_connection_type": "strategic contradiction", "click_to_start_s": 12.936, "edge_id": "03bef9b8-5066-4101-b6b8-0d0a97ee46c5", "edge_created_at": "2026-05-23 02:44:48.152759+00", "in_t2_window": false, "confidence": "high"}'::jsonb)))
 where id = '47d96c14-4cf6-478b-83cc-c513d31420b5' and anchor_edge_id is null and session_kind = 'real';

-- 6a2a4697  connection:8a8d45a9-5327-4355-ae3c-c1fff734b327:25:15  click 2026-05-24 01:27:41.774143+00  +10.482 s
update voice_sessions
   set anchor_edge_id = 'bcc05cdf-063b-41e7-b5ac-b3372dcf2d9e',
       processing_log = processing_log || jsonb_build_array(jsonb_build_object(
         'ts', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
         'phase', 'backfill.anchor_edge_id', 'outcome', 'success',
         'detail', jsonb_build_object('anchor_edge_id_source', '{"read": "docs/reads/voice-launch-attribution.md", "dispatch": "#62", "method": "launch click -> edges via (board, directionless pair, click metadata.mode)", "browser_session_id": "9ab3284a-ec29-4aab-bc85-a1f11a16eb45", "click_event_id": "462514ce-2314-4fca-aca5-e6e04b24b691", "click_ts": "2026-05-24 01:27:41.774143+00", "click_target_id": "connection:8a8d45a9-5327-4355-ae3c-c1fff734b327:25:15", "click_mode": "weave", "click_connection_type": "temporal sequence", "click_to_start_s": 10.482, "edge_id": "bcc05cdf-063b-41e7-b5ac-b3372dcf2d9e", "edge_created_at": "2026-05-24 01:27:33.101142+00", "in_t2_window": false, "confidence": "high"}'::jsonb)))
 where id = '6a2a4697-bfd6-4a12-90b4-3933d2ac3622' and anchor_edge_id is null and session_kind = 'real';

-- fe43bab2  connection:b3c1473b-85bd-405b-90d0-917754d3da5f:12:18  click 2026-05-25 04:43:38.855211+00  +1.260 s
update voice_sessions
   set anchor_edge_id = '3cba225f-6283-4ffc-9323-135421da5a16',
       processing_log = processing_log || jsonb_build_array(jsonb_build_object(
         'ts', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
         'phase', 'backfill.anchor_edge_id', 'outcome', 'success',
         'detail', jsonb_build_object('anchor_edge_id_source', '{"read": "docs/reads/voice-launch-attribution.md", "dispatch": "#62", "method": "launch click -> edges via (board, directionless pair, click metadata.mode)", "browser_session_id": "1d16f397-9743-47a9-81f0-5b98a3fe2732", "click_event_id": "55084ebd-f40c-46d9-a39b-8bbcc909ad92", "click_ts": "2026-05-25 04:43:38.855211+00", "click_target_id": "connection:b3c1473b-85bd-405b-90d0-917754d3da5f:12:18", "click_mode": "weave", "click_connection_type": "temporal", "click_to_start_s": 1.26, "edge_id": "3cba225f-6283-4ffc-9323-135421da5a16", "edge_created_at": "2026-05-25 04:43:13.018751+00", "in_t2_window": false, "confidence": "high"}'::jsonb)))
 where id = 'fe43bab2-05d0-4818-b864-5289f99e8e17' and anchor_edge_id is null and session_kind = 'real';

-- 8dc55161  connection:b3c1473b-85bd-405b-90d0-917754d3da5f:18:16  click 2026-05-25 05:03:59.427524+00  +0.680 s
update voice_sessions
   set anchor_edge_id = 'e1b72d32-b74e-40d8-a8d3-4fcd028bd0e8',
       processing_log = processing_log || jsonb_build_array(jsonb_build_object(
         'ts', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
         'phase', 'backfill.anchor_edge_id', 'outcome', 'success',
         'detail', jsonb_build_object('anchor_edge_id_source', '{"read": "docs/reads/voice-launch-attribution.md", "dispatch": "#62", "method": "launch click -> edges via (board, directionless pair, click metadata.mode)", "browser_session_id": "1d16f397-9743-47a9-81f0-5b98a3fe2732", "click_event_id": "89997d4e-ded4-4169-906f-cbb37d629260", "click_ts": "2026-05-25 05:03:59.427524+00", "click_target_id": "connection:b3c1473b-85bd-405b-90d0-917754d3da5f:18:16", "click_mode": "weave", "click_connection_type": "temporal", "click_to_start_s": 0.68, "edge_id": "e1b72d32-b74e-40d8-a8d3-4fcd028bd0e8", "edge_created_at": "2026-05-25 04:43:13.018751+00", "in_t2_window": false, "confidence": "high"}'::jsonb)))
 where id = '8dc55161-f1b5-4923-873c-0b5437283117' and anchor_edge_id is null and session_kind = 'real';

-- 22962f34  connection:a428492a-08f5-4d66-8da6-a307bcdaea62:33:10  click 2026-06-19 04:21:56.093652+00  +1.385 s
update voice_sessions
   set anchor_edge_id = '8ce813a4-31cf-4689-b9c0-df1c8de4cc06',
       processing_log = processing_log || jsonb_build_array(jsonb_build_object(
         'ts', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
         'phase', 'backfill.anchor_edge_id', 'outcome', 'success',
         'detail', jsonb_build_object('anchor_edge_id_source', '{"read": "docs/reads/voice-launch-attribution.md", "dispatch": "#62", "method": "launch click -> edges via (board, directionless pair, click metadata.mode)", "browser_session_id": "bda1a75a-3781-4eb9-875e-25d8b62cdf08", "click_event_id": "97a4b729-e7cc-405e-8ab6-5e9bd2998952", "click_ts": "2026-06-19 04:21:56.093652+00", "click_target_id": "connection:a428492a-08f5-4d66-8da6-a307bcdaea62:33:10", "click_mode": "weave", "click_connection_type": "structural parallel", "click_to_start_s": 1.385, "edge_id": "8ce813a4-31cf-4689-b9c0-df1c8de4cc06", "edge_created_at": "2026-06-19 04:07:38.913911+00", "in_t2_window": false, "confidence": "high"}'::jsonb)))
 where id = '22962f34-0c87-4a1f-adf0-5c00df157baa' and anchor_edge_id is null and session_kind = 'real';

-- 119259fb  connection:b3c1473b-85bd-405b-90d0-917754d3da5f:24:20  click 2026-07-22 06:38:15.007536+00  +3.745 s
update voice_sessions
   set anchor_edge_id = '1f59969b-8fc2-44a3-a4eb-7cd15a75fe1e',
       processing_log = processing_log || jsonb_build_array(jsonb_build_object(
         'ts', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
         'phase', 'backfill.anchor_edge_id', 'outcome', 'success',
         'detail', jsonb_build_object('anchor_edge_id_source', '{"read": "docs/reads/voice-launch-attribution.md", "dispatch": "#62", "method": "launch click -> edges via (board, directionless pair, click metadata.mode)", "browser_session_id": "3849d3b7-47b4-4e16-8f20-4ae36e273c38", "click_event_id": "d4093b96-25c1-43fd-975f-80f3cfc12b48", "click_ts": "2026-07-22 06:38:15.007536+00", "click_target_id": "connection:b3c1473b-85bd-405b-90d0-917754d3da5f:24:20", "click_mode": "weave", "click_connection_type": "dehumanization gradient", "click_to_start_s": 3.745, "edge_id": "1f59969b-8fc2-44a3-a4eb-7cd15a75fe1e", "edge_created_at": "2026-07-22 06:34:00.210832+00", "in_t2_window": false, "confidence": "high"}'::jsonb)))
 where id = '119259fb-7e61-4de8-a9c4-fcd8fcdde771' and anchor_edge_id is null and session_kind = 'real';

-- 8feed1e5  connection:a428492a-08f5-4d66-8da6-a307bcdaea62:37:33  click 2026-08-12 03:31:43.898144+00  +1.039 s
update voice_sessions
   set anchor_edge_id = '34959e4f-2873-47ba-a8c6-b9b4c3ce08fa',
       processing_log = processing_log || jsonb_build_array(jsonb_build_object(
         'ts', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
         'phase', 'backfill.anchor_edge_id', 'outcome', 'success',
         'detail', jsonb_build_object('anchor_edge_id_source', '{"read": "docs/reads/voice-launch-attribution.md", "dispatch": "#62", "method": "launch click -> edges via (board, directionless pair, click metadata.mode)", "browser_session_id": "72cec5d7-7052-4bd5-a89d-19a93c4577f9", "click_event_id": "36b2acf3-db4b-44ab-b310-42614f10f45b", "click_ts": "2026-08-12 03:31:43.898144+00", "click_target_id": "connection:a428492a-08f5-4d66-8da6-a307bcdaea62:37:33", "click_mode": "weave", "click_connection_type": "philosophical parallel", "click_to_start_s": 1.039, "edge_id": "34959e4f-2873-47ba-a8c6-b9b4c3ce08fa", "edge_created_at": "2026-08-12 03:27:13.429086+00", "in_t2_window": false, "confidence": "high"}'::jsonb)))
 where id = '8feed1e5-0bde-469d-8d43-8eccaf0ad9a1' and anchor_edge_id is null and session_kind = 'real';

-- 2048d084  connection:8a8d45a9-5327-4355-ae3c-c1fff734b327:41:11  click 2026-09-09 05:03:44.069951+00  +1.314 s  [t2 window]
update voice_sessions
   set anchor_edge_id = '253a1b56-0c07-4f77-a50a-b6bcbf20aba0',
       processing_log = processing_log || jsonb_build_array(jsonb_build_object(
         'ts', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
         'phase', 'backfill.anchor_edge_id', 'outcome', 'success',
         'detail', jsonb_build_object('anchor_edge_id_source', '{"read": "docs/reads/voice-launch-attribution.md", "dispatch": "#62", "method": "launch click -> edges via (board, directionless pair, click metadata.mode)", "browser_session_id": "3d113487-4710-44c9-8e15-826910b888aa", "click_event_id": "77c027d2-a87c-4c2a-9f8e-fa52ffd0cf65", "click_ts": "2026-09-09 05:03:44.069951+00", "click_target_id": "connection:8a8d45a9-5327-4355-ae3c-c1fff734b327:41:11", "click_mode": "weave", "click_connection_type": "structural parallel", "click_to_start_s": 1.314, "edge_id": "253a1b56-0c07-4f77-a50a-b6bcbf20aba0", "edge_created_at": "2026-09-09 04:46:39.066044+00", "in_t2_window": true, "confidence": "high"}'::jsonb)))
 where id = '2048d084-6395-4fac-be21-b18f85c56bf3' and anchor_edge_id is null and session_kind = 'real';

-- 02144349  connection:8a8d45a9-5327-4355-ae3c-c1fff734b327:43:11  click 2026-09-17 23:04:18.749593+00  +16.003 s  [t2 window]
update voice_sessions
   set anchor_edge_id = 'fe53dd86-e054-43a0-a9f3-d5cf7d0e567c',
       processing_log = processing_log || jsonb_build_array(jsonb_build_object(
         'ts', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
         'phase', 'backfill.anchor_edge_id', 'outcome', 'success',
         'detail', jsonb_build_object('anchor_edge_id_source', '{"read": "docs/reads/voice-launch-attribution.md", "dispatch": "#62", "method": "launch click -> edges via (board, directionless pair, click metadata.mode)", "browser_session_id": "de513492-105e-4eb3-8dc9-cbe64b0773eb", "click_event_id": "7dd82322-0693-4363-9cbb-3f8f9063988e", "click_ts": "2026-09-17 23:04:18.749593+00", "click_target_id": "connection:8a8d45a9-5327-4355-ae3c-c1fff734b327:43:11", "click_mode": "weave", "click_connection_type": "diagnostic echo", "click_to_start_s": 16.003, "edge_id": "fe53dd86-e054-43a0-a9f3-d5cf7d0e567c", "edge_created_at": "2026-09-17 22:00:02.858354+00", "in_t2_window": true, "confidence": "high"}'::jsonb)))
 where id = '02144349-94a7-4899-9943-b09942aa292f' and anchor_edge_id is null and session_kind = 'real';

-- 1defbdf7  connection:b3c1473b-85bd-405b-90d0-917754d3da5f:26:8  click 2026-09-24 07:58:20.954272+00  +1.745 s  [t2 window]
update voice_sessions
   set anchor_edge_id = '3ee03c47-3965-4a6e-b13c-7eed54378578',
       processing_log = processing_log || jsonb_build_array(jsonb_build_object(
         'ts', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
         'phase', 'backfill.anchor_edge_id', 'outcome', 'success',
         'detail', jsonb_build_object('anchor_edge_id_source', '{"read": "docs/reads/voice-launch-attribution.md", "dispatch": "#62", "method": "launch click -> edges via (board, directionless pair, click metadata.mode)", "browser_session_id": "6901ef36-878c-478f-90e3-dc5c8a94594b", "click_event_id": "3366339c-61cc-4221-bea2-97543d7971e4", "click_ts": "2026-09-24 07:58:20.954272+00", "click_target_id": "connection:b3c1473b-85bd-405b-90d0-917754d3da5f:26:8", "click_mode": "weave", "click_connection_type": "causal", "click_to_start_s": 1.745, "edge_id": "3ee03c47-3965-4a6e-b13c-7eed54378578", "edge_created_at": "2026-09-24 07:53:06.032281+00", "in_t2_window": true, "confidence": "high"}'::jsonb)))
 where id = '1defbdf7-bbb2-4228-8e5b-3fa94d887d06' and anchor_edge_id is null and session_kind = 'real';

-- 3ffe9e77  connection:b3c1473b-85bd-405b-90d0-917754d3da5f:28:8  click 2026-09-26 10:25:36.439169+00  +13.090 s  [t2 window]
update voice_sessions
   set anchor_edge_id = '696a0314-5cc2-4e8b-b4aa-58110622aab8',
       processing_log = processing_log || jsonb_build_array(jsonb_build_object(
         'ts', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
         'phase', 'backfill.anchor_edge_id', 'outcome', 'success',
         'detail', jsonb_build_object('anchor_edge_id_source', '{"read": "docs/reads/voice-launch-attribution.md", "dispatch": "#62", "method": "launch click -> edges via (board, directionless pair, click metadata.mode)", "browser_session_id": "d43a3654-0827-4b47-a45b-2c5b3553cbd5", "click_event_id": "7a573d94-6de9-484c-8624-e2457c842388", "click_ts": "2026-09-26 10:25:36.439169+00", "click_target_id": "connection:b3c1473b-85bd-405b-90d0-917754d3da5f:28:8", "click_mode": "weave", "click_connection_type": "developmental", "click_to_start_s": 13.09, "edge_id": "696a0314-5cc2-4e8b-b4aa-58110622aab8", "edge_created_at": "2026-09-26 10:23:37.18009+00", "in_t2_window": true, "confidence": "high"}'::jsonb)))
 where id = '3ffe9e77-7220-4ed9-97a0-699ee849ed95' and anchor_edge_id is null and session_kind = 'real';

-- 477db21d  connection:a358f35c-dc41-4df2-a942-1f35f527f2d9:5:7  click 2026-10-01 01:43:22.287338+00  +0.934 s  [t2 window]
update voice_sessions
   set anchor_edge_id = 'fc618bf5-8265-444c-8c62-9f0314338dd4',
       processing_log = processing_log || jsonb_build_array(jsonb_build_object(
         'ts', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
         'phase', 'backfill.anchor_edge_id', 'outcome', 'success',
         'detail', jsonb_build_object('anchor_edge_id_source', '{"read": "docs/reads/voice-launch-attribution.md", "dispatch": "#62", "method": "launch click -> edges via (board, directionless pair, click metadata.mode)", "browser_session_id": "30c411f6-1905-47ed-a336-baa2be34ba9c", "click_event_id": "b9c363ff-00f0-4f5b-835c-3ecf4d3676ee", "click_ts": "2026-10-01 01:43:22.287338+00", "click_target_id": "connection:a358f35c-dc41-4df2-a942-1f35f527f2d9:5:7", "click_mode": "weave", "click_connection_type": "ideological convergence", "click_to_start_s": 0.934, "edge_id": "fc618bf5-8265-444c-8c62-9f0314338dd4", "edge_created_at": "2026-09-30 23:45:31.427221+00", "in_t2_window": true, "confidence": "high", "note": "edge unambiguous; loss mechanism (boot-time cache window) undetermined per read §D.3"}'::jsonb)))
 where id = '477db21d-352f-4be3-a117-847d09766786' and anchor_edge_id is null and session_kind = 'real';

-- 71cb3d68  connection:8a8d45a9-5327-4355-ae3c-c1fff734b327:47:17  click 2026-10-03 07:17:26.49879+00  +5.607 s  [t2 window]
update voice_sessions
   set anchor_edge_id = '3cfc878e-b986-4191-9bec-d6facf7ec7df',
       processing_log = processing_log || jsonb_build_array(jsonb_build_object(
         'ts', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
         'phase', 'backfill.anchor_edge_id', 'outcome', 'success',
         'detail', jsonb_build_object('anchor_edge_id_source', '{"read": "docs/reads/voice-launch-attribution.md", "dispatch": "#62", "method": "launch click -> edges via (board, directionless pair, click metadata.mode)", "browser_session_id": "b6b6e7b0-450b-4047-b640-62b441d26793", "click_event_id": "cb2c0a74-9fad-4367-a841-0259f52058a6", "click_ts": "2026-10-03 07:17:26.49879+00", "click_target_id": "connection:8a8d45a9-5327-4355-ae3c-c1fff734b327:47:17", "click_mode": "weave", "click_connection_type": "thematic parallel", "click_to_start_s": 5.607, "edge_id": "3cfc878e-b986-4191-9bec-d6facf7ec7df", "edge_created_at": "2026-10-03 05:56:06.955537+00", "in_t2_window": true, "confidence": "high"}'::jsonb)))
 where id = '71cb3d68-0424-4c5f-934f-8b96dc9a9360' and anchor_edge_id is null and session_kind = 'real';

do $$
declare n_null int; n_bf int; n_skip int;
begin
  select count(*) into n_null from voice_sessions where session_kind = 'real' and anchor_edge_id is null;
  select count(*) into n_skip from voice_sessions where session_kind = 'real' and anchor_edge_id is null and id in ('c93c5e49-e468-4a98-8b03-2236385753a6','e1b8bf89-34e8-490a-bd02-ff6aa5ebfad9');
  select count(*) into n_bf from voice_sessions where processing_log->-1->>'phase' = 'backfill.anchor_edge_id';
  if n_null <> 2 or n_skip <> 2 or n_bf <> 13 then
    raise exception 'backfill end state wrong: null=% (want 2) skipped-null=% (want 2) backfilled=% (want 13)', n_null, n_skip, n_bf;
  end if;
end $$;

commit;

-- ============================================================================
-- AFTER (verify by requery)
-- ============================================================================
select count(*) from voice_sessions where session_kind = 'real' and anchor_edge_id is null;  -- expect 2

-- The 15 rows: every check column must be true on all 15.
with x(id, want_edge, before_n, before_log_md5, before_other_md5) as (values
  ('47d96c14-4cf6-478b-83cc-c513d31420b5'::uuid, '03bef9b8-5066-4101-b6b8-0d0a97ee46c5'::uuid, 393, '6bac5f093c5cb87a65810c54e099683f', 'fb7d8bf08c170c7c2278e5365364d8d9'),
  ('c93c5e49-e468-4a98-8b03-2236385753a6'::uuid, null::uuid, 561, '1c9d484650c485224aa00629bbbd04aa', 'c9eac52c07ea852785ee1989cffbdb43'),
  ('6a2a4697-bfd6-4a12-90b4-3933d2ac3622'::uuid, 'bcc05cdf-063b-41e7-b5ac-b3372dcf2d9e'::uuid, 563, '6fd489d12b2a2c6e99e66fff42938f46', 'efff64f4186fcd2566fcc05a764382f7'),
  ('fe43bab2-05d0-4818-b864-5289f99e8e17'::uuid, '3cba225f-6283-4ffc-9323-135421da5a16'::uuid, 157, 'a526bde747c80b97c3c0fff0dc4064ca', '24751adc21a6e7ff1f68aa7204cd82fb'),
  ('8dc55161-f1b5-4923-873c-0b5437283117'::uuid, 'e1b72d32-b74e-40d8-a8d3-4fcd028bd0e8'::uuid, 396, '6d798eae08f840f4cc3ddf1afbd0cb8b', '37a2037f346fc3e98ee021b5fdfd5743'),
  ('e1b8bf89-34e8-490a-bd02-ff6aa5ebfad9'::uuid, null::uuid, 247, '6dd52eb58c3b679c18c6b022591558d2', '6d5973799d883aece1de096b8c7ed496'),
  ('22962f34-0c87-4a1f-adf0-5c00df157baa'::uuid, '8ce813a4-31cf-4689-b9c0-df1c8de4cc06'::uuid, 921, 'ab11e4d85873ada499dc1cea5e996818', '33267eda723528fa7b876f440d4186a4'),
  ('119259fb-7e61-4de8-a9c4-fcd8fcdde771'::uuid, '1f59969b-8fc2-44a3-a4eb-7cd15a75fe1e'::uuid, 935, '9c31d5cbc93eab13defc9a7c6946b7a4', '393f12ed28bae390b757cdae928071fb'),
  ('8feed1e5-0bde-469d-8d43-8eccaf0ad9a1'::uuid, '34959e4f-2873-47ba-a8c6-b9b4c3ce08fa'::uuid, 841, 'de043ed5b8ffc7347910bc09877191d1', 'e5513e966b303d3b51d328b71f727f01'),
  ('2048d084-6395-4fac-be21-b18f85c56bf3'::uuid, '253a1b56-0c07-4f77-a50a-b6bcbf20aba0'::uuid, 636, 'a763244dd780aa67eb278e5e5ccbedb6', 'c5744dfe42d87c05cd903e5a19c15ec7'),
  ('02144349-94a7-4899-9943-b09942aa292f'::uuid, 'fe53dd86-e054-43a0-a9f3-d5cf7d0e567c'::uuid, 266, '70538e84b5b1196ac9a80b0aea4668b9', '58cae619ecae1e6d085ab892077e1616'),
  ('1defbdf7-bbb2-4228-8e5b-3fa94d887d06'::uuid, '3ee03c47-3965-4a6e-b13c-7eed54378578'::uuid, 714, 'fd412235f8391cb9ad2cda487ba042a6', '1de914704015922606b1c04eb4bb24c4'),
  ('3ffe9e77-7220-4ed9-97a0-699ee849ed95'::uuid, '696a0314-5cc2-4e8b-b4aa-58110622aab8'::uuid, 1104, '81938d4d5f5bd76ffd5ca87904689fda', '7e3a5e0e5d7794261597395d3f27133f'),
  ('477db21d-352f-4be3-a117-847d09766786'::uuid, 'fc618bf5-8265-444c-8c62-9f0314338dd4'::uuid, 545, 'f6588f4f0e80d064374e264c22aa268a', '274b4baf3dd1dfe2f3eac27a61eb7b7f'),
  ('71cb3d68-0424-4c5f-934f-8b96dc9a9360'::uuid, '3cfc878e-b986-4191-9bec-d6facf7ec7df'::uuid, 831, '9783ff4ffad9869db483a4a29e3918a3', '182e23b4f6d619d9f960224731490ffd')
)
select vs.id, vs.anchor_edge_id,
  vs.anchor_edge_id is not distinct from x.want_edge as anchor_ok,
  md5(row(vs.id, vs.user_id, vs.board_snapshot, vs.started_at, vs.ended_at, vs.end_reason, vs.summary, vs.session_kind)::text) = x.before_other_md5 as other_cols_unchanged,
  case when x.want_edge is null
       then md5(vs.processing_log::text) = x.before_log_md5 and jsonb_array_length(vs.processing_log) = x.before_n
       else jsonb_array_length(vs.processing_log) = x.before_n + 1
        and md5((vs.processing_log - x.before_n)::text) = x.before_log_md5
        and vs.processing_log->-1->>'phase' = 'backfill.anchor_edge_id'
        and vs.processing_log->-1->'detail'->'anchor_edge_id_source'->>'edge_id' = x.want_edge::text end as log_ok,
  vs.processing_log->-1->'detail'->'anchor_edge_id_source'->>'confidence' as confidence
from x join voice_sessions vs on vs.id = x.id order by vs.started_at;
-- expect 15 rows; anchor_ok, other_cols_unchanged, log_ok all true; anchor_edge_id null only on c93c5e49 and e1b8bf89.

-- Pipeline-readiness: the backfilled anchors resolve to an edges row with both endpoint nodes (reads.ts:205-214 throws otherwise).
select count(*) n, count(ed.id) edges_found, count(fn.id) from_found, count(tn.id) to_found
from voice_sessions vs left join edges ed on ed.id = vs.anchor_edge_id
left join nodes fn on fn.id = ed.source_node_id left join nodes tn on tn.id = ed.target_node_id
where vs.processing_log->-1->>'phase' = 'backfill.anchor_edge_id';  -- expect 13 | 13 | 13 | 13
