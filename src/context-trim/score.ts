/**
 * Importance scoring — a heuristic ranking so we keep the messages that carry
 * the conversation's intent (questions, constraints, corrections) and drop
 * filler (acknowledgments, pleasantries) first.
 *
 * Purely pattern-based. No embedding model, no second API call. Good enough
 * to beat naive "keep last N" in real chatbot logs; not good enough to replace
 * a proper retrieval system — which is fine, that's a different product.
 *
 * Score clamps to 0..10. Higher = more likely to survive trim.
 */
import type { Message } from './types.js'

const QUESTION_RE      = /\?/
const IMPERATIVE_RE    = /\b(must|don['’]t|do\s+not|never|always|prefer|only|required|need\s+to|should|make\s+sure)\b/i
const CORRECTION_RE    = /\b(actually|i\s+meant|correction|wait|sorry[,\s]|no[,\s]+i|not\s+what|instead)\b/i
const LIST_CONSTRAINT_RE = /^\s*\d+[\.\)]\s+/m
const ENTITY_RE        = /\b(?:[A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3})\b/ // capitalized multi-word spans
// Filler phrases the assistant (or user) produces — low signal.
const FILLER_RE        = /^(sure|of course|okay|ok|thanks|thank you|got it|understood|perfect|great|nice|let me know|no problem|you['’]re welcome)[.!\s]*$/i

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

export function scoreMessage(msg: Message): number {
  // No content and no tool calls = no signal at all.
  const content = extractText(msg).trim()
  if (!content && !msg.tool_calls?.length) return 0

  let score = DEFAULT_SCORE

  // Very short filler response (e.g. "Sure.", "Of course!") is lowest signal.
  if (FILLER_RE.test(content)) return 1

  if (QUESTION_RE.test(content)) score += 2
  if (IMPERATIVE_RE.test(content)) score += 2
  if (CORRECTION_RE.test(content)) score += 3
  if (LIST_CONSTRAINT_RE.test(content)) score += 2
  if (ENTITY_RE.test(content)) score += 1

  // Length heuristics.
  if (content.length < 20) score -= 1
  if (content.length > 500) score += 1
  if (content.length > 2000) score += 1

  // Tool calls are usually high-signal artifacts of the conversation — they
  // represent decisions the model made. Preserve them a bit longer.
  if (msg.tool_calls && msg.tool_calls.length > 0) score += 2

  // User corrections matter more than assistant ones.
  if (msg.role === 'user' && CORRECTION_RE.test(content)) score += 1

  return Math.max(0, Math.min(10, score))
}
