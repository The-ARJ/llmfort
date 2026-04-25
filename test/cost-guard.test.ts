import { describe, it, expect } from 'vitest'
import {
  costGuard,
  CostLimitError,
  getPrice,
  estimateTokens,
  calcCost,
} from '../src/cost-guard/index.js'

describe('getPrice', () => {
  it('returns known GPT-5 pricing', () => {
    const p = getPrice('gpt-5')
    expect(p.input).toBe(1.25)
    expect(p.output).toBe(10.00)
  })

  it('returns known Claude Opus 4.7 pricing (corrected from stale $15)', () => {
    const p = getPrice('claude-opus-4-7')
    expect(p.input).toBe(5.00)
    expect(p.cacheWrite).toBe(6.25)
  })

  it('returns known Gemini 3 Pro pricing', () => {
    const p = getPrice('gemini-3-pro')
    expect(p.input).toBe(2.00)
  })

  it('resolves versioned Claude IDs via longest-prefix match', () => {
    const p = getPrice('claude-sonnet-4-6-20260101')
    expect(p.input).toBe(3.00)
  })

  it('does NOT reverse-prefix match (short "o" must not pick up "o3")', () => {
    const p = getPrice('o')
    expect(p.input).not.toBe(2.00)
  })

  it('empty string yields unknown-model fallback', () => {
    const p = getPrice('')
    expect(p.input).toBeGreaterThan(0)
  })

  it('applies aliases', () => {
    expect(getPrice('claude-opus-4').input).toBe(getPrice('claude-opus-4-7').input)
    expect(getPrice('gemini-flash').input).toBe(getPrice('gemini-2.5-flash').input)
    expect(getPrice('gemini-pro').input).toBe(getPrice('gemini-2.5-pro').input)
  })

  it('cached-input and cache-write are exposed on Claude', () => {
    const p = getPrice('claude-sonnet-4-6')
    expect(p.cachedInput).toBe(0.30)
    expect(p.cacheWrite).toBe(3.75)
  })

  it('unknown models get conservative fallback (not tied to any specific model)', () => {
    const p = getPrice('model-that-does-not-exist')
    expect(p.input).toBeGreaterThan(0)
    expect(p.output).toBeGreaterThan(0)
  })

  it('removed families (Llama/DeepSeek/Mistral) fall back to UNKNOWN', () => {
    // Used to be in the table — now scoped to Claude/GPT/Gemini only.
    const dp = getPrice('deepseek-reasoner')
    const ll = getPrice('llama-3.3-70b-versatile')
    const ms = getPrice('mistral-large-latest')
    const unknown = getPrice('model-that-does-not-exist')
    expect(dp).toEqual(unknown)
    expect(ll).toEqual(unknown)
    expect(ms).toEqual(unknown)
  })
})

describe('estimateTokens', () => {
  it('empty string → 0', () => {
    expect(estimateTokens('')).toBe(0)
  })

  it('english ~chars/4', () => {
    expect(estimateTokens('hello world test')).toBeGreaterThan(2)
    expect(estimateTokens('hello world test')).toBeLessThan(6)
  })

  it('Claude tokenizer is denser (more tokens per char)', () => {
    const text = 'The quick brown fox jumps over the lazy dog'
    expect(estimateTokens(text, 'claude-sonnet-4-6')).toBeGreaterThanOrEqual(estimateTokens(text, 'gpt-5'))
  })

  it('CJK text produces denser count than chars/4', () => {
    const text = '你好世界今天天气很好'  // 10 CJK chars
    expect(estimateTokens(text, 'gpt-5')).toBeGreaterThan(Math.ceil(text.length / 4))
  })
})

