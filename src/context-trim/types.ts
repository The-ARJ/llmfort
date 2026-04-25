/** A single content block. Covers Claude's block shape and maps onto Gemini `Part` / OpenAI multimodal. */
export interface ContentBlock {
  type: 'text' | 'thinking' | 'redacted_thinking' | 'tool_use' | 'tool_result' | 'image' | string
  text?: string
  thinking?: string
  /** Anthropic echoes this on thinking blocks; must round-trip intact on the next turn. */
  signature?: string
  [k: string]: unknown
}

/** OpenAI-shaped message, with optional content-block array for Claude/Gemini/multimodal. */
export interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null | ContentBlock[]
  name?: string
  tool_call_id?: string
  tool_calls?: ToolCall[]
  /** Survives any trim. */
  pinned?: boolean
  /** Stable identifier; referenced by `cacheBreakpoints` and available on output messages. */
  id?: string
}

export interface ToolCall {
  id: string
  type: 'function'
  function: {
    name: string
    arguments: string
  }
}

export type TrimStrategy = 'sliding' | 'importance' | 'summary'

export interface TrimOptions {
  /** Hard cap on history tokens (your budget, not the model's context window). */
  maxTokens: number
  /** Model ID for per-family token-overhead constants. */
  model?: string
  strategy?: TrimStrategy
  /** Default 4. */
  keepLastTurns?: number
  /** Default true. */
  keepSystem?: boolean
  /** Required for `strategy: 'summary'`. Receives messages to compress, returns a summary string. */
  summarize?: (toSummarize: Message[]) => Promise<string>
  /** Default `'system'`. */
  summaryRole?: 'system' | 'user'
  /** Override the built-in importance scorer. Higher score survives longer. */
  score?: (message: Message) => number
  /**
   * Message IDs anchoring prompt-cache prefixes (Anthropic `cache_control`,
   * OpenAI/Gemini automatic caching). Every message at or before the latest
   * breakpoint is protected — trimming earlier invalidates the cache.
   */
  cacheBreakpoints?: string[]
}

export interface TrimResult {
  messages: Message[]
  removed: number
  tokensBefore: number
  tokensAfter: number
  trimmed: boolean
  strategy: TrimStrategy
  /** Tokens over `maxTokens` that couldn't be trimmed (protected set too large). */
  overflow: number
}
