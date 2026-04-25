import type { Message } from './types.js'

const QUESTION_RE       = /\?/
const IMPERATIVE_RE     = /\b(must|don['’]t|do\s+not|never|always|prefer|only|required|need\s+to|should|make\s+sure)\b/i
const CORRECTION_RE     = /\b(actually|i\s+meant|correction|wait|sorry[,\s]|no[,\s]+i|not\s+what|instead)\b/i
const LIST_CONSTRAINT_RE = /^\s*\d+[\.\)]\s+/m
const ENTITY_RE         = /\b(?:[A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3})\b/
const FILLER_RE         = /^(sure|of course|okay|ok|thanks|thank you|got it|understood|perfect|great|nice|let me know|no problem|you['’]re welcome)[.!\s]*$/i

const DEFAULT_SCORE = 5

function extractText(msg: Message): string {
  if (typeof msg.content === 'string') return msg.content
  if (Array.isArray(msg.content)) {
    return msg.content
      .map(b => (typeof b.text === 'string' ? b.text : typeof b.thinking === 'string' ? b.thinking : ''))
      .join(' ')
  }
  return ''
}

/** Heuristic importance score, 0..10. Higher = more likely to survive a trim. */
export function scoreMessage(msg: Message): number {
  const content = extractText(msg).trim()
  if (!content && !msg.tool_calls?.length) return 0
  if (FILLER_RE.test(content)) return 1

  let score = DEFAULT_SCORE
  if (QUESTION_RE.test(content)) score += 2
  if (IMPERATIVE_RE.test(content)) score += 2
  if (CORRECTION_RE.test(content)) score += 3
  if (LIST_CONSTRAINT_RE.test(content)) score += 2
  if (ENTITY_RE.test(content)) score += 1
  if (content.length < 20) score -= 1
  if (content.length > 500) score += 1
  if (content.length > 2000) score += 1
  if (msg.tool_calls && msg.tool_calls.length > 0) score += 2
  if (msg.role === 'user' && CORRECTION_RE.test(content)) score += 1

  return Math.max(0, Math.min(10, score))
}
