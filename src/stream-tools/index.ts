export interface CompletedToolCall {
  id: string
  name: string
  /** Parsed JSON arguments. Falls back to the raw string if parsing fails. */
  arguments: unknown
  argumentsRaw: string
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
  /** Feed one streamed chunk. Returns any tool calls that completed on this chunk. */
  push(chunk: unknown): CompletedToolCall[]
  /** Emit any in-flight calls. Call at end of stream — some providers don't emit a final signal. */
  flush(): CompletedToolCall[]
  /** Current in-flight state for UI progress indicators. */
  partial(): Array<{ id?: string; name?: string; argumentsRaw: string; index: number }>
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
