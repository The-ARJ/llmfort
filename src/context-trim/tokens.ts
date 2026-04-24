/**
 * Per-message token-count overhead, by model family.
 *
 * Real APIs don't bill you just for content tokens — they add a small fixed
 * overhead for the role wrapper, content-type, and (for tool calls) function
 * envelope. Most people forget this and systematically underestimate by 3-10%.
 *
 * Numbers below follow `tiktoken`'s published constants for OpenAI's chat
 * format and Anthropic's documented accounting.
 */
import { estimateTokens } from '../cost-guard/index.js'
import type { Message } from './types.js'

interface Overhead {
  perMessage: number
  perToolCall: number
  /** Primer tokens added to every completion (used when counting a whole conversation). */
  reply: number
}

const OPENAI_OVERHEAD:    Overhead = { perMessage: 4, perToolCall: 10, reply: 2 }
const ANTHROPIC_OVERHEAD: Overhead = { perMessage: 3, perToolCall: 8,  reply: 0 }
const GEMINI_OVERHEAD:    Overhead = { perMessage: 3, perToolCall: 8,  reply: 0 }
const GENERIC_OVERHEAD:   Overhead = { perMessage: 4, perToolCall: 10, reply: 2 }

function overheadFor(model?: string): Overhead {
  if (!model) return GENERIC_OVERHEAD
  if (model.startsWith('claude')) return ANTHROPIC_OVERHEAD
  if (model.startsWith('gemini')) return GEMINI_OVERHEAD
  // OpenAI + everything with an OpenAI-compatible chat API (Groq, Mistral,
  // DeepSeek, Together, etc.) uses the OpenAI overhead shape.
  return OPENAI_OVERHEAD
}

/**
 * Token count for a single message, including role overhead and any tool calls.
 */
export function countMessageTokens(msg: Message, model?: string): number {
  const o = overheadFor(model)
  let tokens = o.perMessage

  if (typeof msg.content === 'string' && msg.content.length > 0) {
    tokens += estimateTokens(msg.content, model)
  }

  if (msg.name) tokens += estimateTokens(msg.name, model)

  if (msg.tool_calls && msg.tool_calls.length > 0) {
    for (const tc of msg.tool_calls) {
      tokens += o.perToolCall
      tokens += estimateTokens(tc.function.name, model)
      tokens += estimateTokens(tc.function.arguments, model)
    }
  }

  if (msg.tool_call_id) tokens += estimateTokens(msg.tool_call_id, model)

  return tokens
}

/**
 * Total token count for a conversation, including the per-completion primer.
 * Pass this directly into your max_tokens headroom calculations.
 */
export function countTokens(messages: Message[], model?: string): number {
  const o = overheadFor(model)
  let total = o.reply
  for (const m of messages) total += countMessageTokens(m, model)
  return total
}
