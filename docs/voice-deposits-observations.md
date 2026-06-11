# Observation log — deposits write path + backfill (2026-06-11, PR #31)

Empirical record from the write-path build and full prod backfill under
prompt version `751831e51d29ead2` (model `claude-opus-4-6`). Observe-only:
nothing here is a fix queued for PR #31. These are the measurements the next
prompt version gets designed against — corpus numbers, base rates, and the
one contained fabrication incident.

Rule numbering below follows the prompt-v2 additions: rule 1 = claim-level
attribution, rule 2 = asymmetry is reportable, rule 3 = proportionality
floor, rule 4 = register breaks are signal.

## 1. Rule-1/rule-2 collision (claim-level attribution × asymmetry)

Seen in stub gen 1 (`02b8222e`, prompt 751831e51d29ead2, 2026-06-11 04:54 UTC).

The two rules fire on the same underlying fact and the output pays for it
twice. Deposit 1 closes with the rule-1 attribution stamp ("This deposit is
entirely the assistant's construction; the user did not develop, contest, or
extend it"). Deposit 2 then exists *solely* to satisfy rule 2 ("The session's
asymmetry is pronounced…") — it records no produced thinking, only session
metadata, yet it occupies a deposit slot at ordinal 2 and is embedded into
the shared retrieval space typed `deposit`. A retrieval consumer matching
against it gets a claim about the session's shape, not a deposit.

Draw-dependent, not deterministic: the 04-00 validation draw of the same stub
folded the asymmetry into the single deposit + open edge (2 rows); this draw
split it out (3 rows). Both are honest under the prompt as written — the
collision is that nothing tells the model whether asymmetry is a *property of
deposits* (rule-1 tail) or a *deposit itself* (standalone paragraph).

Possible future lever (NOT now): one clause clarifying that asymmetry is
reported inside deposits/open edge, never as its own deposit. Defer until
corpus evidence shows how often the standalone form occurs.

## 2. "Posed but not taken up" verbosity footprint

Same stub gen-1 output as entry 1: the assistant's unanswered closing
question is narrated three times — deposit 1 ("was not taken up by the
user"), deposit 2 ("The user did not answer"), open edge ("went unanswered").
The footprint predates the backfill. Observe, do not pre-fix.

Post-backfill measurement (65 sessions, 176 active rows): 44 rows across 36
sessions carry the footprint (regex over posed-but/not-taken-up/unanswered
variants). Over half the corpus narrates non-uptake at least once; much of
that is legitimate rule-1/rule-2 compliance on asymmetric sessions (19 of 65
are assistant-only), so the raw count overstates the defect. The defect form
is repetition WITHIN a session (the 3× case above). Still observe-only.

## 3. Fabricated-continuation on an assistant-only stub (72a855bd)

Backfill, 2026-06-11 05:35 UTC. Session `72a855bd` is 1 utterance, 1,590
chars, assistant-only. The model's output is NOT a summary of that
transcript: after a leading `---`, it invents ~85 lines of multi-turn
USER/ASSISTANT dialogue (Horace, the Odes vs. Ars Poetica, the hummingbird
metaphor, "elective mortality") that never occurred, then emits four
well-formed deposits + open edge summarizing the invented conversation,
with claim-level attribution to "the user" — who never spoke in the session.

The parse failure ("empty deposit body at segment 1", from the leading
`---`) is the only thing that kept this out of prod. The failure was
accidental containment, not detection — the parser caught a formatting
artifact, not the fabrication. A delimiter-relaxation that drops leading
empty segments would have written these deposits cleanly.

Contrast: the other two assistant-only stubs in the failed set (`f52acca7`,
`ef5b9e36`) produced honest refusals ("There is no conversation to extract
deposits from"). Same input shape, divergent draws — epistemic property 1
cuts both ways. Sweep result: `grep -l "^USER:"` across all 65 backfill
outputs hits only this one file; fabrication is isolated, not systemic.

Audit of the written set (2026-06-11, post-triage): 51 sessions with active
deposits, 19 of them assistant-only — a far larger risk class than the one
failure suggested. All 39 deposit/open_edge rows from those 19 sessions
inspected: zero dialogue markers, zero positive attributions of user speech.
Every user mention is the honest negative form ("no user speech appears",
"posed but never taken up", "whether this is live for the user is unknown").
Fabrication was contained to the one failed draw. Parser now trips on
speaker-tagged lines by name (commit 687930e), so a future fabricated draw
fails loud instead of by accident. On rerun, `72a855bd` drew honest behind
the tripwire and wrote cleanly (gen 1, 4 rows, total-asymmetry framing).

## 4. Permanently un-summarizable sessions (zero utterances)

Eight sessions have no utterance rows at all — nothing to summarize, fails
by design on every run, permanent until/unless the sessions are deleted:

- 7f000e91-5c0a-41a6-b914-e89ce8ab1426
- 896ba8d6-7f7a-4317-b05e-80acfb0ae5fb
- 9bc43582-1a2e-48a5-baa0-5da1e46011af
- 9e8f1cbe-0a90-40d8-9f90-4e724c4a372d
- d07e3390-3737-46a8-916f-7346ed8336ad
- d15b4be1-c9cf-458c-bc1e-b52b6df2258d
- 44d63a5a-d783-4499-96fb-40f0194e99d5
- d53e2a4e-e76e-49d8-806b-5627c6fb83ed

## 5. Zero-deposit draws are unrepresentable (6efc2ba3)

Rerun 2026-06-11 06:05 UTC: session `6efc2ba3` (1 utterance) drew a
degenerate output — a leading `---` then `OPEN EDGE: none`. Zero deposits,
zero open edge, zero content. The parser failed it loud (correctly; even a
fully relaxed parse yields zero rows, and there is nothing to embed or
insert).

The structural fact underneath: the schema cannot represent "summarized,
zero deposits" — no rows means the session looks un-summarized, so it
re-executes (one Opus call) on every `--all` rerun until a draw produces at
least one deposit. The proportionality floor says the model should write the
thin statement as a deposit ("say exactly that and stop"); this draw skipped
even that. A targeted single-session rerun drew the honest thin deposit on
the next attempt. At one session affected, rerun-until-honest-draw is
cheaper than machinery. Observe; revisit only if the count grows.

## Final corpus state (2026-06-11)

65/65 summarizable sessions with active deposits (73 total minus the 8 in
entry 4). 176 active rows, all prompt version 751831e51d29ead2, all
claude-opus-4-6. Verified read-only post-backfill.
