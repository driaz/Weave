# Tweet Description Samples + Image-Tweet Analysis Overlap — Issue #2, Decision 2 (READ-MOSTLY)

**Date:** 2026-07-22
**Prod queries:** role `weave_readonly` @ `aws-1-us-east-2.pooler.supabase.com`, db `postgres` (Weave prod), via `WEAVE_PROD_RO_DATABASE_URL`. SELECTs only.
**Writes:** this doc and a throwaway script in the session scratchpad (`gen-descriptions.mjs` — not wired into any pipeline, not in package scripts, dies with the session). Three `claude-sonnet-4-6` API calls generated the sample text below; nothing was written to any database.
**Companions:** `docs/embedding-coverage-probe.md`, `docs/delete-path-and-embed-call-read.md`, `docs/pre-composition-gate-reads.md`.

---

## 1. Task 1 — image-tweet analysis overlap

### 1.1 The split (full scan of the 12 tweet nodes holding non-empty `media_analysis`)

| Title | transcript? | transcript chars | media_analysis chars |
|---|---|---|---|
| Modern Dad | yes | 760 | 1,109 |
| cinesthetic. | yes | 281 | 980 |
| 60 Minutes | yes | 1,098 | 944 |
| matrixbot | yes | 339 | 907 |
| James Lucas | yes | 28 | 895 |
| James Lucas | yes | 28 | 893 |
| Clash Report | yes | 1,368 | 831 |
| Dubs⛧ | **no** | — | 1,164 |
| Camus | **no** | — | 1,020 |
| Emir Han | **no** | — | 923 |
| BreakThrough News | **no** | — | 848 |
| 𝓐𝔂𝓸✯ | **no** | — | 846 |

**7 with transcript, 5 without.**

### 1.2 The code path: analysis implies a downloadable video — there is no image-analysis path

The client fires the pipeline for **every** tweet, with video detection delegated to the server's download step:

```ts
// src/services/linkEnrichment.ts:76-87
// Embedded YouTube → send the YouTube URL directly (guaranteed-downloadable
// by yt-dlp). Otherwise send the tweet URL — yt-dlp's Twitter extractor
// grabs native video; on text-only tweets it fast-fails server-side. We
// accept those wasted invocations rather than building a separate
// client-side video-detection path.
const mediaTriggered = triggerMediaPipeline({ … })
```

Server-side, `downloadVideo` (yt-dlp) is the **first** pipeline step ([media-server/src/process.ts:55-56](../media-server/src/process.ts)); `analyzeMedia` runs only on the downloaded file inside the tier helpers (:150+), and a download failure throws into the catch — no download, no analysis. Static tweet images travel a wholly separate client path (`fetchTweetImage` → `imageBase64` in JSONB, [linkEnrichment.ts:47-58](../src/services/linkEnrichment.ts)) that never reaches Gemini analysis. **The Fly pipeline does not analyze image-only tweets today.**

Transcripts, meanwhile, come from Supadata on *both* surfaces — the client's async fetch is what patches JSONB ([linkEnrichment.ts:65-70](../src/services/linkEnrichment.ts)), and the server does an independent Supadata fetch for its embed text only, with a warning that names the gap: "silent empty transcripts (especially common on native Twitter video, where Supadata coverage is spottier than YouTube)" ([media-server/src/transcript.ts:10-13](../media-server/src/transcript.ts)).

### 1.3 The five analysis-no-transcript rows, verbatim, and what each describes

All five analyses unambiguously describe **video** (cuts, editing rhythm, pacing, audio tracks) — consistent with §1.2's "analysis implies downloaded video." The interesting question is whether the video contained speech (transcript acquisition failed) or didn't (nothing to transcribe). Per row:

**Camus (1,020 chars) — speech clearly present; transcript acquisition failed.**

