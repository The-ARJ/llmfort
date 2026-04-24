# @the-arj/llmfort

> Fortify your LLM calls. Zero-dependency Node.js toolkit for provider-agnostic tool/function-calling schemas, prompt-injection + PII scanning, structured JSON output with repair, and pre-call cost/budget guardrails.

Four focused modules, zero runtime dependencies, full TypeScript types, ESM + CJS.
Built for the 2026 model landscape: **GPT-5**, **Claude 4.7**, **Gemini 3**, **DeepSeek V3.2**, **Llama 4**, **Mistral**, and any OpenAPI-compatible LLM.

`llmfort` sits between your app code and whichever LLM SDK you use. It won't stream, it won't route, it won't call APIs for you — it fortifies the four surfaces provider SDKs leave exposed: **schema shape**, **prompt safety**, **structured output**, and **spend**.

```ts
// Root import (convenient)
import { toolSchema, promptSafe, costGuard, structOut } from '@the-arj/llmfort'

// Or import the one module you need (smaller bundle)
import { toolSchema } from '@the-arj/llmfort/tool-schema'
import { promptSafe } from '@the-arj/llmfort/prompt-safe'
import { structOut } from '@the-arj/llmfort/struct-out'
import { costGuard } from '@the-arj/llmfort/cost-guard'
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
| Hard stop if a call would blow the budget | `tiktoken`, `gpt-tokenizer`, `llm-cost` | Those count tokens. This **enforces** per-call and session budgets with a typed error, and tracks real spend after each call. |

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

### `cost-guard` — Pre-call cost estimation and budget enforcement

```ts
import { costGuard, CostLimitError } from '@the-arj/llmfort/cost-guard'

const guard = costGuard({
  model: 'claude-sonnet-4-6',
  budget: {
    perCall: 0.05,   // max $0.05 per request
    session: 0.50,   // max $0.50 for this guard's lifetime
  },
})

// Before each call — throws CostLimitError if over budget:
await guard.check(prompt)

// After the call, record real usage from the API response:
guard.record(response.usage.input_tokens, response.usage.output_tokens)

// Cumulative stats:
console.log(guard.summary())
// { calls: 3, spent: 0.12, remaining: 0.38, totalInputTokens: 48000, ... }
```

**Supported models (verified April 2026)**

| Family | Models |
|---|---|
| **OpenAI GPT-5 / GPT-4.1** | `gpt-5`, `gpt-5-mini`, `gpt-5-nano`, `gpt-4.1`, `gpt-4.1-mini`, `gpt-4.1-nano` |
| **OpenAI reasoning** | `o3`, `o3-mini`, `o3-pro`, `o4-mini` |
| **OpenAI legacy** | `gpt-4o-mini`, `gpt-4-turbo`, `gpt-4`, `gpt-3.5-turbo` |
| **Claude 4.x** | `claude-opus-4-7`, `claude-opus-4-6`, `claude-sonnet-4-6`, `claude-sonnet-4-5`, `claude-haiku-4-5` |
| **Claude 3.5** | `claude-3-5-sonnet-20241022`, `claude-3-5-haiku-20241022`, `claude-3-opus-20240229` |
| **Gemini 3 / 2.5** | `gemini-3-pro`, `gemini-3-flash`, `gemini-2.5-pro`, `gemini-2.5-flash`, `gemini-2.5-flash-lite` |
| **Gemini 1.5** | `gemini-1.5-pro`, `gemini-1.5-flash` |
| **DeepSeek** | `deepseek-chat`, `deepseek-reasoner` |
| **Groq / Llama / OSS** | `llama-3.3-70b-versatile`, `llama-3.1-8b-instant`, `llama-4-scout-17b`, `llama-4-maverick-17b`, `openai/gpt-oss-120b`, `openai/gpt-oss-20b`, `kimi-k2` |
| **Mistral** | `mistral-large-latest`, `mistral-medium-3`, `mistral-small-latest`, `ministral-8b`, `ministral-3b`, `codestral-latest` |

Unknown model names fall back to a conservative flagship estimate (not tied to any specific retired model), so cost checks never silently skip.

Each `ModelPrice` also exposes `cachedInput` (per 1M tokens) where the provider offers a discount — use it if you're implementing prompt caching:

```ts
import { getPrice } from '@the-arj/llmfort/cost-guard'
const { input, output, cachedInput } = getPrice('claude-sonnet-4-6')
// { input: 3.00, output: 15.00, cachedInput: 0.30 }
```

Token estimation is model-aware: Claude uses a denser 3.5 chars/token heuristic and CJK-heavy text is clamped to 1.5 chars/token. Exact tokenization isn't done here — it would require shipping a tokenizer dependency, which is a deliberate non-goal of this package.

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
  guard.record(res.usage.input_tokens, res.usage.output_tokens)

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

### `costGuard(options)`

| Option | Type | Description |
|---|---|---|
| `model` | `string` | Model ID (e.g. `'claude-sonnet-4-6'`, `'gpt-5'`) |
| `budget.perCall` | `number` | Max USD per call |
| `budget.session` | `number` | Max USD across the guard's lifetime |
| `assumedOutputTokens` | `number` | Assumed output size for pre-call estimate (default: `256`) |

- `guard.check(prompt)` — async, throws `CostLimitError` if over budget.
- `guard.estimate(prompt)` — sync, returns estimate without enforcing.
- `guard.record(inputTokens, outputTokens)` — update session totals from real API usage.
- `guard.summary()` — returns `{ calls, spent, remaining, totalInputTokens, totalOutputTokens, budget }`.

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
