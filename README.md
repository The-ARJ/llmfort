# @the-arj/llmfort

> Fortify your LLM calls. Zero-dependency Node.js toolkit for **GPT**, **Claude**, and **Gemini** — tool schemas, prompt-injection + PII scanning, structured JSON with repair, conversation trimming, cost/budget guardrails, 429 retry, error normalization, cache-key stability, and streaming tool-call accumulation.

Nine focused modules. Zero runtime dependencies. Full TypeScript types. ESM + CJS.
Built for the April 2026 model landscape: **GPT-5 / 5-mini / 5-nano**, **GPT-4.1**, **o3 / o4-mini**, **Claude Opus 4.7 / Sonnet 4.6 / Haiku 4.5**, **Gemini 3 Pro / Flash**.

`llmfort` sits between your app code and whichever LLM SDK you use. It won't stream, it won't route, it won't call APIs for you — it fortifies the surfaces provider SDKs leave exposed.

```ts
// Root import (convenient)
import {
  toolSchema, promptSafe, structOut, contextTrim, costGuard,
  retryLLM, normalizeError, cacheKey, toolCallAccumulator,
} from '@the-arj/llmfort'

// Or import the one module you need (smaller bundle)
import { toolSchema }          from '@the-arj/llmfort/tool-schema'
import { promptSafe }          from '@the-arj/llmfort/prompt-safe'
import { structOut }           from '@the-arj/llmfort/struct-out'
import { contextTrim }         from '@the-arj/llmfort/context-trim'
import { costGuard }           from '@the-arj/llmfort/cost-guard'
import { retryLLM }            from '@the-arj/llmfort/retry-llm'
import { normalizeError }      from '@the-arj/llmfort/error-normalize'
import { cacheKey }            from '@the-arj/llmfort/cache-key'
import { toolCallAccumulator } from '@the-arj/llmfort/stream-tools'
```

---

## Install

```sh
npm install @the-arj/llmfort
```

Requires **Node.js ≥ 18**. Works from both ESM and CJS.

---

## Why this exists

| You want | Existing option | Gap this fills |
|---|---|---|
| One tool definition that works on OpenAI, Anthropic, Gemini | `zod-to-json-schema`, `ai` SDK, provider SDKs | Each SDK emits only its own format. This package emits all three envelopes from a single metadata object, with `additionalProperties: false` for strict-mode compatibility. |
| Block prompt injection / PII before it reaches the model | Python's `llm-guard` / `presidio` | Pure-JS, offline, zero-dep, multilingual. No HTTP, no telemetry, no account. |
| Turn a noisy LLM response into a validated, typed object | Hand-rolled JSON.parse + Zod + retry loop in every project | Extraction, lenient parse, truncation repair, validation, and a surgical repair prompt loop — with any validator (Zod, Valibot, ArkType, AJV, plain JSON Schema). |
| Keep a long conversation under the model's context limit without breaking it | Naive `messages.slice(-20)`, hand-rolled summarization | Turn-aware trimming that preserves system prompts, pinned messages, tool_call/tool_result pairs, and your last N turns. Three strategies: sliding, importance-scored, or LLM-summarized. |
| Hard stop if a call would blow the budget, **including hidden reasoning tokens** | `tiktoken`, `gpt-tokenizer`, `llm-cost` | Those count tokens. This **enforces** per-call, session, and reasoning budgets with a typed error; understands prompt-caching economics (cached-input discount, Anthropic cache-write premium); tracks real spend after each call. |
| Retry 429 and transient errors correctly across three providers | Hand-rolled `setTimeout` loops | Reads OpenAI `x-ratelimit-reset-*`, Anthropic `retry-after`, Gemini `RetryInfo` — falls back to exponential backoff with jitter. Never retries on 400/401/403/content-filter. |
| Know whether a provider error is "safe to retry", "billing", "content filter", or "context overflow" | `if (err.status === 429 \|\| err.error?.type === 'rate_limit_error' \|\| ...)` in every project | Tagged-union `NormalizedError` across OpenAI + Anthropic + Gemini. |
| Build a stable prompt-cache key (byte-stable across tool reorderings, JSON-key reorderings, whitespace drift) | Hand-rolled hashing of `JSON.stringify(messages)` | A canonical serializer + SHA-256 that won't silently break your Anthropic `cache_control` hit rate. |
| Accumulate streamed tool-call JSON-argument deltas (OpenAI + Anthropic) | Custom state machine per app | One `toolCallAccumulator(provider)` that yields completed tool calls. |

