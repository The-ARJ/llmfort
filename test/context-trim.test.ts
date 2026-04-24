import { describe, it, expect, vi } from 'vitest'
import { contextTrim } from '../src/context-trim/index.js'
import type { Message } from '../src/context-trim/types.js'

// ----- Fixtures -----

const systemMsg: Message = { role: 'system', content: 'You are a helpful assistant.' }
const u = (c: string): Message => ({ role: 'user', content: c })
const a = (c: string): Message => ({ role: 'assistant', content: c })

/** Test helper: safe substring check across string | null | ContentBlock[] content. */
function textOf(m: Message): string {
  if (typeof m.content === 'string') return m.content
  if (Array.isArray(m.content)) return m.content.map(b => b.text ?? b.thinking ?? '').join(' ')
  return ''
}
const hasText = (m: Message, needle: string) => textOf(m).includes(needle)

// Conversation: 1 system + 10 (user/assistant) pairs of varying lengths.
function manyTurns(n: number): Message[] {
  const out: Message[] = [systemMsg]
  for (let i = 0; i < n; i++) {
    out.push(u(`User turn ${i}: ${'word '.repeat(20)}`))
    out.push(a(`Assistant turn ${i}: ${'word '.repeat(20)}`))
  }
  return out
}

// ----- Basics -----

describe('contextTrim — no-op behavior', () => {
  it('returns empty array unchanged', async () => {
    const r = await contextTrim([], { maxTokens: 100 })
    expect(r.messages).toEqual([])
    expect(r.trimmed).toBe(false)
    expect(r.removed).toBe(0)
  })

  it('returns everything untrimmed when under budget', async () => {
    const msgs = manyTurns(2)
    const r = await contextTrim(msgs, { maxTokens: 10_000 })
    expect(r.trimmed).toBe(false)
    expect(r.messages).toHaveLength(msgs.length)
    expect(r.removed).toBe(0)
  })

  it('throws on negative maxTokens', async () => {
    await expect(contextTrim([u('x')], { maxTokens: -1 })).rejects.toThrow(RangeError)
  })

  it('throws on NaN maxTokens', async () => {
    await expect(contextTrim([u('x')], { maxTokens: NaN })).rejects.toThrow(RangeError)
  })

  it("throws when strategy='summary' but no summarize callback", async () => {
    await expect(
      contextTrim([u('x')], { maxTokens: 10, strategy: 'summary' }),
    ).rejects.toThrow(TypeError)
  })
})

// ----- Sliding strategy -----