> The composition centers heavily on the primary speaker using tight close-ups that emphasize his rapid, percussive hand gestures and confrontational leaning posture, effectively trapping the viewer's focus on his singular authoritative delivery. This is punctuated by wide, slightly desaturated medium-long shots of the full panel, which visually relegate the other participants to the role of passive background scenery, blending them into the dimly lit, foliage-heavy set design. The auditory landscape is dominated by the speaker's intense, staccato vocal cadence, which creates an inherent tension against the low-key, relaxed ambient noise of the lounge environment. The consistent alternation between these frames establishes an asymmetrical power dynamic where the speaker commands the visual foreground, while the passive group is treated as an extension of the static, immersive set. This creates a distinct friction between the intimate, collaborative setting and the monologic, high-pressure vocal performance.

("dominated by the speaker's intense, staccato vocal cadence", "monologic … vocal performance" — a speaking person, no transcript.)

**Dubs⛧ (1,164 chars) — speech clearly present; transcript acquisition failed.**

> The composition utilizes a split-screen format, contrasting a dynamic, gestural video of the subject on the left with a static, polished portrait on the right to establish a tension between authentic personal expression and a curated celebrity image. Vocal delivery is characterized by an informal, conversational cadence punctuated by incredulous laughter and pauses that frame the subject's perspective as relatable and anecdotal rather than academic. The editing rhythm is dictated by the rapid, constant appearance of scrolling captions that layer over the primary video, creating a frantic visual pace that necessitates dual-focus and treats the spoken word as immediate, high-priority information. By stripping away music and relying solely on the speaker's voice, the audio emphasizes the raw, off-the-cuff quality of the sentiment, effectively contrasting the dry, conversational delivery with the emotive intensity of the subject matter. The visual structure reinforces a social media consumption model, where the duality of the image allows the viewer to simultaneously process the subject's physical personality while consuming the transcribed argument.

("relying solely on the speaker's voice", "the spoken word", on-screen captions of a "transcribed argument" — speech present, no transcript row.)

**Emir Han (923 chars) — speech clearly present; transcript acquisition failed.**

> The scene relies on suffocatingly tight close-ups, physically trapping the two primary characters within the frame to emphasize the claustrophobic nature of their ideological clash. The absence of a musical score amplifies the raw, uneven cadence of the dialogue, where the rhythmic tension fluctuates between aggressive, rapid-fire outbursts and deliberate, heavy silences. Editing choices favor sustained reaction shots, focusing less on the act of speaking and more on the emotional wall each character builds against the other. When the third figure enters the frame, the composition shifts from a two-way confrontation to a triangular power dynamic, with framing that isolates the entrant, visually rendering him the subject of the men's tug-of-war. The interplay between encroaching camera movements and static, unyielding shots creates a visual metaphor for the struggle between empathy and detached intellectualism.

("the raw, uneven cadence of the dialogue" — dialogue present, no transcript.)

**𝓐𝔂𝓸✯ (846 chars) — no speech evident; plausibly nothing to transcribe.**

> The video utilizes extended, languid cuts that allow the audience to dwell on the character's static posture, effectively framing him as an observational figure detached from his rural environment. Naturalistic golden hour lighting and silhouette compositions emphasize his isolation against the backdrop of the water and sky, signaling an existential distance rather than mere loneliness. The slow, mournful musical tempo operates in perfect synchronicity with the visual editing, transforming the character's physical stillness into a heavy, resonant state of quiet introspection. By refusing to cut away or hasten the pacing, the audiovisual relationship forces the viewer to sit within the character's silence, ensuring that the emotional weight of the scene is driven by deliberate, sustained emptiness rather than active narrative movement.

(Music and "the character's silence"; no mention of speech.)

**BreakThrough News (848 chars) — ambiguous: singing, not speech.**

> The visual composition utilizes the golden hour sunset to bathe the massive crowd in a warm, hallowed aesthetic, framing the political assembly as a solemn, quasi-religious ceremony rather than a chaotic demonstration. Editing alternates between sweeping wide shots that emphasize the scale and unity of the collective body and tighter, intimate frames of individual participants, effectively bridging the distance between state-level power and personal devotion. The choral audio delivery is resonant and reverberant, creating a dense wall of sound that commands a reverent listening posture, while the rhythmic, synchronised waving of flags mirrors the cadence of the singing. This tight integration between the visual uniformity of the crowd and the overwhelming auditory experience constructs a sense of inevitable, monolithic national purpose.