describe('calcCost', () => {
  it('legacy 2-arg signature still works', () => {
    const price = getPrice('gpt-5')
    const cost = calcCost(1000, 500, price)
    expect(cost).toBeCloseTo(0.00625, 6)
  })

  it('usage-object signature accepts input+output only', () => {
    const price = getPrice('gpt-5')
    expect(calcCost({ input: 1_000_000, output: 0 }, undefined, price)).toBeCloseTo(1.25, 6)
  })

  it('includes reasoning tokens at output rate', () => {
    const price = getPrice('o3')  // $2 in, $8 out
    const cost = calcCost({ input: 0, output: 0, reasoning: 1_000_000 }, undefined, price)
    expect(cost).toBeCloseTo(8.00, 6)
  })

  it('cached-input tokens use cachedInput rate', () => {
    const price = getPrice('claude-opus-4-7') // input: 5, cachedInput: 0.5
    const full = calcCost({ input: 1_000_000, output: 0 }, undefined, price)
    const cached = calcCost({ input: 0, output: 0, cacheHit: 1_000_000 }, undefined, price)
    expect(full).toBeCloseTo(5.00, 6)
    expect(cached).toBeCloseTo(0.50, 6)
  })

  it('cacheWrite tokens use cacheWrite rate', () => {
    const price = getPrice('claude-opus-4-7')  // cacheWrite: 6.25
    const cost = calcCost({ input: 0, output: 0, cacheWrite: 1_000_000 }, undefined, price)
    expect(cost).toBeCloseTo(6.25, 6)
  })
})

describe('costGuard.estimate + check', () => {
  it('estimate returns cost > 0 and includes reasoning tokens', () => {
    const guard = costGuard({ model: 'gpt-5', assumedReasoningTokens: 500 })
    const est = guard.estimate('hello world')
    expect(est.estimatedCost).toBeGreaterThan(0)
    expect(est.assumedReasoningTokens).toBe(500)
  })

  it('check throws CostLimitError on per-call overage', async () => {
    const g = costGuard({ model: 'gpt-5', budget: { perCall: 0.000001 } })
    await expect(g.check('x'.repeat(100_000))).rejects.toBeInstanceOf(CostLimitError)
  })

  it('check throws with kind=reasoning when reasoning budget exceeded', async () => {
    const g = costGuard({
      model: 'o3',
      budget: { reasoning: 0.0001 },
      assumedReasoningTokens: 100_000,  // 100k reasoning × $8/M = $0.80 (huge over budget)
    })
    let caught: unknown
    try { await g.check('hello') } catch (e) { caught = e }
    expect(caught).toBeInstanceOf(CostLimitError)
    if (caught instanceof CostLimitError) expect(caught.kind).toBe('reasoning')
  })
})

describe('costGuard.record + summary (new API)', () => {
  it('record accepts a usage object', () => {
    const g = costGuard({ model: 'gpt-5' })
    g.record({ input: 1000, output: 500 })
    const s = g.summary()
    expect(s.calls).toBe(1)
    expect(s.totalInputTokens).toBe(1000)
    expect(s.totalOutputTokens).toBe(500)
  })

  it('record accepts the legacy positional form (0.2.x compatibility)', () => {
    const g = costGuard({ model: 'gpt-5' })
    g.record(1000, 500)
    const s = g.summary()
    expect(s.calls).toBe(1)
    expect(s.totalInputTokens).toBe(1000)
    expect(s.totalOutputTokens).toBe(500)
  })

  it('legacy positional rejects NaN', () => {
    const g = costGuard({ model: 'gpt-5' })
    expect(() => g.record(NaN, 0)).toThrow(TypeError)
  })

  it('tracks reasoning tokens separately', () => {
    const g = costGuard({ model: 'o3' })
    g.record({ input: 100, output: 50, reasoning: 2000 })
    const s = g.summary()
    expect(s.totalReasoningTokens).toBe(2000)
    expect(s.reasoningSpent).toBeGreaterThan(0)
  })

  it('reasoningSpent != total spent (tracks isolated reasoning cost)', () => {
    const g = costGuard({ model: 'o3' })  // $2 in, $8 out
    g.record({ input: 1_000_000, output: 1_000_000, reasoning: 1_000_000 })
    const s = g.summary()
    expect(s.spent).toBeCloseTo(2 + 8 + 8, 2)           // $18 total
    expect(s.reasoningSpent).toBeCloseTo(8, 2)           // $8 of which is reasoning
  })

  it('reports cache savings from cacheHit tokens', () => {
    const g = costGuard({ model: 'claude-opus-4-7' })  // input: 5, cachedInput: 0.5
    g.record({ input: 0, output: 0, cacheHit: 1_000_000 })
    const s = g.summary()
    // Savings = (5 - 0.5) × 1M / 1M = $4.50
    expect(s.cacheSavings).toBeCloseTo(4.50, 2)
    expect(s.spent).toBeCloseTo(0.50, 2)
  })

  it('tracks cacheWrite tokens', () => {
    const g = costGuard({ model: 'claude-opus-4-7' })
    g.record({ input: 100, output: 50, cacheWrite: 5000 })
    const s = g.summary()
    expect(s.totalCacheWriteTokens).toBe(5000)
  })

  it('reasoningRemaining respects reasoning budget', () => {
    const g = costGuard({ model: 'o3', budget: { reasoning: 10.00 } })
    g.record({ input: 0, output: 0, reasoning: 500_000 })  // 500k × $8/M = $4
    const s = g.summary()
    expect(s.reasoningRemaining).toBeCloseTo(6.00, 2)
  })

  it('reasoningRemaining null when no reasoning budget', () => {
    const g = costGuard({ model: 'gpt-5' })
    expect(g.summary().reasoningRemaining).toBeNull()
  })
})

