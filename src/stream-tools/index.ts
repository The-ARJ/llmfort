/**
 * Accumulate streamed tool-call chunks from OpenAI or Anthropic into complete
 * tool-call objects.
 *
 * Both providers stream `arguments` as JSON deltas — OpenAI via
 * `choices[].delta.tool_calls[].function.arguments` chunks indexed by
 * `tool_calls[].index`, Anthropic via `content_block_delta` events with
 * `delta.type === 'input_json_delta'`. Teams rebuild this state machine in
 * every app; ship it once.
 *
 * @example
 * const acc = toolCallAccumulator('openai')
 * for await (const chunk of openai.chat.completions.create({ stream: true, ... })) {
 *   const completed = acc.push(chunk)
 *   for (const call of completed) handleToolCall(call)
 * }
 * // Always flush at the end — tool calls on the last message may not have
 * // a dedicated "finished" signal in the stream.
 * for (const call of acc.flush()) handleToolCall(call)
 */

export interface CompletedToolCall {
  id: string
  name: string
  /** The parsed arguments. Falls back to the raw string if JSON parsing fails. */
  arguments: unknown
  /** Original arguments string exactly as the model emitted it. */
  argumentsRaw: string
  /** Position within the streamed batch (OpenAI has `index`; Anthropic has block index). */
  index?: number
}

export type StreamProvider = 'openai' | 'anthropic'

interface PartialCall {
  id?: string
  name?: string
  argsBuffer: string
  index: number
  emitted?: boolean
}

export interface ToolCallAccumulator {
  /**
   * Feed one streamed chunk. Returns any tool calls that completed on this
   * chunk (OpenAI emits `finish_reason: 'tool_calls'` or the index moves on;
   * Anthropic emits `content_block_stop`). Usually empty until the end.
   */
  push(chunk: unknown): CompletedToolCall[]
  /** Emit any tool calls that haven't been reported yet (call at end of stream). */
  flush(): CompletedToolCall[]
  /** Current partial state — useful for UI "streaming tool call" indicators. */
  partial(): Array<{ id?: string; name?: string; argumentsRaw: string; index: number }>
  /** Reset internal state so the accumulator can be reused. */
  reset(): void
}

export function toolCallAccumulator(provider: StreamProvider): ToolCallAccumulator {
  let partials = new Map<number, PartialCall>()

  function finalize(p: PartialCall): CompletedToolCall | null {
    if (p.emitted) return null
    if (!p.id || !p.name) return null
    p.emitted = true
    let parsed: unknown = p.argsBuffer
    if (p.argsBuffer.trim().length > 0) {
      try { parsed = JSON.parse(p.argsBuffer) } catch { /* keep raw */ }
    } else {
      parsed = {}
    }
    return {
      id: p.id,
      name: p.name,
      arguments: parsed,
      argumentsRaw: p.argsBuffer,
      index: p.index,
    }
  }

  function ensurePartial(index: number): PartialCall {
    let p = partials.get(index)
    if (!p) { p = { argsBuffer: '', index }; partials.set(index, p) }
    return p
  }

  function pushOpenAI(chunk: any): CompletedToolCall[] {
    const completed: CompletedToolCall[] = []
    const delta = chunk?.choices?.[0]?.delta
    const finishReason = chunk?.choices?.[0]?.finish_reason

    if (delta?.tool_calls && Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        const idx = typeof tc.index === 'number' ? tc.index : 0
        const p = ensurePartial(idx)
        if (tc.id && !p.id) p.id = tc.id
        if (tc.function?.name && !p.name) p.name = tc.function.name
        if (typeof tc.function?.arguments === 'string') {
          p.argsBuffer += tc.function.arguments
        }
      }
    }

    // When finish_reason: 'tool_calls' fires, every partial is done.
    if (finishReason === 'tool_calls') {
      for (const p of partials.values()) {
        const c = finalize(p)
        if (c) completed.push(c)
      }
    }

    return completed
  }

  function pushAnthropic(chunk: any): CompletedToolCall[] {
    const completed: CompletedToolCall[] = []
    const t = chunk?.type

    if (t === 'content_block_start') {
      const idx = typeof chunk.index === 'number' ? chunk.index : 0
      const block = chunk.content_block
      if (block?.type === 'tool_use') {
        const p = ensurePartial(idx)
        if (block.id) p.id = block.id
        if (block.name) p.name = block.name
        // Anthropic tool_use.input may arrive via deltas, so we don't set it here.
      }
    } else if (t === 'content_block_delta') {
      const idx = typeof chunk.index === 'number' ? chunk.index : 0
      const delta = chunk.delta
      if (delta?.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
        const p = ensurePartial(idx)
        p.argsBuffer += delta.partial_json
      }
    } else if (t === 'content_block_stop') {
      const idx = typeof chunk.index === 'number' ? chunk.index : 0
      const p = partials.get(idx)
      if (p) {
        const c = finalize(p)
        if (c) completed.push(c)
      }
    } else if (t === 'message_stop') {
      // Flush anything not already emitted — belt-and-suspenders.
      for (const p of partials.values()) {
        const c = finalize(p)
        if (c) completed.push(c)
      }
    }

    return completed
  }

  return {
    push(chunk) {
      return provider === 'openai' ? pushOpenAI(chunk) : pushAnthropic(chunk)
    },
    flush() {
      const out: CompletedToolCall[] = []
      for (const p of partials.values()) {
        const c = finalize(p)
        if (c) out.push(c)
      }
      return out
    },
    partial() {
      return Array.from(partials.values()).map(p => {
        const out: { id?: string; name?: string; argumentsRaw: string; index: number } = {
          argumentsRaw: p.argsBuffer,
          index: p.index,
        }
        if (p.id !== undefined) out.id = p.id
        if (p.name !== undefined) out.name = p.name
        return out
      })
    },
    reset() {
      partials = new Map()
    },
  }
}