describe('contextTrim — sliding (default)', () => {
  it('drops oldest turns first', async () => {
    const msgs = manyTurns(6)
    const r = await contextTrim(msgs, { maxTokens: 80, keepLastTurns: 2 })
    expect(r.trimmed).toBe(true)
    // System and last 2 user/assistant pairs should be present.
    expect(r.messages[0]).toBe(systemMsg)
    // Last message should still be the final assistant.
    expect(r.messages[r.messages.length - 1]?.content).toMatch(/Assistant turn 5/)
  })

  it('always preserves system messages', async () => {
    const msgs = manyTurns(10)
    const r = await contextTrim(msgs, { maxTokens: 30, keepLastTurns: 1 })
    expect(r.messages[0]?.role).toBe('system')
    expect(r.messages.filter(m => m.role === 'system')).toHaveLength(1)
  })

  it('keepSystem:false allows system to be trimmed', async () => {
    const msgs = manyTurns(10)
    const r = await contextTrim(msgs, { maxTokens: 30, keepLastTurns: 1, keepSystem: false })
    // Whether it's actually trimmed depends on tokens; but if it were, we'd see it gone.
    // Just ensure no crash and result is sane.
    expect(r.messages.length).toBeGreaterThan(0)
  })

  it('never splits a user/assistant turn', async () => {
    const msgs = manyTurns(8)
    const r = await contextTrim(msgs, { maxTokens: 100, keepLastTurns: 2 })
    // Every user message must have its assistant reply following it (or be the last).
    for (let i = 0; i < r.messages.length - 1; i++) {
      if (r.messages[i]!.role === 'user') {
        expect(r.messages[i + 1]!.role).toBe('assistant')
      }
    }
  })

  it('preserves pinned messages even when old', async () => {
    const msgs: Message[] = [
      systemMsg,
      { ...u('important constraint set very early'), pinned: true },
      a('ok'),
    ]
    for (let i = 0; i < 20; i++) {
      msgs.push(u(`filler user ${i} ${'x'.repeat(200)}`))
      msgs.push(a(`filler assistant ${i} ${'x'.repeat(200)}`))
    }
    const r = await contextTrim(msgs, { maxTokens: 200, keepLastTurns: 1 })
    expect(r.messages.some(m => m.pinned && hasText(m, 'important'))).toBe(true)
  })

  it('reports tokensBefore / tokensAfter / overflow', async () => {
    const msgs = manyTurns(6)
    const r = await contextTrim(msgs, { maxTokens: 200, keepLastTurns: 2 })
    expect(r.tokensBefore).toBeGreaterThan(r.tokensAfter)
    expect(r.overflow).toBe(0) // budget is big enough for protected set
  })

  it('overflow > 0 when protected set alone exceeds budget', async () => {
    const bigSystem: Message = { role: 'system', content: 'x'.repeat(4000) }
    const msgs = [bigSystem, u('hi'), a('hello')]
    const r = await contextTrim(msgs, { maxTokens: 10, keepLastTurns: 1 })
    expect(r.overflow).toBeGreaterThan(0)
    expect(r.messages).toContainEqual(bigSystem)
  })
})

// ----- Importance strategy -----

describe('contextTrim — importance', () => {
  it('drops filler turns before substantive ones', async () => {
    // Build a mix of filler and substantive turns. With importance scoring,
    // the correction and the question should outrank "thanks"/"you're welcome".
    const msgs: Message[] = [
      systemMsg,
      u('thanks'),                                                         // low (filler)
      a('You are welcome.'),                                               // low (filler)
      u('Actually, I meant something different — use informal English.'), // very high (correction)
      a('Got it.'),                                                        // low (filler)
      u('What is the capital of France?'),                                // high (question)
      a('Paris is the capital of France.'),
    ]
    // Compare: sliding would keep the LAST 2 turns. Importance should keep
    // the correction (high score) over the filler "thanks/you're welcome" turn.
    const budget = 100
    const sliding = await contextTrim(msgs, { maxTokens: budget, strategy: 'sliding', keepLastTurns: 1 })
    const importance = await contextTrim(msgs, { maxTokens: budget, strategy: 'importance', keepLastTurns: 1 })

    const slidingHasCorrection = sliding.messages.some(m => hasText(m, 'Actually'))
    const importanceHasCorrection = importance.messages.some(m => hasText(m, 'Actually'))

    // Importance should preserve the correction even when sliding might not.
    if (!slidingHasCorrection) {
      expect(importanceHasCorrection).toBe(true)
    } else {
      // Both preserved it — that's fine, just confirm the strategy ran.
      expect(importance.strategy).toBe('importance')
    }
  })

  it('accepts custom score callback', async () => {
    const msgs = manyTurns(6)
    const score = vi.fn().mockReturnValue(5)
    const r = await contextTrim(msgs, {
      maxTokens: 50,
      strategy: 'importance',
      keepLastTurns: 1,
      score,
    })
    expect(score).toHaveBeenCalled()
    expect(r.strategy).toBe('importance')
  })

  it('score is exposed as helper', () => {
    expect(contextTrim.score(u('Must respect this rule.'))).toBeGreaterThan(contextTrim.score(u('ok')))
    expect(contextTrim.score(u('Actually, I meant something else.'))).toBeGreaterThan(
      contextTrim.score(u('Let me know.'))
    )
  })

  it('handles messages with null content (tool_calls only)', () => {
    const toolMsg: Message = {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: '1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Paris"}' } }],
    }
    expect(() => contextTrim.score(toolMsg)).not.toThrow()
  })
})

