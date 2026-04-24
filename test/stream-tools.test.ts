import { describe, it, expect } from 'vitest'
import { toolCallAccumulator } from '../src/stream-tools/index.js'

describe('toolCallAccumulator — OpenAI', () => {
  it('accumulates a single tool call across chunks', () => {
    const acc = toolCallAccumulator('openai')
    acc.push({
      choices: [{
        delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'get_weather', arguments: '{"ci' } }] },
      }],
    })
    acc.push({
      choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'ty":"' } }] } }],
    })
    acc.push({
      choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'Paris"}' } }] } }],
    })
    const completed = acc.push({ choices: [{ finish_reason: 'tool_calls' }] })
    expect(completed).toHaveLength(1)
    expect(completed[0]!.id).toBe('call_1')
    expect(completed[0]!.name).toBe('get_weather')
    expect(completed[0]!.arguments).toEqual({ city: 'Paris' })
    expect(completed[0]!.argumentsRaw).toBe('{"city":"Paris"}')
  })

  it('handles parallel tool calls (two calls in one response)', () => {
    const acc = toolCallAccumulator('openai')
    acc.push({
      choices: [{
        delta: {
          tool_calls: [
            { index: 0, id: 'c1', function: { name: 'f1', arguments: '{"a":' } },
            { index: 1, id: 'c2', function: { name: 'f2', arguments: '{"b":' } },
          ],
        },
      }],
    })
    acc.push({
      choices: [{
        delta: {
          tool_calls: [
            { index: 0, function: { arguments: '1}' } },
            { index: 1, function: { arguments: '2}' } },
          ],
        },
      }],
    })
    const completed = acc.push({ choices: [{ finish_reason: 'tool_calls' }] })
    expect(completed).toHaveLength(2)
    expect(completed.find(c => c.id === 'c1')!.arguments).toEqual({ a: 1 })
    expect(completed.find(c => c.id === 'c2')!.arguments).toEqual({ b: 2 })
  })

  it('returns [] on chunks that do not complete anything', () => {
    const acc = toolCallAccumulator('openai')
    const out = acc.push({ choices: [{ delta: { content: 'hello' } }] })
    expect(out).toEqual([])
  })

  it('partial() exposes in-flight state', () => {
    const acc = toolCallAccumulator('openai')
    acc.push({
      choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'f', arguments: '{"a":1' } }] } }],
    })
    const partial = acc.partial()
    expect(partial).toHaveLength(1)
    expect(partial[0]!.id).toBe('c1')
    expect(partial[0]!.argumentsRaw).toBe('{"a":1')
  })

  it('flush() emits still-unfinished calls', () => {
    const acc = toolCallAccumulator('openai')
    acc.push({
      choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'f', arguments: '{"a":1}' } }] } }],
    })
    // Never send a finish_reason.
    const out = acc.flush()
    expect(out).toHaveLength(1)
    expect(out[0]!.name).toBe('f')
  })

  it('empty arguments string → {}', () => {
    const acc = toolCallAccumulator('openai')
    acc.push({
      choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'no_args', arguments: '' } }] } }],
    })
    const completed = acc.push({ choices: [{ finish_reason: 'tool_calls' }] })
    expect(completed[0]!.arguments).toEqual({})
  })

  it('invalid JSON → falls back to raw string', () => {
    const acc = toolCallAccumulator('openai')
    acc.push({
      choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'f', arguments: 'not json at all' } }] } }],
    })
    const completed = acc.push({ choices: [{ finish_reason: 'tool_calls' }] })
    expect(completed[0]!.arguments).toBe('not json at all')
  })

  it('reset clears all state', () => {
    const acc = toolCallAccumulator('openai')
    acc.push({
      choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'f', arguments: '{}' } }] } }],
    })
    acc.reset()
    expect(acc.partial()).toHaveLength(0)
    expect(acc.flush()).toHaveLength(0)
  })
})

describe('toolCallAccumulator — Anthropic', () => {
  it('accumulates a tool_use block from input_json_delta events', () => {
    const acc = toolCallAccumulator('anthropic')
    acc.push({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: {} },
    })
    acc.push({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"city":"' } })
    acc.push({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: 'Paris"}' } })
    const completed = acc.push({ type: 'content_block_stop', index: 0 })
    expect(completed).toHaveLength(1)
    expect(completed[0]!.id).toBe('toolu_1')
    expect(completed[0]!.name).toBe('get_weather')
    expect(completed[0]!.arguments).toEqual({ city: 'Paris' })
  })

  it('ignores non-tool content_block_start (e.g. text blocks)', () => {
    const acc = toolCallAccumulator('anthropic')
    acc.push({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
    acc.push({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hello' } })
    const out = acc.push({ type: 'content_block_stop', index: 0 })
    expect(out).toEqual([])
  })

  it('handles two parallel tool_use blocks at different indices', () => {
    const acc = toolCallAccumulator('anthropic')
    acc.push({
      type: 'content_block_start', index: 0,
      content_block: { type: 'tool_use', id: 'a', name: 'f1' },
    })
    acc.push({
      type: 'content_block_start', index: 1,
      content_block: { type: 'tool_use', id: 'b', name: 'f2' },
    })
    acc.push({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"x":1}' } })
    acc.push({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"y":2}' } })
    const c1 = acc.push({ type: 'content_block_stop', index: 0 })
    const c2 = acc.push({ type: 'content_block_stop', index: 1 })
    expect(c1[0]!.arguments).toEqual({ x: 1 })
    expect(c2[0]!.arguments).toEqual({ y: 2 })
  })

  it('message_stop flushes anything still partial', () => {
    const acc = toolCallAccumulator('anthropic')
    acc.push({
      type: 'content_block_start', index: 0,
      content_block: { type: 'tool_use', id: 'x', name: 'f' },
    })
    acc.push({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{}' } })
    const out = acc.push({ type: 'message_stop' })
    expect(out).toHaveLength(1)
    expect(out[0]!.arguments).toEqual({})
  })

  it('content_block_stop on an already-flushed call does not double-emit', () => {
    const acc = toolCallAccumulator('anthropic')
    acc.push({
      type: 'content_block_start', index: 0,
      content_block: { type: 'tool_use', id: 'x', name: 'f' },
    })
    acc.push({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{}' } })
    const first = acc.push({ type: 'content_block_stop', index: 0 })
    expect(first).toHaveLength(1)
    // Simulate a duplicate stop (should not double-emit in flush either).
    const flush = acc.flush()
    expect(flush).toHaveLength(0)
  })
})
