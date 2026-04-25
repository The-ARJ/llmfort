# @the-arj/llmfort

A zero-dependency Node.js toolkit for **GPT**, **Claude**, and **Gemini**. Nine modules covering the surfaces provider SDKs leave to the caller: tool schemas, prompt scanning, structured JSON, conversation trimming, cost guards, retry, error normalization, cache keys, and streaming tool calls.

Pricing and provider quirks verified against the  2026 model landscape: GPT-5 / 5-mini / 5-nano, GPT-4.1, o3 / o4-mini, Claude Opus 4.7 / Sonnet 4.6 / Haiku 4.5, Gemini 3 Pro / Flash.

```sh
npm install @the-arj/llmfort
```

Requires Node.js 18+. Ships ESM + CJS with full TypeScript types.

```ts
import {
  toolSchema, promptSafe, structOut, contextTrim, costGuard,
  retryLLM, normalizeError, cacheKey, toolCallAccumulator,
} from '@the-arj/llmfort'

// Or import individually for smaller bundles:
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

## Modules at a glance

| Module | What it does |
|---|---|
| `tool-schema` | One tool definition → OpenAI / Anthropic / Gemini envelopes. `lint(meta)` warns about each provider's silent-strip and outright-reject keywords. |
| `prompt-safe` | Regex scanner for prompt injection, jailbreak attempts, and PII (English + zh / es / fr / de / ru / ja / ko / ar). Separate `scanToolResult` / `scanRetrievedDoc` entry points for indirect injection. |
| `struct-out` | Extract JSON from a raw LLM response, parse leniently, validate against any schema (Zod / Valibot / ArkType / AJV / plain JSON Schema), and run an optional repair loop with a surgical fix prompt. |
| `context-trim` | Turn-aware conversation trimmer. Preserves system messages, pinned turns, tool_call/tool_result pairs, and Anthropic prompt-cache prefixes. Sliding / importance / summary strategies. |
| `cost-guard` | Pre-call estimate + per-call / session / reasoning-token budget enforcement. Understands cached-input discounts and Anthropic cache-write premium. |
| `retry-llm` | 429 / transient retry. Reads OpenAI `x-ratelimit-reset-*`, Anthropic `retry-after`, Gemini `RetryInfo`; falls back to exponential backoff with jitter. Never retries 400 / 401 / 403 / content-filter. |
| `error-normalize` | Tagged union covering rate-limited / context-overflow / content-filtered / schema-invalid / auth / billing / bad-request / server-error / network / transient / aborted / unknown. |
| `cache-key` | Stable canonical hash for prompt-cache keys (sorted tools, sorted JSON keys in `arguments`, whitespace-normalized prompts, namespace-isolated). |
| `stream-tools` | Streaming tool-call delta accumulator for OpenAI + Anthropic chunk shapes. |

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

**Lint.** Each provider silently strips or rejects different JSON-Schema features. Anthropic strips `pattern` / `minLength` / `format`. Gemini rejects nesting over 5 levels and `$ref` / `allOf` / `anyOf`. OpenAI strict mode requires every field in `required`. `toolSchema.lint(meta)` returns those warnings grouped by provider.

```ts
const { warnings, byProvider } = toolSchema.lint(meta)
if (byProvider.anthropic.length > 0) {
  // e.g. "field 'email': pattern is silently stripped from Claude's input_schema.
  //       Encode this constraint in the description if you want Claude to honor it."
  console.warn(byProvider.anthropic)
}
```

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

// Throw on any violation
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

False-positive guards:

- **Luhn validation** on credit-card matches; random 16-digit order numbers won't trigger.
- **Phone numbers require formatting** (dashes, dots, spaces, parens, or `+1`); bare 10-digit integers won't trigger.
- **Passport matches require context** (`passport`, `travel document`, or `MRZ` within 40 characters); product SKUs won't trigger.
- **Multilingual injection patterns** for Chinese, Spanish, French, German, Russian, Japanese, Korean, and Arabic.

**Indirect injection.** OWASP LLM01 now lists indirect prompt injection — poisoned tool results, malicious RAG documents — as the top attack vector. `promptSafe.scanToolResult()` and `scanRetrievedDoc()` apply a different pattern set tuned for untrusted content: fake system tags, chat-template tokens, markdown-image exfiltration, data-URL payloads, fake `<tool_use>` envelopes, embedded imperatives aimed at the model.

```ts
const apiResult = await fetchExternalAPI(userId)
const scan = promptSafe.scanToolResult(apiResult)
if (!scan.safe) {
  log.warn({ userId, violations: scan.violations }, 'Poisoned tool result')
  return '[tool result redacted — suspicious content]'
}