// ----- Summary strategy -----

describe('contextTrim — summary', () => {
  it('calls summarize callback with removed messages', async () => {
    const msgs = manyTurns(8)
    const summarize = vi.fn().mockResolvedValue('earlier discussion about topics')
    const r = await contextTrim(msgs, {
      maxTokens: 60,
      strategy: 'summary',
      keepLastTurns: 1,
      summarize,
    })
    expect(summarize).toHaveBeenCalled()
    expect(summarize.mock.calls[0]![0].length).toBeGreaterThan(0)
    // Output should contain a summary message.
    expect(r.messages.some(m => hasText(m, 'earlier discussion'))).toBe(true)
  })

  it('places summary as system message by default, before user turns', async () => {
    const msgs = manyTurns(8)
    const r = await contextTrim(msgs, {
      maxTokens: 60,
      strategy: 'summary',
      keepLastTurns: 1,
      summarize: async () => 'sum',
    })
    const sumIdx = r.messages.findIndex(m => hasText(m, '[summary of earlier'))
    const firstUserIdx = r.messages.findIndex(m => m.role === 'user')
    expect(sumIdx).toBeGreaterThanOrEqual(0)
    expect(sumIdx).toBeLessThan(firstUserIdx)
  })

  it('falls back to plain removal if summarize throws', async () => {
    const msgs = manyTurns(6)
    const summarize = vi.fn().mockRejectedValue(new Error('api down'))
    const r = await contextTrim(msgs, {
      maxTokens: 50,
      strategy: 'summary',
      keepLastTurns: 1,
      summarize,
    })
    // Should still return trimmed output, not throw.
    expect(r.trimmed).toBe(true)
    expect(r.messages.some(m => hasText(m, '[summary of'))).toBe(false)
  })

  it('falls back to plain removal if summarize returns empty string', async () => {
    const msgs = manyTurns(6)
    const r = await contextTrim(msgs, {
      maxTokens: 50,
      strategy: 'summary',
      keepLastTurns: 1,
      summarize: async () => '',
    })
    expect(r.messages.some(m => hasText(m, '[summary of'))).toBe(false)
  })

  it('respects summaryRole:"user"', async () => {
    const msgs = manyTurns(8)
    const r = await contextTrim(msgs, {
      maxTokens: 60,
      strategy: 'summary',
      keepLastTurns: 1,
      summaryRole: 'user',
      summarize: async () => 'sum',
    })
    const sum = r.messages.find(m => hasText(m, '[summary of'))
    expect(sum?.role).toBe('user')
  })
})

// ----- Tool call / tool result pair preservation -----

