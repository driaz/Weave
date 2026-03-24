import { GoogleGenAI } from '@google/genai'

const geminiApiKey = import.meta.env.VITE_GEMINI_API_KEY as string | undefined

/**
 * Google GenAI client instance.
 * Returns null if the API key env var is not configured — all downstream
 * consumers must handle the null case gracefully.
 */
export const ai: GoogleGenAI | null = geminiApiKey
  ? new GoogleGenAI({ apiKey: geminiApiKey })
  : null