("choral audio delivery", "the singing" — sung words exist, but whether a transcript *should* exist for crowd singing is not decidable from this text; classified as ambiguous rather than forced into either bucket.)

**Split of the five: 3 speech-present/transcript-failed (Camus, Dubs⛧, Emir Han), 1 no-speech (𝓐𝔂𝓸✯), 1 ambiguous (BreakThrough News).** So the answer to the task question is: no, the pipeline does not analyze image-only tweets — every analysis sits on a downloaded video — but the transcript-less analyses are mostly *Supadata misses on speech-bearing video*, exactly the "spottier native Twitter coverage" the server code warns about, not image analyses.

## 2. Task 2 — three-sample description generation

Generator: throwaway script, `claude-sonnet-4-6`, `max_tokens: 400`, one call per node, prompt sent verbatim as a single user message (no system prompt) with substitutions from prod JSONB. `authorHandle` was present on all three nodes. `media_analysis` present on Modern Dad and cinesthetic.; absent on The Driven Man (line omitted per template).

### 2.1 The Driven Man (`7e07b26e-a250-4afa-bfd4-2b5f6d04dc61`) — transcript 2,520 chars, no media_analysis

**Input block as sent (post-substitution header lines):**

```
Tweet author: The Driven Man (@Thedrivenman)
Tweet text: Yale professor perfectly explains childhood privilege. pic.twitter.com/TIYW6odaja— The Driven Man (@Thedrivenman) April 23, 2026
Transcript of the clip's audio: [full 2,520-char transcript, verbatim below]
```

**Full transcript, verbatim:**

> If I look around this room of Oxford undergraduates, 40% of you were privately educated in a country in which 7% of students have private educations. 80% of you come from meaningful social and economic privilege. As we heard a moment ago, at my university, Yale, there are more students from the top 1% of the income distribution than from the entire bottom half. Now, my university's admissions process is corrupt, and failures of meritocracy might explain it. But Oxford's is not corrupt. You can't buy a place here. And yet, nevertheless, you're all rich. Now, why is that? In the United States, the richest private schools spend over $75,000 per pupil per year on educating their children. In a society with public schools, on average, spend about $12,000. In this country, the richest private schools spend over £30,000 a year educating their children. These massive investments produce massive differences in childhood achievements because when you get trained, you get good at things. A graduate of this university will make 50% more in her first year out than a graduate of the University of York. So meritocracy creates an inequality in which rich parents have the opportunity to spend all this money on their children, which is why meritocratic children are also rich children. That's the first point. Second point. It's not actually fun to have that much invested in you as a kid. It's not easy. You are poked and prodded and tested and subject to tutors and classes and extra help and schools and exams. And you do this from the earliest age up until adulthood. And then you come here and you work hard and then you get a job at McKinsey or Goldman Sachs and you work 80 hours a week. parents and you live in fear that your children will lose the cast that you have acquired by working so hard. And so as parents you do two jobs. You squeeze into your children the same thing that was squeezed into you as you're working to try to make the money to enable you to do that. It's not surprising that in England exam anxiety has now overtaken body image as the largest source of stress in wealthy children. It's not surprising that in the study of a wealthy American private school 50% of children had moderate to severe clinical symptoms of depression, and 75% had moderate to severe clinical symptoms of anxiety. These are not easy lives to live. You will be extremely wealthy, wealthier than you can imagine, wealthier than prior elites have been. But you will not be well, and your children will not be well.

**Generated description, verbatim (989 chars):**