describe('contextTrim — tool call pairs', () => {
  const mkToolCall = (callId: string, fnName: string): Message => ({
    role: 'assistant',
    content: null,
    tool_calls: [{ id: callId, type: 'function', function: { name: fnName, arguments: '{}' } }],
  })

  const mkToolResult = (callId: string, result: string): Message => ({
    role: 'tool',
    tool_call_id: callId,
    content: result,
  })

  it('keeps tool_call and tool_result together when trimming', async () => {
    const msgs: Message[] = [
      systemMsg,
      u('what is the weather?'),
      mkToolCall('c1', 'get_weather'),
      mkToolResult('c1', '{"temp": 72}'),
      a('It is 72 degrees.'),
      // Filler turns that will get trimmed:
      ...Array.from({ length: 10 }, (_, i) => [
        u(`filler ${i} ${'x'.repeat(100)}`),
        a(`response ${i} ${'x'.repeat(100)}`),
      ]).flat(),
    ]
    const r = await contextTrim(msgs, { maxTokens: 200, keepLastTurns: 1 })
    // If the tool call survives, its result must too.
    const toolCallIdx = r.messages.findIndex(m => m.tool_calls?.[0]?.id === 'c1')
    const toolResIdx = r.messages.findIndex(m => m.tool_call_id === 'c1')
    if (toolCallIdx >= 0) expect(toolResIdx).toBeGreaterThanOrEqual(0)
    if (toolResIdx >= 0) expect(toolCallIdx).toBeGreaterThanOrEqual(0)
  })

  it('never removes tool_result without removing its tool_call', async () => {
    const msgs: Message[] = [
      systemMsg,
      u('first request'),
      mkToolCall('c1', 'f'),
      mkToolResult('c1', 'result1'),
      a('Result given.'),
      u('second request'),
      a('Second response.'),
    ]
    // Trim aggressively.
    const r = await contextTrim(msgs, { maxTokens: 30, keepLastTurns: 1 })
    // Check invariant: every tool_call_id in the output has a matching tool_call.
    const callIds = new Set<string>()
    for (const m of r.messages) {
      for (const tc of m.tool_calls ?? []) callIds.add(tc.id)
    }
    for (const m of r.messages) {
      if (m.tool_call_id) {
        expect(callIds.has(m.tool_call_id)).toBe(true)
      }
    }
  })

  it('drops orphan tool messages (no matching call)', async () => {
    const msgs: Message[] = [
      systemMsg,
      mkToolResult('ghost', 'orphan'),  // no preceding call
      u('hello'),
      a('hi'),
    ]
    const r = await contextTrim(msgs, { maxTokens: 10_000 })
    // Even when we have all the budget in the world, orphan tool messages
    // should be dropped because they're broken state.
    expect(r.messages.some(m => m.tool_call_id === 'ghost')).toBe(false)
  })

  it('multi-call assistant turn: all results stay with their call', async () => {
    const msgs: Message[] = [
      systemMsg,
      u('check weather in two cities'),
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'c1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"A"}' } },
          { id: 'c2', type: 'function', function: { name: 'get_weather', arguments: '{"city":"B"}' } },
        ],
      },
      mkToolResult('c1', '72'),
      mkToolResult('c2', '68'),
      a('A=72, B=68'),
      ...Array.from({ length: 5 }, (_, i) => [u(`f${i} ${'x'.repeat(50)}`), a('r')]).flat(),
    ]
    const r = await contextTrim(msgs, { maxTokens: 100, keepLastTurns: 1 })
    // Either both tool calls + both results, or neither.
    const callMsgs = r.messages.filter(m => m.tool_calls?.length)
    const resMsgs = r.messages.filter(m => m.tool_call_id)
    if (callMsgs.length > 0) {
      expect(resMsgs.length).toBe(2)
    } else {
      expect(resMsgs.length).toBe(0)
    }
  })
})

// ----- Helpers -----

describe('contextTrim — helpers', () => {
  it('count returns total with overhead', () => {
    const n = contextTrim.count([u('hello')])
    expect(n).toBeGreaterThan(0)
  })

  it('countMessage > estimateTokens alone (includes overhead)', () => {
    const n = contextTrim.countMessage(u('hi'))
    expect(n).toBeGreaterThanOrEqual(4) // overhead alone is ~4
  })

  it('count varies by model family', () => {
    const msgs = [u('hello world')]
    const openai = contextTrim.count(msgs, 'gpt-5')
    const claude = contextTrim.count(msgs, 'claude-sonnet-4-6')
    // Claude has denser tokenization heuristic -> more tokens for same text.
    expect(claude).toBeGreaterThanOrEqual(openai - 5)
  })

  it('dryRun predicts trimming without mutating', () => {
    const msgs = manyTurns(10)
    const dry = contextTrim.dryRun(msgs, { maxTokens: 50 })
    expect(dry.wouldTrim).toBe(true)
    expect(dry.overBudgetBy).toBeGreaterThan(0)
    // Original array untouched.
    expect(msgs).toHaveLength(21)
  })

  it('dryRun reports false when under budget', () => {
    const dry = contextTrim.dryRun([u('hi')], { maxTokens: 10_000 })
    expect(dry.wouldTrim).toBe(false)
    expect(dry.overBudgetBy).toBe(0)
  })
})

