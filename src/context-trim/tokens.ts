import { estimateTokens } from '../cost-guard/index.js'
import type { Message } from './types.js'

// Overhead numbers from tiktoken's published constants for OpenAI's chat
// format and Anthropic's documented token accounting.
interface Overhead {
  perMessage: number
  perToolCall: number
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

/** Token count for a single message including role overhead, content blocks, and tool calls. */
export function countMessageTokens(msg: Message, model?: string): number {
  const o = overheadFor(model)
  let tokens = o.perMessage

  if (typeof msg.content === 'string' && msg.content.length > 0) {
    tokens += estimateTokens(msg.content, model)
  } else if (Array.isArray(msg.content)) {
    for (const block of msg.content) {
      if (typeof block.text === 'string') tokens += estimateTokens(block.text, model)
      if (typeof block.thinking === 'string') tokens += estimateTokens(block.thinking, model)
      tokens += 4 // block envelope
      if (block.type === 'tool_use' && typeof (block as any).input === 'object') {
        try { tokens += estimateTokens(JSON.stringify((block as any).input), model) } catch { /* ignore */ }
      }
      if (block.type === 'tool_result' && (block as any).content !== undefined) {
        const c = (block as any).content
        if (typeof c === 'string') tokens += estimateTokens(c, model)
      }
    }
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

/** Total token count for the conversation, including the reply primer. */
export function countTokens(messages: Message[], model?: string): number {
  const o = overheadFor(model)
  let total = o.reply
  for (const m of messages) total += countMessageTokens(m, model)
  return total
}