describe('costGuard — input validation (prevents session poisoning)', () => {
  it('record throws TypeError on NaN', () => {
    const g = costGuard({ model: 'gpt-5' })
    expect(() => g.record({ input: NaN, output: 100 })).toThrow(TypeError)
    expect(() => g.record({ input: 100, output: NaN })).toThrow(TypeError)
    expect(() => g.record({ input: 100, output: 100, reasoning: NaN })).toThrow(TypeError)
    expect(() => g.record({ input: 100, output: 100, cacheHit: NaN })).toThrow(TypeError)
  })

  it('record throws RangeError on negatives', () => {
    const g = costGuard({ model: 'gpt-5' })
    expect(() => g.record({ input: -1, output: 100 })).toThrow(RangeError)
    expect(() => g.record({ input: 100, output: 100, reasoning: -1 })).toThrow(RangeError)
  })

  it('failed record does not poison totals', () => {
    const g = costGuard({ model: 'gpt-5' })
    g.record({ input: 100, output: 50 })
    try { g.record({ input: NaN, output: 10 }) } catch { /* expected */ }
    const s = g.summary()
    expect(s.calls).toBe(1)
    expect(s.totalInputTokens).toBe(100)
    expect(Number.isFinite(s.spent)).toBe(true)
  })

  it('costGuard() throws on negative assumedOutputTokens', () => {
    expect(() => costGuard({ model: 'gpt-5', assumedOutputTokens: -1 })).toThrow(RangeError)
  })

  it('costGuard() throws on negative assumedReasoningTokens', () => {
    expect(() => costGuard({ model: 'gpt-5', assumedReasoningTokens: -1 })).toThrow(RangeError)
  })
})

describe('costGuard — perCall + session budget', () => {
  it('perCall throws first', async () => {
    const g = costGuard({ model: 'gpt-5', budget: { perCall: 0.0000001 } })
    let e: unknown
    try { await g.check('x'.repeat(1000)) } catch (err) { e = err }
    expect(e).toBeInstanceOf(CostLimitError)
    if (e instanceof CostLimitError) expect(e.kind).toBe('perCall')
  })

  it('session throws when cumulative exceeded', async () => {
    const g = costGuard({ model: 'gpt-5', budget: { session: 0.00001 } })
    g.record({ input: 1_000_000, output: 0 }) // $1.25 spent
    let e: unknown
    try { await g.check('hi') } catch (err) { e = err }
    expect(e).toBeInstanceOf(CostLimitError)
    if (e instanceof CostLimitError) expect(e.kind).toBe('session')
  })

  it('remaining reports what is left', () => {
    const g = costGuard({ model: 'gpt-5', budget: { session: 10.00 } })
    g.record({ input: 1_000_000, output: 0 })  // $1.25
    expect(g.summary().remaining).toBeCloseTo(8.75, 2)
  })
})