> A Yale professor, speaking to an audience of Oxford undergraduates, argues that the overrepresentation of wealthy students at elite universities reflects not corruption but the compounding advantages that affluent families are able to purchase for their children from an early age, citing stark disparities in per-pupil spending between private and public schools in both the United States and the United Kingdom. He goes on to contend that this system, while financially rewarding for those who navigate it successfully, exacts a significant psychological toll: children subjected to intensive academic preparation show disproportionately high rates of anxiety and depression, and the pressure to preserve socioeconomic status persists into adulthood and across generations. The tweet frames the clip as a lucid and authoritative explanation of how childhood privilege operates, presenting the professor's remarks as a compelling encapsulation of the mechanisms behind elite reproduction.

### 2.2 Modern Dad (`6febc310-f75e-496d-bbb5-a430bc496169`) — transcript 760 chars, media_analysis 1,109 chars

**Input block as sent:**

```
Tweet author: Modern Dad (@ModernxDad)
Tweet text: Don't marry the person you can have fun with but.. pic.twitter.com/ok5lHccsoV— Modern Dad (@ModernxDad) May 8, 2026
Transcript of the clip's audio: [full 760-char transcript, verbatim below]
Tonal/visual analysis of the clip: [the node's full 1,109-char media_analysis]
```

**Full transcript, verbatim:**

> Don't marry the person you can have fun with. Marry the person you can suffer with. Anyone can love you when life is good, when the sun is shining, the money is flowing, the smiles come easy. That part is simple, but love isn't proven on the best days. Love is revealed in the worst ones, when life hits hard, when the nightmare starts, when everything feels uncertain. Romance isn't vacations and photos. Romance is who sits next to you in the ER waiting room at 3 a.m., who holds your hand when the future feels terrifying who looks at the broke exhausted messy version of you and still chooses you still stays still fights for you because anyone can be your playmate in the sunshine but the right person they're the one willing to walk through hell with you

**Generated description, verbatim (610 chars):**

> A speaker delivers a measured, philosophical monologue arguing that the truest test of a relationship is not shared enjoyment during easy times but the willingness to remain committed through suffering, crisis, and hardship. The narration plays over footage of a marriage proposal taking place in a hospital room, a visual pairing that frames the act of commitment as inseparable from mortality and struggle rather than celebration. Shared by Modern Dad with a caption that withholds its conclusion, the clip positions enduring love — not compatible happiness — as the proper basis for choosing a life partner.

### 2.3 cinesthetic. (`70d5c9b0-6e53-47e8-ac4e-f02f84261b29`) — transcript 281 chars, media_analysis 980 chars

**Input block as sent:**

```
Tweet author: cinesthetic. (@TheCinesthetic)
Tweet text: Robert Downey Jr. visiting Wall Street for a documentary in the early '90s and openly criticizing the culture there feels strangely ahead of its time. pic.twitter.com/8pRfJSWhKR— cinesthetic. (@TheCinesthetic) May 16, 2026
Transcript of the clip's audio: [full 281-char transcript, verbatim below]
Tonal/visual analysis of the clip: [the node's full 980-char media_analysis]
```

**Full transcript, verbatim:**

> If money is evil, then that building is hell. This is the most obnoxious group of money-hungry, low IQ, high energy, jackrabbit, fucking wannabe, big time, small time, shit-talking, bothersome, irritating bunch of motherfuckers I have ever had to endure for more than five minutes.

**Generated description, verbatim (730 chars):**

> A man identified as Robert Downey Jr. appears in what is described as an early-1990s documentary segment filmed at Wall Street, delivering a calm, measured condemnation of the financial culture and the people who embody it, characterizing the environment in aggressively dismissive terms. The clip contrasts chaotic, tightly framed footage of a crowded trading floor with a composed, isolated shot of the speaker, visually positioning him as a detached outsider passing judgment on the collective frenzy around him. The person sharing the clip presents it as unexpectedly prescient, suggesting that Downey Jr.'s critical stance toward Wall Street excess feels more resonant in retrospect than it might have at the time of filming.

