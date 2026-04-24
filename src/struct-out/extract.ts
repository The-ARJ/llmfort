/**
 * Find the most-likely JSON region in a raw LLM response string.
 *
 * Real LLM outputs take many shapes:
 *   - Bare JSON: `{...}` or `[...]`
 *   - Fenced: ```json\n{...}\n```   or   ```\n{...}\n```
 *   - Tagged:  <json>{...}</json>
 *   - Preambled: "Here is the result:\n{...}"
 *   - Multiple blocks: preamble example + actual answer
 *
 * Strategy: collect every plausible candidate, rank them, return the best.
 * Never uses eval; never executes untrusted content.
 */

interface Candidate {
  text: string
  score: number
  /** Index in the original string where this candidate started. */
  start: number
}

/**
 * Scan the string for balanced {...} and [...] regions.
 * Respects string literals and escapes so braces inside "strings" don't count.
 */
function findBalancedRegions(input: string): Array<{ text: string; start: number }> {
  const out: Array<{ text: string; start: number }> = []
  const openers = new Set(['{', '['])
  const closerFor: Record<string, string> = { '{': '}', '[': ']' }

  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!
    if (!openers.has(ch)) continue

    // Walk forward tracking nesting and string state.
    const stack: string[] = [closerFor[ch]!]
    let inString: '"' | "'" | null = null
    let j = i + 1
    while (j < input.length && stack.length > 0) {
      const c = input[j]!
      if (inString) {
        if (c === '\\') { j += 2; continue }
        if (c === inString) inString = null
        j++
        continue
      }
      if (c === '"' || c === "'") { inString = c; j++; continue }
      if (c === '{' || c === '[') { stack.push(closerFor[c]!); j++; continue }
      if (c === '}' || c === ']') {
        const expected = stack[stack.length - 1]
        if (c !== expected) {
          // Mismatched closer — bail on this candidate entirely.
          stack.length = 0
          j = input.length + 1
          break
        }
        stack.pop()
        j++
        continue
      }
      j++
    }

    if (stack.length === 0) {
      out.push({ text: input.slice(i, j), start: i })
      // Advance past this region — no nested starts we care about.
      i = j - 1
    }
    // If stack didn't close, it's a truncated region — handled by parse.ts's
    // truncation repair. We still register it so the caller can attempt repair.
    else if (stack.length > 0 && j >= input.length) {
      out.push({ text: input.slice(i), start: i })
      break
    }
  }
  return out
}

/**
 * Extract candidates from explicit wrappers (fences and tags) first — these
 * carry the highest confidence signal that "this is the model's JSON."
 */
function findFencedRegions(input: string): Array<{ text: string; start: number; fenced: boolean }> {
  const out: Array<{ text: string; start: number; fenced: boolean }> = []

  // ``` or ```json ... ```
  const fenceRe = /```(?:json|JSON)?\s*\n?([\s\S]*?)```/g
  let m: RegExpExecArray | null
  while ((m = fenceRe.exec(input)) !== null) {
    const inner = m[1]!.trim()
    if (inner) out.push({ text: inner, start: m.index, fenced: true })
  }

  // <json>...</json>
  const tagRe = /<json>\s*([\s\S]*?)\s*<\/json>/gi
  while ((m = tagRe.exec(input)) !== null) {
    const inner = m[1]!.trim()
    if (inner) out.push({ text: inner, start: m.index, fenced: true })
  }

  return out
}

const PREAMBLE_MARKERS = [
  /\bresult\s*:/i,
  /\banswer\s*:/i,
  /\boutput\s*:/i,
  /\bjson\s*:/i,
  /\bhere(?:'s|\s+is)\b/i,
]

function scoreCandidate(c: { text: string; start: number; fenced?: boolean }, fullInput: string): number {
  let score = 0
  // Longer content generally wins — the real payload is usually biggest.
  score += Math.min(c.text.length, 50_000) / 100
  // Explicit fence/tag is a strong positive signal.
  if (c.fenced) score += 50
  // Preceded by a marker like "Result:" or "Here is" within 40 chars.
  const preface = fullInput.slice(Math.max(0, c.start - 40), c.start)
  if (PREAMBLE_MARKERS.some(re => re.test(preface))) score += 20
  // Starts with { rather than [ — objects are the common case for structured out.
  if (c.text.trimStart().startsWith('{')) score += 5
  // Later occurrences win ties — models often show an example, then the real answer.
  score += c.start / 10_000
  return score
}

/**
 * Return the single most-likely JSON string from the raw LLM response,
 * or null if no plausible region exists.
 */
export function extract(raw: string): string | null {
  if (!raw) return null
  const trimmed = raw.trim()
  if (!trimmed) return null

  const candidates: Candidate[] = []

  // 1) Fenced / tagged regions — re-scan each inner payload for balanced JSON.
  for (const fenced of findFencedRegions(raw)) {
    const balanced = findBalancedRegions(fenced.text)
    for (const b of balanced) {
      candidates.push({
        text: b.text,
        start: fenced.start + b.start,
        score: scoreCandidate({ ...b, fenced: true, start: fenced.start }, raw),
      })
    }
    // Also consider the fence payload itself as a candidate (may be bare JSON).
    candidates.push({
      text: fenced.text,
      start: fenced.start,
      score: scoreCandidate({ ...fenced }, raw),
    })
  }

  // 2) Balanced regions anywhere in the raw string (covers "no fence" case).
  for (const b of findBalancedRegions(raw)) {
    candidates.push({
      text: b.text,
      start: b.start,
      score: scoreCandidate({ ...b, fenced: false }, raw),
    })
  }

  if (candidates.length === 0) {
    // Last-ditch: the whole string might BE the JSON (no wrappers, parseable bare).
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) return trimmed
    return null
  }

  candidates.sort((a, b) => b.score - a.score)
  return candidates[0]!.text
}
