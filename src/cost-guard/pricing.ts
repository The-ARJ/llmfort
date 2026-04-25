/** USD per 1M tokens. Verified against OpenAI, Anthropic, and Google pricing pages (2026-04). */
export interface ModelPrice {
  input: number
  output: number
  /** Cached-input rate per 1M tokens, if the provider offers a discount. */
  cachedInput?: number
  /** Cache-write rate per 1M tokens. Anthropic-specific; falls back to `input` elsewhere. */
  cacheWrite?: number
  /** Reasoning-token rate per 1M tokens. Defaults to `output` if absent. */
  reasoning?: number
}

export const PRICING: Record<string, ModelPrice> = {
  // OpenAI
  'gpt-5':        { input: 1.25, output: 10.00, cachedInput: 0.125 },
  'gpt-5-mini':   { input: 0.25, output:  2.00, cachedInput: 0.025 },
  'gpt-5-nano':   { input: 0.05, output:  0.40, cachedInput: 0.005 },
  'gpt-4.1':      { input: 2.00, output:  8.00, cachedInput: 0.50  },
  'gpt-4.1-mini': { input: 0.40, output:  1.60, cachedInput: 0.10  },
  'gpt-4.1-nano': { input: 0.10, output:  0.40, cachedInput: 0.025 },
  'o3':           { input: 2.00, output:  8.00, cachedInput: 0.50  },
  'o3-pro':       { input: 20.00, output: 80.00 },
  'o3-mini':      { input: 1.10, output:  4.40, cachedInput: 0.55  },
  'o4-mini':      { input: 1.10, output:  4.40, cachedInput: 0.275 },
  'gpt-4o-mini':   { input: 0.15, output:  0.60, cachedInput: 0.075 },
  'gpt-4-turbo':   { input: 10.00, output: 30.00 },
  'gpt-4':         { input: 30.00, output: 60.00 },
  'gpt-3.5-turbo': { input:  0.50, output:  1.50 },

  // Anthropic
  'claude-opus-4-7':           { input:  5.00, output: 25.00, cachedInput: 0.50, cacheWrite:  6.25 },
  'claude-opus-4-6':           { input: 15.00, output: 75.00, cachedInput: 1.50, cacheWrite: 18.75 },
  'claude-sonnet-4-6':         { input:  3.00, output: 15.00, cachedInput: 0.30, cacheWrite:  3.75 },
  'claude-sonnet-4-5':         { input:  3.00, output: 15.00, cachedInput: 0.30, cacheWrite:  3.75 },
  'claude-haiku-4-5':          { input:  1.00, output:  5.00, cachedInput: 0.10, cacheWrite:  1.25 },
  'claude-haiku-4-5-20251001': { input:  1.00, output:  5.00, cachedInput: 0.10, cacheWrite:  1.25 },
  'claude-3-5-sonnet-20241022': { input: 3.00, output: 15.00, cachedInput: 0.30, cacheWrite: 3.75 },
  'claude-3-5-haiku-20241022':  { input: 0.80, output:  4.00, cachedInput: 0.08, cacheWrite: 1.00 },
  'claude-3-opus-20240229':     { input: 15.00, output: 75.00 },

  // Google
  'gemini-3-pro':           { input: 2.00,  output: 12.00, cachedInput: 0.50 },
  'gemini-3-flash':         { input: 0.50,  output:  3.00, cachedInput: 0.125 },
  'gemini-2.5-pro':         { input: 1.25,  output: 10.00, cachedInput: 0.31 },
  'gemini-2.5-flash':       { input: 0.30,  output:  2.50, cachedInput: 0.075 },
  'gemini-2.5-flash-lite':  { input: 0.10,  output:  0.40, cachedInput: 0.025 },
  'gemini-1.5-pro':         { input: 1.25,  output:  5.00 },
  'gemini-1.5-flash':       { input: 0.075, output:  0.30 },
}

/** Public aliases → canonical pricing key. */
const ALIASES: Record<string, string> = {
  'claude-sonnet-4':  'claude-sonnet-4-6',
  'claude-opus-4':    'claude-opus-4-7',
  'claude-haiku-4':   'claude-haiku-4-5',
  'gpt-5-preview':    'gpt-5',
  'gemini-flash':     'gemini-2.5-flash',
  'gemini-pro':       'gemini-2.5-pro',
}

function longestPrefixMatch(model: string): string | undefined {
  let best: string | undefined
  for (const key of Object.keys(PRICING)) {
    if (key.length === 0) continue
    if (model.startsWith(key) && (!best || key.length > best.length)) {
      best = key
    }
  }
  return best
}

/** Fallback rate for unknown models; intentionally independent of any specific model to avoid going stale. */
const UNKNOWN_MODEL_PRICE: ModelPrice = { input: 3.00, output: 12.00 }

export function getPrice(model: string): ModelPrice {
  if (!model) return UNKNOWN_MODEL_PRICE
  if (model in PRICING) return PRICING[model]!
  const aliased = ALIASES[model]
  if (aliased && aliased in PRICING) return PRICING[aliased]!
  const prefix = longestPrefixMatch(model)
  if (prefix) return PRICING[prefix]!
  return UNKNOWN_MODEL_PRICE
}

/**
 * Estimate tokens via a provider-aware chars/token heuristic. ±10-15% vs real
 * tokenization; plug in `tiktoken` / `@anthropic-ai/tokenizer` / Gemini's
 * `countTokens` and feed the result into `calcCost` if you need exact counts.
 */
export function estimateTokens(text: string, model?: string): number {
  if (!text) return 0

  const cjkCount = (text.match(/[぀-ヿ㐀-䶿一-鿿가-힯]/g) ?? []).length
  if (cjkCount > text.length * 0.2) {
    return Math.ceil(text.length / 1.5)
  }

  let charsPerToken = 4
  if (model) {
    if (model.startsWith('claude')) charsPerToken = 3.5
    else if (model.startsWith('gemini')) charsPerToken = 4
  }
  return Math.ceil(text.length / charsPerToken)
}

export interface UsageBreakdown {
  input: number
  output: number
  /** Reasoning/thinking tokens. Billed at `price.reasoning` or, if absent, `price.output`. */
  reasoning?: number
  /** Input tokens served from the prompt cache (charged at `price.cachedInput`). */
  cacheHit?: number
  /** Input tokens written to the cache (charged at `price.cacheWrite` or `price.input`). */
  cacheWrite?: number
}

export function calcCost(
  inputOrUsage: number | UsageBreakdown,
  outputTokens?: number,
  price?: ModelPrice,
): number {
  if (typeof inputOrUsage === 'number') {
    const p = price ?? UNKNOWN_MODEL_PRICE
    return (inputOrUsage * p.input + (outputTokens ?? 0) * p.output) / 1_000_000
  }
  const usage = inputOrUsage
  const p = price ?? UNKNOWN_MODEL_PRICE
  const inputCost     = usage.input * p.input
  const cacheHitCost  = (usage.cacheHit ?? 0) * (p.cachedInput ?? p.input)
  const cacheWriteCost = (usage.cacheWrite ?? 0) * (p.cacheWrite ?? p.input)
  const outputCost    = usage.output * p.output
  const reasoningCost = (usage.reasoning ?? 0) * (p.reasoning ?? p.output)
  return (inputCost + cacheHitCost + cacheWriteCost + outputCost + reasoningCost) / 1_000_000
}
