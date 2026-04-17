-- Phase 1: Remove ghost board events
-- Ghost boards have ONLY session lifecycle events (session_started,
-- session_ended, board_switched) with zero content events. Real boards
-- (even new ones with just one item_added) are preserved.
delete from weave_events
where board_id in (
  select board_id
  from weave_events
  group by board_id
  having count(*) filter (
    where event_type not in ('session_started', 'board_switched', 'session_ended')
  ) = 0
);

-- Phase 2a: item_added — prepend "node:" to existing composite key
-- Before: "c943a456-...:7"
-- After:  "node:c943a456-...:7"
update weave_events
set target_id = 'node:' || target_id
where event_type = 'item_added'
  and target_id is not null;

-- Phase 2b: connection_label_clicked — convert edge ID to prefixed format
-- Before: "weave-4-3" (board context in separate board_id column)
-- After:  "connection:c943a456-...:4:3" (fully self-contained)
update weave_events
set target_id = 'connection:' || board_id || ':' ||
  split_part(target_id, '-', 2) || ':' ||
  split_part(target_id, '-', 3)
where event_type = 'connection_label_clicked'
  and target_id is not null;

-- Phase 2c: connection_description_closed — same transform
update weave_events
set target_id = 'connection:' || board_id || ':' ||
  split_part(target_id, '-', 2) || ':' ||
  split_part(target_id, '-', 3)
where event_type = 'connection_description_closed'
  and target_id is not null;

-- Events with null target_id (session_started, session_ended,
-- board_switched, board_created, weave_triggered) are left unchanged.
-- Future client code will emit board events as "board:{board_id}"
-- going forward, but historical nulls are preserved as-is.