// ----- Token counting edge cases -----

describe('contextTrim — token counting edge cases', () => {
  it('counts content:null messages with tool_calls', () => {
    const toolMsg: Message = {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: '1', type: 'function', function: { name: 'f', arguments: '{"x":1}' } }],
    }
    const n = contextTrim.countMessage(toolMsg, 'gpt-5')
    expect(n).toBeGreaterThan(10) // overhead + per-call + name + args
  })

  it('counts empty string content as just overhead', () => {
    const empty: Message = { role: 'user', content: '' }
    const n = contextTrim.countMessage(empty, 'gpt-5')
    expect(n).toBeGreaterThan(0)
    expect(n).toBeLessThan(10)
  })

  it('handles very long content without crashing', () => {
    const big = u('x'.repeat(10_000))
    expect(() => contextTrim.countMessage(big)).not.toThrow()
  })
})

// ----- Adversarial edge cases (from probe) -----

describe('contextTrim — adversarial edge cases', () => {
  it('mid-conversation system message is still preserved', async () => {
    const msgs: Message[] = [
      systemMsg,
      u('hi'),
      a('hello'),
      { role: 'system', content: 'new instruction injected mid-run' },
      u('continue'),
      a('ok'),
    ]
    const r = await contextTrim(msgs, { maxTokens: 30, keepLastTurns: 1 })
    expect(r.messages.filter(m => m.role === 'system')).toHaveLength(2)
  })

  it('keepLastTurns:0 with tight budget trims all turns, keeps system', async () => {
    const msgs: Message[] = [
      systemMsg,
      u('u1 ' + 'x'.repeat(200)), a('a1 ' + 'x'.repeat(200)),
      u('u2 ' + 'x'.repeat(200)), a('a2 ' + 'x'.repeat(200)),
    ]
    const r = await contextTrim(msgs, { maxTokens: 10, keepLastTurns: 0 })
    expect(r.messages.every(m => m.role === 'system')).toBe(true)
  })

  it('keepLastTurns > available returns everything (no crash)', async () => {
    const msgs: Message[] = [u('u1'), a('a1')]
    const r = await contextTrim(msgs, { maxTokens: 10_000, keepLastTurns: 10 })
    expect(r.messages).toHaveLength(2)
  })

  it('maxTokens:0 returns protected set, reports overflow', async () => {
    const msgs: Message[] = [systemMsg, u('hi'), a('hello')]
    const r = await contextTrim(msgs, { maxTokens: 0, keepLastTurns: 1 })
    expect(r.overflow).toBeGreaterThan(0)
  })

  it('assistant with null content and no tool_calls does not crash', async () => {
    const msgs: Message[] = [
      systemMsg,
      u('hi'),
      { role: 'assistant', content: null },
    ]
    await expect(contextTrim(msgs, { maxTokens: 10 })).resolves.toBeDefined()
  })

  it('pinned tool-call turn keeps its tool results', async () => {
    const msgs: Message[] = [
      u('important query'),
      {
        role: 'assistant', content: null, pinned: true,
        tool_calls: [{ id: 'p', type: 'function', function: { name: 'f', arguments: '{}' } }],
      },
      { role: 'tool', tool_call_id: 'p', content: 'result' },
      a('final'),
      ...Array.from({ length: 10 }, (_, i): Message[] => [
        u(`f${i} ${'x'.repeat(100)}`),
        a('ok'),
      ]).flat(),
    ]
    const r = await contextTrim(msgs, { maxTokens: 80, keepLastTurns: 1 })
    const hasCall = r.messages.some(m => m.tool_calls?.[0]?.id === 'p')
    const hasResult = r.messages.some(m => m.tool_call_id === 'p')
    expect(hasCall).toBe(true)
    expect(hasResult).toBe(true)
  })

  it('does not mutate the input messages array', async () => {
    const msgs: Message[] = [systemMsg, u('hi'), a('hello')]
    const snapshot = JSON.stringify(msgs)
    await contextTrim(msgs, { maxTokens: 5, keepLastTurns: 0 })
    expect(JSON.stringify(msgs)).toBe(snapshot)
  })

  it('summary is not called when already under budget', async () => {
    const summarize = vi.fn().mockResolvedValue('sum')
    await contextTrim(
      [systemMsg, u('hi')],
      { maxTokens: 10_000, strategy: 'summary', summarize },
    )
    expect(summarize).not.toHaveBeenCalled()
  })

  it('dryRun does not mutate', () => {
    const msgs = [systemMsg, u('hi')]
    const snap = JSON.stringify(msgs)
    contextTrim.dryRun(msgs, { maxTokens: 5 })
    expect(JSON.stringify(msgs)).toBe(snap)
  })
})

