interface Candidate {
  text: string
  score: number
  start: number
}

// String-literal-aware scan for balanced {...} and [...] regions.
function findBalancedRegions(input: string): Array<{ text: string; start: number }> {
  const out: Array<{ text: string; start: number }> = []
  const openers = new Set(['{', '['])
  const closerFor: Record<string, string> = { '{': '}', '[': ']' }

  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!
    if (!openers.has(ch)) continue

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
        if (c !== expected) { stack.length = 0; j = input.length + 1; break }
        stack.pop()
        j++
        continue
      }
      j++
    }

    if (stack.length === 0) {
      out.push({ text: input.slice(i, j), start: i })
      i = j - 1
    } else if (j >= input.length) {
      // Truncated region — register it so parse.ts can attempt structural repair.
      out.push({ text: input.slice(i), start: i })
      break
    }
  }
  return out
}

function findFencedRegions(input: string): Array<{ text: string; start: number; fenced: boolean }> {
  const out: Array<{ text: string; start: number; fenced: boolean }> = []

  const fenceRe = /```(?:json|JSON)?\s*\n?([\s\S]*?)```/g
  let m: RegExpExecArray | null
  while ((m = fenceRe.exec(input)) !== null) {
    const inner = m[1]!.trim()
    if (inner) out.push({ text: inner, start: m.index, fenced: true })
  }

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
  score += Math.min(c.text.length, 50_000) / 100
  if (c.fenced) score += 50
  const preface = fullInput.slice(Math.max(0, c.start - 40), c.start)
  if (PREAMBLE_MARKERS.some(re => re.test(preface))) score += 20
  if (c.text.trimStart().startsWith('{')) score += 5
  // Later occurrences win ties — models often show an example before the real answer.
  score += c.start / 10_000
  return score
}

/** Return the most-likely JSON string from a raw LLM response, or null. */
export function extract(raw: string): string | null {
  if (!raw) return null
  const trimmed = raw.trim()
  if (!trimmed) return null

  const candidates: Candidate[] = []

  for (const fenced of findFencedRegions(raw)) {
    const balanced = findBalancedRegions(fenced.text)
    for (const b of balanced) {
      candidates.push({
        text: b.text,
        start: fenced.start + b.start,
        score: scoreCandidate({ ...b, fenced: true, start: fenced.start }, raw),
      })
    }
    candidates.push({
      text: fenced.text,
      start: fenced.start,
      score: scoreCandidate({ ...fenced }, raw),
    })
  }

  for (const b of findBalancedRegions(raw)) {
    candidates.push({
      text: b.text,
      start: b.start,
      score: scoreCandidate({ ...b, fenced: false }, raw),
    })
  }

  if (candidates.length === 0) {
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) return trimmed
    return null
  }

  candidates.sort((a, b) => b.score - a.score)
  return candidates[0]!.text
}
