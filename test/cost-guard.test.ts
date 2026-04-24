import { describe, it, expect } from 'vitest'
import { costGuard, CostLimitError, getPrice, estimateTokens, calcCost } from '../src/cost-guard/index.js'

describe('getPrice', () => {
  it('returns known model pricing', () => {
    const p = getPrice('gpt-4o')
    expect(p.input).toBe(2.50)
    expect(p.output).toBe(10.00)
  })

  it('falls back to conservative pricing for unknown model', () => {
    const p = getPrice('totally-unknown-model-xyz')
    expect(p.input).toBeGreaterThan(0)
    expect(p.output).toBeGreaterThan(0)
  })

  it('returns claude pricing', () => {
    const p = getPrice('claude-sonnet-4-6')
    expect(p.input).toBe(3.00)
  })
})

describe('estimateTokens', () => {
  it('estimates ~4 chars per token', () => {
    const tokens = estimateTokens('hello world test prompt here')
    expect(tokens).toBeGreaterThan(0)
    expect(tokens).toBeLessThan(20)
  })

  it('returns 0 for empty string', () => {
    expect(estimateTokens('')).toBe(0)
  })
})

describe('calcCost', () => {
  it('computes cost correctly for gpt-4o', () => {
    const price = getPrice('gpt-4o')
    // 1000 input tokens at $2.50/1M + 500 output at $10/1M = 0.0025 + 0.005 = 0.0075
    const cost = calcCost(1000, 500, price)
    expect(cost).toBeCloseTo(0.0075, 6)
  })

  it('returns 0 for zero tokens', () => {
    expect(calcCost(0, 0, { input: 2.5, output: 10 })).toBe(0)
  })
})

describe('costGuard.estimate', () => {
  it('returns estimate without throwing', () => {
    const guard = costGuard({ model: 'gpt-4o' })
    const est = guard.estimate('Hello, tell me about Node.js.')
    expect(est.inputTokens).toBeGreaterThan(0)
    expect(est.estimatedCost).toBeGreaterThan(0)
    expect(est.model).toBe('gpt-4o')
  })

  it('uses assumed output tokens in cost calculation', () => {
    const guard = costGuard({ model: 'gpt-4o', assumedOutputTokens: 0 })
    const est = guard.estimate('Hello.')
    // Cost with 0 output should be less than with 256
    const guardWithOutput = costGuard({ model: 'gpt-4o', assumedOutputTokens: 1000 })
    const estWithOutput = guardWithOutput.estimate('Hello.')
    expect(est.estimatedCost).toBeLessThan(estWithOutput.estimatedCost)
  })
})

describe('costGuard.check', () => {
  it('resolves for prompt within per-call budget', async () => {
    const guard = costGuard({ model: 'gpt-4o-mini', budget: { perCall: 1.00 } })
    await expect(guard.check('Hi')).resolves.toBeDefined()
  })

  it('throws CostLimitError when perCall budget exceeded', async () => {
    const guard = costGuard({ model: 'gpt-4o', budget: { perCall: 0.000001 } })
    const bigPrompt = 'word '.repeat(5000)
    await expect(guard.check(bigPrompt)).rejects.toBeInstanceOf(CostLimitError)
  })

  it('CostLimitError.kind is perCall', async () => {
    const guard = costGuard({ model: 'gpt-4o', budget: { perCall: 0.000001 } })
    try {
      await guard.check('word '.repeat(5000))
    } catch (e) {
      expect(e).toBeInstanceOf(CostLimitError)
      expect((e as CostLimitError).kind).toBe('perCall')
    }
  })

  it('throws CostLimitError when session budget exceeded', async () => {
    const guard = costGuard({ model: 'gpt-4o', budget: { session: 0.000001 } })
    guard.record(100_000, 100_000) // simulate previous spend
    await expect(guard.check('Hello')).rejects.toBeInstanceOf(CostLimitError)
  })

  it('CostLimitError.kind is session', async () => {
    const guard = costGuard({ model: 'gpt-4o', budget: { session: 0.000001 } })
    guard.record(100_000, 100_000)
    try {
      await guard.check('Hello')
    } catch (e) {
      expect((e as CostLimitError).kind).toBe('session')
    }
  })
})

describe('costGuard.record + summary', () => {
  it('tracks calls and token totals', () => {
    const guard = costGuard({ model: 'gpt-4o' })
    guard.record(100, 50)
    guard.record(200, 100)
    const s = guard.summary()
    expect(s.calls).toBe(2)
    expect(s.totalInputTokens).toBe(300)
    expect(s.totalOutputTokens).toBe(150)
  })

  it('reports spent correctly', () => {
    const guard = costGuard({ model: 'gpt-4o' })
    guard.record(1_000_000, 0) // 1M input tokens = $2.50
    const s = guard.summary()
    expect(s.spent).toBeCloseTo(2.50, 4)
  })

  it('reports remaining when session budget is set', () => {
    const guard = costGuard({ model: 'gpt-4o', budget: { session: 1.00 } })
    guard.record(100_000, 0)
    const s = guard.summary()
    expect(s.remaining).not.toBeNull()
    expect(s.remaining!).toBeLessThan(1.00)
  })

  it('remaining is null when no session budget', () => {
    const guard = costGuard({ model: 'gpt-4o' })
    expect(guard.summary().remaining).toBeNull()
  })
})
