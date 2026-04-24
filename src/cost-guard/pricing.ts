/** Prices in USD per 1M tokens. Verified April 2026. */
export interface ModelPrice {
  input: number
  output: number
  /** Cached-input price per 1M tokens, if the provider offers a discount. */
  cachedInput?: number
}

export const PRICING: Record<string, ModelPrice> = {
  // ---------- OpenAI ----------
  // Flagship GPT-5 family (2025 release)
  'gpt-5':                   { input: 1.25,  output: 10.00, cachedInput: 0.125 },
  'gpt-5-mini':              { input: 0.25,  output: 2.00,  cachedInput: 0.025 },
  'gpt-5-nano':              { input: 0.05,  output: 0.40,  cachedInput: 0.005 },
  'gpt-4.1':                 { input: 2.00,  output: 8.00,  cachedInput: 0.50  },
  'gpt-4.1-mini':            { input: 0.40,  output: 1.60,  cachedInput: 0.10  },
  'gpt-4.1-nano':            { input: 0.10,  output: 0.40,  cachedInput: 0.025 },
  // Legacy (still billable, retained for back-compat)
  'gpt-4o-mini':             { input: 0.15,  output: 0.60,  cachedInput: 0.075 },
  'gpt-4-turbo':             { input: 10.00, output: 30.00 },
  'gpt-4':                   { input: 30.00, output: 60.00 },
  'gpt-3.5-turbo':           { input: 0.50,  output: 1.50  },
  // Reasoning
  'o3':                      { input: 2.00,  output: 8.00,  cachedInput: 0.50 },
  'o3-mini':                 { input: 1.10,  output: 4.40,  cachedInput: 0.55 },
  'o3-pro':                  { input: 20.00, output: 80.00 },
  'o4-mini':                 { input: 1.10,  output: 4.40,  cachedInput: 0.275 },

  // ---------- Anthropic Claude ----------
  // Claude 4.x family
  'claude-opus-4-7':            { input: 5.00,  output: 25.00, cachedInput: 0.50  },
  'claude-opus-4-6':            { input: 15.00, output: 75.00, cachedInput: 1.50  },
  'claude-sonnet-4-6':          { input: 3.00,  output: 15.00, cachedInput: 0.30  },
  'claude-sonnet-4-5':          { input: 3.00,  output: 15.00, cachedInput: 0.30  },
  'claude-haiku-4-5':           { input: 1.00,  output: 5.00,  cachedInput: 0.10  },
  'claude-haiku-4-5-20251001':  { input: 1.00,  output: 5.00,  cachedInput: 0.10  },
  // Claude 3.5 (legacy but still served)
  'claude-3-5-sonnet-20241022': { input: 3.00,  output: 15.00, cachedInput: 0.30 },
  'claude-3-5-haiku-20241022':  { input: 0.80,  output: 4.00,  cachedInput: 0.08 },
  'claude-3-opus-20240229':     { input: 15.00, output: 75.00 },

  // ---------- Google Gemini ----------
  // Gemini 3 family (flagship April 2026)
  'gemini-3-pro':            { input: 2.00,  output: 12.00 },
  'gemini-3-flash':          { input: 0.50,  output: 3.00  },
  // Gemini 2.5 family (still widely used)
  'gemini-2.5-pro':          { input: 1.25,  output: 10.00 }, // <=200k tokens; >200k tier is 2.50/15.00
  'gemini-2.5-flash':        { input: 0.30,  output: 2.50  },
  'gemini-2.5-flash-lite':   { input: 0.10,  output: 0.40  },
  // Gemini 1.5 (legacy)
  'gemini-1.5-pro':          { input: 1.25,  output: 5.00  },
  'gemini-1.5-flash':        { input: 0.075, output: 0.30  },

  // ---------- DeepSeek ----------
  // V3.2+ unified pricing
  'deepseek-chat':           { input: 0.28,  output: 0.42, cachedInput: 0.028 },
  'deepseek-reasoner':       { input: 0.28,  output: 0.42, cachedInput: 0.028 },

  // ---------- Groq (Llama / OSS) ----------
  'llama-3.3-70b-versatile': { input: 0.59,  output: 0.79 },
  'llama-3.1-8b-instant':    { input: 0.05,  output: 0.08 },
  'llama-4-scout-17b':       { input: 0.11,  output: 0.34 },
  'llama-4-maverick-17b':    { input: 0.50,  output: 0.77 },
  'openai/gpt-oss-120b':     { input: 0.15,  output: 0.75 },
  'openai/gpt-oss-20b':      { input: 0.10,  output: 0.50 },
  'kimi-k2':                 { input: 1.00,  output: 3.00 },

  // ---------- Mistral ----------
  'mistral-large-latest':    { input: 2.00,  output: 6.00 },
  'mistral-medium-3':        { input: 0.40,  output: 2.00 },
  'mistral-small-latest':    { input: 0.20,  output: 0.60 },
  'ministral-8b':            { input: 0.10,  output: 0.10 },
  'ministral-3b':            { input: 0.04,  output: 0.04 },
  'codestral-latest':        { input: 0.30,  output: 0.90 },
}

/** Explicit aliases — resolves ambiguous public names to their canonical pricing key. */
const ALIASES: Record<string, string> = {
  'claude-sonnet-4':   'claude-sonnet-4-6',
  'claude-opus-4':     'claude-opus-4-7',
  'claude-haiku-4':    'claude-haiku-4-5',
  'gpt-5-preview':     'gpt-5',
  'gemini-flash':      'gemini-2.5-flash',
  'gemini-pro':        'gemini-2.5-pro',
}

/**
 * Longest-key-that-is-a-prefix-of-the-model-ID lookup.
 * Never matches the other direction (which caused false hits for short IDs
 * like "o" matching "o1") and never matches the empty key.
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
 * Conservative default for completely unknown models.
 * Intentionally not a real model — prevents the fallback from going stale
 * as specific models are retired. Calibrated to mid-range 2026 flagship pricing
 * so budgets err on the side of caution.
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
 * Defaults to ~4 chars/token (English-heavy GPT/Claude baseline).
 * Pass a model name to get a tokenizer-family-aware adjustment:
 *  - Claude models tokenize denser (~3.5 chars/token) — we scale up.
 *  - Gemini models sit near 4 chars/token.
 *  - CJK-heavy text is clamped to a 1.5 chars/token floor so non-Latin
 *    prompts don't under-estimate catastrophically.
 *
 * This is intentionally a heuristic: exact tokenization requires the
 * provider's tokenizer, which would pull in a large dependency.
 */
export function estimateTokens(text: string, model?: string): number {
  if (!text) return 0

  // Detect a non-trivial share of CJK / wide chars — those tokenize at ~1.5 chars/token.
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

/** Calculate cost in USD given token counts and model pricing. */
export function calcCost(
  inputTokens: number,
  outputTokens: number,
  price: ModelPrice,
): number {
  return (inputTokens * price.input + outputTokens * price.output) / 1_000_000
}