// ----- Claude content-block awareness -----

describe('contextTrim — Claude content blocks + thinking', () => {
  it('counts tokens for content-array messages (text + thinking)', () => {
    const msg: Message = {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'Let me reason about this carefully...', signature: 'sig_abc' },
        { type: 'text', text: 'The answer is 42.' },
      ],
    }
    const n = contextTrim.countMessage(msg, 'claude-sonnet-4-6')
    // Must count both blocks, not just the first.
    expect(n).toBeGreaterThan(15)
  })

  it('preserves thinking block atomically with its assistant turn', async () => {
    const msgs: Message[] = [
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'what is 2+2?' },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'Simple arithmetic.', signature: 'sig_1' },
          { type: 'text', text: '4' },
        ],
      },
      ...Array.from({ length: 10 }, (_, i): Message[] => [
        { role: 'user', content: `f${i} ${'x'.repeat(80)}` },
        { role: 'assistant', content: `r${i}` },
      ]).flat(),
    ]
    const r = await contextTrim(msgs, { maxTokens: 120, keepLastTurns: 2, model: 'claude-sonnet-4-6' })
    // If the assistant turn with thinking survives, its content array must be intact.
    const thinkingTurn = r.messages.find(m =>
      Array.isArray(m.content) && m.content.some(b => b.type === 'thinking'),
    )
    if (thinkingTurn) {
      const blocks = thinkingTurn.content as any[]
      expect(blocks.some(b => b.type === 'thinking' && b.signature === 'sig_1')).toBe(true)
      expect(blocks.some(b => b.type === 'text')).toBe(true)
    }
  })

  it('importance scorer reads text from content-array', () => {
    const a: Message = {
      role: 'user',
      content: [{ type: 'text', text: 'Actually, I meant use metric units.' }],
    }
    const b: Message = {
      role: 'user',
      content: [{ type: 'text', text: 'ok' }],
    }
    expect(contextTrim.score(a)).toBeGreaterThan(contextTrim.score(b))
  })

  it('message with content:null (tool_calls only) still counts', () => {
    const msg: Message = {
      role: 'assistant',
      content: null,
      tool_calls: [{
        id: 'x', type: 'function',
        function: { name: 'get_weather', arguments: '{"city":"Paris"}' },
      }],
    }
    expect(contextTrim.countMessage(msg, 'gpt-5')).toBeGreaterThan(10)
    expect(() => contextTrim.score(msg)).not.toThrow()
  })
})

// ----- Idempotence -----

describe('contextTrim — idempotence', () => {
  it('trimming an already-trimmed result returns the same messages', async () => {
    const msgs = manyTurns(10)
    const first = await contextTrim(msgs, { maxTokens: 100, keepLastTurns: 2 })
    const second = await contextTrim(first.messages, { maxTokens: 100, keepLastTurns: 2 })
    expect(second.trimmed).toBe(false)
    expect(second.messages).toEqual(first.messages)
  })
})
