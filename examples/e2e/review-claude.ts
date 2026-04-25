/**
 * End-to-end Claude example using llmfort.
 *
 * Flow:
 *   1. tool-schema      — generate a tool envelope for Claude
 *   2. tool-schema.lint — surface Claude-specific schema warnings
 *   3. prompt-safe      — scan user input for injection / PII
 *   4. cost-guard       — enforce a session budget (incl. reasoning + cache)
 *   5. cache-key        — hash the request for local caching
 *   6. retry-llm        — wrap the API call in 429-aware retry
 *   7. error-normalize  — classify any failure into a tagged kind
 *   8. struct-out       — extract + parse + validate Claude's JSON, with
 *                         Claude pre-fill and a repair loop using a second call
 *   9. context-trim     — bound conversation history before the next turn
 *
 * Run with:
 *   ANTHROPIC_API_KEY=sk-ant-... npm run start:claude
 */
import Anthropic from '@anthropic-ai/sdk'
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
  contextTrim,
  type Message,
} from '@the-arj/llmfort'

// ---------- Setup ----------

if (!process.env.ANTHROPIC_API_KEY) {
  console.error('Set ANTHROPIC_API_KEY to run this example.')
  process.exit(1)
}

const MODEL = 'claude-sonnet-4-6'
const claude = new Anthropic()
const guard  = costGuard({ model: MODEL, budget: { session: 1.00, reasoning: 0.50 } })

// ---------- 1. Tool definition (lint and emit Claude envelope) ----------

const reviewToolMeta = {
  name: 'submit_review',
  description: 'Submit a structured review. Score is 0-10, sentiment is positive/neutral/negative.',
  params: {
    title:     { type: 'string'  as const, description: 'Short label for the review' },
    sentiment: { type: 'string'  as const, enum: ['positive', 'neutral', 'negative'], description: 'Overall sentiment' },
    score:     { type: 'integer' as const, minimum: 0, maximum: 10, description: 'Quality 0-10' },
    reason:    { type: 'string'  as const, description: 'One-sentence justification' },
  },
}

const lint = toolSchema.lint(reviewToolMeta)
if (lint.warnings.length > 0) {
  console.warn(
    `[llmfort] schema lint: ${lint.byProvider.anthropic.length} Anthropic, `
    + `${lint.byProvider.openai.length} OpenAI, ${lint.byProvider.gemini.length} Gemini warnings`,
  )
}

const reviewTool = toolSchema(reviewToolMeta, 'anthropic')

// ---------- 2. Schema for output validation ----------

const ReviewSchema = z.object({
  title:     z.string().min(1),
  sentiment: z.enum(['positive', 'neutral', 'negative']),
  score:     z.number().int().min(0).max(10),
  reason:    z.string().min(1),
})

// ---------- 3. The reusable request function ----------

interface ClaudeUsage {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
}

async function callClaude(
  systemPrompt: string,
  history: Message[],
  options: { prefill?: string; tools?: typeof reviewTool[] } = {},
): Promise<{ text: string; usage: ClaudeUsage }> {
  // Build messages array. Claude wants user/assistant turns; system is a top-level field.
  const messages = history
    .filter(m => m.role !== 'system')
    .map(m => ({
      role: m.role as 'user' | 'assistant',
      content: typeof m.content === 'string' ? m.content : (m.content ?? ''),
    }))

  if (options.prefill) {
    messages.push({ role: 'assistant', content: options.prefill })
  }

  const res = await claude.messages.create({
    model: MODEL,
    max_tokens: 1024,
    system: systemPrompt,
    messages: messages as any,
    ...(options.tools ? { tools: options.tools as any } : {}),
  })

  const textBlock = res.content.find((b: any) => b.type === 'text')
  return {
    text: textBlock ? (textBlock as any).text : '',
    usage: res.usage as ClaudeUsage,
  }
}

// ---------- 4. The full pipeline ----------

