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
  /** Max USD per single call (estimated cost). */
  perCall?: number
  /** Max USD across the guard instance's lifetime. */
  session?: number
  /**
   * Max USD of reasoning-token spend across the session. Reasoning tokens
   * (o-series, Claude thinking, Gemini thinking) are billed as output and can
   * be 5-10x the visible output — this is the one budget most users miss.
   */
  reasoning?: number
}

export interface CostGuardOptions {
  model: string
  budget?: Budget
  /** Assumed output tokens when the response isn't available yet. Default 256. */
  assumedOutputTokens?: number
  /**
   * Assumed reasoning tokens for pre-call estimates. Default 0 (only reasoning-
   * capable models will blow past this, and users pass `reasoning_effort` in
   * that case; they can raise this default for those models).
   */
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
  /** Total spent on reasoning tokens alone. */
  reasoningSpent: number
  /** Total saved (vs uncached rate) from prompt-cache hits. */
  cacheSavings: number
  /** Remaining session budget, or null if none was set. */
  remaining: number | null
  /** Remaining reasoning-token budget, or null if none was set. */
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
  /** Record actual token usage after a completed call. */
  record(usage: UsageBreakdown): void
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
    uncachedInputForSavings: 0, // for cacheSavings calculation
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

    record(usage: UsageBreakdown) {
      // NaN / Infinity / negatives must reject before mutation — a single bad
      // value would propagate through subsequent arithmetic and silently
      // disable budget enforcement.
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
