/**
 * Word-level comparison of two transcripts of the same audio. Case and
 * punctuation are ignored so the number reflects different words, not
 * different formatting.
 */
export function normalizeWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}'\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean)
}

/**
 * Word error rate of `hypothesis` against `reference`: word-level edit
 * distance divided by the reference length. 0 is identical; it can exceed 1
 * when the hypothesis is much longer. Two empty transcripts score 0.
 */
export function wordErrorRate(reference: string, hypothesis: string): number {
  const ref = normalizeWords(reference)
  const hyp = normalizeWords(hypothesis)
  if (ref.length === 0) return hyp.length === 0 ? 0 : 1

  let previous = Array.from({ length: hyp.length + 1 }, (_, j) => j)
  for (let i = 1; i <= ref.length; i++) {
    const current = [i]
    for (let j = 1; j <= hyp.length; j++) {
      const substitution = previous[j - 1] + (ref[i - 1] === hyp[j - 1] ? 0 : 1)
      current[j] = Math.min(substitution, previous[j] + 1, current[j - 1] + 1)
    }
    previous = current
  }
  return previous[hyp.length] / ref.length
}
