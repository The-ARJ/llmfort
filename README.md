# @the-arj/llmfort

Helpers for the boring-but-important code around every LLM API call.

When you build an app that talks to GPT, Claude, or Gemini, you keep writing the same things over and over:

- Defining the same tool/function-calling schema in three slightly different shapes for three providers
- Catching prompt-injection attempts and PII before they hit the API
- Parsing JSON out of an LLM response that wrapped it in markdown fences and added a preamble
- Retrying a 429 with the right backoff
- Trimming a long conversation so it fits in the context window without dropping the system prompt
- Tracking cost per call and refusing to keep going past a budget

This package gives you small, focused functions for each of those, with zero runtime dependencies. You keep using the OpenAI / Anthropic / Google SDKs you already use; this just wraps the rough edges.

```sh
npm install @the-arj/llmfort
```

Node 18+. Works in ESM and CommonJS. Full TypeScript types.

---

## A real example

Take user input, scan it for PII and prompt injection, enforce a $1 budget per session, call Claude, and turn its response into a typed object:

```ts
import Anthropic from '@anthropic-ai/sdk'
import { z } from 'zod'
import { promptSafe, costGuard, structOut } from '@the-arj/llmfort'

const claude = new Anthropic()
const guard  = costGuard({ model: 'claude-sonnet-4-6', budget: { session: 1.00 } })

const Review = z.object({
  title:  z.string(),
  score:  z.number().min(0).max(10),
  reason: z.string(),
})

async function review(userInput: string) {
  promptSafe.assert(userInput)               // throws if injection / PII detected
  await guard.check(userInput)               // throws if over budget

  const res = await claude.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    messages: [{ role: 'user', content: `${userInput}\nReply with JSON: {title, score, reason}` }],
  })

  guard.record({ input: res.usage.input_tokens, output: res.usage.output_tokens })

  const parsed = structOut.parseSafe(
    (res.content[0] as { text: string }).text,
    Review,
  )
  return parsed.ok ? parsed.data : null
}
```

Three lines added to a normal Anthropic call get you input safety, cost enforcement, and validated output.

---

## What's in the box

Pick the one or two helpers that solve a problem you have. They're independent — you don't need to use any others.

| Helper | What it does | Subpath import |
|---|---|---|
| `promptSafe` | Scan input for prompt injection, jailbreak, and PII | `@the-arj/llmfort/prompt-safe` |
| `structOut` | Parse + validate JSON out of an LLM response | `@the-arj/llmfort/struct-out` |
| `costGuard` | Enforce per-call and session USD budgets | `@the-arj/llmfort/cost-guard` |
| `contextTrim` | Trim long conversations to fit a token budget | `@the-arj/llmfort/context-trim` |
| `toolSchema` | One tool definition → OpenAI / Anthropic / Gemini envelopes | `@the-arj/llmfort/tool-schema` |
| `retryLLM` | Provider-aware 429 / 5xx retry with backoff | `@the-arj/llmfort/retry-llm` |
| `normalizeError` | Provider errors → tagged union you can `switch` on | `@the-arj/llmfort/error-normalize` |
| `cacheKey` | Stable hash of a chat request, for your own cache | `@the-arj/llmfort/cache-key` |
| `toolCallAccumulator` | Assemble streamed tool-call deltas into completed calls | `@the-arj/llmfort/stream-tools` |

```ts
// Import everything from the root:
import { promptSafe, costGuard, structOut } from '@the-arj/llmfort'

// Or just the one you need (smaller bundle):
import { promptSafe } from '@the-arj/llmfort/prompt-safe'
```

---

## Common recipes

### Refuse user input that looks like an attack

```ts
import { promptSafe, PromptViolationError } from '@the-arj/llmfort'

try {
  promptSafe.assert(userInput)
} catch (err) {
  if (err instanceof PromptViolationError) {
    return 'Your message was blocked by safety checks.'
  }
  throw err
}
```

You can also call it without throwing and inspect the result:

```ts
const r = promptSafe(userInput)
if (!r.safe) console.log(r.violations) // [{ type, label, match }]
```

Or redact PII without blocking the request:

```ts
const cleaned = promptSafe.redact(userInput)
// "Email me at [REDACTED_EMAIL] or call [REDACTED_PHONE]"
```

### Parse JSON out of an LLM response

The model wrapped its JSON in a code fence and added a preamble. `structOut` handles that:

```ts
import { structOut } from '@the-arj/llmfort'
import { z } from 'zod'

const Schema = z.object({ city: z.string(), temp: z.number() })

const result = structOut.parseSafe(llmResponseText, Schema)
if (result.ok) {
  console.log(result.data.city, result.data.temp)
}
```

If you want it to ask the model to fix mistakes automatically, pass a `repair` callback:

