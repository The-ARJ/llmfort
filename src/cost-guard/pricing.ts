/**
 * Prices in USD per 1M tokens. Verified April 2026.
 *
 * Scope: OpenAI (GPT/o-series), Anthropic (Claude), Google (Gemini).
 * Other providers (DeepSeek, Mistral, Llama, etc.) use the conservative
 * UNKNOWN_MODEL_PRICE fallback — llmfort is a sidecar, not a pricing registry.
 */
export interface ModelPrice {
  input: number
  output: number
  /** Cached-input price per 1M tokens, where the provider offers a discount. */
  cachedInput?: number
  /**
   * Cache-write price per 1M tokens. Anthropic charges a premium to write
   * entries into the prompt cache. Providers without distinct write pricing
   * use `input` implicitly.
   */
  cacheWrite?: number
  /**
   * Reasoning-token price per 1M tokens. Defaults to `output` when not set —
   * OpenAI, Anthropic, and Gemini all bill reasoning tokens as output in their
   * current meters. This field is reserved for providers that split it out.
   */
  reasoning?: number
}

export const PRICING: Record<string, ModelPrice> = {
  // ---------- OpenAI ----------
  // GPT-5 flagship family
  'gpt-5':        { input: 1.25, output: 10.00, cachedInput: 0.125 },
  'gpt-5-mini':   { input: 0.25, output:  2.00, cachedInput: 0.025 },
  'gpt-5-nano':   { input: 0.05, output:  0.40, cachedInput: 0.005 },
  // GPT-4.1 family
  'gpt-4.1':      { input: 2.00, output:  8.00, cachedInput: 0.50  },
  'gpt-4.1-mini': { input: 0.40, output:  1.60, cachedInput: 0.10  },
  'gpt-4.1-nano': { input: 0.10, output:  0.40, cachedInput: 0.025 },
  // Reasoning models
  'o3':           { input: 2.00, output:  8.00, cachedInput: 0.50  },
  'o3-pro':       { input: 20.00, output: 80.00 },
  'o3-mini':      { input: 1.10, output:  4.40, cachedInput: 0.55  },
  'o4-mini':      { input: 1.10, output:  4.40, cachedInput: 0.275 },
  // Legacy
  'gpt-4o-mini':   { input: 0.15, output:  0.60, cachedInput: 0.075 },
  'gpt-4-turbo':   { input: 10.00, output: 30.00 },
  'gpt-4':         { input: 30.00, output: 60.00 },
  'gpt-3.5-turbo': { input:  0.50, output:  1.50 },

  // ---------- Anthropic Claude ----------
  // Claude 4.x
  'claude-opus-4-7':           { input:  5.00, output: 25.00, cachedInput: 0.50, cacheWrite:  6.25 },
  'claude-opus-4-6':           { input: 15.00, output: 75.00, cachedInput: 1.50, cacheWrite: 18.75 },
  'claude-sonnet-4-6':         { input:  3.00, output: 15.00, cachedInput: 0.30, cacheWrite:  3.75 },
  'claude-sonnet-4-5':         { input:  3.00, output: 15.00, cachedInput: 0.30, cacheWrite:  3.75 },
  'claude-haiku-4-5':          { input:  1.00, output:  5.00, cachedInput: 0.10, cacheWrite:  1.25 },
  'claude-haiku-4-5-20251001': { input:  1.00, output:  5.00, cachedInput: 0.10, cacheWrite:  1.25 },
  // Claude 3.5 (legacy)
  'claude-3-5-sonnet-20241022': { input: 3.00, output: 15.00, cachedInput: 0.30, cacheWrite: 3.75 },
  'claude-3-5-haiku-20241022':  { input: 0.80, output:  4.00, cachedInput: 0.08, cacheWrite: 1.00 },
  'claude-3-opus-20240229':     { input: 15.00, output: 75.00 },

  // ---------- Google Gemini ----------
  'gemini-3-pro':           { input: 2.00,  output: 12.00, cachedInput: 0.50 },
  'gemini-3-flash':         { input: 0.50,  output:  3.00, cachedInput: 0.125 },
  'gemini-2.5-pro':         { input: 1.25,  output: 10.00, cachedInput: 0.31 },
  'gemini-2.5-flash':       { input: 0.30,  output:  2.50, cachedInput: 0.075 },
  'gemini-2.5-flash-lite':  { input: 0.10,  output:  0.40, cachedInput: 0.025 },
  'gemini-1.5-pro':         { input: 1.25,  output:  5.00 },
  'gemini-1.5-flash':       { input: 0.075, output:  0.30 },
}