async function reviewProduct(userInput: string): Promise<z.infer<typeof ReviewSchema> | null> {
  // 4a. Scan the user input.
  try {
    promptSafe.assert(userInput)
  } catch (err) {
    if (err instanceof PromptViolationError) {
      console.error(`Refused: ${err.violations.map(v => v.label).join(', ')}`)
      return null
    }
    throw err
  }

  // 4b. Compute a cache key. In a real app you'd check Redis / SQLite first.
  const key = await cacheKey({
    model: MODEL,
    system: 'You are a product reviewer.',
    messages: [{ role: 'user', content: userInput }],
    tools: [reviewTool as unknown as Record<string, unknown>],
  })
  console.log(`[cache key] ${key.slice(0, 16)}...`)

  // 4c. Pre-call budget check.
  await guard.check(userInput)

  // 4d. Build the conversation history. We're going to ask Claude to return JSON
  // matching the tool's input_schema. Pre-fill `{` to suppress preamble.
  const systemPrompt = [
    'You are a product reviewer. Respond ONLY with a JSON object matching this shape:',
    JSON.stringify(reviewTool.input_schema, null, 2),
    'Do not wrap in markdown. Do not add commentary.',
  ].join('\n')

  const history: Message[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user',   content: userInput, id: 'turn-1' },
  ]

  // 4e. Call Claude with retry. The reattach helper re-prepends the pre-fill.
  const pf = structOut.prefillForClaude()

  const callOnce = (h: Message[]) => retryLLM(
    () => callClaude(systemPrompt, h, { prefill: pf.prefill }),
    {
      maxAttempts: 4,
      onRetry: ({ attempt, reason, delayMs }) =>
        console.warn(`[retry] attempt ${attempt}: ${reason} (waiting ${delayMs}ms)`),
    },
  )

  let res: Awaited<ReturnType<typeof callOnce>>
  try {
    res = await callOnce(history)
  } catch (err) {
    const e = normalizeError(err)
    console.error(`[error] ${e.kind} (${e.provider ?? 'unknown'}): ${e.message}`)
    return null
  }

  guard.record({
    input:      res.usage.input_tokens,
    output:     res.usage.output_tokens,
    cacheHit:   res.usage.cache_read_input_tokens,
    cacheWrite: res.usage.cache_creation_input_tokens,
  })

  // 4f. Structure + repair the output.
  const result = await structOut({
    raw: pf.reattach(res.text),
    schema: ReviewSchema,
    maxRetries: 2,
    repair: async ({ prompt }) => {
      // Repair turn: ask Claude to fix its previous response. Pre-fill again.
      const repairHistory: Message[] = [
        ...history,
        { role: 'assistant', content: res.text },
        { role: 'user',      content: prompt },
      ]
      const fix = await callOnce(repairHistory)
      guard.record({
        input:      fix.usage.input_tokens,
        output:     fix.usage.output_tokens,
        cacheHit:   fix.usage.cache_read_input_tokens,
        cacheWrite: fix.usage.cache_creation_input_tokens,
      })
      return pf.reattach(fix.text)
    },
    onAttempt: ({ attempt, kind, stage }) =>
      console.log(`[struct-out] attempt=${attempt} kind=${kind} stage=${stage}`),
  })

  // 4g. Trim history before the next turn (would normally feed into a chat loop).
  const trimmed = await contextTrim(
    [...history, { role: 'assistant', content: res.text }],
    {
      model: MODEL,
      maxTokens: 50_000,
      keepLastTurns: 4,
      cacheBreakpoints: ['turn-1'],
    },
  )
  console.log(`[trim] ${trimmed.tokensBefore} → ${trimmed.tokensAfter} tokens (removed ${trimmed.removed})`)

  return result.ok ? result.data : null
}

// ---------- 5. Run ----------

async function main() {
  const userInput = process.argv.slice(2).join(' ')
    || 'Review the iPhone 17 Pro Max camera in one paragraph.'

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
