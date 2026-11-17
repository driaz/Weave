-- Opener gaps from voice_sessions.processing_log: the same marks run.mjs
-- reads, on real devices. Read-only. Run with the read-only prod URL
--   psql "$WEAVE_PROD_RO_DATABASE_URL" -f scripts/opener-timing/prod-openers.sql
-- or paste into the read-only Supabase connector (cloud sessions).
-- First occurrence per phase = the opener's. click→session.started is not
-- logged in prod (the app has no Speak-click event), so TOTAL starts at
-- voice.session.started here and at the click in run.mjs.
with s as (
  select id, started_at, processing_log pl
  from voice_sessions
  where started_at > now() - interval '30 days'
),
f as (
  select s.id, s.started_at, x.e->>'phase' phase, min((x.e->>'ts')::timestamptz) ts
  from s, jsonb_array_elements(s.pl) x(e)
  group by 1, 2, 3
),
p as (
  select id, started_at,
    max(ts) filter (where phase = 'voice.session.started') st,
    max(ts) filter (where phase = 'voice.session.ready') rd,
    max(ts) filter (where phase = 'voice.retrieval.deposit_corpus') dc,
    max(ts) filter (where phase = 'voice.turn.started') ts_,
    max(ts) filter (where phase = 'voice.claude.request_sent') rq,
    max(ts) filter (where phase = 'voice.claude.first_text_delta') ftd,
    max(ts) filter (where phase = 'voice.tts.segment_requested') tq,
    max(ts) filter (where phase = 'voice.mux.segment_added') sa,
    max(ts) filter (where phase = 'voice.mux.segment_writing') sw
  from f group by 1, 2
),
g as (
  select
    extract(epoch from rd - st) * 1000 started_ready,
    extract(epoch from dc - rd) * 1000 ready_corpus,
    extract(epoch from ts_ - rd) * 1000 ready_turn,
    extract(epoch from ftd - rq) * 1000 ttft,
    extract(epoch from tq - ftd) * 1000 first_sentence,
    extract(epoch from sa - tq) * 1000 tts_ttfb,
    extract(epoch from sw - sa) * 1000 added_writing,
    extract(epoch from sw - st) * 1000 total
  from p where st is not null and sw is not null
)
select gap, count(v) n,
  round(percentile_cont(0.5) within group (order by v)) median,
  round(min(v)) min, round(max(v)) max
from (
  select '1 started→ready' gap, started_ready v from g
  union all select '2 ready→deposit_corpus', ready_corpus from g
  union all select '3 ready→turn.started', ready_turn from g
  union all select '4 request_sent→first_text', ttft from g
  union all select '5 first_text→tts.requested', first_sentence from g
  union all select '6 tts.requested→segment_added', tts_ttfb from g
  union all select '7 segment_added→writing', added_writing from g
  union all select '8 TOTAL started→writing', total from g
) z
group by gap order by gap;