---

## Modules

### `tool-schema` — Generate LLM function-calling schemas

Describe your tool once, get the exact shape each provider expects.

```ts
import { toolSchema, toolSchemaAll } from '@the-arj/llmfort/tool-schema'

const schema = toolSchema({
  name: 'get_weather',
  description: 'Get current weather for a city',
  params: {
    city: { type: 'string', description: 'City name' },
    unit: { type: 'string', enum: ['C', 'F'], required: false },
  },
}, 'openai')
// → { type: 'function', function: { name, description, parameters: { ..., additionalProperties: false } } }

// Same tool, every provider at once:
const { openai, anthropic, gemini, generic } = toolSchemaAll(meta)
```

Every output includes `additionalProperties: false` on the generated object schema — required for OpenAI **strict-mode** function calling and Gemini **structured outputs**, and recommended for Anthropic tool use.

| Provider key | Model family | Output shape |
|---|---|---|
| `'openai'` | GPT-5, GPT-4.1, o3, o4-mini | `{ type: 'function', function: { name, description, parameters } }` |
| `'anthropic'` | Claude Opus 4.7, Sonnet 4.6, Haiku 4.5 | `{ name, description, input_schema }` |
| `'gemini'` | Gemini 3 Pro, Gemini 2.5 Flash | `{ functionDeclarations: [{ name, description, parameters }] }` |
| `'generic'` | DeepSeek, Llama, Mistral, custom | `{ name, description, parameters }` |

**ParamMeta fields:** `type`, `description`, `enum`, `required` (default `true`), `items`, `minimum`, `maximum`, `default`.

---

### `prompt-safe` — Prompt injection, jailbreak, and PII detection

Runs **client-side before any API call**. No network requests, no telemetry. Works with any LLM.

```ts
import { promptSafe, PromptViolationError } from '@the-arj/llmfort/prompt-safe'

// Scan and inspect violations
const result = promptSafe(userInput)
// { safe: false, violations: [{ type: 'injection', label: 'ignore_instructions', match: '...' }] }

// Redact PII in-place (emails, phones, SSNs, API keys, JWTs, ...)
const clean = promptSafe.redact(userInput)
// "Contact [REDACTED_EMAIL] or call [REDACTED_PHONE]"

// Throw on any violation — drop into middleware
promptSafe.assert(userInput) // throws PromptViolationError if unsafe

// Disable categories you don't need
promptSafe(text, { injection: true, jailbreak: false, pii: true })
```

**Detection coverage**

