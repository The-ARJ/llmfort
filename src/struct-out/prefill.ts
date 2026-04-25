import { structOut } from './index.js'
import type { StructOutResult, Validator } from './types.js'

export interface PrefillDirective {
  /** The pre-fill character to seed the assistant turn with. */
  prefill: '{' | '['
  /** Pass as the final assistant message to `anthropic.messages.create({ messages: [...] })`. */
  message: { role: 'assistant'; content: string }
  /** Stitch the pre-fill character back onto Claude's raw response before parsing. */
  reattach: (rawResponseText: string) => string
}

/** Build a pre-fill directive that primes Claude to emit JSON starting with `{` or `[`. */
export function prefillForClaude(
  opts: { kind?: 'object' | 'array' } = {},
): PrefillDirective {
  const prefill: '{' | '[' = opts.kind === 'array' ? '[' : '{'
  return {
    prefill,
    message: { role: 'assistant', content: prefill },
    reattach: (raw: string) => {
      const trimmed = raw.trimStart()
      return trimmed.startsWith(prefill) ? raw : prefill + raw
    },
  }
}

/** One-shot: re-attach pre-fill to Claude's response and run the full struct-out pipeline. */
export function parsePrefilledClaude<T>(
  rawResponseText: string,
  schema: Validator<T>,
  opts: { kind?: 'object' | 'array' } = {},
): StructOutResult<T> {
  const pf = prefillForClaude(opts)
  return structOut.parseSafe(pf.reattach(rawResponseText), schema)
}
