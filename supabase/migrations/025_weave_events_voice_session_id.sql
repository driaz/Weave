-- Migration 025: add voice_session_id to weave_events.
--
-- weave_events.session_id holds a client-generated "browser session"
-- correlation id (services/eventTracker.ts: one crypto.randomUUID()
-- per page load). It groups events that share a tab lifetime; it has
-- nothing to do with voice_sessions rows.
--
-- The new voice_session_id column points at voice_sessions.id (the
-- Postgres uuid returned by voiceSessionController.startSession). When
-- an event was emitted from a voice context (today: the two lifecycle
-- events voice.session.started / voice.session.ended; potentially
-- more after Phase 8 polish), we can now join weave_events back to
-- the voice_sessions row that drove it.
--
-- Design choices:
--   - NO foreign key. weave_events is a telemetry log. Events should
--     reference voice session uuids freely, including for sessions
--     that have since been deleted. Hard FK + cascade would erase the
--     telemetry trail for any deleted session.
--   - Nullable. Most weave_events rows (canvas interactions, weave
--     triggers, etc.) have no voice context — null is the correct
--     default and prevents the column from forcing a value into
--     non-voice call sites.
--   - Partial index `WHERE voice_session_id IS NOT NULL`. The "events
--     for a given voice session" lookup is the only expected access
--     pattern. Most rows will have NULL here, so a partial index
--     keeps the index small and the writes for non-voice events
--     unaffected.
--
-- Backfill: none. The 45 pre-Phase-8 weave_events rows reference
-- voice sessions that never existed in the new schema — leaving
-- their voice_session_id NULL is the correct historical record.
--
-- Down migration: drop the index, then drop the column.

alter table weave_events
  add column voice_session_id uuid;

create index idx_weave_events_voice_session_id
  on weave_events (voice_session_id)
  where voice_session_id is not null;
