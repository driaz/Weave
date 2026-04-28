import { GoogleGenAI, ThinkingLevel, type Part } from '@google/genai'
import { readFile } from 'node:fs/promises'

const GEMINI_API_KEY = process.env.GEMINI_API_KEY
if (!GEMINI_API_KEY) throw new Error('GEMINI_API_KEY is required')

const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY })

const MODEL = 'gemini-3.1-flash-lite-preview'

const PROMPT_VIDEO_AUDIO = `You are analyzing audio and video for a content reasoning system.
Your analysis will be stored as metadata and used by a separate AI
to find thematic connections between pieces of content a user has
collected.

The transcript of this audio exists separately — don't describe
what was said. Describe what the audio and video are DOING that
the transcript misses.

AUDIO:
- Vocal delivery: pace, affect, tension between words and tone.
  How does the WAY something is said modify or contradict WHAT is said?
- Music/soundtrack: not genre labels, but what the music is doing
  to the listener. Is it framing the words as tragic? Heroic? Ironic?
  Does it shift, and what does the shift signal?
- Silence and space: where does the audio breathe, and what does
  that breathing communicate?

VIDEO:
- Composition and framing: tight vs wide, what's centered, what's
  obscured. How do framing choices direct attention or withhold it?
- Editing rhythm: pace of cuts, held shots vs rapid montage.
  What does the editing tempo communicate?
- Light and color: not labels like "dark" — what the visual palette
  communicates and how it shifts across the piece.

RELATIONSHIP:
- How do audio and video work together? Do they reinforce each other
  or create tension? Does the score tell you how to feel about what
  you're seeing, or does it contradict the image?

Describe mechanics with enough interpretation to be useful.
"Tight close-ups during monologue with cuts to wide desolate
landscape on pauses — framing the speaker as swallowed by the
environment" is useful. "The cinematography is moody" is not.

Even for longer videos, capture the overall arc in 4-6 sentences.
Don't describe scene by scene. Dense, precise, no filler.

This metadata will be read by a reasoning system, not displayed
to the user directly.`

const PROMPT_AUDIO_ONLY = `You are analyzing audio for a content reasoning system. Your analysis
will be stored as metadata and used by a separate AI to find thematic
connections between pieces of content a user has collected.

The transcript of this audio exists separately — don't describe
what was said. Describe what the audio is DOING that the transcript
misses.

Focus on:
- Vocal delivery: pace, affect, tension between words and tone.
  How does the WAY something is said modify or contradict WHAT is said?
- Music/soundtrack: not genre labels, but what the music is doing
  to the listener. Is it framing the words as tragic? Heroic? Ironic?
  Does it shift, and what does the shift signal?
- Silence and space: where does the audio breathe, and what does
  that breathing communicate?
- Emotional arc: how does the piece move through emotional registers
  from start to finish? What's the trajectory?

Describe mechanics with enough interpretation to be useful.
"Deliberate pacing with significant pauses after rhetorical questions,
establishing an instructional tone" is useful. "The speaker sounds
thoughtful" is not.

3-5 sentences. Dense, precise, no filler. This metadata will be
read by a reasoning system, not displayed to the user directly.`

export interface AnalyzeMediaInput {
  /** Path to the source video. Sent in full when present (under-10-min tier). */
  videoPath?: string
  /** Path to the standalone audio track. Used alone for the audio-only tier. */
  audioPath?: string
}

/**
 * Run Gemini media analysis. Two modes, picked by the caller based on duration:
 *  - videoPath set → full video+audio analysis (under-10-min tier)
 *  - audioPath only → audio-only analysis (over-10-min tier)
 *
 * Returns the analysis text or empty string on failure (never throws — analysis
 * is best-effort; the embedding still ships even if this fails).
 */
export async function analyzeMedia(input: AnalyzeMediaInput): Promise<string> {
  const { videoPath, audioPath } = input
  const parts: Part[] = []
  let prompt: string

  if (videoPath) {
    prompt = PROMPT_VIDEO_AUDIO
    const data = (await readFile(videoPath)).toString('base64')
    parts.push({ text: prompt }, { inlineData: { mimeType: 'video/mp4', data } })
  } else if (audioPath) {
    prompt = PROMPT_AUDIO_ONLY
    const data = (await readFile(audioPath)).toString('base64')
    parts.push({ text: prompt }, { inlineData: { mimeType: 'audio/opus', data } })
  } else {
    return ''
  }

  try {
    const res = await ai.models.generateContent({
      model: MODEL,
      contents: [{ role: 'user', parts }],
      config: {
        thinkingConfig: { thinkingLevel: ThinkingLevel.HIGH },
      },
    })
    return res.text?.trim() ?? ''
  } catch (err) {
    console.warn('[analyze] media analysis failed:', err)
    return ''
  }
}