| Category | Patterns |
|---|---|
| **Injection** (English + zh/es/fr/de/ru/ja/ko/ar) | `ignore previous instructions`, `system: you are`, prompt leak, translate-leak, chat-template token injection (`<\|im_start\|>`, `[INST]`), unicode direction override + zero-width smuggling, indirect-injection markers, markdown-image exfiltration |
| **Jailbreak** | DAN, "do anything now", developer/god mode, base64 payloads, opposite/evil mode, persona exploits (grandma, deceased, etc.), simulation framing, repeat-N-times token overflow, educational/hypothetical harmful framing |
| **PII** | Email, US phone (requires formatting — won't false-positive on order numbers), SSN, credit card (**Luhn-validated**), IPv4, passport (requires context word), API keys (OpenAI `sk-proj-`/`sk-ant-`, Google `AIza`, AWS `AKIA`, GitHub `ghp_`, Slack `xoxb-/xoxp-`), JWT |

Notable hardening vs. naive regex scanners:

- **Luhn validation** on credit-card matches — random 16-digit order numbers don't trigger.
- **Phone numbers require formatting** (dashes, dots, spaces, parens, or `+1`) — bare 10-digit integers like invoice IDs don't trigger.
- **Passport matches require context** (`passport`, `travel document`, `MRZ` within 40 chars) — product SKUs don't trigger.
- **Multilingual injection patterns** for Chinese, Spanish, French, German, Russian, Japanese, Korean, Arabic — the single most common bypass in 2025-2026 research.

---

### `struct-out` — Reliable structured JSON from any LLM

Most "just ask the model for JSON" calls fail 2–15% of the time in production: markdown fences around the object, extra fields the schema didn't ask for, a string where a number should be, truncation mid-brace, prose instead of JSON. `struct-out` handles every one of those without you writing the same brittle extractor–parser–validator–retry loop in every project.

```ts
import { structOut } from '@the-arj/llmfort/struct-out'
import { z } from 'zod'  // or Valibot, ArkType, AJV, or a plain JSON Schema object

const Review = z.object({
  title:  z.string(),
  score:  z.number().min(0).max(10),
  reason: z.string(),
})

const result = await structOut({
  raw: llmResponseString,   // whatever came back from the model
  schema: Review,
  repair: async ({ prompt }) => {
    // Your LLM call — llmfort just hands you the surgical fix prompt.
    const { content } = await openai.chat.completions.create({
      model: 'gpt-5',
      messages: [{ role: 'user', content: prompt }],
    })
    return content
  },
  maxRetries: 2,
})

if (result.ok) {
  console.log(result.data.title, result.data.score)
} else {
  console.error(result.error.kind, result.error.validationError)
}
```

**Pipeline** — every stage is a pure function you can use on its own:

1. **Extract** — finds JSON whether it's in ` ```json ` fences, `<json>` tags, after a preamble, as one of several blocks, or bare. Ranks candidates, picks the most likely.
2. **Parse** — strict `JSON.parse` first; falls back to lenient pass that recovers from trailing commas, single quotes, `//` / `/* */` comments, smart quotes, unquoted keys. If the string looks truncated, closes open brackets in correct nesting order.
3. **Validate** — duck-typed adapter. Works with anything that has `.safeParse()` (Zod, Valibot), `.parse()` (ArkType), `.validate()` (AJV), or a plain JSON Schema object.
4. **Repair** — if validation fails, builds a surgical fix prompt (*"field `score`: expected number 0–10, got string 'high'"*) and calls your `repair` callback. Retries up to `maxRetries`.
5. **Fallback** — `partial: 'return'` salvages fields that validated; `'null'` returns null; `'throw'` (default) throws `StructOutError` with full attempt history.

**Sync helpers** (no network, no callback):

```ts
structOut.extract(raw)                     // string | null — just the extraction
structOut.parse(raw)                        // unknown — extract + lenient parse
structOut.validate(obj, schema)             // ValidationResult — validate an object you already have
structOut.parseSafe(raw, schema)            // full sync pipeline, no repair. Returns { ok, data/error }
```

**Works with any validator you already have:**

```ts
// Zod (safeParse)
const schema = z.object({ title: z.string(), score: z.number() })

// ArkType (throw-style parse)
const schema = type({ title: 'string', score: 'number' })

// AJV (validate + errors)
const schema = { validate: ajv.compile({ type: 'object', ... }), errors: null }

// Plain JSON Schema — zero dependencies
const schema = {
  type: 'object',
  required: ['title', 'score'],
  additionalProperties: false,
  properties: {
    title: { type: 'string' },
    score: { type: 'number', minimum: 0, maximum: 10 },
  },
}
```

The built-in JSON Schema checker covers what LLMs actually emit (`type`, `required`, `properties`, `items`, `enum`, `minimum`/`maximum`, `additionalProperties`). For full JSON Schema support, pass an AJV instance.

---

### `context-trim` — Keep conversations alive without losing what matters

As a chat grows, it approaches the model's context limit. Naive solutions — `messages.slice(-20)`, or a summarization call on every turn — either lose what the user set up at the start, or bleed money with every message. `context-trim` is turn-aware: it never splits a user/assistant pair, never orphans a tool result, and lets you keep the early-conversation constraints that the user stated once and expects to be remembered.

```ts
import { contextTrim } from '@the-arj/llmfort/context-trim'

const trimmed = await contextTrim(messages, {
  model: 'gpt-5',               // for per-model token-overhead accounting
  maxTokens: 100_000,           // your budget for history (leave room for reply!)
  strategy: 'sliding',          // 'sliding' | 'importance' | 'summary'
  keepLastTurns: 4,             // last N user/assistant turns always survive
})

await openai.chat.completions.create({
  model: 'gpt-5',
  messages: trimmed.messages,   // ready to send
})
```

**Three strategies**, pick the one that fits your app:

- **`sliding`** (default) — drop oldest turns first. Predictable. Right for most chatbots.
- **`importance`** — drop lowest-score turns first. Keeps questions, constraints, corrections over acknowledgments. Right when the early parts of a conversation carry the real signal.
- **`summary`** — invoke *your* callback to summarize the dropped block into a single message. No LLM-calling magic — you control the cost and the model.

```ts
// Strategy: summary — you own the LLM call
const trimmed = await contextTrim(messages, {
  maxTokens: 50_000,
  strategy: 'summary',
  keepLastTurns: 2,
  summarize: async (toSummarize) => {
    const res = await openai.chat.completions.create({
      model: 'gpt-5-nano',   // cheap model is fine here
      messages: [
        { role: 'system', content: 'Summarize these messages in 3 sentences.' },
        ...toSummarize,
      ],
    })
    return res.choices[0].message.content!
  },
})
```

**Hard rules — enforced across every strategy:**

- **System messages are never trimmed** (unless `keepSystem: false`).
- **Last `keepLastTurns` are always preserved** (default 4).
- **`pinned: true` messages survive any trim** — mark the user's initial constraints and they stick.
- **Tool-call / tool-result pairs stay atomic.** If a trim would orphan a tool result, we expand the removal to include its parent assistant call. If a tool result has no matching call in the history (broken state), it's dropped first.
- **Turn boundaries are never split.** An assistant reply is never separated from its user message.

**Token counting accounts for per-message overhead** — OpenAI adds ~4 tokens per message for role wrapping; Anthropic and Gemini have their own constants. Most naive counters miss this and systematically underestimate by 3-10%.

```ts
contextTrim.count(messages, 'gpt-5')      // total tokens incl. overhead
contextTrim.countMessage(msg, 'gpt-5')    // single message
contextTrim.dryRun(messages, opts)        // { wouldTrim, tokensBefore, overBudgetBy }
contextTrim.score(msg)                    // 0..10 importance score
```

---

### `cost-guard` — Pre-call cost estimation, budget enforcement, reasoning-token aware

```ts
import { costGuard, CostLimitError } from '@the-arj/llmfort/cost-guard'

const guard = costGuard({
  model: 'claude-opus-4-7',
  budget: {
    perCall:   0.05,  // max $0.05 per request
    session:   2.00,  // max $2.00 for this guard's lifetime
    reasoning: 0.50,  // max $0.50 spent on reasoning/thinking tokens
  },
})

// Before each call — throws CostLimitError if over budget (perCall | session | reasoning):
await guard.check(prompt)

// After the call, record real usage. Pass the usage object straight from the API:
guard.record({
  // Claude: res.usage.{input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens}
  input:      res.usage.input_tokens,
  output:     res.usage.output_tokens,
  cacheHit:   res.usage.cache_read_input_tokens,
  cacheWrite: res.usage.cache_creation_input_tokens,
})

// OpenAI: res.usage.{prompt_tokens, completion_tokens, completion_tokens_details.reasoning_tokens, prompt_tokens_details.cached_tokens}
guard.record({
  input:     res.usage.prompt_tokens - (res.usage.prompt_tokens_details?.cached_tokens ?? 0),
  output:    res.usage.completion_tokens,
  reasoning: res.usage.completion_tokens_details?.reasoning_tokens,
  cacheHit:  res.usage.prompt_tokens_details?.cached_tokens,
})

console.log(guard.summary())
// {
//   calls: 3, spent: 0.42, remaining: 1.58,
//   totalInputTokens: 48000, totalOutputTokens: 12000,
//   totalReasoningTokens: 45000, reasoningSpent: 0.36, reasoningRemaining: 0.14,
//   totalCacheHitTokens: 20000, totalCacheWriteTokens: 5000, cacheSavings: 0.09,
//   ...
// }
```

**What's new vs. naive token counters:**

- **Reasoning tokens are separately metered.** GPT-5 `reasoning_effort: high` and Claude 4.6+ adaptive thinking can be **5-10× the visible output**. A session budget without reasoning accounting is off by an order of magnitude.
- **Prompt-cache economics.** Anthropic charges 1.25× for 5-minute cache writes and 0.1× for cache hits. OpenAI discounts cached input by ~50%. `record()` accepts `cacheHit` / `cacheWrite` so your estimates match your bill.
- **No session poisoning.** `record()` throws on NaN/Infinity/negative inputs before mutating totals — one bad value can't silently disable budget enforcement.

**Supported models (verified April 2026):**

| Family | Models |
|---|---|
| **OpenAI GPT-5 / GPT-4.1** | `gpt-5`, `gpt-5-mini`, `gpt-5-nano`, `gpt-4.1`, `gpt-4.1-mini`, `gpt-4.1-nano` |
| **OpenAI reasoning** | `o3`, `o3-pro`, `o3-mini`, `o4-mini` |
| **OpenAI legacy** | `gpt-4o-mini`, `gpt-4-turbo`, `gpt-4`, `gpt-3.5-turbo` |
| **Claude 4.x** | `claude-opus-4-7`, `claude-opus-4-6`, `claude-sonnet-4-6`, `claude-sonnet-4-5`, `claude-haiku-4-5` |
| **Claude 3.5** | `claude-3-5-sonnet-20241022`, `claude-3-5-haiku-20241022`, `claude-3-opus-20240229` |
| **Gemini 3 / 2.5** | `gemini-3-pro`, `gemini-3-flash`, `gemini-2.5-pro`, `gemini-2.5-flash`, `gemini-2.5-flash-lite` |
| **Gemini 1.5** | `gemini-1.5-pro`, `gemini-1.5-flash` |

Other providers (Llama, DeepSeek, Mistral, etc.) get a conservative fallback. Bring your own rate via `calcCost(usage, _, customPrice)` if you need exact numbers for them — llmfort is a sidecar, not a pricing registry.

Token estimation is model-aware: Claude uses a denser 3.5 chars/token heuristic; CJK-heavy text is clamped to 1.5 chars/token. For exact counts, bring your own tokenizer (`tiktoken`, `@anthropic-ai/tokenizer`, Gemini `countTokens`) and pass the number into `calcCost()` directly.

---

### `retry-llm` — 429 + transient-error retry with provider-aware backoff

```ts
import { retryLLM } from '@the-arj/llmfort/retry-llm'

const res = await retryLLM(
  () => openai.chat.completions.create({ model: 'gpt-5', messages }),
  { maxAttempts: 5, baseDelayMs: 500 },
)
```

Reads OpenAI `x-ratelimit-reset-*`, Anthropic `retry-after`, Gemini `RetryInfo` — falls back to exponential backoff with jitter. **Never retries** 400 / 401 / 403 / content-filter errors (those won't succeed on retry). Classifies 429 / 5xx / ECONNRESET / overloaded / RESOURCE_EXHAUSTED automatically.

```ts
await retryLLM(fn, {
  maxAttempts: 4,
  baseDelayMs: 500,
  maxDelayMs:  30_000,
  jitter:      'equal',          // 'full' | 'equal' | 'none'
  signal:      abortController.signal,
  onRetry:     ({ attempt, reason, delayMs }) => log.warn({ attempt, reason, delayMs }),
  shouldRetry: (err, attempt) => /* optional override */ undefined,
})
```

---

### `error-normalize` — One tagged union across OpenAI, Anthropic, and Gemini errors

Every provider throws a different shape. Normalize once, handle once.

```ts
import { normalizeError, isRetryable } from '@the-arj/llmfort/error-normalize'

try {
  await someLLMCall()
} catch (err) {
  const e = normalizeError(err)
  //  e.kind: 'rate_limited' | 'context_overflow' | 'content_filtered' | 'schema_invalid'
  //        | 'auth' | 'billing' | 'bad_request' | 'server_error' | 'network' | 'transient'
  //        | 'aborted' | 'unknown'
  //  e.provider: 'openai' | 'anthropic' | 'gemini' | undefined
  //  e.status, e.message, e.retryable, e.raw

  if (e.kind === 'context_overflow') await trimAndRetry()
  else if (e.kind === 'content_filtered') return userFacingRefusal()
  else if (e.retryable) await retryLLM(...)
  else throw e
}
```

---

### `cache-key` — Stable hash for prompt-caching hit rate

Prompt caching breaks when your cache prefix drifts — a reordered tool list, JSON key reshuffling in `tool_calls[].arguments`, or whitespace normalization differences all invalidate the cache and force a full re-read. `cacheKey()` computes a stable hash that survives all of those.

```ts
import { cacheKey, cacheKeySync } from '@the-arj/llmfort/cache-key'

const key = await cacheKey({
  model: 'claude-opus-4-7',
  system: '   You are helpful.   ',   // whitespace normalized
  messages,                           // content blocks preserved, llmfort-internal fields stripped
  tools: [...],                       // sorted by name
  response_format: { ... },
  params: { temperature: 0.7 },       // JSON keys sorted
  namespace: 'ws_acme',               // workspace/tenant isolation
})
// SHA-256 hex, 64 chars. Use cacheKeySync() for FNV-1a (16 chars, non-cryptographic) if you're not in Node.
```

---

### `stream-tools` — Accumulate streamed tool-call JSON across chunks

OpenAI streams `tool_calls[].function.arguments` as JSON deltas; Anthropic streams `input_json_delta` events. Every team writes the same state machine. This one is ~120 lines, handles parallel calls, malformed JSON fallback, and exposes `.partial()` for UI "streaming tool call" indicators.

```ts
import { toolCallAccumulator } from '@the-arj/llmfort/stream-tools'

const acc = toolCallAccumulator('openai')  // or 'anthropic'
for await (const chunk of stream) {
  const completed = acc.push(chunk)
  for (const call of completed) handleToolCall(call)  // { id, name, arguments, argumentsRaw }
}
for (const call of acc.flush()) handleToolCall(call)  // always flush at end
```

---

## End-to-end example

All four modules working together — scan the input, enforce budget, call the model, structure the output:

```ts
import { promptSafe, costGuard, structOut } from '@the-arj/llmfort'
import Anthropic from '@anthropic-ai/sdk'
import { z } from 'zod'

const Review = z.object({
  title:  z.string(),
  score:  z.number().min(0).max(10),
  reason: z.string(),
})

const guard  = costGuard({ model: 'claude-sonnet-4-6', budget: { session: 1.00 } })
const claude = new Anthropic()

async function reviewRequest(userMessage: string) {
  // 1. Block injection / jailbreak / PII before it reaches Claude
  promptSafe.assert(userMessage)

  // 2. Enforce cost budget before the API call
  await guard.check(userMessage)

  const call = (prompt: string) => claude.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    messages: [{ role: 'user', content: prompt }],
  })

  // 3. Call Claude
  const res = await call(userMessage)
  guard.record({ input: res.usage.input_tokens, output: res.usage.output_tokens })

  // 4. Structure the output, repairing if the model returned malformed JSON.
  const result = await structOut({
    raw: (res.content[0] as { text: string }).text,
    schema: Review,
    repair: async ({ prompt }) => {
      const fix = await call(prompt)
      guard.record(fix.usage.input_tokens, fix.usage.output_tokens)
      return (fix.content[0] as { text: string }).text
    },
    maxRetries: 2,
  })

  return result.ok ? result.data : null
}
```

Swap the SDK and model name — the four layers are identical for GPT-5, Gemini 3, DeepSeek, or any other provider.

---

## API reference

### `toolSchema(meta, provider?)`

| Param | Type | Description |
|---|---|---|
| `meta.name` | `string` | Tool name (default: `'tool'`) |
| `meta.description` | `string` | What the tool does |
| `meta.params` | `Record<string, ParamMeta>` | Parameter definitions |
| `provider` | `'openai' \| 'anthropic' \| 'gemini' \| 'generic'` | Output format (default: `'generic'`) |

### `promptSafe(text, options?)`

| Option | Default | Description |
|---|---|---|
| `injection` | `true` | Detect prompt injection (EN + 7 other languages) |
| `jailbreak` | `true` | Detect jailbreak patterns |
| `pii` | `true` | Detect PII with false-positive guards |

Returns `{ safe: boolean, violations: Violation[] }`.
- `promptSafe.redact(text)` — PII-only redaction (injection/jailbreak text is not removed — removal changes meaning).
- `promptSafe.assert(text, options?)` — throws `PromptViolationError` if unsafe.

### `structOut(options)`

| Option | Type | Description |
|---|---|---|
| `raw` | `string` | The raw LLM response to structure |
| `schema` | `Validator<T>` | Zod, Valibot, ArkType, AJV, or plain JSON Schema object |
| `repair` | `(ctx) => Promise<string>` | Optional callback — called on validation failure with a surgical fix prompt; must return the model's new raw response |
| `maxRetries` | `number` | Max repair iterations (default `2`) |
| `partial` | `'throw' \| 'null' \| 'return'` | Behavior on exhausted retries (default `'throw'`) |
| `signal` | `AbortSignal` | Aborts the repair loop |
| `onAttempt` | `(info) => void` | Observability hook, fires after every attempt |

Returns `StructOutResult<T>`: `{ ok: true, data, attempts }` | `{ ok: false, error, attempts, data?/partial? }`.

Sync helpers: `structOut.extract`, `structOut.parse`, `structOut.validate`, `structOut.parseSafe`.
Errors: `StructOutError` with `.kind` of `'no_json' | 'parse' | 'validation' | 'exhausted' | 'aborted'`.

### `contextTrim(messages, options)`

| Option | Type | Description |
|---|---|---|
| `maxTokens` | `number` | Hard cap on tokens of history to keep |
| `model` | `string` | Model ID (for per-family overhead constants) |
| `strategy` | `'sliding' \| 'importance' \| 'summary'` | Default `'sliding'` |
| `keepLastTurns` | `number` | Last N turns always preserved (default `4`) |
| `keepSystem` | `boolean` | Keep system messages (default `true`) |
| `summarize` | `(msgs) => Promise<string>` | Required for `strategy: 'summary'` |
| `summaryRole` | `'system' \| 'user'` | Where the summary goes (default `'system'`) |
| `score` | `(msg) => number` | Custom scorer for `strategy: 'importance'` |

Returns `TrimResult`: `{ messages, removed, tokensBefore, tokensAfter, trimmed, strategy, overflow }`.
Sync helpers: `contextTrim.count`, `contextTrim.countMessage`, `contextTrim.dryRun`, `contextTrim.score`.

### `costGuard(options)`

| Option | Type | Description |
|---|---|---|
| `model` | `string` | Model ID (e.g. `'claude-opus-4-7'`, `'gpt-5'`) |
| `budget.perCall` | `number` | Max USD per call |
| `budget.session` | `number` | Max USD across the guard's lifetime |
| `budget.reasoning` | `number` | Max USD of reasoning-token spend (the hidden killer on o-series and Claude thinking) |
| `assumedOutputTokens` | `number` | Assumed output size for pre-call estimate (default `256`) |
| `assumedReasoningTokens` | `number` | Assumed reasoning tokens for pre-call estimate (default `0`) |

- `guard.check(prompt)` — async, throws `CostLimitError` (kind: `'perCall' \| 'session' \| 'reasoning'`) if over budget.
- `guard.estimate(prompt)` — sync, returns estimate without enforcing.
- `guard.record(usage)` — `usage: { input, output, reasoning?, cacheHit?, cacheWrite? }`. Update session totals.
- `guard.summary()` — returns `{ calls, spent, reasoningSpent, cacheSavings, remaining, reasoningRemaining, totalInputTokens, totalOutputTokens, totalReasoningTokens, totalCacheHitTokens, totalCacheWriteTokens, budget }`.

### `retryLLM(fn, options)`

| Option | Type | Description |
|---|---|---|
| `maxAttempts` | `number` | Total attempts including first try (default `4`) |
| `baseDelayMs` | `number` | Base delay for exponential backoff (default `500`) |
| `maxDelayMs` | `number` | Cap on any single delay (default `30_000`) |
| `jitter` | `'full' \| 'equal' \| 'none'` | Default `'equal'` |
| `shouldRetry` | `(err, attempt) => boolean \| undefined` | Override the default classifier |
| `signal` | `AbortSignal` | Abort the retry loop |
| `onRetry` | `(info) => void` | Fires before each retry sleep |

Exhausted retries throw `RetryExhaustedError` with `.attempts` and `.lastError`.
Helpers: `classifyError(err)`, `retryDelayFromError(err)`.

### `normalizeError(err)`

Returns `{ kind, message, status?, provider?, retryable, raw }`. Shortcut: `isRetryable(err)`.
Idempotent — passing an already-normalized error returns it unchanged.

### `cacheKey(input)` / `cacheKeySync(input)`

| Field | Type | Description |
|---|---|---|
| `model` | `string` | Required — part of the key so caches don't cross-pollute |
| `messages` | `Message[]` | Content normalized, `pinned`/`id` stripped, tool-call args re-sorted |
| `system` | `string` | Separate system prompt (Anthropic) — whitespace-normalized |
| `tools` | `Array<{name, ...}>` | Sorted by tool name |
| `response_format` | `unknown` | Structured-output spec |
| `params` | `Record<string, unknown>` | Deterministic knobs (temperature, top_p, max_tokens) — keys sorted |
| `namespace` | `string` | Workspace/tenant isolation prefix |

`cacheKey()` is async, returns 64-char SHA-256 hex. `cacheKeySync()` returns 16-char FNV-1a (non-cryptographic).
`cacheKeyCanonical(input)` returns the canonical string without hashing — useful for debugging.

### `toolCallAccumulator(provider)`

| Method | Returns | |
|---|---|---|
| `.push(chunk)` | `CompletedToolCall[]` | Tool calls that completed on this chunk (often empty) |
| `.flush()` | `CompletedToolCall[]` | Emit any in-flight calls — always call at end of stream |
| `.partial()` | `Array<{ id?, name?, argumentsRaw, index }>` | In-flight state for UI indicators |
| `.reset()` | `void` | Clear internal state so the accumulator can be reused |

`CompletedToolCall`: `{ id, name, arguments, argumentsRaw, index? }`.

---

## What this package does NOT do

Deliberate non-goals, to keep the bundle tiny and the scope clear:

- **No exact tokenization** — we use a chars/token heuristic. For exact counts, use `tiktoken` or `gpt-tokenizer` and feed the count into `calcCost` directly.
- **No network calls** — no telemetry, no remote blocklists, no cloud PII classifier. If you need ML-based detection, pair with `llm-guard` (Python) via HTTP.
- **No streaming wrappers** — use the provider SDKs directly and call `record()` when usage arrives.
- **No Zod schema input** — we take plain metadata. If you prefer Zod, use `zod-to-json-schema` and feed the result in as `params`.

---

## License

MIT © [The-ARJ](https://github.com/The-ARJ)