(The full prompts as actually sent — every substitution included byte-for-byte — are preserved in the scratchpad's `sample-outputs.json`; the header lines above show the substitutions, and the transcripts/analyses are reproduced in full in this doc and, for the two analyses, in §1.3 and the coverage probe doc.)

### 2.4 Comparison table

| Node | Transcript chars | media_analysis chars | Description chars | Description ÷ transcript |
|---|---|---|---|---|
| The Driven Man | 2,520 | — | 989 | 0.39 (2.5:1 compression) |
| Modern Dad | 760 | 1,109 | 610 | 0.80 (1.25:1) |
| cinesthetic. | 281 | 980 | 730 | 2.60 (expansion; total text input 1,481 chars incl. analysis → 0.49) |

### 2.5 Mechanical-violation check (fidelity only — no quality judgment)

- **Verbatim quoting:** none found. No description reproduces a transcript run; the profane cinesthetic. transcript is rendered as "characterizing the environment in aggressively dismissive terms" — described, not quoted.
- **Outside knowledge:** none found. cinesthetic. handles the recognizable subject correctly under the constraint — "A man **identified as** Robert Downey Jr. … **what is described as** an early-1990s documentary" attributes both facts to the tweet text rather than asserting them from knowledge, and adds no external biography.
- **Invented content:** none found; every claim traces to an input (Modern Dad's "hospital room" and "proposal" come from the media_analysis; "a caption that withholds its conclusion" traces to the tweet text's trailing "but..").
- **One borderline fidelity note (flagged, not judged):** The Driven Man description says the wealth concentration "reflects **not corruption but** the compounding advantages…", while the transcript asserts corruption for one of the two universities: "my university's admissions process **is corrupt** … But Oxford's is **not** corrupt." The generalization is traceable to the Oxford half of the input but contradicts the Yale half. Cited for the blind quality read to weigh.

### 2.6 Prompt-artifact observations (notes for the design review — the prompt was NOT modified)

1. The template's fixed framing "a video clip shared in a tweet" would misdescribe image-only tweets if ever applied to them (Task 1 shows analyses currently imply video, so no live conflict today).
2. `{tweetText}` carries oEmbed boilerplate into the prompt raw — `pic.twitter.com/…` link, author repetition, and date ("— The Driven Man (@Thedrivenman) April 23, 2026"). Sonnet ignored it gracefully in all three samples, but it is uncontrolled input the template neither strips nor fences.
3. "2-3 sentences" produced 610–989 chars — Sonnet satisfies the sentence count with very long sentences. If the design wants length control, sentence count alone doesn't provide it.
4. The template was sent as a single user message; the existing YouTube generator splits system/user ([netlify/lib/youtubeDescription.ts](../netlify/lib/youtubeDescription.ts)). Behaviorally fine here; noted as an inconsistency the design may want to resolve.
5. The template has no conditional for a missing `authorHandle` (all three nodes had one; an absent handle would render "(undefined)" if implemented naively).

## 3. Interpretation (quarantined)

- Task 1's coverage fact for the design: **`media_analysis` is a video-only asset today.** An embed-composition design that treats analysis as the image-tweet rescue channel would find zero coverage there; image-only tweets' visual content remains entirely unanalyzed (their `imageBase64` goes into the client's multimodal embed parts, but no text derivative exists).
- The 3-of-5 speech-bearing/transcript-less rows quantify the Supadata-Twitter gap on this corpus: among the 12 analyzed video tweets, at least 3 (25%) have speech the transcript channel missed while the analysis channel captured its register. A description generator fed analysis-only inputs would still have material for these.
- The samples establish feasibility mechanics only (per the brief, quality is judged elsewhere): the conditional media_analysis line works, constraint-following was clean across all three, and the one fidelity wobble occurred in the longest-transcript, no-analysis case.

## 4. Open questions

1. Is the BreakThrough News class (sung content) in scope for "transcript" at all — should the design treat singing as speech, music, or its own category?
2. The three transcript-less speech rows: retry Supadata, fall back to analysis-only descriptions, or accept the gap? (Depends on whether Supadata's Twitter misses are transient or structural — not measurable from this corpus.)
3. Should `{tweetText}` be stripped of the oEmbed boilerplate before substitution (observation 2.6.2), given the description generator's output may itself be embedded?