// Same idea for a RAG-retrieved document
const doc = await vectorStore.fetch(docId)
if (!promptSafe.scanRetrievedDoc(doc.text).safe) skipThisDoc()
```

---

### `struct-out` — Reliable structured JSON from any LLM

LLM JSON output fails for many reasons: markdown fences, extra fields the schema didn't ask for, a string where a number should be, mid-brace truncation, prose instead of JSON. `struct-out` extracts the JSON region, parses leniently, validates against any schema, and (optionally) runs a repair loop with a surgical fix prompt.

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

**Claude assistant pre-fill.** Pre-filling `{` into the assistant turn primes Claude to continue strict JSON, suppressing markdown fences and preamble. `struct-out` exposes a directive plus a one-shot helper:

```ts
import Anthropic from '@anthropic-ai/sdk'
import { structOut } from '@the-arj/llmfort/struct-out'

const pf = structOut.prefillForClaude()           // { prefill:'{', message, reattach }

const res = await anthropic.messages.create({
  model: 'claude-sonnet-4-6',
  max_tokens: 1024,
  messages: [
    { role: 'user', content: 'Return {title, score}' },
    pf.message,                                    // primes Claude to continue from "{"
  ],
})

const raw = pf.reattach((res.content[0] as { text: string }).text)
const parsed = structOut.parseSafe(raw, MySchema)

// Or the one-shot form:
const parsed2 = structOut.parsePrefilledClaude(res.content[0].text, MySchema)
```

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

**Cache-breakpoint protection.** If you use Anthropic `cache_control` or rely on OpenAI/Gemini automatic prompt caching, trimming messages before the cache anchor invalidates the prefix and forces a full re-read (plus a cache-write premium on Anthropic). Pass the message IDs that anchor the cached prefix and `context-trim` will refuse to trim at or before them:

```ts
const trimmed = await contextTrim(messages, {
  maxTokens: 100_000,
  cacheBreakpoints: ['system-prompt-v3', 'user-turn-anchor'],  // these message IDs survive any trim
})
if (trimmed.overflow > 0) {
  // Protected set exceeds budget — your cache strategy is the problem, not the budget.
}
```

**Token counting** includes per-message overhead — OpenAI adds ~4 tokens per message for role wrapping, Anthropic and Gemini use their own constants. Counters that ignore this underestimate by ~3–10%.

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

- **Reasoning tokens** are metered separately. GPT-5 `reasoning_effort: high` and Claude 4.6+ adaptive thinking can produce 5–10× the visible output; a session budget that ignores them will be off by that factor.
- **Prompt caching.** Anthropic charges 1.25× for 5-minute cache writes and 0.1× for cache hits; OpenAI discounts cached input by ~50%. `record()` accepts `cacheHit` and `cacheWrite` so estimates match your bill.
- **No session poisoning.** `record()` rejects NaN, Infinity, and negative values before mutating totals.

**Supported models (verified  2026):**

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

OpenAI streams `tool_calls[].function.arguments` as JSON deltas; Anthropic streams `input_json_delta` events. The accumulator handles both, supports parallel calls, falls back to the raw string when JSON parsing fails, and exposes `.partial()` for in-flight progress.

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

Scan input, enforce a budget, call the model, structure the response, repair on failure:

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
  promptSafe.assert(userMessage)
  await guard.check(userMessage)

  const call = (prompt: string) => claude.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    messages: [{ role: 'user', content: prompt }],
  })

  const res = await call(userMessage)
  guard.record({ input: res.usage.input_tokens, output: res.usage.output_tokens })

  const result = await structOut({
    raw: (res.content[0] as { text: string }).text,
    schema: Review,
    repair: async ({ prompt }) => {
      const fix = await call(prompt)
      guard.record({ input: fix.usage.input_tokens, output: fix.usage.output_tokens })
      return (fix.content[0] as { text: string }).text
    },
    maxRetries: 2,
  })

  return result.ok ? result.data : null
}
```

Swap the SDK and model name to target OpenAI or Gemini.

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
| `budget.reasoning` | `number` | Max USD spent on reasoning tokens (o-series, Claude thinking) |
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

## Out of scope

- **No exact tokenization.** A chars-per-token heuristic is used; for exact counts, plug in `tiktoken`, `@anthropic-ai/tokenizer`, or Gemini `countTokens` and call `calcCost` directly.
- **No network calls.** No telemetry, no remote blocklists, no cloud PII classifier.
- **No provider SDK wrapper.** Use OpenAI / Anthropic / Google SDKs directly; this package transforms inputs and outputs.
- **No agent loops, RAG, vector stores, eval harness, prompt-template DSL, or browser-side streaming.**

---

## License

MIT © [The-ARJ](https://github.com/The-ARJ)
