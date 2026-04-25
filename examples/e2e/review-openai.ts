/**
 * Same end-to-end flow as review-claude.ts, targeting OpenAI's chat-completions
 * API. Demonstrates how the same llmfort modules adapt to a different provider
 * shape:
 *
 *   - cost-guard usage fields differ (prompt_tokens / completion_tokens /
 *     completion_tokens_details.reasoning_tokens / prompt_tokens_details.cached_tokens)
 *   - tool envelope is OpenAI's { type: 'function', function: {...} }
 *   - OpenAI returns plain text (no Claude pre-fill needed); we use response_format
 *     for structured output
 *
 * Run with:
 *   OPENAI_API_KEY=sk-... npm run start:openai
 */
import OpenAI from 'openai'
import { z } from 'zod'
import {
  toolSchema,
  promptSafe,
  PromptViolationError,
  costGuard,
  cacheKey,
  retryLLM,
  normalizeError,
  structOut,
} from '@the-arj/llmfort'

if (!process.env.OPENAI_API_KEY) {
  console.error('Set OPENAI_API_KEY to run this example.')
  process.exit(1)
}

const MODEL = 'gpt-5'
const openai = new OpenAI()
const guard  = costGuard({ model: MODEL, budget: { session: 1.00, reasoning: 0.50 } })

// ---------- Tool definition ----------

const reviewToolMeta = {
  name: 'submit_review',
  description: 'Submit a structured review.',
  params: {
    title:     { type: 'string'  as const, description: 'Short label' },
    sentiment: { type: 'string'  as const, enum: ['positive', 'neutral', 'negative'] },
    score:     { type: 'integer' as const, minimum: 0, maximum: 10 },
    reason:    { type: 'string'  as const, description: 'One-sentence justification' },
  },
}

const reviewTool = toolSchema(reviewToolMeta, 'openai')

const ReviewSchema = z.object({
  title:     z.string(),
  sentiment: z.enum(['positive', 'neutral', 'negative']),
  score:     z.number().int().min(0).max(10),
  reason:    z.string(),
})

// ---------- Pipeline ----------

async function reviewProduct(userInput: string): Promise<z.infer<typeof ReviewSchema> | null> {
  try {
    promptSafe.assert(userInput)
  } catch (err) {
    if (err instanceof PromptViolationError) {
      console.error(`Refused: ${err.violations.map(v => v.label).join(', ')}`)
      return null
    }
    throw err
  }

  const key = await cacheKey({
    model: MODEL,
    messages: [{ role: 'user', content: userInput }],
    tools: [reviewTool as unknown as Record<string, unknown>],
  })
  console.log(`[cache key] ${key.slice(0, 16)}...`)

  await guard.check(userInput)

  // Use response_format with json_schema for OpenAI strict mode.
  const responseFormat = {
    type: 'json_schema' as const,
    json_schema: {
      name: 'review',
      strict: true,
      schema: reviewTool.function.parameters as unknown as Record<string, unknown>,
    },
  }

  const callOnce = (messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>) =>
    retryLLM(
      () => openai.chat.completions.create({
        model: MODEL,
        messages,
        response_format: responseFormat,
        stream: false,
      }),
      {
        maxAttempts: 4,
        onRetry: ({ attempt, reason, delayMs }) =>
          console.warn(`[retry] attempt ${attempt}: ${reason} (waiting ${delayMs}ms)`),
      },
    )

  const baseMessages = [
    { role: 'system' as const, content: 'You are a product reviewer. Respond with the requested JSON only.' },
    { role: 'user'   as const, content: userInput },
  ]

  let res
  try {
    res = await callOnce(baseMessages)
  } catch (err) {
    const e = normalizeError(err)
    console.error(`[error] ${e.kind} (${e.provider ?? 'unknown'}): ${e.message}`)
    return null
  }

  const usage = res.usage as {
    prompt_tokens: number
    completion_tokens: number
    completion_tokens_details?: { reasoning_tokens?: number }
    prompt_tokens_details?:     { cached_tokens?: number }
  }
  const cachedInput = usage.prompt_tokens_details?.cached_tokens ?? 0
  guard.record({
    input:     usage.prompt_tokens - cachedInput,
    output:    usage.completion_tokens,
    reasoning: usage.completion_tokens_details?.reasoning_tokens,
    cacheHit:  cachedInput,
  })

  const rawText = res.choices[0]!.message.content ?? ''

  const result = await structOut({
    raw: rawText,
    schema: ReviewSchema,
    maxRetries: 2,
    repair: async ({ prompt }) => {
      const fix = await callOnce([
        ...baseMessages,
        { role: 'assistant', content: rawText },
        { role: 'user',      content: prompt },
      ])
      const u = fix.usage as typeof usage
      const cached = u.prompt_tokens_details?.cached_tokens ?? 0
      guard.record({
        input:     u.prompt_tokens - cached,
        output:    u.completion_tokens,
        reasoning: u.completion_tokens_details?.reasoning_tokens,
        cacheHit:  cached,
      })
      return fix.choices[0]!.message.content ?? ''
    },
  })

  return result.ok ? result.data : null
}

async function main() {
  const userInput = process.argv.slice(2).join(' ')
    || 'Review the latest VS Code release in one paragraph.'

  console.log(`> ${userInput}\n`)

  const review = await reviewProduct(userInput)
  if (review) {
    console.log('\n--- Review ---')
    console.log(`Title:     ${review.title}`)
    console.log(`Sentiment: ${review.sentiment}`)
    console.log(`Score:     ${review.score}/10`)
    console.log(`Reason:    ${review.reason}`)
  } else {
    console.log('\n(no review produced)')
  }

  const summary = guard.summary()
  console.log('\n--- Cost summary ---')
  console.log(`Calls:           ${summary.calls}`)
  console.log(`Total spent:     $${summary.spent.toFixed(6)}`)
  console.log(`Reasoning spent: $${summary.reasoningSpent.toFixed(6)}`)
  console.log(`Cache savings:   $${summary.cacheSavings.toFixed(6)}`)
  console.log(`Remaining:       $${summary.remaining?.toFixed(6) ?? 'n/a'}`)
}

main().catch(err => {
  console.error('Unhandled error:', err)
  process.exit(1)
})