```ts
const result = await structOut({
  raw: llmResponseText,
  schema: Schema,
  maxRetries: 2,
  repair: async ({ prompt }) => {
    // `prompt` is a fix-it message generated for you. Send it to the model.
    const fix = await claude.messages.create({ /* ... */ messages: [{ role: 'user', content: prompt }] })
    return (fix.content[0] as { text: string }).text
  },
})
```

Schema can be Zod, Valibot, ArkType, an AJV instance, or a plain JSON Schema object — anything with a `.safeParse`, `.parse`, or `.validate` method.

### Stop a runaway loop from blowing your budget

```ts
import { costGuard, CostLimitError } from '@the-arj/llmfort'

const guard = costGuard({
  model: 'gpt-5',
  budget: { perCall: 0.10, session: 5.00 },
})

try {
  await guard.check(prompt)            // throws CostLimitError if the next call would exceed budget
  const res = await openai.chat.completions.create({ /* ... */ })
  guard.record({                       // record real usage from the response
    input:  res.usage.prompt_tokens,
    output: res.usage.completion_tokens,
  })
} catch (err) {
  if (err instanceof CostLimitError) {
    console.log(`stopped: ${err.kind} budget hit ($${err.estimated.toFixed(4)} > $${err.limit.toFixed(4)})`)
  }
}

console.log(guard.summary())
// { calls: 3, spent: 0.42, remaining: 4.58, ... }
```

For Claude or Gemini, swap the field names — `record({ input, output, cacheHit?, cacheWrite?, reasoning? })` accepts everything.

### Keep a long chat under the context window

```ts
import { contextTrim } from '@the-arj/llmfort'

const trimmed = await contextTrim(messages, {
  model: 'gpt-5',
  maxTokens: 100_000,    // your budget for history; leave room for the reply
  keepLastTurns: 4,      // last 4 turns always survive
})

await openai.chat.completions.create({
  model: 'gpt-5',
  messages: trimmed.messages,
})
```

The trimmer never breaks a tool_call from its result, never drops the system prompt, and you can pin specific messages with `pinned: true`.

### Generate a tool definition for any provider

Write it once, get the right envelope per provider:

```ts
import { toolSchema } from '@the-arj/llmfort'

const meta = {
  name: 'get_weather',
  description: 'Get weather for a city',
  params: {
    city:  { type: 'string', description: 'City name' },
    units: { type: 'string', enum: ['c', 'f'], required: false },
  },
}

const openaiTool    = toolSchema(meta, 'openai')      // { type: 'function', function: {...} }
const anthropicTool = toolSchema(meta, 'anthropic')   // { name, description, input_schema }
const geminiTool    = toolSchema(meta, 'gemini')      // { functionDeclarations: [...] }
```

Schemas are emitted in the exact strict-mode-compatible shape each provider expects — including OpenAI's "every property in `required`, optionals widened with null" rule.

### Retry a flaky API call

```ts
import { retryLLM } from '@the-arj/llmfort'

const res = await retryLLM(
  () => openai.chat.completions.create({ /* ... */ }),
  { maxAttempts: 4 },
)
```

Retries 429, 5xx, network errors. Reads OpenAI / Anthropic / Gemini `Retry-After` headers. Never retries 400 / 401 / 403 / content-filter — those won't succeed on retry.

---

## Module reference

Each module's full options are documented inline in its `.d.ts` file (your IDE will autocomplete them). Below is a quick lookup.

### `promptSafe(text, options?)`

Returns `{ safe: boolean, violations: Violation[] }`.

Options: `{ injection?: boolean, jailbreak?: boolean, pii?: boolean }` (all default `true`).

Static methods:
- `promptSafe.redact(text)` — replaces detected PII with `[REDACTED_*]` tokens.
- `promptSafe.assert(text, options?)` — throws `PromptViolationError` if unsafe.
- `promptSafe.scanToolResult(text)` / `.scanRetrievedDoc(text)` — different pattern set tuned for content coming from tool calls or RAG retrieval (indirect-injection patterns).

### `structOut(options)`

Async pipeline with a repair loop.

```ts
structOut({
  raw: string,
  schema: Validator,
  maxRetries?: number,             // default 2
  partial?: 'throw' | 'null' | 'return',
  repair?: (ctx) => Promise<string>,
  signal?: AbortSignal,
  onAttempt?: (info) => void,
})
```

Sync helpers (no network, no callback):
- `structOut.parseSafe(raw, schema)` — full pipeline minus repair.
- `structOut.extract(raw)` — just the JSON-extraction step.
- `structOut.parse(raw)` — extract + lenient parse.
- `structOut.validate(value, schema)` — validate-only.

Claude pre-fill helper for the most reliable JSON output on Anthropic:
- `structOut.prefillForClaude({ kind?: 'object' | 'array' })` — returns `{ prefill, message, reattach }`.
- `structOut.parsePrefilledClaude(rawResponse, schema)` — one-shot version.

