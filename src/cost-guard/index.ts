import { getPrice, estimateTokens, calcCost, type ModelPrice } from './pricing.js'

export type { ModelPrice }
export { getPrice, estimateTokens, calcCost }

export interface Budget {
  /** Max USD per single call. */
  perCall?: number
  /** Max USD across the entire guard instance lifetime. */
  session?: number
}

export interface CostGuardOptions {
  model: string
  budget?: Budget
  /** Assumed output tokens when the response isn't available yet. Default: 256 */
  assumedOutputTokens?: number
}

export interface CostEstimate {
  inputTokens: number
  assumedOutputTokens: number
  estimatedCost: number
  model: string
}

export interface SessionSummary {
  calls: number
  totalInputTokens: number
  totalOutputTokens: number
  spent: number
  remaining: number | null
  budget: Budget
}

export class CostLimitError extends Error {
  readonly kind: 'perCall' | 'session'
  readonly estimated: number
  readonly limit: number
  constructor(kind: 'perCall' | 'session', estimated: number, limit: number) {
    super(
      kind === 'perCall'
        ? `Per-call cost limit exceeded: estimated $${estimated.toFixed(6)} > $${limit.toFixed(6)}`
        : `Session cost limit exceeded: cumulative $${estimated.toFixed(6)} > $${limit.toFixed(6)}`
    )
    this.name = 'CostLimitError'
    this.kind = kind
    this.estimated = estimated
    this.limit = limit
  }
}

export interface CostGuard {
  /**
   * Estimate cost for a prompt and throw `CostLimitError` if it exceeds budget.
   * Call this *before* sending to the LLM API.
   */
  check(prompt: string, outputTokens?: number): Promise<CostEstimate>
  /** Estimate cost without enforcing limits. */
  estimate(prompt: string, outputTokens?: number): CostEstimate
  /**
   * Record actual token usage after a completed call.
   * Pass the token counts from the API response to keep session totals accurate.
   */
  record(inputTokens: number, outputTokens: number): void
  /** Cumulative session statistics. */
  summary(): SessionSummary
}

/**
 * Create a cost guard for a specific model. Call `.check()` before each LLM
 * request to enforce per-call and session budgets.
 *
 * @example
 * const guard = costGuard({ model: 'gpt-4o', budget: { session: 0.50 } })
 * await guard.check(prompt)          // throws CostLimitError if over budget
 * const res = await openai.chat(...)
 * guard.record(res.usage.prompt_tokens, res.usage.completion_tokens)
 * console.log(guard.summary())
 */
export function costGuard(options: CostGuardOptions): CostGuard {
  const { model, budget = {}, assumedOutputTokens = 256 } = options
  const price = getPrice(model)

  let totalInput  = 0
  let totalOutput = 0
  let calls       = 0

  function buildEstimate(prompt: string, outputTokens?: number): CostEstimate {
    const inputTokens = estimateTokens(prompt)
    const out = outputTokens ?? assumedOutputTokens
    return {
      inputTokens,
      assumedOutputTokens: out,
      estimatedCost: calcCost(inputTokens, out, price),
      model,
    }
  }

  return {
    estimate(prompt, outputTokens) {
      return buildEstimate(prompt, outputTokens)
    },

    async check(prompt, outputTokens) {
      const est = buildEstimate(prompt, outputTokens)

      if (budget.perCall !== undefined && est.estimatedCost > budget.perCall) {
        throw new CostLimitError('perCall', est.estimatedCost, budget.perCall)
      }

      if (budget.session !== undefined) {
        const sessionSpent = calcCost(totalInput, totalOutput, price)
        if (sessionSpent + est.estimatedCost > budget.session) {
          throw new CostLimitError('session', sessionSpent + est.estimatedCost, budget.session)
        }
      }

      return est
    },

    record(inputTokens, outputTokens) {
      totalInput  += inputTokens
      totalOutput += outputTokens
      calls       += 1
    },

    summary() {
      const spent = calcCost(totalInput, totalOutput, price)
      return {
        calls,
        totalInputTokens:  totalInput,
        totalOutputTokens: totalOutput,
        spent,
        remaining: budget.session !== undefined ? Math.max(0, budget.session - spent) : null,
        budget,
      }
    },
  }
}
