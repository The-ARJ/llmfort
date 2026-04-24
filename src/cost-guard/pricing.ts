/** Prices in USD per 1M tokens */
export interface ModelPrice {
  input: number
  output: number
}

export const PRICING: Record<string, ModelPrice> = {
  // ChatGPT / GPT
  'gpt-4o':                  { input: 2.50,   output: 10.00  },
  'gpt-4o-mini':             { input: 0.15,   output: 0.60   },
  'gpt-4.5-preview':         { input: 75.00,  output: 150.00 },
  'gpt-4-turbo':             { input: 10.00,  output: 30.00  },
  'gpt-4':                   { input: 30.00,  output: 60.00  },
  'gpt-3.5-turbo':           { input: 0.50,   output: 1.50   },
  'o1':                      { input: 15.00,  output: 60.00  },
  'o1-mini':                 { input: 3.00,   output: 12.00  },
  'o3':                      { input: 10.00,  output: 40.00  },
  'o3-mini':                 { input: 1.10,   output: 4.40   },
  'o4-mini':                 { input: 1.10,   output: 4.40   },
  // Claude
  'claude-opus-4-7':            { input: 15.00, output: 75.00 },
  'claude-sonnet-4-6':          { input: 3.00,  output: 15.00 },
  'claude-haiku-4-5-20251001':  { input: 0.80,  output: 4.00  },
  'claude-3-5-sonnet-20241022': { input: 3.00,  output: 15.00 },
  'claude-3-5-haiku-20241022':  { input: 0.80,  output: 4.00  },
  'claude-3-opus-20240229':     { input: 15.00, output: 75.00 },
  'claude-3-sonnet-20240229':   { input: 3.00,  output: 15.00 },
  'claude-3-haiku-20240307':    { input: 0.25,  output: 1.25  },
  // Gemini
  'gemini-2.5-pro':          { input: 1.25,  output: 10.00  },
  'gemini-2.0-flash':        { input: 0.10,  output: 0.40   },
  'gemini-1.5-pro':          { input: 1.25,  output: 5.00   },
  'gemini-1.5-flash':        { input: 0.075, output: 0.30   },
  // DeepSeek
  'deepseek-chat':           { input: 0.27,  output: 1.10   },
  'deepseek-reasoner':       { input: 0.55,  output: 2.19   },
  // Llama via Groq
  'llama-3.3-70b-versatile': { input: 0.59,  output: 0.79   },
  'llama-3.1-8b-instant':    { input: 0.05,  output: 0.08   },
  'llama-3.1-70b-versatile': { input: 0.59,  output: 0.79   },
  'mixtral-8x7b-32768':      { input: 0.24,  output: 0.24   },
  // Mistral
  'mistral-large-latest':    { input: 2.00,  output: 6.00   },
  'mistral-small-latest':    { input: 0.10,  output: 0.30   },
  'codestral-latest':        { input: 0.20,  output: 0.60   },
}

export function getPrice(model: string): ModelPrice {
  if (model in PRICING) return PRICING[model]!
  // Fuzzy fallback: match by prefix (handles versioned names like claude-sonnet-4-6-20260101)
  const key = Object.keys(PRICING).find(k => model.startsWith(k) || k.startsWith(model))
  if (key) return PRICING[key]!
  // Unknown model — conservative estimate (gpt-4o input price)
  return { input: 2.50, output: 10.00 }
}

/** Estimate token count from a string. Uses the ~4 chars/token heuristic. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

/** Calculate cost in USD given token counts and model pricing. */
export function calcCost(inputTokens: number, outputTokens: number, price: ModelPrice): number {
  return (inputTokens * price.input + outputTokens * price.output) / 1_000_000
}