### `costGuard(options)`

```ts
costGuard({
  model: string,
  budget?: { perCall?: number, session?: number, reasoning?: number },
  assumedOutputTokens?: number,    // default 256
  assumedReasoningTokens?: number, // default 0
})
```

Methods:
- `await guard.check(prompt)` — throws `CostLimitError` if over budget.
- `guard.estimate(prompt)` — same calculation, no enforcement.
- `guard.record(usage)` — `{ input, output, reasoning?, cacheHit?, cacheWrite? }` or legacy positional `(input, output)`.
- `guard.summary()` — `{ calls, spent, remaining, reasoningSpent, cacheSavings, ... }`.

Models with built-in pricing: GPT-5 family, GPT-4.1 family, o3 / o3-pro / o3-mini / o4-mini, GPT-4o-mini / GPT-4-turbo / GPT-4 / GPT-3.5-turbo, Claude 4.x and 3.5, Gemini 3 / 2.5 / 1.5. Unknown models fall back to a conservative estimate.

### `contextTrim(messages, options)`

```ts
contextTrim(messages, {
  maxTokens: number,
  model?: string,
  strategy?: 'sliding' | 'importance' | 'summary',
  keepLastTurns?: number,           // default 4
  keepSystem?: boolean,             // default true
  cacheBreakpoints?: string[],      // message IDs anchoring cached prefixes
  summarize?: (msgs) => Promise<string>,  // required for strategy: 'summary'
})
```

Returns `{ messages, removed, tokensBefore, tokensAfter, trimmed, overflow }`.

Helpers: `contextTrim.count`, `contextTrim.countMessage`, `contextTrim.dryRun`, `contextTrim.score`.

### `toolSchema(meta, provider?)`

```ts
toolSchema(meta, 'openai' | 'anthropic' | 'gemini' | 'generic')
```

Helpers:
- `toolSchemaAll(meta)` — returns all four envelopes in one object.
- `toolSchema.lint(meta)` — warns about provider-specific quirks (Anthropic strips `pattern`, Gemini rejects nesting > 5, etc.).
- `toolSchema.lintUnknown(meta)` — catches misspelled JSON-Schema keywords.

### `retryLLM(fn, options?)`

```ts
retryLLM(fn, {
  maxAttempts?: number,            // default 4
  baseDelayMs?: number,            // default 500
  maxDelayMs?: number,             // default 30000
  jitter?: 'full' | 'equal' | 'none',
  signal?: AbortSignal,
  onRetry?: (info) => void,
  shouldRetry?: (err, attempt) => boolean | undefined,
})
```

Throws `RetryExhaustedError` after the last attempt fails.

Helpers: `classifyError(err)`, `retryDelayFromError(err)`.

### `normalizeError(err)`

Returns `{ kind, message, status?, provider?, retryable, raw }`.

`kind` is one of: `'rate_limited' | 'context_overflow' | 'content_filtered' | 'schema_invalid' | 'auth' | 'billing' | 'bad_request' | 'server_error' | 'network' | 'transient' | 'aborted' | 'unknown'`.

Helper: `isRetryable(err)`.

### `cacheKey(input)` / `cacheKeySync(input)`

```ts
cacheKey({
  model: string,
  messages?: unknown[],
  system?: string,
  tools?: unknown[],
  response_format?: unknown,
  params?: Record<string, unknown>,
  namespace?: string,
})
```

Async returns a SHA-256 hex (64 chars). Sync returns FNV-1a (16 chars, non-cryptographic). Both produce the same value for the same input regardless of object-key order, tool ordering, or whitespace drift.

Debug helper: `cacheKeyCanonical(input)` — returns the canonical string before hashing.

### `toolCallAccumulator(provider)`

```ts
const acc = toolCallAccumulator('openai' | 'anthropic')

for await (const chunk of stream) {
  for (const call of acc.push(chunk)) handle(call)
}
for (const call of acc.flush()) handle(call)   // always flush at end of stream
```

`call` is `{ id, name, arguments, argumentsRaw, index? }`.

---

## What this package isn't

To stay small and useful, llmfort deliberately doesn't try to be:

- **A provider SDK** — keep using `openai`, `@anthropic-ai/sdk`, `@google/generative-ai` directly.
- **An agent framework** — no planner, no executor, no tool-loop runner. You write the loop.
- **A RAG library** — no embeddings, no vector store, no chunking.
- **A prompt-template DSL** — tagged templates and string concatenation are fine.
- **An exact tokenizer** — uses a chars-per-token heuristic (~10–15% off vs real tokenization). For exact counts, plug in `tiktoken` and pass the number into `calcCost` directly.
- **A telemetry / eval product** — no metrics export, no LLM-as-judge.

If a request feels like it would push the package toward any of those, it'll be declined.

---

## License

MIT © [The-ARJ](https://github.com/The-ARJ)
