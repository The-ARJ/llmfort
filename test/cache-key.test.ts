import { describe, it, expect } from 'vitest'
import { cacheKey, cacheKeySync, cacheKeyCanonical } from '../src/index.js'

describe('cacheKey — basic', () => {
  it('same input → same key', async () => {
    const input = { model: 'gpt-5', messages: [{ role: 'user', content: 'hi' }] }
    expect(await cacheKey(input)).toBe(await cacheKey(input))
  })

  it('different model → different key', async () => {
    const a = await cacheKey({ model: 'gpt-5', messages: [{ role: 'user', content: 'hi' }] })
    const b = await cacheKey({ model: 'claude-opus-4-7', messages: [{ role: 'user', content: 'hi' }] })
    expect(a).not.toBe(b)
  })

  it('sha256 output is 64 hex chars (when Node crypto is available)', async () => {
    const k = await cacheKey({ model: 'gpt-5' })
    expect(k).toMatch(/^[0-9a-f]{64}$/)
  })

  it('sync variant is 16 hex chars', () => {
    const k = cacheKeySync({ model: 'gpt-5' })
    expect(k).toMatch(/^[0-9a-f]{16}$/)
  })
})

describe('cacheKey — whitespace & key-order stability', () => {
  it('trailing whitespace does not change the key', async () => {
    const a = await cacheKey({ model: 'gpt-5', system: 'You are helpful.' })
    const b = await cacheKey({ model: 'gpt-5', system: 'You are helpful.   ' })
    expect(a).toBe(b)
  })

  it('CRLF vs LF normalized', async () => {
    const a = await cacheKey({ model: 'gpt-5', system: 'line1\nline2' })
    const b = await cacheKey({ model: 'gpt-5', system: 'line1\r\nline2' })
    expect(a).toBe(b)
  })

  it('runs of spaces/tabs collapsed', async () => {
    const a = await cacheKey({ model: 'gpt-5', system: 'a  b   c' })
    const b = await cacheKey({ model: 'gpt-5', system: 'a b c' })
    expect(a).toBe(b)
  })

  it('tool-call arguments JSON key order does not affect key', async () => {
    const base = {
      model: 'gpt-5',
      messages: [
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            { id: 'c1', type: 'function', function: { name: 'f', arguments: '{"a":1,"b":2}' } },
          ],
        },
      ],
    }
    const swapped = {
      ...base,
      messages: [
        {
          ...base.messages[0]!,
          tool_calls: [
            { id: 'c1', type: 'function', function: { name: 'f', arguments: '{"b":2,"a":1}' } },
          ],
        },
      ],
    }
    expect(await cacheKey(base)).toBe(await cacheKey(swapped))
  })

  it('tools re-ordered by name produce same key', async () => {
    const a = await cacheKey({
      model: 'gpt-5',
      tools: [
        { name: 'b_tool', description: 'B' },
        { name: 'a_tool', description: 'A' },
      ],
    })
    const b = await cacheKey({
      model: 'gpt-5',
      tools: [
        { name: 'a_tool', description: 'A' },
        { name: 'b_tool', description: 'B' },
      ],
    })
    expect(a).toBe(b)
  })

  it('llmfort bookkeeping fields (pinned, id) do not affect key', async () => {
    const a = await cacheKey({
      model: 'gpt-5',
      messages: [{ role: 'user', content: 'hi' }],
    })
    const b = await cacheKey({
      model: 'gpt-5',
      messages: [{ role: 'user', content: 'hi', pinned: true, id: 'msg_1' }],
    })
    expect(a).toBe(b)
  })

  it('namespace isolates keys (workspace/tenant separation)', async () => {
    const a = await cacheKey({ model: 'gpt-5', namespace: 'ws_a', messages: [{ role: 'user', content: 'hi' }] })
    const b = await cacheKey({ model: 'gpt-5', namespace: 'ws_b', messages: [{ role: 'user', content: 'hi' }] })
    expect(a).not.toBe(b)
  })

  it('message content order IS significant (prepend a system msg)', async () => {
    const a = await cacheKey({ model: 'gpt-5', messages: [{ role: 'user', content: 'hi' }] })
    const b = await cacheKey({
      model: 'gpt-5',
      messages: [
        { role: 'system', content: 'be helpful' },
        { role: 'user', content: 'hi' },
      ],
    })
    expect(a).not.toBe(b)
  })

  it('params JSON key order does not matter', async () => {
    const a = await cacheKey({ model: 'gpt-5', params: { temperature: 0.7, top_p: 0.9 } })
    const b = await cacheKey({ model: 'gpt-5', params: { top_p: 0.9, temperature: 0.7 } })
    expect(a).toBe(b)
  })
})

describe('cacheKeyCanonical — debugging', () => {
  it('returns a string with normalized content', () => {
    const c = cacheKeyCanonical({ model: 'gpt-5', system: 'a  b' })
    expect(typeof c).toBe('string')
    expect(c).toContain('"a b"') // whitespace-normalized
  })
})
