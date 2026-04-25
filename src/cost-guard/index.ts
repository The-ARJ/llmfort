import {
  calcCost,
  estimateTokens,
  getPrice,
  type ModelPrice,
  type UsageBreakdown,
} from './pricing.js'

export type { ModelPrice, UsageBreakdown }
export { getPrice, estimateTokens, calcCost }

export interface Budget {
  perCall?: number
  session?: number
  /** Cap on reasoning-token spend (o-series, Claude thinking). */
  reasoning?: number
}

export interface CostGuardOptions {
  model: string
  budget?: Budget
  /** Default 256. */
  assumedOutputTokens?: number
  /** Default 0. */
  assumedReasoningTokens?: number
}

export interface CostEstimate {
  inputTokens: number
  assumedOutputTokens: number
  assumedReasoningTokens: number
  estimatedCost: number
  model: string
}

export interface SessionSummary {
  calls: number
  totalInputTokens: number
  totalOutputTokens: number
  totalReasoningTokens: number
  totalCacheHitTokens: number
  totalCacheWriteTokens: number
  spent: number
  reasoningSpent: number
  /** Saved vs uncached rate from prompt-cache hits. */
  cacheSavings: number
  remaining: number | null
  reasoningRemaining: number | null
  budget: Budget
}

export class CostLimitError extends Error {
  readonly kind: 'perCall' | 'session' | 'reasoning'
  readonly estimated: number
  readonly limit: number
  constructor(kind: 'perCall' | 'session' | 'reasoning', estimated: number, limit: number) {
    const verb =
      kind === 'perCall'   ? 'Per-call cost limit exceeded' :
      kind === 'session'   ? 'Session cost limit exceeded' :
                             'Reasoning-token cost limit exceeded'
    super(`${verb}: $${estimated.toFixed(6)} > $${limit.toFixed(6)}`)
    this.name = 'CostLimitError'
    this.kind = kind
    this.estimated = estimated
    this.limit = limit
  }
}

export interface CostGuard {
  /** Estimate cost and throw `CostLimitError` if over budget. */
  check(prompt: string, outputTokens?: number): Promise<CostEstimate>
  /** Estimate cost without enforcing limits. */
  estimate(prompt: string, outputTokens?: number): CostEstimate
  record(usage: UsageBreakdown): void
  record(inputTokens: number, outputTokens: number): void
  summary(): SessionSummary
}

export function costGuard(options: CostGuardOptions): CostGuard {
  const { model, budget = {} } = options
  let { assumedOutputTokens = 256, assumedReasoningTokens = 0 } = options

  if (!Number.isFinite(assumedOutputTokens) || assumedOutputTokens < 0) {
    throw new RangeError(
      `costGuard: assumedOutputTokens must be a finite non-negative number, got ${assumedOutputTokens}`,
    )
  }
  if (!Number.isFinite(assumedReasoningTokens) || assumedReasoningTokens < 0) {
    throw new RangeError(
      `costGuard: assumedReasoningTokens must be a finite non-negative number, got ${assumedReasoningTokens}`,
    )
  }
  assumedOutputTokens    = Math.floor(assumedOutputTokens)
  assumedReasoningTokens = Math.floor(assumedReasoningTokens)

  const price = getPrice(model)

  const totals = {
    input:      0,
    output:     0,
    reasoning:  0,
    cacheHit:   0,
    cacheWrite: 0,
    calls:      0,
  }

  function buildEstimate(prompt: string, outputTokens?: number): CostEstimate {
    const inputTokens = estimateTokens(prompt, model)
    const out = outputTokens ?? assumedOutputTokens
    const estimatedCost = calcCost(
      { input: inputTokens, output: out, reasoning: assumedReasoningTokens },
      undefined,
      price,
    )
    return {
      inputTokens,
      assumedOutputTokens: out,
      assumedReasoningTokens,
      estimatedCost,
      model,
    }
  }

  function currentSpent(): number {
    return calcCost(
      {
        input:      totals.input,
        output:     totals.output,
        reasoning:  totals.reasoning,
        cacheHit:   totals.cacheHit,
        cacheWrite: totals.cacheWrite,
      },
      undefined,
      price,
    )
  }

  function currentReasoningSpent(): number {
    return calcCost(
      { input: 0, output: 0, reasoning: totals.reasoning },
      undefined,
      price,
    )
  }

  return {
    estimate: (prompt, outputTokens) => buildEstimate(prompt, outputTokens),

    async check(prompt, outputTokens) {
      const est = buildEstimate(prompt, outputTokens)

      if (budget.perCall !== undefined && est.estimatedCost > budget.perCall) {
        throw new CostLimitError('perCall', est.estimatedCost, budget.perCall)
      }

      if (budget.session !== undefined) {
        const projected = currentSpent() + est.estimatedCost
        if (projected > budget.session) {
          throw new CostLimitError('session', projected, budget.session)
        }
      }

      if (budget.reasoning !== undefined) {
        const reasoningProjected =
          currentReasoningSpent() +
          calcCost({ input: 0, output: 0, reasoning: assumedReasoningTokens }, undefined, price)
        if (reasoningProjected > budget.reasoning) {
          throw new CostLimitError('reasoning', reasoningProjected, budget.reasoning)
        }
      }

      return est
    },

    record(usageOrInput: UsageBreakdown | number, outputTokens?: number) {
      const usage: UsageBreakdown = typeof usageOrInput === 'number'
        ? { input: usageOrInput, output: outputTokens ?? 0 }
        : usageOrInput

      // NaN / Infinity / negatives reject before mutation; one bad value would
      // otherwise propagate through arithmetic and silently disable budgets.
      const fields: Array<[keyof UsageBreakdown, number | undefined]> = [
        ['input',      usage.input],
        ['output',     usage.output],
        ['reasoning',  usage.reasoning],
        ['cacheHit',   usage.cacheHit],
        ['cacheWrite', usage.cacheWrite],
      ]
      for (const [name, v] of fields) {
        if (v === undefined) continue
        if (!Number.isFinite(v)) {
          throw new TypeError(`costGuard.record: ${name} must be a finite number, got ${v}`)
        }
        if (v < 0) {
          throw new RangeError(`costGuard.record: ${name} must be >= 0, got ${v}`)
        }
      }
      totals.input      += usage.input
      totals.output     += usage.output
      totals.reasoning  += usage.reasoning  ?? 0
      totals.cacheHit   += usage.cacheHit   ?? 0
      totals.cacheWrite += usage.cacheWrite ?? 0
      totals.calls      += 1
    },

    summary(): SessionSummary {
      const spent = currentSpent()
      const reasoningSpent = currentReasoningSpent()
      const cacheSavings = totals.cacheHit > 0 && price.cachedInput !== undefined
        ? (totals.cacheHit * (price.input - price.cachedInput)) / 1_000_000
        : 0
      return {
        calls:                 totals.calls,
        totalInputTokens:      totals.input,
        totalOutputTokens:     totals.output,
        totalReasoningTokens:  totals.reasoning,
        totalCacheHitTokens:   totals.cacheHit,
        totalCacheWriteTokens: totals.cacheWrite,
        spent,
        reasoningSpent,
        cacheSavings,
        remaining:          budget.session  !== undefined ? Math.max(0, budget.session  - spent)          : null,
        reasoningRemaining: budget.reasoning !== undefined ? Math.max(0, budget.reasoning - reasoningSpent) : null,
        budget,
      }
    },
  }
}
