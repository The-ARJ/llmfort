/**
 * Vendor-neutral (OpenAI-shaped) message type.
 *
 * This shape covers most 2026 SDKs unchanged (OpenAI, Groq, Together, Mistral,
 * DeepSeek). For Anthropic/Gemini, adapt at the boundary — the `role`/`content`
 * + optional `tool_calls` / `tool_call_id` structure maps cleanly.
 */
export interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool'
  /**
   * Content string. May be null for assistant turns that only contain tool_calls
   * (OpenAI spec). Token counting handles both cases.
   */
  content: string | null
  /** Function or tool name, used by some providers. */
  name?: string
  /** When role === 'tool', the id of the tool_call this is responding to. */
  tool_call_id?: string
  /** When role === 'assistant', the tool calls the model wants to make. */
  tool_calls?: ToolCall[]
  /** llmfort bookkeeping: survive any trim. */
  pinned?: boolean
  /** Optional stable identifier — useful if you want to reference specific messages. */
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
  /**
   * Hard cap on tokens of history to keep. This is YOUR budget, not the model's
   * context window — typically set to (context_window - max_output_tokens - headroom).
   */
  maxTokens: number

  /** Model ID used for token-count overhead constants. Defaults to a generic tokenizer. */
  model?: string

  /** Strategy. Default 'sliding'. */
  strategy?: TrimStrategy

  /** Number of most-recent turns always preserved. Default 4. */
  keepLastTurns?: number

  /** If false, system messages may be removed. Default true. */
  keepSystem?: boolean

  /**
   * Required for strategy: 'summary'. Receives the messages that would be
   * removed and returns a string that replaces them.
   */
  summarize?: (toSummarize: Message[]) => Promise<string>

  /** Where to place the summary message. Default 'system'. */
  summaryRole?: 'system' | 'user'

  /**
   * Custom score function for strategy: 'importance'. Overrides the built-in
   * heuristic. Higher score = more likely to survive trim.
   */
  score?: (message: Message) => number
}

export interface TrimResult {
  /** The trimmed message array. Safe to pass directly to any LLM SDK. */
  messages: Message[]
  /** Number of messages removed from the original. */
  removed: number
  /** Token count of the original input. */
  tokensBefore: number
  /** Token count of the trimmed output. */
  tokensAfter: number
  /** True if any messages were removed. */
  trimmed: boolean
  /** Which strategy actually ran. */
  strategy: TrimStrategy
  /**
   * If the protected set (system + pinned + last turns) already exceeds
   * maxTokens, we return it anyway and report the overflow. Zero otherwise.
   */
  overflow: number
}