/** Human-readable aliases → canonical pricing key. */
const ALIASES: Record<string, string> = {
  'claude-sonnet-4':  'claude-sonnet-4-6',
  'claude-opus-4':    'claude-opus-4-7',
  'claude-haiku-4':   'claude-haiku-4-5',
  'gpt-5-preview':    'gpt-5',
  'gemini-flash':     'gemini-2.5-flash',
  'gemini-pro':       'gemini-2.5-pro',
}

/**
 * Longest-key-that-is-a-prefix-of-the-model-ID lookup.
 * Never matches the other direction (which would let short IDs like "o" match
 * "o3") and never matches the empty key.
 */
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

/**
 * Conservative fallback for unknown models — intentionally NOT tied to any
 * specific model name so it doesn't go stale. Calibrated to mid-range 2026
 * flagship pricing so budgets err on the side of caution.
 */
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
 * Estimate token count from a string using a provider-aware heuristic.
 *
 * Defaults to ~4 chars/token (English-heavy GPT baseline). Model-aware:
 *   - Claude: ~3.5 chars/token
 *   - Gemini: ~4 chars/token
 *   - CJK-heavy text: ~1.5 chars/token
 *
 * For exact counts, bring your own tokenizer (`tiktoken`,
 * `@anthropic-ai/tokenizer`, Gemini `countTokens`) and feed the number into
 * `calcCost()` directly. This heuristic is ±10-15% vs. real tokenization.
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

/**
 * Calculate cost from token counts and model pricing.
 *
 * If `usage.reasoning` is provided, it's added to `output` tokens (every
 * tier-1 provider bills reasoning as output in 2026). Override with a custom
 * `price.reasoning` rate if that ever changes.
 *
 * If `usage.cacheHit` is provided, those tokens are billed at the cached rate
 * instead of the standard input rate. If `usage.cacheWrite` is provided,
 * those tokens are billed at the cache-write rate (Anthropic only charges a
 * premium here; OpenAI/Gemini use input rate implicitly).
 */
export interface UsageBreakdown {
  /** Uncached input tokens. */
  input: number
  /** Visible output tokens. */
  output: number
  /** Reasoning / thinking tokens. Billed as output unless price.reasoning is set. */
  reasoning?: number
  /** Input tokens served from the prompt cache. */
  cacheHit?: number
  /**
   * Input tokens written TO the prompt cache (Anthropic bills a 1.25x premium
   * for 5m TTL writes; OpenAI has no separate write rate).
   */
  cacheWrite?: number
}

export function calcCost(
  inputOrUsage: number | UsageBreakdown,
  outputTokens?: number,
  price?: ModelPrice,
): number {
  // Legacy overload: calcCost(inputTokens, outputTokens, price)
  if (typeof inputOrUsage === 'number') {
    const p = price ?? UNKNOWN_MODEL_PRICE
    return (inputOrUsage * p.input + (outputTokens ?? 0) * p.output) / 1_000_000
  }
  // New overload: calcCost(usage, _, price)
  const usage = inputOrUsage
  const p = price ?? UNKNOWN_MODEL_PRICE
  const inputCost     = usage.input * p.input
  const cacheHitCost  = (usage.cacheHit ?? 0) * (p.cachedInput ?? p.input)
  const cacheWriteCost = (usage.cacheWrite ?? 0) * (p.cacheWrite ?? p.input)
  const outputCost    = usage.output * p.output
  const reasoningCost = (usage.reasoning ?? 0) * (p.reasoning ?? p.output)
  return (inputCost + cacheHitCost + cacheWriteCost + outputCost + reasoningCost) / 1_000_000
}
